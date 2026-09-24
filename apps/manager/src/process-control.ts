import { spawn } from "node:child_process"
import { ManagerError } from "./errors.js"

// Agent 只提供程序證據；exact identity 與 missing-listener Stop 政策仍由 OMW 的
// process-control.ps1 原子核對。不可先用 HTTP health 取代 helper 的安全判斷。
export function runProcessHelper<T>(
  command: string,
  arguments_: string[],
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 12_000
  const maxOutputBytes = options.maxOutputBytes ?? 32 * 1024
  const child = spawn(command, arguments_, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    const timer = setTimeout(() => fail("Windows process helper 執行逾時。"), timeoutMs)
    const fail = (message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch {
        // kill 失敗不覆蓋既定錯誤，也不代表 helper 已確認終止。
      }
      reject(new ManagerError("PROCESS_CONTROL_FAILED", message, 500))
    }
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > maxOutputBytes) return fail("Windows process helper 輸出超過限制。")
      stdoutChunks.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > maxOutputBytes) fail("Windows process helper 輸出超過限制。")
    })
    child.once("error", () => fail("Windows process helper 執行失敗。"))
    child.once("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(new ManagerError("PROCESS_CONTROL_FAILED", "Windows process helper 執行失敗。", 500))
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8").trim()) as T)
      } catch {
        reject(new ManagerError("PROCESS_CONTROL_INVALID_RESPONSE", "Windows process helper 回傳無效資料。", 500))
      }
    })
  })
}
