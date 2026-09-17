import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { StoredCredentials } from "./auth.js"

const MAX_DPAPI_OUTPUT = 64 * 1024
const DPAPI_TIMEOUT_MS = 5_000

type DpapiSpawn = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams

export interface CredentialStore {
  exists(): boolean
  load(): Promise<StoredCredentials>
  save(credentials: StoredCredentials): Promise<void>
}

export class DpapiCredentialStore implements CredentialStore {
  readonly filename: string
  private readonly powershell: string
  private readonly helperPath: string
  private readonly spawnDpapi: DpapiSpawn
  private readonly dpapiTimeoutMs: number

  constructor(options: {
    dataDirectory: string
    powershell?: string
    spawnDpapi?: DpapiSpawn
    dpapiTimeoutMs?: number
  }) {
    this.filename = path.join(options.dataDirectory, "credentials.dpapi")
    this.powershell = options.powershell ?? "pwsh.exe"
    this.helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/credential-store.ps1")
    this.spawnDpapi = options.spawnDpapi ?? spawn
    this.dpapiTimeoutMs = options.dpapiTimeoutMs ?? DPAPI_TIMEOUT_MS
  }

  exists(): boolean {
    return existsSync(this.filename)
  }

  async load(): Promise<StoredCredentials> {
    if (!this.exists()) throw new Error(`Remote access credential store 不存在：${this.filename}`)
    const ciphertext = await readFile(this.filename, "utf8")
    const plaintext = await runDpapi(this.powershell, this.helperPath, "Unprotect", ciphertext, this.spawnDpapi, this.dpapiTimeoutMs)
    try {
      return validateCredentials(JSON.parse(plaintext) as unknown)
    } finally {
      // JavaScript strings cannot be zeroed; keep plaintext scoped to this call and never return or log it.
    }
  }

  async save(credentials: StoredCredentials): Promise<void> {
    const validated = validateCredentials(credentials)
    const ciphertext = await runDpapi(this.powershell, this.helperPath, "Protect", JSON.stringify(validated), this.spawnDpapi, this.dpapiTimeoutMs)
    await mkdir(path.dirname(this.filename), { recursive: true })
    const temporary = `${this.filename}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
    try {
      await writeFile(temporary, ciphertext, { encoding: "utf8", flag: "wx" })
      await rename(temporary, this.filename)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
}

function validateCredentials(value: unknown): StoredCredentials {
  if (!isRecord(value) || !isBasic(value.manager) || !isBasic(value.openCode) || typeof value.launcherToken !== "string") {
    throw new Error("DPAPI credential store 格式無效。")
  }
  if (value.manager.password.length < 16 || value.openCode.password.length < 16 || value.launcherToken.length < 32) {
    throw new Error("Remote access passwords 至少 16 字元，launcher token 至少 32 字元。")
  }
  return {
    manager: { username: value.manager.username, password: value.manager.password },
    openCode: { username: value.openCode.username, password: value.openCode.password },
    launcherToken: value.launcherToken,
  }
}

function isBasic(value: unknown): value is { username: string; password: string } {
  return isRecord(value)
    && typeof value.username === "string" && value.username.length > 0
    && !/[:\u0000-\u001f\u007f]/.test(value.username)
    && typeof value.password === "string" && value.password.length > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function runDpapi(
  powershell: string,
  helperPath: string,
  action: "Protect" | "Unprotect",
  input: string,
  spawnProcess: DpapiSpawn,
  timeoutMs: number,
): Promise<string> {
  if (process.platform !== "win32") return Promise.reject(new Error("DPAPI credential store 只支援 Windows current user。"))
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnProcess(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", helperPath, "-Action", action], {
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
    deadline = setTimeout(() => fail(new Error(`Windows DPAPI helper exceeded its ${timeoutMs}ms deadline.`), true), timeoutMs)
    try {
      child.stdin.end(input, "utf8")
    } catch {
      fail(new Error("Windows DPAPI helper input failed."), true)
    }
  })
}
