#!/usr/bin/env node
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
  type SpawnOptionsWithoutStdio,
} from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { open, readFile, realpath, stat } from "node:fs/promises"
import { constants as osConstants } from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import type {
  LauncherRegistrationRequest,
  LauncherReservationRequest,
  LauncherReservationResponse,
} from "@omw/contracts"

const HTTP_TIMEOUT_MS = 1_500
const DPAPI_TIMEOUT_MS = 5_000
const MAX_DPAPI_OUTPUT = 64 * 1024
const KNOWN_SUBCOMMANDS = new Set([
  "acp", "agent", "attach", "auth", "completion", "db", "debug", "export", "generate", "github", "import",
  "mcp", "models", "plug", "plugin", "pr", "providers", "run", "serve", "session", "stats", "uninstall",
  "upgrade", "web",
])
const ROOT_OPTIONS_WITH_VALUE = new Set([
  "-m", "-s", "--agent", "--cors", "--hostname", "--log-level", "--mdns-domain", "--model", "--port",
  "--prompt", "--replay-limit", "--session",
])
const ROOT_BOOLEAN_OPTIONS = new Set([
  "-c", "--auto", "--continue", "--fork", "--mdns", "--mini", "--no-replay", "--print-logs", "--pure",
])
const NON_TUI_ROOT_OPTIONS = new Set(["-h", "--help", "-v", "--version"])

interface LauncherCredentials {
  launcherToken: string
}

interface ChildResult {
  pid: number
  completion: Promise<number>
}

export type DpapiSpawn = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams

export interface LauncherDependencies {
  loadCredentials(environment: NodeJS.ProcessEnv, cwd: string): Promise<LauncherCredentials>
  request<T>(origin: string, pathname: string, token: string, body: unknown): Promise<T>
  resolveExecutable(value: string, launcherPath: string, environment: NodeJS.ProcessEnv): Promise<string>
  spawnForeground(executable: string, args: string[], options: SpawnOptions): ChildResult
  invocationId(): string
  diagnostic(message: string): void
}

export interface InvocationPlan {
  managed: boolean
  requestedPort?: number
  projectArgument?: string
  reason?: string
}

export async function runLauncher(
  argv: string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
  launcherPath: string,
  dependencies: LauncherDependencies = defaultDependencies,
): Promise<number> {
  const executable = await dependencies.resolveExecutable(environment.OMW_OPENCODE_EXECUTABLE ?? "", launcherPath, environment)
  if (environment.OMW_LAUNCHER_ACTIVE === "1") throw new Error("拒絕 launcher 自遞迴。")
  const plan = planInvocation(argv)
  if (!plan.managed) {
    if (plan.reason) dependencies.diagnostic(`OMW launcher bypass: ${plan.reason}`)
    return await dependencies.spawnForeground(executable, argv, foregroundOptions(cwd, environment)).completion
  }

  let credentials: LauncherCredentials
  let reservation: LauncherReservationResponse
  const invocationId = dependencies.invocationId()
  try {
    credentials = await dependencies.loadCredentials(environment, cwd)
    const origin = configuredManagerOrigin(environment)
    const body: LauncherReservationRequest = {
      clientInvocationId: invocationId,
      directory: plan.projectArgument === undefined ? cwd : path.resolve(cwd, plan.projectArgument),
      ...(plan.requestedPort === undefined ? {} : { requestedPort: plan.requestedPort }),
    }
    // Reservation is OMW's atomic allocation confirmation; a second health probe here would add a race window before spawn.
    reservation = await dependencies.request<LauncherReservationResponse>(origin, "/api/v1/launcher/reservations", credentials.launcherToken, body)
  } catch (error) {
    if (environment.OMW_REQUIRED === "1") {
      dependencies.diagnostic(`OMW launcher required but unavailable: ${safeMessage(error)}`)
      return 70
    }
    dependencies.diagnostic(`OMW launcher unavailable; running native OpenCode: ${safeMessage(error)}`)
    return await dependencies.spawnForeground(executable, argv, foregroundOptions(cwd, environment)).completion
  }

  const childEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    OMW_LAUNCHER_ACTIVE: "1",
  }
  delete childEnvironment.OPENCODE_SERVER_USERNAME
  delete childEnvironment.OPENCODE_SERVER_PASSWORD
  const child = dependencies.spawnForeground(
    executable,
    managedArguments(argv, reservation.port),
    foregroundOptions(cwd, childEnvironment),
  )
  const origin = configuredManagerOrigin(environment)
  const registration: LauncherRegistrationRequest = { clientInvocationId: invocationId, pid: child.pid }
  const register = dependencies.request(
    origin,
    `/api/v1/launcher/reservations/${encodeURIComponent(reservation.reservationId)}/register`,
    credentials.launcherToken,
    registration,
  ).catch((error: unknown) => dependencies.diagnostic(`OMW registration failed; TUI remains native-owned: ${safeMessage(error)}`))

  try {
    return await child.completion
  } finally {
    await register
    await dependencies.request(
      origin,
      `/api/v1/launcher/reservations/${encodeURIComponent(reservation.reservationId)}/finalize`,
      credentials.launcherToken,
      registration,
    ).catch((error: unknown) => dependencies.diagnostic(`OMW finalization failed: ${safeMessage(error)}`))
  }
}

