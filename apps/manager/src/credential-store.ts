import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { StoredCredentials } from "./auth.js"

const MAX_DPAPI_OUTPUT = 64 * 1024

export interface CredentialStore {
  exists(): boolean
  load(): Promise<StoredCredentials>
  save(credentials: StoredCredentials): Promise<void>
}

export class DpapiCredentialStore implements CredentialStore {
  readonly filename: string
  private readonly powershell: string
  private readonly helperPath: string

  constructor(options: { dataDirectory: string; powershell?: string }) {
    this.filename = path.join(options.dataDirectory, "credentials.dpapi")
    this.powershell = options.powershell ?? "pwsh.exe"
    this.helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/credential-store.ps1")
  }

  exists(): boolean {
    return existsSync(this.filename)
  }

  async load(): Promise<StoredCredentials> {
    if (!this.exists()) throw new Error(`Remote access credential store 不存在：${this.filename}`)
    const ciphertext = await readFile(this.filename, "utf8")
    const plaintext = await runDpapi(this.powershell, this.helperPath, "Unprotect", ciphertext)
    try {
      return validateCredentials(JSON.parse(plaintext) as unknown)
    } finally {
      // JavaScript strings cannot be zeroed; keep plaintext scoped to this call and never return or log it.
    }
  }

  async save(credentials: StoredCredentials): Promise<void> {
    const validated = validateCredentials(credentials)
    const ciphertext = await runDpapi(this.powershell, this.helperPath, "Protect", JSON.stringify(validated))
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

function runDpapi(powershell: string, helperPath: string, action: "Protect" | "Unprotect", input: string): Promise<string> {
  if (process.platform !== "win32") return Promise.reject(new Error("DPAPI credential store 只支援 Windows current user。"))
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", helperPath, "-Action", action], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8")
      if (Buffer.byteLength(next, "utf8") > MAX_DPAPI_OUTPUT) child.kill()
      return next.slice(0, MAX_DPAPI_OUTPUT)
    }
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk) })
    child.once("error", () => reject(new Error("無法啟動 Windows DPAPI helper。")))
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || "Windows DPAPI helper 失敗。"))
      resolve(stdout)
    })
    child.stdin.end(input, "utf8")
  })
}
