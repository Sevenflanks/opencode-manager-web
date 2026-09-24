import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import type { SessionMetadata, SessionTodo } from "@omw/contracts"
import type { InstanceRecord } from "../../repository.js"
import { ManagerError } from "../../errors.js"
import { runProcessHelper } from "../../process-control.js"
import type { LaunchResult, InspectResult, StopResult, RuntimeSessionStatus, RuntimePendingRequest, RuntimeSummary, RuntimeActivityEvidence, RuntimeActivityEvent, RuntimeActivityObserver, RuntimePort } from "../../runtime.js"

const HTTP_TIMEOUT_MS = 2_000

interface HelperIdentity {
  pid: number
  creationTimeUtc: string
  creationTimeTicks: string
  executable: string
}

interface TrackedLaunch {
  child: ChildProcess
  port: number
  identity?: HelperIdentity
}

export class OpenCodeRuntime implements RuntimePort {
  readonly agentFamily = "opencode"
  private readonly executable: string
  private readonly powershell: string
  private readonly helperPath: string
  private readonly publicOriginForPort: ((port: number) => string | null) | null
  private readonly environment: NodeJS.ProcessEnv
  private readonly sameRunChildren = new Map<string, TrackedLaunch>()

  constructor(options: {
    executable: string
    dataDirectory: string
    powershell?: string
    publicOriginForPort?: (port: number) => string | null
    environment?: NodeJS.ProcessEnv
  }) {
    if (!options.executable) throw new ManagerError("OPENCODE_EXECUTABLE_REQUIRED", "必須設定 OMW_OPENCODE_EXECUTABLE。", 500)
    if (!existsSync(options.executable)) throw new ManagerError("OPENCODE_EXECUTABLE_NOT_FOUND", "設定的 OpenCode executable 不存在。", 500)
    this.executable = realpathSync(options.executable)
    this.powershell = options.powershell ?? "pwsh.exe"
    this.helperPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../scripts/process-control.ps1")
    this.publicOriginForPort = options.publicOriginForPort ?? null
    this.environment = options.environment ?? process.env
  }

  async launch(directory: string, port: number, instanceId: string): Promise<LaunchResult> {
    const child = spawnBackground(this.executable, directory, port, this.environment)
    await waitForSpawn(child)
    if (!child.pid) throw new ManagerError("PROCESS_DID_NOT_START", "OpenCode 未回報 PID。", 502)
    const tracked: TrackedLaunch = { child, port }
    this.sameRunChildren.set(instanceId, tracked)
    child.unref()

    let identity: HelperIdentity
    try {
      if (!spawnHandleIsAlive(child)) {
        throw new ManagerError("PROCESS_EXITED_BEFORE_IDENTITY", `OpenCode root PID ${child.pid} 在 identity 建立前已退出。`, 502)
      }
      identity = await this.helper<HelperIdentity>([
        "-Action", "Describe",
        "-ProcessId", String(child.pid),
        "-ExpectedExecutable", this.executable,
      ])
      if (identity.pid !== child.pid || !sameWindowsPath(identity.executable, this.executable)) {
        throw new ManagerError("PROCESS_IDENTITY_MISMATCH", "Describe 回傳的 PID 或 executable 不屬於本次 launch。", 502)
      }
      if (!spawnHandleIsAlive(child)) {
        throw new ManagerError("PROCESS_EXITED_DURING_IDENTITY", `OpenCode root PID ${child.pid} 在 identity 建立期間退出。`, 502)
      }
      tracked.identity = identity
    } catch (error) {
      // 尚未建立 exact identity 時只碰原生 ChildProcess handle，不以 PID ancestry 推導 Stop authority。
      const cleanup = await this.cleanupLaunch(instanceId)
      if (!cleanup.stopped) {
        throw new ManagerError(
          "STARTUP_CLEANUP_FAILED",
          `${this.sanitized(error)}；Startup cleanup 失敗：${cleanup.reason ?? "unknown cleanup failure"}`,
          500,
        )
      }
      throw error
    }
    return {
      ...identity,
      endpoint: `http://127.0.0.1:${port}`,
      directory,
      instanceId,
    }
  }