export function planInvocation(argv: string[]): InvocationPlan {
  const delimiterIndex = argv.indexOf("--")
  const rootArguments = delimiterIndex === -1 ? argv : argv.slice(0, delimiterIndex)
  const delimiterPositionals = delimiterIndex === -1 ? [] : argv.slice(delimiterIndex + 1)
  const rootPositionals: string[] = []

  for (let index = 0; index < rootArguments.length; index++) {
    const argument = rootArguments[index]
    if (!argument) continue
    if (NON_TUI_ROOT_OPTIONS.has(argument)) return { managed: false }
    if (ROOT_OPTIONS_WITH_VALUE.has(argument)) {
      const value = rootArguments[index + 1]
      if (!value || value.startsWith("-")) {
        return { managed: false, reason: `${argument} has no unambiguous value` }
      }
      index++
      continue
    }
    if (argument.startsWith("--") && argument.includes("=")) {
      const option = argument.slice(0, argument.indexOf("="))
      if (ROOT_OPTIONS_WITH_VALUE.has(option)) continue
    }
    if (ROOT_BOOLEAN_OPTIONS.has(argument)) continue
    if (argument.startsWith("-")) {
      return { managed: false, reason: `unknown root option ${argument} is not parsed by the launcher` }
    }
    rootPositionals.push(argument)
  }
  if (rootPositionals[0] && KNOWN_SUBCOMMANDS.has(rootPositionals[0])) return { managed: false }
  if (rootPositionals.length + delimiterPositionals.length > 1) {
    return { managed: false, reason: "multiple root positionals cannot be registered safely" }
  }
  const projectArgument = rootPositionals[0] ?? delimiterPositionals[0]
  if (projectArgument === "") return { managed: false, reason: "empty root project cannot be registered safely" }

  const ports = flagValues(rootArguments, "--port")
  const hostnames = flagValues(rootArguments, "--hostname")
  if (ports.length > 1 || hostnames.length > 1) return { managed: false, reason: "duplicate --port/--hostname flags are not rewritten" }
  if (hostnames[0] !== undefined && hostnames[0] !== "127.0.0.1") {
    return { managed: false, reason: `hostname ${hostnames[0]} is not managed loopback` }
  }
  if (ports[0] === undefined) return { managed: true, ...(projectArgument === undefined ? {} : { projectArgument }) }
  if (!/^\d+$/.test(ports[0])) return { managed: false, reason: "explicit --port is not an integer" }
  const requestedPort = Number(ports[0])
  if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65_535) {
    return { managed: false, reason: "explicit --port is outside 1-65535" }
  }
  return { managed: true, requestedPort, ...(projectArgument === undefined ? {} : { projectArgument }) }
}

