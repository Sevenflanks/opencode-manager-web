import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const maxFileBytes = 128 * 1024
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url))
const sourceFiles = new Set([
  "app.js", "auth.js", "config.js", "connectivity.js", "credential-controller.js", "credential-setup.js",
  "credential-store.js", "errors.js", "isolation.js", "lifecycle-diagnostics.js", "remote-access.js",
  "repository.js", "runtime.js", "server.js", "service.js",
])
type StartupStage = "port" | "version" | "remote_access" | "configuration" | "credentials" | "application" | "reconcile" | "listen"
type LifecycleEvent = "start" | "ready" | "shutdown_requested" | "close_completed" | "startup_failed"
const startupStages = new Set<StartupStage>(["port", "version", "remote_access", "configuration", "credentials", "application", "reconcile", "listen"])
const lifecycleEvents = new Set<LifecycleEvent>(["start", "ready", "shutdown_requested", "close_completed", "startup_failed"])
export interface LocalVerificationDiagnostic {
  event: "local_tui_verify_phase_started" | "local_tui_verify_phase_completed" | "local_tui_verify_finished"
  instanceId: string
  attempt: number
  stage: "inspect" | "listener_wait" | "readiness"
  result: "pending" | "listener_pending" | "listener_confirmed" | "identity_unverified" | "completed" | "success" | "timeout" | "failed" | "cancelled"
  elapsedMs: number
  stageElapsedMs: number
  remainingMs: number
}
const verificationEvents = new Set(["local_tui_verify_phase_started", "local_tui_verify_phase_completed", "local_tui_verify_finished"])
const verificationStages = new Set(["inspect", "listener_wait", "readiness"])
const verificationResults = new Set(["pending", "listener_pending", "listener_confirmed", "identity_unverified", "completed", "success", "timeout", "failed", "cancelled"])
export interface ReadinessDiagnostic {
  event: "opencode_readiness_request_started" | "opencode_readiness_response_received" | "opencode_readiness_request_completed" | "opencode_readiness_validation_completed" | "opencode_readiness_retry" | "opencode_readiness_finished"
  instanceId: string
  scope: "initial_local_tui" | "other"
  verificationAttempt?: number
  attempt: number
  stage: "health" | "path" | "readiness"
  result: "pending" | "success" | "http_timeout" | "network" | "http_status" | "content_type" | "json_parse" | "health_invalid" | "directory_mismatch" | "deadline" | "cancelled"
  httpStatus?: number
  elapsedMs: number
  stageElapsedMs: number
  remainingMs: number
}
const readinessEvents = new Set(["opencode_readiness_request_started", "opencode_readiness_response_received", "opencode_readiness_request_completed", "opencode_readiness_validation_completed", "opencode_readiness_retry", "opencode_readiness_finished"])
const readinessResults = new Set(["pending", "success", "http_timeout", "network", "http_status", "content_type", "json_parse", "health_invalid", "directory_mismatch", "deadline", "cancelled"])
const knownErrorNames = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError", "ManagerError"])
const knownErrorCodes = new Set([
  "ENOENT", "EACCES", "EPERM", "EADDRINUSE", "ECONNREFUSED", "ETIMEDOUT", "SQLITE_BUSY", "SQLITE_CORRUPT",
  "OPENCODE_EXECUTABLE_REQUIRED", "OPENCODE_EXECUTABLE_NOT_FOUND",
])

