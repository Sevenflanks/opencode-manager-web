#!/usr/bin/env node
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { resolveCredentialHelper, resolveDataDirectory, resolveExecutable, runDpapiAction, runLauncher, safeMessage } from "./cli.js"

const STARTUP_DEADLINE_MS = 10_000
const INITIALIZATION_DEADLINE_MS = 30_000
const OWNED_PROCESS_STOP_DEADLINE_MS = 2_000

export interface LocalCredentials {
  manager: { username: string; password: string }
  launcherToken: string
}

export class CredentialInitializationCancelledError extends Error {
  constructor() {
    super("OMW 初始化已取消，可直接重試。")
    this.name = "CredentialInitializationCancelledError"
  }
}

export class CredentialSetupRequiredError extends Error {
  constructor() {
    super("缺少 OMW 初始設定；請先在本機互動式終端執行 omw。")
    this.name = "CredentialSetupRequiredError"
  }
}

export interface ManagerCliDependencies {
  ensureCredentials(dataDirectory: string, environment: NodeJS.ProcessEnv): Promise<LocalCredentials>
  probe(origin: string, token: string): Promise<"omw" | "absent" | "foreign">
  spawnManager(entry: string, options: SpawnOptions): OwnedManagerProcess
  managerEntry(): Promise<string>
  webRoot(): Promise<string>
  resolveExecutable(value: string, launcherPath: string, environment: NodeJS.ProcessEnv): Promise<string>
  launcherPath(): string
  sleep(milliseconds: number): Promise<void>
  now(): number
  output(message: string): void
  diagnostic(message: string): void
  runOpenCode(argv: string[], environment: NodeJS.ProcessEnv): Promise<number>
  cliVersion(): Promise<string>
}

export interface OwnedManagerProcess {
  stop(): Promise<void>
  preserve(): void
}

export interface CredentialInitializationDependencies {
  isInteractive(): boolean
  load(filename: string, environment: NodeJS.ProcessEnv): Promise<LocalCredentials>
  save(filename: string, credentials: LocalCredentials, environment: NodeJS.ProcessEnv): Promise<void>
  promptUsername(): Promise<string>
  promptPassword(): Promise<string>
  createToken(): string
  sleep(milliseconds: number): Promise<void>
  now(): number
}

export async function runManagerCli(
  argv: string[],
  environment: NodeJS.ProcessEnv,
  dependencies: ManagerCliDependencies = defaultDependencies,
): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    dependencies.output(await dependencies.cliVersion())
    return 0
  }
  const wrapperArguments = argv[0] === "opencode" ? argv.slice(1) : null
  if (argv.length && !wrapperArguments) throw new Error("未知命令；OpenCode TUI 請使用 omw opencode [project] [-s session]。")
  let ready: { dataDirectory: string; origin: string } | undefined
  try {
    const dataDirectory = resolveDataDirectory(environment)
    const credentials = await dependencies.ensureCredentials(dataDirectory, environment)
    const port = parsePort(environment.OMW_PORT ?? "4174")
    const origin = `http://127.0.0.1:${port}`
    await ensureManagerReady(dataDirectory, origin, port, credentials, environment, dependencies)
    ready = { dataDirectory, origin }
  } catch (cause) {
    if (
      !wrapperArguments
      || environment.OMW_REQUIRED === "1"
      || cause instanceof CredentialInitializationCancelledError
      || cause instanceof CredentialSetupRequiredError
    ) throw cause
    dependencies.diagnostic(`OMW Manager bootstrap failed; continuing with native OpenCode: ${safeMessage(cause)}`)
  }
  if (wrapperArguments) return await dependencies.runOpenCode(wrapperArguments, environment)
  dependencies.output(`OMW CLI version: ${await dependencies.cliVersion()}`)
  dependencies.output(`OMW Manager ready: ${ready!.origin}`)
  dependencies.output(`Data directory: ${ready!.dataDirectory}`)
  dependencies.output("OpenCode TUI: omw opencode [project] [-s session]")
  return 0
}

export async function readCliVersion(moduleUrl: string = import.meta.url): Promise<string> {
  let directory = path.dirname(fileURLToPath(moduleUrl))
  while (true) {
    const filename = path.join(directory, "package.json")
    try {
      const metadata = JSON.parse(await readFile(filename, "utf8")) as unknown
      if (!isRecord(metadata) || typeof metadata.version !== "string" || !metadata.version) {
        throw new Error(`OMW package metadata 缺少有效 version：${filename}`)
      }
      return metadata.version
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause
    }
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error("找不到 OMW package metadata。")
    directory = parent
  }
}