export function managedArguments(argv: string[], port: number): string[] {
  const delimiterIndex = argv.indexOf("--")
  const insertionIndex = delimiterIndex === -1 ? argv.length : delimiterIndex
  const next = argv.slice(0, insertionIndex)
  if (flagValues(argv, "--hostname").length === 0) next.push("--hostname", "127.0.0.1")
  if (flagValues(argv, "--port").length === 0) next.push("--port", String(port))
  return next.concat(argv.slice(insertionIndex))
}

function flagValues(argv: string[], flag: "--port" | "--hostname"): string[] {
  const values: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === "--") break
    if (argument === flag) {
      values.push(argv[index + 1] ?? "")
      index++
    } else if (argument?.startsWith(`${flag}=`)) {
      values.push(argument.slice(flag.length + 1))
    }
  }
  return values
}

function foregroundOptions(cwd: string, environment: NodeJS.ProcessEnv): SpawnOptions {
  return { cwd, env: environment, stdio: "inherit", shell: false, detached: false, windowsHide: false }
}

function managerOrigin(value: string): string {
  const url = new URL(value)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.origin !== value || url.pathname !== "/") {
    throw new Error("OMW_MANAGER_ORIGIN 必須是完整的 http://127.0.0.1:<port> origin。")
  }
  return url.origin
}

async function loadCredentials(environment: NodeJS.ProcessEnv, _cwd: string): Promise<LauncherCredentials> {
  if (process.platform !== "win32") throw new Error("DPAPI launcher integration 只支援 Windows current user。")
  const dataDirectory = resolveDataDirectory(environment)
  const filename = path.join(dataDirectory, "credentials.dpapi")
  const helper = resolveCredentialHelper()
  const ciphertext = await readFile(filename, "utf8")
  const plaintext = await runDpapi(environment.OMW_POWERSHELL_EXECUTABLE ?? "pwsh.exe", helper, ciphertext)
  return decodeLauncherCredentials(plaintext)
}

function configuredManagerOrigin(environment: NodeJS.ProcessEnv): string {
  return managerOrigin(environment.OMW_MANAGER_ORIGIN ?? `http://127.0.0.1:${environment.OMW_PORT ?? "4174"}`)
}

export function resolveCredentialHelper(moduleDirectory = path.dirname(fileURLToPath(import.meta.url))): string {
  const candidates = [
    path.resolve(moduleDirectory, "../scripts/credential-store.ps1"),
    path.resolve(moduleDirectory, "../../../../apps/manager/scripts/credential-store.ps1"),
  ]
  const helper = candidates.find(existsSync)
  if (!helper) throw new Error("找不到 OMW DPAPI credential helper。")
  return helper
}

export function decodeLauncherCredentials(plaintext: string): LauncherCredentials {
  const value = JSON.parse(plaintext) as unknown
  if (!isRecord(value) || typeof value.launcherToken !== "string" || value.launcherToken.length < 32) {
    throw new Error("DPAPI credential store 格式無效。")
  }
  return { launcherToken: value.launcherToken }
}

export function runDpapi(
  powershell: string,
  helper: string,
  ciphertext: string,
  options: { spawnProcess?: DpapiSpawn; timeoutMs?: number } = {},
): Promise<string> {
  return runDpapiAction(powershell, helper, "Unprotect", ciphertext, options)
}