export function createLifecycleDiagnostics(dataDirectory: string): {
  setContext(context: { port?: number; managerVersion?: string }): void
  record(event: LifecycleEvent, details?: { stage?: string; error?: unknown; source?: "api" }): void
  recordLocalVerification(details: LocalVerificationDiagnostic): void
  recordReadiness(details: ReadinessDiagnostic): void
} {
  const logDirectory = path.join(dataDirectory, "logs")
  const current = path.join(logDirectory, "manager-lifecycle.jsonl")
  let port: number | undefined
  let managerVersion: string | undefined

  function write(record: Record<string, unknown>): void {
    try {
      const line = `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, ...record })}\n`
      // 不讓單筆輸入繞過 rotation 上限；不可截斷 JSONL 產生無效紀錄。
      if (Buffer.byteLength(line) > maxFileBytes) return
      mkdirSync(logDirectory, { recursive: true })
      const size = existsSync(current) ? statSync(current).size : 0
      if (size + Buffer.byteLength(line) > maxFileBytes && size > 0) {
        rmSync(`${current}.1`, { force: true })
        renameSync(current, `${current}.1`)
      }
      appendFileSync(current, line, { encoding: "utf8", flag: "a" })
    } catch {
      // 診斷失敗不可改變 Manager 的啟停結果；不要把檔案錯誤寫入 stdout/stderr。
    }
  }

  function record(event: LifecycleEvent, details?: { stage?: string; error?: unknown; source?: "api" }): void {
    try {
      if (!lifecycleEvents.has(event)) return
      write({ event, port: port ?? null, managerVersion: managerVersion ?? null,
        ...(event === "start" ? { ppid: process.ppid, nodeVersion: process.version } : {}),
        ...(details && typeof details.stage === "string" && startupStages.has(details.stage as StartupStage) ? { stage: details.stage } : {}),
        ...(details?.source === "api" ? { source: "api" } : {}),
        ...(details && "error" in details ? { error: safeError(details.error) } : {}),
      })
    } catch { /* 診斷不能覆蓋原本的啟停或 fatal exception */ }
  }

  // Monitor 只觀察，不安裝 uncaughtException/unhandledRejection handler，保留 Node 預設非零退出。
  process.on("uncaughtExceptionMonitor", (error: unknown, origin: string) => {
    try {
      write({ event: "uncaught_exception", port: port ?? null,
        source: origin === "unhandledRejection" ? "unhandledRejection" : "uncaughtException", error: safeError(error) })
    } catch { /* 保留 Node 原本的 crash behavior */ }
  })
  // exit callback 必須同步寫入；signal/硬終止不保證觸發。
  process.on("exit", (code) => { try { write({ event: "exit", port: port ?? null, code }) } catch { /* best effort */ } })
  record("start")
  return {
    setContext(context) {
      try {
        if (Number.isInteger(context.port) && context.port! >= 1 && context.port! <= 65_535) port = context.port
        if (typeof context.managerVersion === "string" && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]{1,32})?$/.test(context.managerVersion)) {
          managerVersion = context.managerVersion
        }
      } catch { /* 不信任外部傳入的 getter */ }
    },
    record,
    recordLocalVerification(details) {
      try {
        // 只投影 fixed codes、UUID 與數字；不可 spread runtime/request/error 到持久化紀錄。
        const { event, instanceId, attempt, stage, result, elapsedMs, stageElapsedMs, remainingMs } = details
        if (!verificationEvents.has(event) || !verificationStages.has(stage) || !verificationResults.has(result)
          || typeof instanceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId)
          || !Number.isSafeInteger(attempt) || attempt < 1
          || ![elapsedMs, stageElapsedMs, remainingMs].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER)) return
        write({ event, instanceId, attempt, stage, result, elapsedMs, stageElapsedMs, remainingMs })
      } catch { /* 診斷輸入或寫入失敗不可改變驗證結果 */ }
    },
    recordReadiness(details) {
      try {
        const { event, instanceId, scope, verificationAttempt, attempt, stage, result, httpStatus, elapsedMs, stageElapsedMs, remainingMs } = details
        if (!readinessEvents.has(event) || !readinessResults.has(result) || !["health", "path", "readiness"].includes(stage)
          || !["initial_local_tui", "other"].includes(scope)
          || typeof instanceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId)
          || !Number.isSafeInteger(attempt) || attempt < 1
          || (scope === "initial_local_tui" && (!Number.isSafeInteger(verificationAttempt) || verificationAttempt! < 1))
          || (scope === "other" && verificationAttempt !== undefined)
          || (httpStatus !== undefined && (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599))
          || ![elapsedMs, stageElapsedMs, remainingMs].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER)) return
        // 子 readiness 只描述 adapter 核對；Instance ready 仍由 service 的 deadline 與世代保護決定。
        write({ event, instanceId, scope, ...(verificationAttempt === undefined ? {} : { verificationAttempt }), attempt, stage, result,
          ...(httpStatus === undefined ? {} : { httpStatus }), elapsedMs, stageElapsedMs, remainingMs })
      } catch { /* 只投影 allowlist；getter、sink 或 IO 失敗均不可改變 readiness */ }
    },
  }
}

function safeError(value: unknown): { name: string | null; code: string | null; frames: string[] } {
  const empty = { name: null, code: null, frames: [] }
  // 自訂 Error 欄位與 stack 均可能包含密碼；只抽取固定 error 類別與本套件程式行號。
  try {
    if (!(value instanceof Error)) return empty
    let name: string | null = null
    let code: string | null = null
    if (knownErrorNames.has(value.name)) name = value.name
    const candidate = (value as NodeJS.ErrnoException).code
    if (typeof candidate === "string" && knownErrorCodes.has(candidate)) code = candidate
    const stack = value.stack
    const frames: string[] = []
    if (typeof stack === "string" && stack.length <= 32_768) {
      for (const line of stack.split("\n", 31).slice(1)) {
        if (line.length > 512) continue
        const match = /(?:\(|\s)(file:\/\/\/[^\s()]+|[A-Za-z]:\\[^\s()]+):(\d{1,6}):(\d{1,6})\)?\s*$/.exec(line)
        if (!match) continue
        const location = match[1]!.startsWith("file:") ? fileURLToPath(match[1]!) : match[1]!
        const relative = path.relative(sourceDirectory, location)
        if (!sourceFiles.has(relative)) continue
        const lineNumber = Number(match[2])
        const columnNumber = Number(match[3])
        if (lineNumber < 1 || lineNumber > 100_000 || columnNumber < 1 || columnNumber > 10_000) continue
        frames.push(`${relative}:${lineNumber}:${columnNumber}`)
        if (frames.length === 5) break
      }
    }
    return { name, code, frames }
  } catch {
    // revoked Proxy 的 instanceof、getters、prepareStackTrace 均可能 throw。
    return empty
  }
}