async function ensureManagerReady(
  dataDirectory: string,
  origin: string,
  port: number,
  credentials: LocalCredentials,
  environment: NodeJS.ProcessEnv,
  dependencies: ManagerCliDependencies,
): Promise<void> {
  const initial = await dependencies.probe(origin, credentials.launcherToken)
  if (initial === "omw") return
  if (initial === "foreign") throw foreignManagerError(port)

  await mkdir(dataDirectory, { recursive: true })
  const lockName = processLockName(await realpath(dataDirectory), "manager-start.lock")
  const deadline = dependencies.now() + STARTUP_DEADLINE_MS
  let lock: net.Server | undefined
  while (!lock) {
    lock = await tryAcquireProcessLock(lockName)
    if (lock) break
    const status = await dependencies.probe(origin, credentials.launcherToken)
    if (status === "omw") return
    if (status === "foreign") throw foreignManagerError(port)
    if (dependencies.now() >= deadline) throw new Error("另一個 OMW Manager 啟動仍在進行；請稍後重試。")
    await dependencies.sleep(100)
  }

  let owner: OwnedManagerProcess | undefined
  try {
    const rechecked = await dependencies.probe(origin, credentials.launcherToken)
    if (rechecked === "omw") return
    if (rechecked === "foreign") throw foreignManagerError(port)

    const [entry, webRoot, executable] = await Promise.all([
      dependencies.managerEntry(),
      dependencies.webRoot(),
      dependencies.resolveExecutable(
        environment.OMW_OPENCODE_EXECUTABLE ?? "",
        dependencies.launcherPath(),
        environment,
      ),
    ])
    owner = dependencies.spawnManager(entry, {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...environment,
        OMW_DATA_DIR: dataDirectory,
        OMW_PORT: String(port),
        OMW_LAUNCHER_INTEGRATION: "1",
        OMW_WEB_ROOT: webRoot,
        OMW_OPENCODE_EXECUTABLE: executable,
      },
    })
    while (dependencies.now() < deadline) {
      await dependencies.sleep(100)
      const status = await dependencies.probe(origin, credentials.launcherToken)
      if (status === "omw") {
        owner.preserve()
        owner = undefined
        return
      }
      if (status === "foreign") throw foreignManagerError(port)
    }
    const finalStatus = await dependencies.probe(origin, credentials.launcherToken)
    if (finalStatus === "omw") {
      owner.preserve()
      owner = undefined
      return
    }
    if (finalStatus === "foreign") throw foreignManagerError(port)
    throw new Error("OMW Manager 未在期限內完成 readiness；請檢查本機設定後重試。")
  } catch (cause) {
    if (owner) {
      try {
        // 只清理由本次 spawn 回傳的 ChildProcess owner，不可從 port 或 PID 猜測既有 Manager 的 ownership。
        await owner.stop()
      } catch (cleanupCause) {
        throw new Error(`${errorMessage(cause)}；本次 Manager process cleanup 失敗：${errorMessage(cleanupCause)}`)
      }
    }
    throw cause
  } finally {
    await releaseProcessLock(lock)
  }
}

export async function ensureCredentials(
  dataDirectory: string,
  environment: NodeJS.ProcessEnv,
  dependencies: CredentialInitializationDependencies = defaultCredentialDependencies,
): Promise<LocalCredentials> {
  const filename = path.join(dataDirectory, "credentials.dpapi")
  if (existsSync(filename)) return await dependencies.load(filename, environment)
  if (!dependencies.isInteractive()) {
    throw new CredentialSetupRequiredError()
  }
  await mkdir(dataDirectory, { recursive: true })
  const lockName = processLockName(await realpath(dataDirectory), "initialize.lock")
  let lock: net.Server | undefined
  const deadline = dependencies.now() + INITIALIZATION_DEADLINE_MS
  while (!lock) {
    lock = await tryAcquireProcessLock(lockName)
    if (lock) break
    if (existsSync(filename)) return await dependencies.load(filename, environment)
    if (dependencies.now() >= deadline) throw new Error("另一個 OMW 初始化仍在進行；請稍後重試。")
    await dependencies.sleep(100)
  }
  try {
    if (existsSync(filename)) return await dependencies.load(filename, environment)
    const username = await dependencies.promptUsername() || "omw"
    if (/[:\u0000-\u001f\u007f]/.test(username)) throw new Error("OMW 帳號不可包含冒號或控制字元。")
    const password = await dependencies.promptPassword()
    const credentials: LocalCredentials = {
      manager: { username, password },
      launcherToken: dependencies.createToken(),
    }
    await dependencies.save(filename, credentials, environment)
    // 重新走 persisted store 的解密與驗證，避免後續 wrapper 使用未真正落盤的 in-memory token。
    return await dependencies.load(filename, environment)
  } finally {
    await releaseProcessLock(lock)
  }
}