  async adoptLocal(directory: string, port: number, instanceId: string, pid: number): Promise<LaunchResult> {
    const identity = await this.helper<HelperIdentity>([
      "-Action", "Describe",
      "-ProcessId", String(pid),
      "-ExpectedExecutable", this.executable,
    ])
    if (identity.pid !== pid || !sameWindowsPath(identity.executable, this.executable)) {
      throw new ManagerError("PROCESS_IDENTITY_MISMATCH", "Local TUI PID 或 executable 不屬於設定的 OpenCode executable。", 409)
    }
    return {
      ...identity,
      endpoint: `http://127.0.0.1:${port}`,
      directory,
      instanceId,
    }
  }

  async cleanupLaunch(instanceId: string): Promise<StopResult> {
    const tracked = this.sameRunChildren.get(instanceId)
    if (!tracked?.child.pid) return { stopped: false, reason: "same-run launch authority unavailable" }
    if (!tracked.identity) return await cleanupUnidentifiedRoot(tracked.child)
    try {
      const result = await this.helper<StopResult>([
        "-Action", "Stop",
        "-ProcessId", String(tracked.identity.pid),
        "-ExpectedCreationTicks", tracked.identity.creationTimeTicks,
        "-ExpectedExecutable", tracked.identity.executable,
        "-Port", String(tracked.port),
      ])
      if (result.stopped) this.sameRunChildren.delete(instanceId)
      return result
    } catch (error) {
      return { stopped: false, reason: this.sanitized(error) }
    }
  }

