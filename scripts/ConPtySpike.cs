using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Omw.ConPtySpike
{
    public sealed class OwnedProcess : IDisposable
    {
        const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        const uint PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016;
        const uint WAIT_OBJECT_0 = 0;

        IntPtr processHandle, threadHandle, pseudoConsole;
        FileStream input, output;
        Thread outputThread, closeThread;
        long outputBytes;
        long outputPersistedBytes;
        int closeStarted;

        public int ProcessId { get; private set; }
        public DateTime CreationTimeUtc { get; private set; }
        public long OutputBytes { get { return Interlocked.Read(ref outputBytes); } }
        public long OutputPersistedBytes { get { return Interlocked.Read(ref outputPersistedBytes); } }
        public bool OutputTruncated { get { return OutputBytes > OutputPersistedBytes; } }
        public string OutputError { get; private set; }

        OwnedProcess(IntPtr process, IntPtr thread, IntPtr console, IntPtr inputWrite,
            IntPtr outputRead, string outputPath, int pid)
        {
            processHandle = process;
            threadHandle = thread;
            pseudoConsole = console;
            ProcessId = pid;
            SafeFileHandle inputSafe = null, outputSafe = null;
            try
            {
                inputSafe = new SafeFileHandle(inputWrite, true); inputWrite = IntPtr.Zero;
                input = new FileStream(inputSafe, FileAccess.Write, 4096, false); inputSafe = null;
                outputSafe = new SafeFileHandle(outputRead, true); outputRead = IntPtr.Zero;
                output = new FileStream(outputSafe, FileAccess.Read, 4096, false); outputSafe = null;
                CreationTimeUtc = ReadCreationTime(processHandle);
                outputThread = new Thread(() => DrainOutput(outputPath)) { IsBackground = true, Name = "ConPTY output drain" };
                outputThread.Start();
            }
            catch
            {
                TerminateProcess(processHandle, 1);
                WaitForSingleObject(processHandle, 2000);
                if (input != null) input.Dispose(); else if (inputSafe != null) inputSafe.Dispose(); else Close(ref inputWrite);
                if (output != null) output.Dispose(); else if (outputSafe != null) outputSafe.Dispose(); else Close(ref outputRead);
                Thread boundedClose = new Thread(() => ClosePseudoConsole(console)) { IsBackground = true };
                boundedClose.Start(); boundedClose.Join(2000);
                pseudoConsole = IntPtr.Zero;
                Close(ref threadHandle); Close(ref processHandle);
                throw;
            }
        }

        public static OwnedProcess Start(string executable, string[] arguments, string workingDirectory,
            IDictionary<string, string> environment, short columns, short rows, string outputPath)
        {
            IntPtr inputRead = IntPtr.Zero, inputWrite = IntPtr.Zero;
            IntPtr outputRead = IntPtr.Zero, outputWrite = IntPtr.Zero;
            IntPtr console = IntPtr.Zero, attributes = IntPtr.Zero, environmentBlock = IntPtr.Zero;
            PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
            OwnedProcess owned = null;
            try
            {
                SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES {
                    nLength = Marshal.SizeOf<SECURITY_ATTRIBUTES>(), bInheritHandle = true
                };
                Check(CreatePipe(out inputRead, out inputWrite, ref security, 0), "CreatePipe(input)");
                Check(CreatePipe(out outputRead, out outputWrite, ref security, 0), "CreatePipe(output)");
                Check(SetHandleInformation(inputWrite, 1, 0), "SetHandleInformation(input)");
                Check(SetHandleInformation(outputRead, 1, 0), "SetHandleInformation(output)");
                int hr = CreatePseudoConsole(new COORD(columns, rows), inputRead, outputWrite, 0, out console);
                if (hr != 0) Marshal.ThrowExceptionForHR(hr);

                IntPtr bytes = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes);
                attributes = Marshal.AllocHGlobal(bytes);
                Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref bytes), "InitializeProcThreadAttributeList");
                Check(UpdateProcThreadAttribute(attributes, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                    console, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute");

                STARTUPINFOEX startup = new STARTUPINFOEX();
                startup.StartupInfo.cb = Marshal.SizeOf<STARTUPINFOEX>();
                startup.lpAttributeList = attributes;
                environmentBlock = BuildEnvironmentBlock(environment);
                StringBuilder commandLine = new StringBuilder(Quote(executable));
                foreach (string argument in arguments) commandLine.Append(' ').Append(Quote(argument));
                Check(CreateProcessW(executable, commandLine, IntPtr.Zero, IntPtr.Zero, false,
                    EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, environmentBlock,
                    workingDirectory, ref startup, out pi), "CreateProcessW");

                IntPtr process = pi.hProcess, thread = pi.hThread, transferredConsole = console;
                IntPtr transferredInput = inputWrite, transferredOutput = outputRead;
                pi.hProcess = pi.hThread = console = inputWrite = outputRead = IntPtr.Zero;
                owned = new OwnedProcess(process, thread, transferredConsole, transferredInput, transferredOutput, outputPath, pi.dwProcessId);
                return owned;
            }
            finally
            {
                if (owned == null && pi.hProcess != IntPtr.Zero)
                {
                    TerminateProcess(pi.hProcess, 1);
                    WaitForSingleObject(pi.hProcess, 2000);
                }
                Close(ref pi.hThread); Close(ref pi.hProcess);
                if (console != IntPtr.Zero) ClosePseudoConsole(console);
                Close(ref inputRead); Close(ref inputWrite); Close(ref outputRead); Close(ref outputWrite);
                if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
                if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
            }
        }

        public bool HasExited { get { return WaitForSingleObject(processHandle, 0) == WAIT_OBJECT_0; } }
        public bool WaitForExit(int milliseconds) { return WaitForSingleObject(processHandle, (uint)milliseconds) == WAIT_OBJECT_0; }
        public bool Terminate(int exitCode) { return HasExited || TerminateProcess(processHandle, (uint)exitCode); }
        public int ExitCode { get { uint code; Check(GetExitCodeProcess(processHandle, out code), "GetExitCodeProcess"); return (int)code; } }
        public void SendCtrlC() { input.WriteByte(3); input.Flush(); }
        public void CloseInput() { if (input != null) { input.Dispose(); input = null; } }

        public bool ClosePseudoConsoleBounded(int milliseconds)
        {
            if (Interlocked.Exchange(ref closeStarted, 1) == 0)
            {
                IntPtr value = pseudoConsole;
                pseudoConsole = IntPtr.Zero;
                closeThread = new Thread(() => ClosePseudoConsole(value)) { IsBackground = true, Name = "ConPTY close" };
                closeThread.Start();
            }
            return closeThread == null || closeThread.Join(milliseconds);
        }

        public bool WaitForOutputDrain(int milliseconds) { return outputThread == null || outputThread.Join(milliseconds); }

        void DrainOutput(string path)
        {
            try
            {
                using (FileStream destination = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read))
                {
                    byte[] buffer = new byte[8192];
                    int read;
                    while ((read = output.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        Interlocked.Add(ref outputBytes, read);
                        int writable = (int)Math.Min(read, Math.Max(0, 8 * 1024 * 1024 - outputPersistedBytes));
                        if (writable > 0) { destination.Write(buffer, 0, writable); destination.Flush(); Interlocked.Add(ref outputPersistedBytes, writable); }
                    }
                    destination.Flush(true);
                }
            }
            catch (Exception ex) { OutputError = ex.Message; }
        }

        public void Dispose()
        {
            if (processHandle != IntPtr.Zero && !HasExited) { Terminate(1); WaitForExit(2000); }
            CloseInput();
            if (pseudoConsole != IntPtr.Zero || closeThread != null) ClosePseudoConsoleBounded(2000);
            if (!WaitForOutputDrain(2000) && output != null) output.Dispose();
            if (output != null) { output.Dispose(); output = null; }
            Close(ref threadHandle); Close(ref processHandle);
        }

        static IntPtr BuildEnvironmentBlock(IDictionary<string, string> environment)
        {
            List<string> entries = new List<string>();
            foreach (KeyValuePair<string, string> item in environment) entries.Add(item.Key + "=" + item.Value);
            entries.Sort(StringComparer.OrdinalIgnoreCase);
            return Marshal.StringToHGlobalUni(string.Join("\0", entries) + "\0\0");
        }

        static string Quote(string value)
        {
            if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
            StringBuilder result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in value)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') result.Append('\\', slashes * 2 + 1); else result.Append('\\', slashes);
                slashes = 0; result.Append(c);
            }
            result.Append('\\', slashes * 2).Append('"');
            return result.ToString();
        }

        static DateTime ReadCreationTime(IntPtr process)
        {
            FILETIME creation, exit, kernel, user;
            Check(GetProcessTimes(process, out creation, out exit, out kernel, out user), "GetProcessTimes");
            return DateTime.FromFileTimeUtc(((long)creation.dwHighDateTime << 32) | creation.dwLowDateTime);
        }

        static void Check(bool success, string operation) { if (!success) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), operation); }
        static void Close(ref IntPtr handle) { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }

        [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; public COORD(short x, short y) { X = x; Y = y; } }
        [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
        [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
        [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
        [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint dwLowDateTime, dwHighDateTime; }

        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(COORD size, IntPtr input, IntPtr output, uint flags, out IntPtr console);
        [DllImport("kernel32.dll")] static extern int ResizePseudoConsole(IntPtr console, COORD size);
        [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr console);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
        [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

        public void Resize(short columns, short rows) { int hr = ResizePseudoConsole(pseudoConsole, new COORD(columns, rows)); if (hr != 0) Marshal.ThrowExceptionForHR(hr); }
    }
}