function processLockName(dataDirectory: string, logicalName: string): string {
  // 不讀寫 legacy .lock 檔；用 TTL 或 PID 猜測 stale owner 可能誤搶仍存活的 lock。
  const identity = createHash("sha256")
    .update(dataDirectory.toLowerCase())
    .update("\0")
    .update(logicalName)
    .digest("hex")
  return `\\\\.\\pipe\\omw-${identity}`
}

async function tryAcquireProcessLock(lockName: string): Promise<net.Server | undefined> {
  const server = net.createServer((socket) => socket.destroy())
  return await new Promise((resolve, reject) => {
    const onError = (cause: NodeJS.ErrnoException): void => {
      server.off("listening", onListening)
      if (cause.code === "EADDRINUSE") resolve(undefined)
      else reject(cause)
    }
    const onListening = (): void => {
      server.off("error", onError)
      resolve(server)
    }
    server.once("error", onError)
    server.once("listening", onListening)
    // Windows named pipe 會隨持有 process handle 消失，owner 異常結束也不會留下 stale lock。
    server.listen({ path: lockName, exclusive: true })
  })
}

async function releaseProcessLock(lock: net.Server): Promise<void> {
  if (!lock.listening) return
  await new Promise<void>((resolve, reject) => {
    lock.close((cause) => cause ? reject(cause) : resolve())
  })
}

async function loadCredentials(filename: string, environment: NodeJS.ProcessEnv): Promise<LocalCredentials> {
  const helper = credentialHelper()
  const plaintext = await runDpapiAction(
    environment.OMW_POWERSHELL_EXECUTABLE ?? "pwsh.exe",
    helper,
    "Unprotect",
    await readFile(filename, "utf8"),
  )
  return decodeManagerCredentials(plaintext)
}

export function decodeManagerCredentials(plaintext: string): LocalCredentials {
  try {
    return validateCredentials(JSON.parse(plaintext) as unknown)
  } catch (cause) {
    if (cause instanceof SyntaxError) throw new Error("DPAPI credential store 無法解析。")
    throw cause
  }
}

