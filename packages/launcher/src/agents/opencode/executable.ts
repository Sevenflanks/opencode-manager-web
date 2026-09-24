import { existsSync, realpathSync } from "node:fs"
import { open, readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"

export async function resolveExecutable(value: string, launcherPath: string, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const pathEntries = (environment.PATH ?? "").split(path.delimiter).filter(Boolean)
  const candidates = value
    ? [value]
    : [
        ...(environment.OPENCODE_INSTALL_DIR ? [path.join(environment.OPENCODE_INSTALL_DIR, "opencode.exe")] : []),
        ...(environment.XDG_BIN_DIR ? [path.join(environment.XDG_BIN_DIR, "opencode.exe")] : []),
        ...pathEntries.map((entry) => path.join(entry, "opencode.exe")),
      ]
  if (value && !path.isAbsolute(value)) throw new Error("OMW_OPENCODE_EXECUTABLE 必須是存在的 absolute path。")
  const candidate = candidates.find((item) => path.isAbsolute(item) && existsSync(item))
  if (!candidate) {
    if (!value) {
      const diagnostics: string[] = []
      for (const shim of pathEntries
        .map((entry) => path.join(entry, "opencode.cmd"))
        .filter((item) => path.isAbsolute(item) && existsSync(item))) {
        try {
          return await resolveKnownOpenCodeShim(shim, launcherPath)
        } catch (error) {
          diagnostics.push(`shim「${shim}」：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (diagnostics.length > 0) {
        throw new Error(`找不到可驗證的 OpenCode executable。${diagnostics.join("；")}。請以 OMW_OPENCODE_EXECUTABLE 設定真正 executable 的絕對路徑。`)
      }
    }
    throw new Error("找不到可驗證的 OpenCode executable；請以 OMW_OPENCODE_EXECUTABLE 提供真正 executable 的絕對路徑。")
  }
  if (value && path.extname(candidate).toLowerCase() === ".cmd") {
    const shim = (await resolveCandidateIdentity(candidate, launcherPath)).executable
    let executable: string
    try {
      executable = await resolveKnownOpenCodeShim(shim, launcherPath)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`OpenCode executable 必須是有效的 Windows PE executable，不可使用 script 或 shim「${shim}」；${reason}。請以 OMW_OPENCODE_EXECUTABLE 設定真正 executable 的絕對路徑。`)
    }
    throw new Error(`OpenCode executable 必須是有效的 Windows PE executable，不可使用 script 或 shim「${shim}」；請改設為已驗證的 executable「${executable}」。`)
  }
  return validateOpenCodeExecutable(candidate, launcherPath)
}

async function resolveKnownOpenCodeShim(shim: string, launcherPath: string): Promise<string> {
  const knownLines = [
    /^@ECHO[ \t]+off$/i,
    /^GOTO[ \t]+start$/i,
    /^:find_dp0$/i,
    /^SET[ \t]+dp0=%~dp0$/i,
    /^EXIT[ \t]+\/b$/i,
    /^:start$/i,
    /^SETLOCAL$/i,
    /^CALL[ \t]+:find_dp0$/i,
    /^"%dp0%\\node_modules\\opencode-ai\\bin\\opencode\.exe"[ \t]+%\*$/i,
  ]
  // 僅接受 npm 已知的固定 9 行；水平空白可變，但不可忽略額外命令或分支。
  const lines = (await readFile(shim, "utf8"))
    .replace(/\r\n?/g, "\n")
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => line.replace(/^[ \t]+|[ \t]+$/g, ""))
  if (lines.length !== knownLines.length || knownLines.some((line, index) => !line.test(lines[index] ?? ""))) {
    throw new Error("格式不符合可安全靜態辨識的已知 OpenCode shim")
  }
  const target = path.resolve(path.dirname(shim), "node_modules", "opencode-ai", "bin", "opencode.exe")
  if (!existsSync(target)) throw new Error(`推導目標「${target}」不存在`)
  try {
    return await validateOpenCodeExecutable(target, launcherPath)
  } catch (error) {
    throw new Error(`推導目標「${target}」驗證失敗：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function validateOpenCodeExecutable(candidate: string, launcherPath: string): Promise<string> {
  const { executable, size } = await resolveCandidateIdentity(candidate, launcherPath)
  if (path.extname(executable).toLowerCase() !== ".exe" || !await hasWindowsPeSignature(executable, size)) {
    throw new Error("OpenCode executable 必須是有效的 Windows PE executable，不可使用 script、shim 或一般檔案。")
  }
  return executable
}

async function resolveCandidateIdentity(candidate: string, launcherPath: string): Promise<{ executable: string; size: number }> {
  const details = await stat(candidate)
  if (!details.isFile()) throw new Error("OpenCode executable 必須是一般檔案。")
  const executable = await realpath(candidate)
  const launcher = existsSync(launcherPath) ? await realpath(launcherPath) : path.resolve(launcherPath)
  if (samePath(executable, launcher) || /^omw(?:-opencode)?(?:\.cmd|\.ps1|\.exe)?$/i.test(path.basename(executable))) {
    throw new Error("OMW_OPENCODE_EXECUTABLE 不可指向 OMW launcher。")
  }
  return { executable, size: details.size }
}

function samePath(left: string, right: string): boolean {
  const comparable = (value: string): string => {
    const resolved = existsSync(value) ? realpathSync.native(value) : path.resolve(value)
    return resolved.replace(/[\\/]+$/, "").toLowerCase()
  }
  return comparable(left) === comparable(right)
}

async function hasWindowsPeSignature(filename: string, size: number): Promise<boolean> {
  if (size < 68) return false
  const handle = await open(filename, "r")
  try {
    // 只驗證 Windows PE container；不執行 user-provided binary 做版本探測。
    const dosHeader = Buffer.alloc(64)
    if ((await handle.read(dosHeader, 0, dosHeader.length, 0)).bytesRead !== dosHeader.length) return false
    if (dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) return false
    const peOffset = dosHeader.readUInt32LE(0x3c)
    if (peOffset > size - 4) return false
    const signature = Buffer.alloc(4)
    if ((await handle.read(signature, 0, signature.length, peOffset)).bytesRead !== signature.length) return false
    return signature.equals(Buffer.from([0x50, 0x45, 0, 0]))
  } finally {
    await handle.close()
  }
}