export function runDpapiAction(
  powershell: string,
  helper: string,
  action: "Protect" | "Unprotect",
  input: string,
  options: { spawnProcess?: DpapiSpawn; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = (options.spawnProcess ?? spawn)(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", helper, "-Action", action], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch {
      reject(new Error("無法啟動 Windows DPAPI helper。"))
      return
    }

    const stdout: Buffer[] = []
    let outputBytes = 0
    let settled = false
    let deadline: NodeJS.Timeout | undefined
    const cleanup = (): void => {
      if (deadline) clearTimeout(deadline)
      child.stdout.off("data", onStdout)
      child.stderr.off("data", onStderr)
      child.stdin.off("error", onInputError)
      child.off("error", onError)
      child.off("close", onClose)
    }
    const fail = (error: Error, kill: boolean): void => {
      if (settled) return
      settled = true
      cleanup()
      if (kill) {
        try { child.kill() } catch { /* 仍以既定的 bounded rejection 為準。 */ }
      }
      child.stdin.destroy()
      reject(error)
    }
    const accept = (chunk: Buffer, capture: boolean): void => {
      outputBytes += chunk.byteLength
      if (outputBytes > MAX_DPAPI_OUTPUT) {
        fail(new Error("Windows DPAPI helper exceeded the output limit."), true)
        return
      }
      if (capture) stdout.push(chunk)
    }
    const onStdout = (chunk: Buffer): void => accept(chunk, true)
    const onStderr = (chunk: Buffer): void => accept(chunk, false)
    const onInputError = (): void => fail(new Error("Windows DPAPI helper input failed."), true)
    const onError = (): void => fail(new Error("無法啟動 Windows DPAPI helper。"), false)
    const onClose = (code: number | null): void => {
      if (settled) return
      settled = true
      cleanup()
      child.stdin.destroy()
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"))
      else reject(new Error(`Windows DPAPI helper 失敗（exit code ${code ?? "unknown"}）。`))
    }

    child.stdout.on("data", onStdout)
    child.stderr.on("data", onStderr)
    child.stdin.once("error", onInputError)
    child.once("error", onError)
    child.once("close", onClose)
    const timeoutMs = options.timeoutMs ?? DPAPI_TIMEOUT_MS
    deadline = setTimeout(() => fail(new Error(`Windows DPAPI helper exceeded its ${timeoutMs}ms deadline.`), true), timeoutMs)
    try {
      child.stdin.end(input, "utf8")
    } catch {
      fail(new Error("Windows DPAPI helper input failed."), true)
    }
  })
}

export function resolveDataDirectory(environment: NodeJS.ProcessEnv): string {
  if (environment.OMW_DATA_DIR) return path.resolve(environment.OMW_DATA_DIR)
  if (!environment.LOCALAPPDATA) throw new Error("找不到 LOCALAPPDATA；請明確設定 OMW_DATA_DIR。")
  return path.resolve(environment.LOCALAPPDATA, "OMW")
}

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

function spawnForeground(executable: string, args: string[], options: SpawnOptions): ChildResult {
  const child = spawn(executable, args, options)
  if (!child.pid) {
    child.once("error", () => {})
    throw new Error("OpenCode child 未回報 PID。")
  }
  return {
    pid: child.pid,
    completion: new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => resolve(code ?? signalExitCode(signal)))
    }),
  }
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1
  return 128 + (osConstants.signals[signal] ?? 1)
}

async function request<T>(origin: string, pathname: string, token: string, body: unknown): Promise<T> {
  const response = await fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-omw-launcher-token": token },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  if (!response.ok) {
    const value = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
    throw new Error(`${value?.error?.code ?? `HTTP_${response.status}`}: ${value?.error?.message ?? "Manager request failed"}`)
  }
  return await response.json() as T
}

export function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|token|secret)[-_][A-Za-z0-9._-]{8,}\b/gi, "[REDACTED]")
    .slice(0, 512)
}

function samePath(left: string, right: string): boolean {
  const comparable = (value: string): string => {
    const resolved = existsSync(value) ? realpathSync.native(value) : path.resolve(value)
    return resolved.replace(/[\\/]+$/, "").toLowerCase()
  }
  return comparable(left) === comparable(right)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const defaultDependencies: LauncherDependencies = {
  loadCredentials,
  request,
  resolveExecutable,
  spawnForeground,
  invocationId: randomUUID,
  diagnostic: (message) => process.stderr.write(`${message}\n`),
}

if (process.argv[1] && samePath(fileURLToPath(import.meta.url), process.argv[1])) {
  runLauncher(process.argv.slice(2), process.env, process.cwd(), process.argv[1])
    .then((code) => { process.exitCode = code })
    .catch((error: unknown) => {
      process.stderr.write(`omw-opencode failed: ${safeMessage(error)}\n`)
      process.exitCode = 70
    })
}
