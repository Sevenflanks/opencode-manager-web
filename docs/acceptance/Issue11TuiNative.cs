using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Omw.Issue11Acceptance
{
    public static class SharedText
    {
        public static string ReadAllText(string path)
        {
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (StreamReader reader = new StreamReader(stream, Encoding.UTF8, true))
            {
                return reader.ReadToEnd();
            }
        }
    }

    public class OwnedChild : IDisposable
    {
        internal IntPtr ProcessHandle;
        internal IntPtr ThreadHandle;
        public int ProcessId { get; internal set; }
        public bool HasExited { get { return Native.WaitForSingleObject(ProcessHandle, 0) == Native.WAIT_OBJECT_0; } }
        public bool WaitForExit(int milliseconds) { return Native.WaitForSingleObject(ProcessHandle, (uint)milliseconds) == Native.WAIT_OBJECT_0; }
        public int ExitCode { get { uint value; Native.Check(Native.GetExitCodeProcess(ProcessHandle, out value), "GetExitCodeProcess"); return unchecked((int)value); } }
        public void Terminate(int exitCode) { if (!HasExited) Native.Check(Native.TerminateProcess(ProcessHandle, unchecked((uint)exitCode)), "TerminateProcess"); }
        public virtual void Dispose() { Native.Close(ref ThreadHandle); Native.Close(ref ProcessHandle); }
    }

    public sealed class ConPtyChild : OwnedChild
    {
        IntPtr pseudoConsole;
        FileStream input;
        FileStream output;
        Thread outputThread;
        Thread closeThread;
        int closeStarted;
        public string OutputError { get; private set; }

        internal ConPtyChild(IntPtr process, IntPtr thread, int pid, IntPtr console, IntPtr inputWrite, IntPtr outputRead, string outputPath)
        {
            ProcessHandle = process;
            ThreadHandle = thread;
            ProcessId = pid;
            pseudoConsole = console;
            input = new FileStream(new SafeFileHandle(inputWrite, true), FileAccess.Write, 4096, false);
            output = new FileStream(new SafeFileHandle(outputRead, true), FileAccess.Read, 4096, false);
            outputThread = new Thread(() => Drain(outputPath)) { IsBackground = true, Name = "Issue11 ConPTY drain" };
            outputThread.Start();
        }

        public void SendCtrlC() { input.WriteByte(3); input.Flush(); }
        public void WriteInput(string value)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(value);
            input.Write(bytes, 0, bytes.Length);
            input.Flush();
        }
        public void CloseInput() { if (input != null) { input.Dispose(); input = null; } }
        public bool WaitForOutputDrain(int milliseconds) { return outputThread == null || outputThread.Join(milliseconds); }
        public bool ClosePseudoConsoleBounded(int milliseconds)
        {
            if (Interlocked.Exchange(ref closeStarted, 1) == 0)
            {
                IntPtr value = pseudoConsole;
                pseudoConsole = IntPtr.Zero;
                closeThread = new Thread(() => Native.ClosePseudoConsole(value)) { IsBackground = true, Name = "Issue11 ConPTY close" };
                closeThread.Start();
            }
            return closeThread == null || closeThread.Join(milliseconds);
        }

        void Drain(string path)
        {
            try
            {
                using (FileStream destination = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.ReadWrite))
                {
                    byte[] buffer = new byte[8192];
                    long retained = 0;
                    int read;
                    while ((read = output.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        int writable = (int)Math.Min(read, Math.Max(0, 8 * 1024 * 1024 - retained));
                        if (writable > 0) { destination.Write(buffer, 0, writable); destination.Flush(); retained += writable; }
                    }
                    destination.Flush(true);
                }
            }
            catch (Exception error) { OutputError = error.Message; }
        }

        public override void Dispose()
        {
            CloseInput();
            if (pseudoConsole != IntPtr.Zero || closeThread != null) ClosePseudoConsoleBounded(2000);
            if (!WaitForOutputDrain(2000) && output != null) output.Dispose();
            if (output != null) { output.Dispose(); output = null; }
            base.Dispose();
        }
    }

    public sealed class PtyHostResult
    {
        public int ExitCode { get; internal set; }
        public bool InJobBeforeResume { get; internal set; }
    }

    public static class PtyHost
    {
        public static PtyHostResult Run(string executable, string[] arguments, string workingDirectory)
        {
            IntPtr input = IntPtr.Zero, output = IntPtr.Zero;
            Native.PROCESS_INFORMATION process = new Native.PROCESS_INFORMATION();
            bool resumed = false;
            try
            {
                Native.SECURITY_ATTRIBUTES inheritable = new Native.SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf<Native.SECURITY_ATTRIBUTES>(), bInheritHandle = true };
                input = Native.CreateFileW("CONIN$", 0xC0000000, 3, ref inheritable, 3, 0, IntPtr.Zero);
                output = Native.CreateFileW("CONOUT$", 0xC0000000, 3, ref inheritable, 3, 0, IntPtr.Zero);
                Native.CheckHandle(input, "CreateFileW(CONIN$)");
                Native.CheckHandle(output, "CreateFileW(CONOUT$)");

                // Reopen the attached console handles so Node stdio:"inherit" descendants cannot retain the lifecycle host's redirected handles.
                Native.STARTUPINFOEX startup = new Native.STARTUPINFOEX();
                startup.StartupInfo.cb = Marshal.SizeOf<Native.STARTUPINFOEX>();
                startup.StartupInfo.dwFlags = Native.STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = input;
                startup.StartupInfo.hStdOutput = output;
                startup.StartupInfo.hStdError = output;
                Native.CreateWithAttributes(executable, arguments, workingDirectory, null, true, Native.CREATE_SUSPENDED, ref startup, new[] { input, output }, IntPtr.Zero, out process);

                bool inJob;
                Native.Check(Native.IsProcessInJob(process.hProcess, IntPtr.Zero, out inJob), "IsProcessInJob");
                if (!inJob) throw new InvalidOperationException("PTY target did not inherit the current-run Job before resume.");
                if (Native.ResumeThread(process.hThread) == UInt32.MaxValue) Native.ThrowLastError("ResumeThread");
                resumed = true;
                uint wait = Native.WaitForSingleObject(process.hProcess, Native.INFINITE);
                if (wait != Native.WAIT_OBJECT_0) throw new Win32Exception("WaitForSingleObject failed for PTY target.");
                uint exitCode;
                Native.Check(Native.GetExitCodeProcess(process.hProcess, out exitCode), "GetExitCodeProcess");
                return new PtyHostResult { ExitCode = unchecked((int)exitCode), InJobBeforeResume = true };
            }
            catch
            {
                if (!resumed && process.hProcess != IntPtr.Zero)
                {
                    Native.TerminateProcess(process.hProcess, 125);
                    Native.WaitForSingleObject(process.hProcess, 2000);
                }
                throw;
            }
            finally
            {
                Native.Close(ref input); Native.Close(ref output);
                Native.Close(ref process.hThread); Native.Close(ref process.hProcess);
            }
        }
    }

    public sealed class OwnedJob : IDisposable
    {
        IntPtr handle;
        public OwnedJob()
        {
            handle = Native.CreateJobObjectW(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) Native.ThrowLastError("CreateJobObjectW");
            Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            Native.Check(Native.SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf<Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()), "SetInformationJobObject");
        }

        public uint ActiveProcesses
        {
            get
            {
                Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION value;
                Native.Check(Native.QueryInformationJobObject(handle, 1, out value, (uint)Marshal.SizeOf<Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>(), IntPtr.Zero), "QueryInformationJobObject");
                return value.ActiveProcesses;
            }
        }

        public bool WaitEmpty(int milliseconds)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(milliseconds);
            while (DateTime.UtcNow < deadline) { if (ActiveProcesses == 0) return true; Thread.Sleep(20); }
            return ActiveProcesses == 0;
        }

        public void Terminate(int exitCode)
        {
            if (ActiveProcesses != 0) Native.Check(Native.TerminateJobObject(handle, unchecked((uint)exitCode)), "TerminateJobObject");
        }

        public OwnedChild StartRedirected(string executable, string[] arguments, string workingDirectory, IDictionary<string, string> environment, string stdoutPath, string stderrPath)
        {
            IntPtr input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero;
            Native.PROCESS_INFORMATION process = new Native.PROCESS_INFORMATION();
            try
            {
                Native.SECURITY_ATTRIBUTES inheritable = new Native.SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf<Native.SECURITY_ATTRIBUTES>(), bInheritHandle = true };
                input = Native.CreateFileW("NUL", 0x80000000, 3, ref inheritable, 3, 0, IntPtr.Zero);
                output = Native.CreateFileW(stdoutPath, 0x40000000, 3, ref inheritable, 2, 0x80, IntPtr.Zero);
                error = Native.CreateFileW(stderrPath, 0x40000000, 3, ref inheritable, 2, 0x80, IntPtr.Zero);
                Native.CheckHandle(input, "CreateFileW(stdin)"); Native.CheckHandle(output, "CreateFileW(stdout)"); Native.CheckHandle(error, "CreateFileW(stderr)");
                Native.STARTUPINFOEX startup = new Native.STARTUPINFOEX();
                startup.StartupInfo.cb = Marshal.SizeOf<Native.STARTUPINFOEX>();
                startup.StartupInfo.dwFlags = 0x100;
                startup.StartupInfo.hStdInput = input; startup.StartupInfo.hStdOutput = output; startup.StartupInfo.hStdError = error;
                Native.CreateWithAttributes(executable, arguments, workingDirectory, environment, true, Native.CREATE_SUSPENDED | Native.CREATE_NO_WINDOW, ref startup, new[] { input, output, error }, IntPtr.Zero, out process);
                BindAndResume(process);
                OwnedChild child = new OwnedChild { ProcessHandle = process.hProcess, ThreadHandle = process.hThread, ProcessId = process.dwProcessId };
                process.hProcess = process.hThread = IntPtr.Zero;
                return child;
            }
            finally { Native.Close(ref input); Native.Close(ref output); Native.Close(ref error); Native.Close(ref process.hThread); Native.Close(ref process.hProcess); }
        }

        public ConPtyChild StartConPty(string executable, string[] arguments, string workingDirectory, IDictionary<string, string> environment, short columns, short rows, string outputPath)
        {
            IntPtr inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero, outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero, console = IntPtr.Zero;
            Native.PROCESS_INFORMATION process = new Native.PROCESS_INFORMATION();
            try
            {
                Native.SECURITY_ATTRIBUTES inheritable = new Native.SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf<Native.SECURITY_ATTRIBUTES>(), bInheritHandle = true };
                Native.Check(Native.CreatePipe(out inputRead, out inputWrite, ref inheritable, 0), "CreatePipe(input)");
                Native.Check(Native.CreatePipe(out outputRead, out outputWrite, ref inheritable, 0), "CreatePipe(output)");
                Native.Check(Native.SetHandleInformation(inputWrite, 1, 0), "SetHandleInformation(input)");
                Native.Check(Native.SetHandleInformation(outputRead, 1, 0), "SetHandleInformation(output)");
                int result = Native.CreatePseudoConsole(new Native.COORD(columns, rows), inputRead, outputWrite, 0, out console);
                if (result != 0) Marshal.ThrowExceptionForHR(result);
                Native.STARTUPINFOEX startup = new Native.STARTUPINFOEX();
                startup.StartupInfo.cb = Marshal.SizeOf<Native.STARTUPINFOEX>();
                Native.CreateWithAttributes(executable, arguments, workingDirectory, environment, false, Native.CREATE_SUSPENDED, ref startup, null, console, out process);
                BindAndResume(process);
                ConPtyChild child = new ConPtyChild(process.hProcess, process.hThread, process.dwProcessId, console, inputWrite, outputRead, outputPath);
                process.hProcess = process.hThread = console = inputWrite = outputRead = IntPtr.Zero;
                return child;
            }
            finally
            {
                Native.Close(ref inputRead); Native.Close(ref inputWrite); Native.Close(ref outputRead); Native.Close(ref outputWrite);
                if (console != IntPtr.Zero) Native.ClosePseudoConsole(console);
                Native.Close(ref process.hThread); Native.Close(ref process.hProcess);
            }
        }

        void BindAndResume(Native.PROCESS_INFORMATION process)
        {
            try
            {
                Native.Check(Native.AssignProcessToJobObject(handle, process.hProcess), "AssignProcessToJobObject");
                if (Native.ResumeThread(process.hThread) == UInt32.MaxValue) Native.ThrowLastError("ResumeThread");
            }
            catch { Native.TerminateProcess(process.hProcess, 125); Native.WaitForSingleObject(process.hProcess, 2000); throw; }
        }

        public void Dispose()
        {
            if (handle != IntPtr.Zero)
            {
                try { if (ActiveProcesses != 0) Terminate(124); WaitEmpty(5000); } finally { Native.Close(ref handle); }
            }
        }
    }

    internal static class Native
    {
        internal const uint CREATE_SUSPENDED = 0x00000004, CREATE_UNICODE_ENVIRONMENT = 0x00000400, CREATE_NO_WINDOW = 0x08000000, EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        internal const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000, WAIT_OBJECT_0 = 0, INFINITE = 0xFFFFFFFF, STARTF_USESTDHANDLES = 0x00000100;
        static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = new IntPtr(0x00020002), PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = new IntPtr(0x00020016);

        [StructLayout(LayoutKind.Sequential)] internal struct COORD { public short X, Y; public COORD(short x, short y) { X = x; Y = y; } }
        [StructLayout(LayoutKind.Sequential)] internal struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct STARTUPINFO { public int cb; public IntPtr lpReserved, lpDesktop, lpTitle; public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
        [StructLayout(LayoutKind.Sequential)] internal struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
        [StructLayout(LayoutKind.Sequential)] internal struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
        [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
        [StructLayout(LayoutKind.Sequential)] internal struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
        [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
        [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }

        internal static void CreateWithAttributes(string executable, string[] arguments, string workingDirectory, IDictionary<string, string> environment, bool inheritHandles, uint flags, ref STARTUPINFOEX startup, IntPtr[] inheritedHandles, IntPtr pseudoConsole, out PROCESS_INFORMATION process)
        {
            int count = (inheritedHandles == null ? 0 : 1) + (pseudoConsole == IntPtr.Zero ? 0 : 1);
            IntPtr size = IntPtr.Zero, list = IntPtr.Zero, handleList = IntPtr.Zero, environmentBlock = IntPtr.Zero;
            bool initialized = false;
            try
            {
                InitializeProcThreadAttributeList(IntPtr.Zero, count, 0, ref size);
                list = Marshal.AllocHGlobal(size);
                Check(InitializeProcThreadAttributeList(list, count, 0, ref size), "InitializeProcThreadAttributeList"); initialized = true;
                startup.lpAttributeList = list;
                if (inheritedHandles != null)
                {
                    handleList = Marshal.AllocHGlobal(IntPtr.Size * inheritedHandles.Length);
                    for (int index = 0; index < inheritedHandles.Length; index++) Marshal.WriteIntPtr(handleList, index * IntPtr.Size, inheritedHandles[index]);
                    Check(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handleList, new IntPtr(IntPtr.Size * inheritedHandles.Length), IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute(handle list)");
                }
                if (pseudoConsole != IntPtr.Zero) Check(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, pseudoConsole, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute(pseudoconsole)");
                if (environment != null) environmentBlock = BuildEnvironmentBlock(environment);
                Check(CreateProcessW(executable, new StringBuilder(CommandLine(executable, arguments)), IntPtr.Zero, IntPtr.Zero, inheritHandles, flags | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT, environmentBlock, workingDirectory, ref startup, out process), "CreateProcessW");
            }
            finally
            {
                if (initialized) DeleteProcThreadAttributeList(list);
                if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
                if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
                if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
            }
        }

        static IntPtr BuildEnvironmentBlock(IDictionary<string, string> environment)
        {
            List<string> entries = new List<string>();
            foreach (KeyValuePair<string, string> item in environment) entries.Add(item.Key + "=" + item.Value);
            entries.Sort(StringComparer.OrdinalIgnoreCase);
            return Marshal.StringToHGlobalUni(string.Join("\0", entries) + "\0\0");
        }
        static string CommandLine(string executable, string[] arguments) { StringBuilder value = new StringBuilder(Quote(executable)); foreach (string argument in arguments) value.Append(' ').Append(Quote(argument)); return value.ToString(); }
        static string Quote(string value) { if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value; StringBuilder result = new StringBuilder("\""); int slashes = 0; foreach (char c in value) { if (c == '\\') { slashes++; continue; } if (c == '"') result.Append('\\', slashes * 2 + 1); else result.Append('\\', slashes); slashes = 0; result.Append(c); } result.Append('\\', slashes * 2).Append('"'); return result.ToString(); }
        internal static void Check(bool success, string operation) { if (!success) ThrowLastError(operation); }
        internal static void CheckHandle(IntPtr handle, string operation) { if (handle == IntPtr.Zero || handle == new IntPtr(-1)) ThrowLastError(operation); }
        internal static void ThrowLastError(string operation) { int error = Marshal.GetLastWin32Error(); throw new Win32Exception(error, operation + " failed with Win32 error " + error); }
        internal static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle); handle = IntPtr.Zero; }

        [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool QueryInformationJobObject(IntPtr job, int informationClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information, uint length, IntPtr returnedLength);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll")] internal static extern int CreatePseudoConsole(COORD size, IntPtr input, IntPtr output, uint flags, out IntPtr console);
        [DllImport("kernel32.dll")] internal static extern void ClosePseudoConsole(IntPtr console);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
        [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES attributes, uint creation, uint flags, IntPtr template);
    }
}