  async readiness(instance: LaunchResult | InstanceRecord): Promise<{ version: string; directory: string }> {
    const expectedDirectory = "directory" in instance ? instance.directory : instance.projectDirectory
    const endpoint = checkedEndpoint(instance.endpoint, "port" in instance ? instance.port : Number(new URL(instance.endpoint).port))
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      try {
        const health = await requestJson(endpoint, "/global/health") as { healthy?: unknown; version?: unknown }
        if (health.healthy !== true || typeof health.version !== "string" || !health.version) {
          throw new Error("health response 缺少 healthy/version")
        }
        const pathResult = await requestJson(endpoint, "/path") as { directory?: unknown }
        if (typeof pathResult.directory !== "string" || !sameWindowsPath(pathResult.directory, expectedDirectory)) {
          throw new Error("endpoint 回報的 Project directory 不符")
        }
        return { version: health.version, directory: pathResult.directory }
      } catch {
        await delay(200)
      }
    }
    throw new ManagerError("INSTANCE_START_TIMEOUT", "OpenCode 未在 15000 ms 內證明 ready。", 504)
  }

  async inspect(instance: InstanceRecord | LaunchResult): Promise<InspectResult> {
    const identity = requireIdentity(instance)
    if (!sameWindowsPath(identity.executable, this.executable)) {
      return { processState: "unknown", running: false, matched: false, portOwnerMatched: false, portOwnedByOther: true }
    }
    return await this.helper<InspectResult>([
      "-Action", "Inspect",
      "-ProcessId", String(identity.pid),
      "-ExpectedCreationTicks", identity.creationTimeTicks,
      "-ExpectedExecutable", identity.executable,
      "-Port", String("port" in instance ? instance.port : Number(new URL(instance.endpoint).port)),
    ])
  }

  async stop(instance: InstanceRecord): Promise<StopResult> {
    const identity = requireIdentity(instance)
    if (!sameWindowsPath(identity.executable, this.executable)) {
      return { stopped: false, reason: "recorded executable does not match the configured OpenCode executable" }
    }
    const result = await this.helper<StopResult>([
      "-Action", "Stop",
      "-ProcessId", String(identity.pid),
      "-ExpectedCreationTicks", identity.creationTimeTicks,
      "-ExpectedExecutable", identity.executable,
      "-Port", String(instance.port),
    ])
    if (result.stopped) this.sameRunChildren.delete(instance.id)
    return result
  }

  async sessions(instance: InstanceRecord): Promise<SessionMetadata[]> {
    const value = await requestJson(checkedEndpoint(instance.endpoint, instance.port), routed("/session", instance.projectDirectory))
    return parseSessions(value, instance.projectDirectory)
  }

  async children(instance: InstanceRecord, sessionId: string): Promise<SessionMetadata[]> {
    const value = await requestJson(
      checkedEndpoint(instance.endpoint, instance.port),
      routed(`/session/${encodeURIComponent(sessionId)}/children`, instance.projectDirectory),
    )
    return parseSessions(value, instance.projectDirectory).filter((session) => session.parentID === sessionId)
  }

  async todos(instance: InstanceRecord, sessionId: string): Promise<SessionTodo[]> {
    const value = await requestJson(
      checkedEndpoint(instance.endpoint, instance.port),
      routed(`/session/${encodeURIComponent(sessionId)}/todo`, instance.projectDirectory),
    )
    if (!Array.isArray(value)) throw new Error("OpenCode todo response 不是 array")
    return value.map((entry, index) => {
      if (!isObject(entry) || typeof entry.content !== "string" || !entry.content.trim()
        || !["pending", "in_progress", "completed", "cancelled"].includes(entry.status as string)
        || !["high", "medium", "low"].includes(entry.priority as string)) {
        // 無效資料不能呈現成空清單；未知狀態也不能誤計入完成數。
        throw new Error(`OpenCode todo entry ${index + 1} 無效`)
      }
      return { content: entry.content, status: entry.status, priority: entry.priority } as SessionTodo
    })
  }

  async activity(instance: InstanceRecord): Promise<RuntimeActivityEvidence> {
    const value = await requestJson(
      checkedEndpoint(instance.endpoint, instance.port),
      routed("/session/status", instance.projectDirectory),
    )
    if (!isObject(value)) throw new Error("OpenCode status response 不是 object")
    const status = parseStatusMap(value)
    if (status.invalidSessionIds.length > 0) throw new Error("OpenCode status response 含無效 entry")
    return { busySessionIds: status.busySessionIds }
  }

  observeActivity(
    instance: InstanceRecord,
    onEvent: (event: RuntimeActivityEvent) => Promise<void> | void,
  ): RuntimeActivityObserver {
    const controller = new AbortController()
    const done = this.consumeActivityEvents(instance, onEvent, controller).catch((error: unknown) => {
      if (!controller.signal.aborted) throw error
    })
    return { close: () => controller.abort(), done }
  }

  async createSession(instance: InstanceRecord): Promise<SessionMetadata> {
    const value = await requestJson(
      checkedEndpoint(instance.endpoint, instance.port),
      routed("/session", instance.projectDirectory),
      { method: "POST", body: {} },
    )
    const session = parseSessions([value], instance.projectDirectory)[0]
    if (!session) throw new Error("OpenCode create Session response 無效")
    return session
  }

  async summary(instance: InstanceRecord): Promise<RuntimeSummary> {
    const endpoint = checkedEndpoint(instance.endpoint, instance.port)
    const [sessionsResult, statusesResult, questionsResult, permissionsResult] = await Promise.allSettled([
      this.sessions(instance),
      requestJson(endpoint, routed("/session/status", instance.projectDirectory)),
      requestJson(endpoint, routed("/question", instance.projectDirectory)),
      requestJson(endpoint, routed("/permission", instance.projectDirectory)),
    ])
    const errors: string[] = []
    const sessions = sessionsResult.status === "fulfilled" ? sessionsResult.value : []
    const sessionsKnown = sessionsResult.status === "fulfilled"
    if (sessionsResult.status === "rejected") errors.push("session: REQUEST_FAILED")

    let activity: RuntimeSummary["activity"] = "unknown"
    let busySessions: number | null = null
    let retrySessions: number | null = null
    let sessionStatuses: RuntimeSessionStatus[] | null = null
    let invalidStatusSessionIds: string[] | null = null
    if (statusesResult.status === "rejected") {
      errors.push("status: REQUEST_FAILED")
    } else if (!isObject(statusesResult.value)) {
      errors.push("status: OpenCode status response 不是 object")
    } else {
      try {
        const status = parseStatusMap(statusesResult.value)
        sessionStatuses = status.sessionStatuses
        invalidStatusSessionIds = status.invalidSessionIds
        if (status.invalidSessionIds.length > 0) {
          errors.push("status: RESPONSE_INVALID")
        } else {
          busySessions = status.busySessions
          retrySessions = status.retrySessions
          activity = status.activity
        }
      } catch (error) {
        errors.push("status: RESPONSE_INVALID")
      }
    }

    let pendingQuestions: number | null = null
    let questionRequests: RuntimePendingRequest[] | null = null
    let invalidQuestionSessionIds: string[] | null = null
    try {
      if (questionsResult.status === "rejected") throw questionsResult.reason
      const parsed = parsePendingRequests(questionsResult.value)
      questionRequests = parsed.requests
      invalidQuestionSessionIds = parsed.invalidSessionIds
      if (parsed.invalidSessionIds.length > 0) throw new Error("OpenCode question response 含無效 entry")
      pendingQuestions = uniqueRequestCount(parsed.requests)
    } catch (error) {
      errors.push(questionsResult.status === "rejected" ? "question: REQUEST_FAILED" : "question: RESPONSE_INVALID")
    }

    let pendingPermissions: number | null = null
    let permissionRequests: RuntimePendingRequest[] | null = null
    let invalidPermissionSessionIds: string[] | null = null
    try {
      if (permissionsResult.status === "rejected") throw permissionsResult.reason
      const parsed = parsePendingRequests(permissionsResult.value)
      permissionRequests = parsed.requests
      invalidPermissionSessionIds = parsed.invalidSessionIds
      if (parsed.invalidSessionIds.length > 0) throw new Error("OpenCode permission response 含無效 entry")
      pendingPermissions = uniqueRequestCount(parsed.requests)
    } catch (error) {
      errors.push(permissionsResult.status === "rejected" ? "permission: REQUEST_FAILED" : "permission: RESPONSE_INVALID")
    }

    return {
      activity,
      busySessions,
      retrySessions,
      pendingQuestions,
      pendingPermissions,
      error: errors.length ? errors.join("；") : null,
      sessions,
      sessionsKnown,
      sessionStatuses,
      invalidStatusSessionIds,
      questionRequests,
      invalidQuestionSessionIds,
      permissionRequests,
      invalidPermissionSessionIds,
    }
  }

  openUrl(instance: Pick<InstanceRecord, "endpoint" | "projectDirectory" | "port">, sessionId?: string): string {
    const publicOrigin = this.publicOriginForPort?.(instance.port)
    const endpoint = publicOrigin
      ? checkedPublicOrigin(publicOrigin, instance.port)
      : checkedEndpoint(instance.endpoint, instance.port)
    const directory = Buffer.from(instance.projectDirectory, "utf8").toString("base64url")
    const pathname = sessionId
      ? `/${directory}/session/${encodeURIComponent(sessionId)}`
      : `/${directory}/session`
    return new URL(pathname, endpoint).toString()
  }

  remoteUrlUnavailableReason(instance: Pick<InstanceRecord, "port">): string | null {
    if (!this.publicOriginForPort) return null
    try {
      const publicOrigin = this.publicOriginForPort(instance.port)
      if (publicOrigin !== null) checkedPublicOrigin(publicOrigin, instance.port)
      return null
    } catch (error) {
      return this.sanitized(error)
    }
  }

  private async consumeActivityEvents(
    instance: InstanceRecord,
    onEvent: (event: RuntimeActivityEvent) => Promise<void> | void,
    controller: AbortController,
  ): Promise<void> {
    const endpoint = checkedEndpoint(instance.endpoint, instance.port)
    const connectionTimer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(`${endpoint}${routed("/event", instance.projectDirectory)}`, {
        headers: { accept: "text/event-stream" },
        redirect: "error",
        signal: controller.signal,
      })
    } finally {
      clearTimeout(connectionTimer)
    }
    if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") || !response.body) {
      throw new Error(`OpenCode event stream 回傳 HTTP ${response.status}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (!controller.signal.aborted) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        if (buffer.length > 64 * 1024) throw new Error("OpenCode event stream frame 過大")
        let boundary = sseBoundary(buffer)
        while (boundary) {
          const frame = buffer.slice(0, boundary.index)
          buffer = buffer.slice(boundary.index + boundary.length)
          await this.consumeActivityFrame(instance, frame, onEvent)
          boundary = sseBoundary(buffer)
        }
      }
    } finally {
      reader.releaseLock()
    }
    if (!controller.signal.aborted) throw new Error("OpenCode event stream unexpected EOF")
  }

  private async consumeActivityFrame(
    instance: InstanceRecord,
    frame: string,
    onEvent: (event: RuntimeActivityEvent) => Promise<void> | void,
  ): Promise<void> {
    const data = frame.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (!data) return
    const event = JSON.parse(data) as unknown
    if (!isObject(event) || typeof event.type !== "string" || !isObject(event.properties)) return
    if (event.type === "server.connected") {
      const snapshot = await this.activity(instance)
      await onEvent({ type: "activity", source: "snapshot", sessionIds: snapshot.busySessionIds })
      return
    }
    if (event.type === "session.status") {
      const sessionId = event.properties.sessionID
      const status = event.properties.status
      if (typeof sessionId !== "string" || !sessionId || !isObject(status) || typeof status.type !== "string") {
        throw new Error("OpenCode session.status event 無效")
      }
      parseStatusMap({ [sessionId]: status })
      if (status.type === "busy") await onEvent({ type: "activity", source: "event", sessionIds: [sessionId] })
      return
    }
    if (event.type === "session.created") {
      const info = event.properties.info
      if (!isObject(info) || typeof info.id !== "string" || !info.id || typeof info.directory !== "string"
        || !sameWindowsPath(info.directory, instance.projectDirectory)) {
        throw new Error("OpenCode session.created event directory/metadata 無效")
      }
      await onEvent({ type: "session-created", sessionId: info.id })
    }
  }

  private async helper<T>(arguments_: string[]): Promise<T> {
    return await runProcessHelper<T>(this.powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-File", this.helperPath,
      ...arguments_,
    ])
  }

  private sanitized(error: unknown): string {
    return safeMessage(error)
  }
}

function spawnBackground(
  executable: string,
  directory: string,
  port: number,
  environment: NodeJS.ProcessEnv,
): ChildProcess {
  return spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--pure", "--log-level", "INFO"], {
    cwd: directory,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: managedServerEnvironment(environment),
  })
}

export function managedServerEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment }
  delete childEnvironment.OPENCODE_SERVER_USERNAME
  delete childEnvironment.OPENCODE_SERVER_PASSWORD
  return childEnvironment
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve)
    child.once("error", reject)
  })
}

function spawnHandleIsAlive(child: ChildProcess): boolean {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return false
  try {
    // Signal 0 is evaluated through Node's original process handle and does not signal the process.
    return child.kill(0)
  } catch {
    return false
  }
}

async function cleanupUnidentifiedRoot(child: ChildProcess): Promise<StopResult> {
  const pid = child.pid ?? "unknown"
  if (spawnHandleIsAlive(child)) {
    try {
      if (!child.kill()) {
        return { stopped: false, reason: `cleanup unresolved: original root PID ${pid} rejected native-handle termination; descendants were not inspected` }
      }
      if (!await waitForChildExit(child, 5_000)) {
        return { stopped: false, reason: `cleanup unresolved: original root PID ${pid} did not exit within 5000 ms; descendants were not inspected` }
      }
    } catch (error) {
      return { stopped: false, reason: `cleanup unresolved: original root PID ${pid} native-handle termination failed: ${safeMessage(error)}; descendants were not inspected` }
    }
    return { stopped: false, reason: `cleanup unresolved: original root PID ${pid} was stopped through its native handle, but descendant identity is unavailable` }
  }
  return { stopped: false, reason: `cleanup unresolved: original root PID ${pid} already exited before exact identity was established; descendants were not inspected` }
}

function waitForChildExit(child: ChildProcess, timeout: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), timeout)
    const onExit = () => finish(true)
    const onError = () => finish(false)
    const finish = (result: boolean) => {
      clearTimeout(timer)
      child.off("exit", onExit)
      child.off("error", onError)
      resolve(result)
    }
    child.once("exit", onExit)
    child.once("error", onError)
  })
}

function requireIdentity(instance: InstanceRecord | LaunchResult): HelperIdentity {
  if (instance.pid == null || instance.creationTimeTicks == null || instance.executable == null) {
    throw new ManagerError("PROCESS_IDENTITY_INCOMPLETE", "Instance 缺少可安全核對的 process identity。", 409)
  }
  return {
    pid: instance.pid,
    creationTimeUtc: instance.creationTimeUtc ?? "",
    creationTimeTicks: instance.creationTimeTicks,
    executable: instance.executable,
  }
}

function checkedEndpoint(value: string, expectedPort: number): string {
  const url = new URL(value)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || Number(url.port) !== expectedPort || url.username || url.password) {
    throw new ManagerError("UNTRUSTED_INSTANCE_ENDPOINT", "Instance endpoint 不是受控 loopback URL。", 409)
  }
  return url.origin
}

async function requestJson(
  endpoint: string,
  pathname: string,
  options: { method?: "POST"; body?: unknown } = {},
): Promise<unknown> {
  const response = await fetch(`${endpoint}${pathname}`, {
    headers: { accept: "application/json", ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
    ...(options.method ? { method: options.method } : {}),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    redirect: "error",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error(`OpenCode ${pathname} 回傳 HTTP ${response.status}`)
  }
  return await response.json()
}

function checkedPublicOrigin(value: string, expectedPort: number): string {
  const url = new URL(value)
  const actualPort = url.port ? Number(url.port) : 443
  if (url.protocol !== "https:" || actualPort !== expectedPort || url.username || url.password || url.pathname !== "/") {
    throw new ManagerError("REMOTE_MAPPING_INVALID", "Remote OpenCode URL 不是預先核對的 same-port HTTPS origin。", 409)
  }
  return url.origin
}

function routed(pathname: string, directory: string): string {
  const separator = pathname.includes("?") ? "&" : "?"
  return `${pathname}${separator}directory=${encodeURIComponent(directory)}`
}

function parseSessions(value: unknown, expectedDirectory?: string): SessionMetadata[] {
  if (!Array.isArray(value)) throw new Error("OpenCode Session response 不是 array")
  const ids = new Set<string>()
  return value.map((item, index) => {
    if (!isObject(item) || typeof item.id !== "string" || item.id.trim().length === 0) {
      throw new Error(`OpenCode Session entry ${index + 1} 缺少合法 id`)
    }
    if (ids.has(item.id)) throw new Error(`OpenCode Session metadata 重複 id ${item.id}`)
    ids.add(item.id)
    if (expectedDirectory
      && (typeof item.directory !== "string" || !sameWindowsPath(item.directory, expectedDirectory))) {
      throw new Error("OpenCode Session metadata directory 與 Instance 不符")
    }
    const session: SessionMetadata = { id: item.id, title: typeof item.title === "string" ? item.title : item.id }
    if (item.parentID !== undefined) {
      if (typeof item.parentID !== "string" || item.parentID.trim().length === 0) {
        throw new Error(`OpenCode Session ${item.id} parentID 無效`)
      }
      session.parentID = item.parentID
    }
    if (typeof item.time === "object" && item.time && "updated" in item.time && typeof item.time.updated === "number") {
      session.updatedAt = item.time.updated
    }
    return session
  })
}

function parsePendingRequests(value: unknown): { requests: RuntimePendingRequest[]; invalidSessionIds: string[] } {
  if (!Array.isArray(value)) throw new Error("OpenCode pending response 不是 array")
  const requests: RuntimePendingRequest[] = []
  const invalidSessionIds: string[] = []
  for (const [index, item] of value.entries()) {
    if (!isObject(item) || typeof item.sessionID !== "string" || item.sessionID.trim().length === 0) {
      throw new Error(`OpenCode pending entry ${index + 1} 缺少可歸屬的 sessionID`)
    }
    if (typeof item.id !== "string" || item.id.trim().length === 0) {
      invalidSessionIds.push(item.sessionID)
      continue
    }
    requests.push({ id: item.id, sessionId: item.sessionID })
  }
  return { requests, invalidSessionIds }
}

function uniqueRequestCount(requests: RuntimePendingRequest[]): number {
  return new Set(requests.map((request) => request.id)).size
}

function parseStatusMap(value: Record<string, unknown>): {
  activity: RuntimeSummary["activity"]
  busySessions: number
  retrySessions: number
  busySessionIds: string[]
  sessionStatuses: RuntimeSessionStatus[]
  invalidSessionIds: string[]
} {
  const busySessionIds: string[] = []
  const sessionStatuses: RuntimeSessionStatus[] = []
  const invalidSessionIds: string[] = []
  for (const [sessionId, status] of Object.entries(value)) {
    if (!sessionId) throw new Error("Session status 缺少合法 session ID")
    if (!isObject(status) || typeof status.type !== "string") {
      invalidSessionIds.push(sessionId)
      continue
    }
    if (status.type === "busy" || status.type === "idle") {
      if (!hasOnlyKeys(status, ["type"])) {
        invalidSessionIds.push(sessionId)
        continue
      }
      if (status.type === "busy") busySessionIds.push(sessionId)
      sessionStatuses.push({ sessionId, type: status.type })
      continue
    }
    if (status.type === "retry") {
      if (!hasOnlyKeys(status, ["type", "attempt", "message", "action", "next"])
        || !isNonNegativeInteger(status.attempt)
        || typeof status.message !== "string"
        || !isNonNegativeInteger(status.next)
        || (status.action !== undefined && !isRetryAction(status.action))) {
        invalidSessionIds.push(sessionId)
        continue
      }
      sessionStatuses.push({ sessionId, type: "retry" })
      continue
    }
    invalidSessionIds.push(sessionId)
  }
  return {
    busySessions: busySessionIds.length,
    retrySessions: sessionStatuses.filter((status) => status.type === "retry").length,
    busySessionIds,
    sessionStatuses,
    invalidSessionIds,
    activity: invalidSessionIds.length > 0
      ? "unknown"
      : busySessionIds.length > 0 ? "busy" : Object.keys(value).length > 0 ? "reported-non-busy" : "none-reported",
  }
}

function sseBoundary(value: string): { index: number; length: number } | null {
  const match = /\r?\n\r?\n/.exec(value)
  return match ? { index: match.index, length: match[0].length } : null
}

function isRetryAction(value: unknown): boolean {
  if (!isObject(value) || !hasOnlyKeys(value, ["reason", "provider", "title", "message", "label", "link"])) return false
  return ["reason", "provider", "title", "message", "label"].every((key) => typeof value[key] === "string")
    && (value.link === undefined || typeof value.link === "string")
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

function sameWindowsPath(left: string, right: string): boolean {
  return path.resolve(left).replace(/[\\/]+$/, "").toLowerCase() === path.resolve(right).replace(/[\\/]+$/, "").toLowerCase()
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function safeMessage(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error))
}

function redact(value: string): string {
  return value
    .replace(/\bAuthorization\s*:\s*(?:Basic|Bearer)\s+[^\s,;]+/gi, "Authorization: [REDACTED]")
    .replace(/\b[A-Z][A-Z0-9_]*(?:PASSWORD|TOKEN|SECRET|CREDENTIAL|API_KEY)[A-Z0-9_]*\s*=\s*[^\s,;]+/gi, "[REDACTED_ENV]")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|token|secret)[-_][A-Za-z0-9._-]{8,}\b/gi, "[REDACTED]")
    .slice(0, 4_096)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