async function saveCredentials(filename: string, credentials: LocalCredentials, environment: NodeJS.ProcessEnv): Promise<void> {
  const ciphertext = await runDpapiAction(
    environment.OMW_POWERSHELL_EXECUTABLE ?? "pwsh.exe",
    credentialHelper(),
    "Protect",
    JSON.stringify(credentials),
  )
  const temporary = `${filename}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  try {
    await writeFile(temporary, ciphertext, { encoding: "utf8", flag: "wx" })
    await rename(temporary, filename)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function credentialHelper(): string {
  return resolveCredentialHelper()
}

export async function probeManager(origin: string, token: string): Promise<"omw" | "absent" | "foreign"> {
  try {
    const response = await fetch(`${origin}/api/v1/launcher/identity`, {
      headers: { "x-omw-launcher-token": token },
      redirect: "error",
      signal: AbortSignal.timeout(1_000),
    })
    if (!response.ok) return "foreign"
    const value = await response.json() as { product?: unknown; protocolVersion?: unknown }
    return value.product === "omw-manager" && value.protocolVersion === 1 ? "omw" : "foreign"
  } catch {
    return await isLoopbackPortOccupied(origin) ? "foreign" : "absent"
  }
}

export function isLoopbackPortOccupied(origin: string): Promise<boolean> {
  const port = Number(new URL(origin).port)
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port })
    let settled = false
    const finish = (occupied: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(occupied)
    }
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
    socket.setTimeout(500, () => finish(false))
  })
}

function spawnManager(entry: string, options: SpawnOptions): OwnedManagerProcess {
  const child = spawn(process.execPath, [entry], options)
  if (!child.pid) throw new Error("無法啟動 OMW Manager background process。")
  return ownedManagerProcess(child)
}

function ownedManagerProcess(child: ChildProcess): OwnedManagerProcess {
  return {
    preserve() {
      child.unref()
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (error?: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(deadline)
          child.off("exit", onExit)
          child.off("error", onError)
          if (error) reject(error)
          else resolve()
        }
        const onExit = (): void => finish()
        const onError = (cause: Error): void => finish(cause)
        const deadline = setTimeout(
          () => finish(new Error("owned Manager process 未在 cleanup deadline 內退出。")),
          OWNED_PROCESS_STOP_DEADLINE_MS,
        )
        child.once("exit", onExit)
        child.once("error", onError)
        if (!child.kill()) finish(new Error("無法停止本次啟動的 Manager process。"))
      })
    },
  }
}

async function managerEntry(): Promise<string> {
  return await existingRealPath([
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../manager/src/server.js"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../apps/manager/dist/src/server.js"),
  ], "找不到已打包的 OMW Manager entry。")
}

async function webRoot(): Promise<string> {
  return await existingRealPath([
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../apps/web/dist"),
  ], "找不到已打包的 OMW Web assets。")
}

async function existingRealPath(candidates: string[], message: string): Promise<string> {
  const candidate = candidates.find(existsSync)
  if (!candidate) throw new Error(message)
  return await realpath(candidate)
}

function validateCredentials(value: unknown): LocalCredentials {
  if (!isRecord(value) || !isRecord(value.manager)
    || typeof value.manager.username !== "string" || !value.manager.username
    || typeof value.manager.password !== "string" || value.manager.password.length < 16
    || typeof value.launcherToken !== "string" || value.launcherToken.length < 32) {
    throw new Error("DPAPI credential store 格式無效。")
  }
  return {
    manager: { username: value.manager.username, password: value.manager.password },
    launcherToken: value.launcherToken,
  }
}

async function confirmedPassword(): Promise<string> {
  const password = await promptHidden("OMW 密碼（至少 16 字元，本機與遠端登入共用）: ")
  if (password.length < 16) throw new Error("密碼至少需要 16 字元。")
  if (password !== await promptHidden("再次輸入密碼: ")) throw new Error("兩次輸入的密碼不一致。")
  return password
}

function promptVisible(prompt: string): Promise<string> {
  process.stdout.write(prompt)
  return readLine(false)
}

function promptHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt)
  return readLine(true)
}

function readLine(masked: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = ""
    process.stdin.setRawMode!(true)
    process.stdin.resume()
    process.stdin.setEncoding("utf8")
    const finish = (error?: Error): void => {
      process.stdin.off("data", onData)
      process.stdin.setRawMode!(false)
      process.stdin.pause()
      process.stdout.write("\n")
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\u0003") return finish(new CredentialInitializationCancelledError())
        if (character === "\r" || character === "\n") return finish()
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1)
          if (!masked) process.stdout.write("\b \b")
        } else if (character >= " ") {
          value += character
          if (!masked) process.stdout.write(character)
        }
      }
    }
    process.stdin.on("data", onData)
  })
}

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("OMW_PORT 必須是 1 到 65535 的整數。")
  return port
}

function foreignManagerError(port: number): Error {
  return new Error(`127.0.0.1:${port} 已由非 OMW Manager 程序使用；不會停止或取代該程序。`)
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function samePath(left: string, right: string): boolean {
  const comparable = (value: string): string => (existsSync(value) ? realpathSync.native(value) : path.resolve(value)).toLowerCase()
  return comparable(left) === comparable(right)
}

const defaultCredentialDependencies: CredentialInitializationDependencies = {
  isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY && typeof process.stdin.setRawMode === "function"),
  load: loadCredentials,
  save: saveCredentials,
  promptUsername: () => promptVisible("OMW 帳號 [omw]: "),
  promptPassword: confirmedPassword,
  createToken: () => randomBytes(32).toString("base64url"),
  sleep,
  now: Date.now,
}

const defaultDependencies: ManagerCliDependencies = {
  ensureCredentials,
  probe: probeManager,
  spawnManager,
  managerEntry,
  webRoot,
  resolveExecutable,
  launcherPath: () => process.argv[1] ?? fileURLToPath(import.meta.url),
  sleep,
  now: Date.now,
  output: (message) => process.stdout.write(`${message}\n`),
  diagnostic: (message) => process.stderr.write(`${message}\n`),
  runOpenCode: (argv, environment) => runLauncher(argv, environment, process.cwd(), process.argv[1] ?? fileURLToPath(import.meta.url)),
  cliVersion: () => readCliVersion(),
}

if (process.argv[1] && samePath(fileURLToPath(import.meta.url), process.argv[1])) {
  runManagerCli(process.argv.slice(2), process.env)
    .then((code) => { process.exitCode = code })
    .catch((cause: unknown) => {
      process.stderr.write(`omw failed: ${safeMessage(cause)}\n`)
      process.exitCode = 70
    })
}
