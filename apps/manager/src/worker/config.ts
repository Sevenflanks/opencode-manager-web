import path from "node:path"
import { readFile, stat } from "node:fs/promises"

export function workerOrigin(value: string | undefined, name: string, internal = false): string {
  if (!value) throw new Error(`${name} 必填。`)
  const url = new URL(value)
  if (url.origin !== value || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || !(url.protocol === "https:" || (url.protocol === "http:" && (internal || url.hostname === "127.0.0.1")))) throw new Error(`${name} 必須是完整 root origin；非 loopback public origin 必須使用 HTTPS。`)
  return value
}

export async function workerSecret(environment: NodeJS.ProcessEnv, key: string, minLength: number): Promise<string> {
  const filename = environment[key]
  if (!filename || !path.isAbsolute(filename)) throw new Error(`${key} 必須指定 absolute secret file。`)
  const metadata = await stat(filename)
  if (!metadata.isFile() || metadata.size > 4096) throw new Error(`${key} secret file 格式無效。`)
  const secret = (await readFile(filename, "utf8")).replace(/\r?\n$/, "")
  if (secret.length < minLength || /[\r\n\0]/.test(secret)) throw new Error(`${key} secret 格式無效。`)
  return secret
}

export async function workerBrowserCredentials(environment: NodeJS.ProcessEnv) {
  const username = environment.OMW_BROWSER_USERNAME
  if (!username || /[:\r\n\0]/.test(username)) throw new Error("OMW_BROWSER_USERNAME 必填且不可含冒號。")
  return { username, password: await workerSecret(environment, "OMW_BROWSER_PASSWORD_FILE", 16) }
}

export function workerPort(value: string | undefined, fallback: number): number {
  const port = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Worker port 必須是 1..65535。")
  return port
}

export function workerExecutionHost(value: string | undefined): "127.0.0.1" | "0.0.0.0" {
  if (value === undefined) return "0.0.0.0"
  if (value !== "127.0.0.1" && value !== "0.0.0.0") throw new Error("OMW_EXECUTION_HOST 必須是 127.0.0.1 或 0.0.0.0。")
  return value
}
