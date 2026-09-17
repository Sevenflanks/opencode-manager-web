import { randomUUID } from "node:crypto"
import { readdir, realpath, stat } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import type {
  DirectoryListing,
  DirectoryShortcut,
  InstanceKind,
  LauncherRegistrationRequest,
  LauncherRegistrationResponse,
  LauncherReservationRequest,
  LauncherReservationResponse,
  ManagedInstance,
  OpenUrlResponse,
  OverviewFilter,
  OverviewResponse,
  SessionChildrenResponse,
  SessionRootsResponse,
} from "@omw/contracts"
import type { InstancePortPoolConfig } from "./config.js"
import { ManagerError } from "./errors.js"
import type { InstanceRecord, PortAllocation } from "./repository.js"
import { ManagerRepository } from "./repository.js"
import type { InspectResult, RuntimePort, RuntimeSummary } from "./runtime.js"

const EMPTY_SUMMARY = {
  activity: "unknown" as const,
  busySessions: null,
  pendingQuestions: null,
  pendingPermissions: null,
  error: null,
}
const RESERVATION_TTL_MS = 10_000
const INCOMPLETE_IDENTITY_GRACE_MS = 15_000

export class ManagerService {
  constructor(
    private readonly repository: ManagerRepository,
    private readonly runtime: RuntimePort,
    private readonly portPool: InstancePortPoolConfig = { min: 42_000, max: 42_099 },
  ) {}

  async overview(query = "", filter: OverviewFilter = "all"): Promise<OverviewResponse> {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-TW")
    const instances = await Promise.all(this.repository.listInstances().map(async (record) => this.present(record)))
    return {
      shortcuts: this.repository.listShortcuts(),
      instances: instances.filter((instance) => matchesFilter(instance, filter) && matchesQuery(instance, normalizedQuery)),
    }
  }

  async browse(directory: string): Promise<DirectoryListing> {
    const current = await canonicalDirectory(directory)
    const parentCandidate = path.dirname(current)
    const parent = samePath(parentCandidate, current) ? null : parentCandidate
    const children = []
    const errors: Array<{ path: string; message: string }> = []
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const candidate = path.join(current, entry.name)
      try {
        const canonical = await canonicalDirectory(candidate)
        children.push({ name: entry.name, path: canonical })
      } catch (error) {
        errors.push({ path: candidate, message: safeMessage(error) })
      }
    }
    children.sort((left, right) => left.name.localeCompare(right.name, "zh-TW"))
    return { current, parent, children, errors }
  }

  async createShortcut(input: { name: string; directory: string }): Promise<DirectoryShortcut> {
    const now = new Date().toISOString()
    return this.repository.createShortcut({
      id: randomUUID(),
      name: validName(input.name),
      directory: await canonicalDirectory(input.directory),
      createdAt: now,
      updatedAt: now,
    })
  }

  async updateShortcut(id: string, input: { name: string; directory: string }): Promise<DirectoryShortcut> {
    const existing = this.repository.getShortcut(id)
    if (!existing) throw new ManagerError("SHORTCUT_NOT_FOUND", "找不到 Directory Shortcut。", 404)
    const updated = this.repository.updateShortcut({
      ...existing,
      name: validName(input.name),
      directory: await canonicalDirectory(input.directory),
      updatedAt: new Date().toISOString(),
    })
    if (!updated) throw new ManagerError("SHORTCUT_NOT_FOUND", "找不到 Directory Shortcut。", 404)
    return updated
  }

  deleteShortcut(id: string): void {
    if (!this.repository.deleteShortcut(id)) throw new ManagerError("SHORTCUT_NOT_FOUND", "找不到 Directory Shortcut。", 404)
  }

  async start(directoryInput: string): Promise<ManagedInstance> {
    const directory = await canonicalDirectory(directoryInput)
    const allocation = await this.reservePort("headless", directory, null)
    const record = newInstanceRecord(allocation, directory, null)
    this.repository.createReservedInstance(allocation.id, record)

    try {
      const launch = await this.runtime.launch(directory, allocation.port, allocation.id)
      // Persist exact identity before any readiness work so a startup failure remains safely stoppable.
      Object.assign(record, {
        pid: launch.pid,
        creationTimeUtc: launch.creationTimeUtc,
        creationTimeTicks: launch.creationTimeTicks,
        executable: launch.executable,
        endpoint: launch.endpoint,
      })
      this.repository.saveInstance(record)
      const identity = await this.runtime.inspect(record)
      if (!identity.running || !identity.matched || !identity.portOwnerMatched) {
        throw new ManagerError("INSTANCE_IDENTITY_UNVERIFIED", "OpenCode process identity 或 port owner 無法核對。", 409)
      }
      const health = await this.runtime.readiness(launch)
      record.state = "ready"
      record.healthVersion = health.version
      this.repository.saveInstance(record)
      return await this.present(record)
    } catch (error) {
      const failure = safeRuntimeCode(error, "INSTANCE_START_FAILED")
      let cleanupError: string | null = null
      if (record.pid != null) {
        try {
          const cleanup = await this.runtime.cleanupLaunch(record.id)
          if (!cleanup.stopped) cleanupError = "STARTUP_CLEANUP_UNRESOLVED"
        } catch (cleanupFailure) {
          cleanupError = safeRuntimeCode(cleanupFailure, "STARTUP_CLEANUP_FAILED").code
        }
      }
      record.state = "failed"
      record.error = [
        failure.code,
        cleanupError,
      ].filter(Boolean).join("；")
      record.stderrSummary = null
      this.repository.saveInstance(record)
      if (cleanupError === null && await loopbackPortAvailable(record.port)) {
        this.repository.releaseAllocationForInstance(record.id)
      }
      throw new ManagerError(failure.code, "OpenCode Instance 啟動失敗。", failure.statusCode)
    }
  }

  async reserveLocal(input: LauncherReservationRequest): Promise<LauncherReservationResponse> {
    const directory = await canonicalDirectory(input.directory)
    await this.cleanupExpiredReservations()
    const existing = this.repository.getAllocationByInvocation(input.clientInvocationId)
    if (existing) {
      if (!samePath(existing.projectDirectory, directory) || (input.requestedPort !== undefined && existing.port !== input.requestedPort)) {
        throw new ManagerError("INVOCATION_CONFLICT", "clientInvocationId 已用於不同 directory 或 port。", 409)
      }
      return reservationResponse(existing)
    }
    const allocation = await this.reservePort("local-tui", directory, input.clientInvocationId, input.requestedPort)
    return reservationResponse(allocation)
  }

  async registerLocal(reservationId: string, input: LauncherRegistrationRequest): Promise<LauncherRegistrationResponse> {
    const existing = this.repository.getInstanceByInvocation(input.clientInvocationId)
    if (existing) {
      if (existing.id !== reservationId || existing.pid !== input.pid) {
        throw new ManagerError("INVOCATION_CONFLICT", "Local TUI invocation 已登錄為不同 PID。", 409)
      }
      return { instanceId: existing.id, state: localRegistrationState(existing) }
    }
    const allocation = this.requireLocalAllocation(reservationId, input.clientInvocationId)
    if (!this.runtime.adoptLocal) throw new ManagerError("LOCAL_REGISTRATION_UNAVAILABLE", "Runtime 不支援 Local TUI identity registration。", 501)
    const launch = await this.runtime.adoptLocal(allocation.projectDirectory, allocation.port, allocation.id, input.pid)
    const createdAt = Date.parse(launch.creationTimeUtc)
    if (!Number.isFinite(createdAt) || createdAt < Date.parse(allocation.createdAt)) {
      throw new ManagerError("LOCAL_PROCESS_NOT_FRESH", "Local TUI process 必須在 reservation 建立後啟動。", 409)
    }
    const record = newInstanceRecord(allocation, allocation.projectDirectory, input.clientInvocationId)
    Object.assign(record, {
      pid: launch.pid,
      creationTimeUtc: launch.creationTimeUtc,
      creationTimeTicks: launch.creationTimeTicks,
      executable: launch.executable,
      endpoint: launch.endpoint,
    })
    try {
      this.repository.createReservedInstance(allocation.id, record)
    } catch (error) {
      const raced = this.repository.getInstanceByInvocation(input.clientInvocationId)
      if (!raced || raced.id !== reservationId || raced.pid !== input.pid) throw error
      return { instanceId: raced.id, state: localRegistrationState(raced) }
    }
    // Local TUI owns the console. Readiness proof runs independently and never grants OMW Stop authority.
    void this.verifyLocalRegistration(record.id)
    return { instanceId: record.id, state: "starting" }
  }

  async finalizeLocal(reservationId: string, input: LauncherRegistrationRequest): Promise<LauncherRegistrationResponse> {
    const allocation = this.repository.getAllocation(reservationId)
    if (!allocation) return { instanceId: reservationId, state: "stopped" }
    if (allocation.kind !== "local-tui" || allocation.clientInvocationId !== input.clientInvocationId) {
      throw new ManagerError("RESERVATION_NOT_FOUND", "找不到符合 invocation 的 Local TUI reservation。", 404)
    }
    const record = this.repository.getInstance(reservationId)
    if (!record) {
      if (await loopbackPortAvailable(allocation.port)) this.repository.releaseReservation(allocation.id)
      return { instanceId: reservationId, state: "stopped" }
    }
    if (record.pid !== input.pid) throw new ManagerError("PROCESS_IDENTITY_MISMATCH", "Finalize PID 與已登錄 Local TUI 不符。", 409)
    if (await loopbackPortAvailable(record.port)) {
      record.state = "stopped"
      record.stoppedAt = new Date().toISOString()
      record.error = null
      this.repository.saveInstance(record)
      this.repository.releaseAllocationForInstance(record.id)
      return { instanceId: record.id, state: "stopped" }
    }
    record.state = "unreachable"
    record.error = "Launcher 已回報結束，但 loopback port 仍由 process 使用；保留 allocation 等待 reconcile。"
    this.repository.saveInstance(record)
    return { instanceId: record.id, state: "starting" }
  }

  async stop(id: string): Promise<ManagedInstance> {
    const record = this.requireInstance(id)
    if (record.state === "stopped") return await this.present(record)
    if ((record.kind ?? "headless") !== "headless") {
      throw new ManagerError("LOCAL_TUI_OBSERVE_ONLY", "Local TUI Instance 僅可觀察與開啟，不提供 Stop authority。", 409)
    }
    const result = await this.runtime.stop(record)
    if (!result.stopped) {
      throw new ManagerError("PROCESS_IDENTITY_MISMATCH", "拒絕停止：process identity 無法安全核對。", 409)
    }
    record.state = "stopped"
    record.stoppedAt = new Date().toISOString()
    record.error = null
    this.repository.saveInstance(record)
    if (await loopbackPortAvailable(record.port)) this.repository.releaseAllocationForInstance(record.id)
    return await this.present(record)
  }

  async sessionRoots(id: string): Promise<SessionRootsResponse> {
    const record = this.requireInstance(id)
    await this.requireFreshEndpointIdentity(record)
    const sessions = dedupeSessions(await this.runtime.sessions(record))
    const ids = new Set(sessions.map((session) => session.id))
    return {
      roots: sessions.filter((session) => !session.parentID),
      unknownParent: sessions.filter((session) => session.parentID && !ids.has(session.parentID)),
    }
  }

  async sessionChildren(id: string, sessionId: string): Promise<SessionChildrenResponse> {
    const record = this.requireInstance(id)
    await this.requireFreshEndpointIdentity(record)
    const children = dedupeSessions(await this.runtime.children(record, sessionId))
      .filter((session) => session.parentID === sessionId)
    return { parentID: sessionId, children, loadedDirectChildren: children.length }
  }

  async openUrl(id: string, sessionId?: string): Promise<OpenUrlResponse> {
    const record = this.requireInstance(id)
    await this.requireFreshEndpointIdentity(record)
    const unavailableReason = this.runtime.remoteUrlUnavailableReason?.(record) ?? null
    if (unavailableReason) throw new ManagerError("REMOTE_URL_UNAVAILABLE", unavailableReason, 409)
    if (sessionId) {
      const sessions = await this.runtime.sessions(record)
      if (!sessions.some((session) => session.id === sessionId)) {
        throw new ManagerError("SESSION_NOT_FOUND", "所選 Session 不存在於此 Project metadata。", 404)
      }
    }
    return { url: this.runtime.openUrl(record, sessionId), instanceId: id, sessionId: sessionId ?? null }
  }

  async reconcile(): Promise<void> {
    await this.cleanupExpiredReservations()
    for (const record of this.repository.listInstances().filter((instance) => instance.state !== "stopped")) {
      record.state = "unreachable"
      record.healthVersion = null
      record.error = "Manager 已重啟，正在重新核對 Instance。"
      this.repository.saveInstance(record)
      if (!hasExactIdentity(record)) {
        const launchAge = Date.now() - Date.parse(record.launchedAt)
        if (launchAge >= INCOMPLETE_IDENTITY_GRACE_MS && await loopbackPortAvailable(record.port)) {
          record.state = "stopped"
          record.stoppedAt = new Date().toISOString()
          record.error = "Instance 未留下 exact process identity，且 startup grace 後 endpoint 仍未監聽。"
          this.repository.saveInstance(record)
          this.repository.releaseAllocationForInstance(record.id)
        } else {
          // 沒有 creation time/executable 就不以 PID 猜 ownership；occupied port 也維持隔離。
          record.error = "Instance 未留下 exact process identity；保留 allocation，不授予 Stop authority。"
          this.repository.saveInstance(record)
        }
        continue
      }
      let identity
      try {
        identity = await this.runtime.inspect(record)
      } catch (error) {
        record.error = safeRuntimeCode(error, "INSTANCE_IDENTITY_CHECK_FAILED").code
        this.repository.saveInstance(record)
        continue
      }
      if (!identity.running || !identity.matched || identity.portOwnedByOther) {
        record.error = "INSTANCE_IDENTITY_UNVERIFIED"
        this.repository.saveInstance(record)
        continue
      }
      if (!identity.portOwnerMatched) {
        record.error = "Process identity 已核對，但 endpoint 未監聽；保留安全 Stop authority。"
        this.repository.saveInstance(record)
        continue
      }
      try {
        const health = await this.runtime.readiness(record)
        record.state = "ready"
        record.healthVersion = health.version
        record.error = null
      } catch (error) {
        // Identity still grants safe Stop authority even when health is unavailable.
        record.error = safeRuntimeCode(error, "INSTANCE_READINESS_FAILED").code
      }
      this.repository.saveInstance(record)
    }
  }

  private requireInstance(id: string): InstanceRecord {
    const record = this.repository.getInstance(id)
    if (!record) throw new ManagerError("INSTANCE_NOT_FOUND", "找不到 Instance。", 404)
    return record
  }

  private requireLocalAllocation(id: string, clientInvocationId: string): PortAllocation {
    const allocation = this.repository.getAllocation(id)
    if (!allocation || allocation.kind !== "local-tui" || allocation.clientInvocationId !== clientInvocationId) {
      throw new ManagerError("RESERVATION_NOT_FOUND", "找不到符合 invocation 的 Local TUI reservation。", 404)
    }
    return allocation
  }

  private async reservePort(
    kind: InstanceKind,
    directory: string,
    clientInvocationId: string | null,
    requestedPort?: number,
  ): Promise<PortAllocation> {
    await this.cleanupExpiredReservations()
    if (requestedPort !== undefined && (!Number.isInteger(requestedPort) || requestedPort < this.portPool.min || requestedPort > this.portPool.max)) {
      throw new ManagerError("PORT_OUTSIDE_FIXED_POOL", `Explicit port ${requestedPort} 不在 fixed pool ${this.portPool.min}-${this.portPool.max}。`, 409)
    }
    const candidates = requestedPort === undefined
      ? Array.from({ length: this.portPool.max - this.portPool.min + 1 }, (_, index) => this.portPool.min + index)
      : [requestedPort]
    for (const port of candidates) {
      if (!await loopbackPortAvailable(port)) {
        if (requestedPort !== undefined) throw new ManagerError("PORT_UNAVAILABLE", `Explicit port ${port} 已被使用。`, 409)
        continue
      }
      const now = new Date()
      const allocation: PortAllocation = {
        id: randomUUID(),
        kind,
        clientInvocationId,
        projectDirectory: directory,
        port,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + RESERVATION_TTL_MS).toISOString(),
        instanceId: null,
      }
      if (this.repository.tryCreateAllocation(allocation)) return allocation
      if (clientInvocationId) {
        const existing = this.repository.getAllocationByInvocation(clientInvocationId)
        if (existing) {
          if (samePath(existing.projectDirectory, directory)
            && (requestedPort === undefined || existing.port === requestedPort)) return existing
          throw new ManagerError("INVOCATION_CONFLICT", "clientInvocationId 已用於不同 directory 或 port。", 409)
        }
      }
      if (requestedPort !== undefined) {
        throw new ManagerError("PORT_UNAVAILABLE", `Explicit port ${port} 已被保留。`, 409)
      }
    }
    throw new ManagerError("PORT_POOL_EXHAUSTED", `Fixed port pool ${this.portPool.min}-${this.portPool.max} 沒有可保留的 loopback port。`, 409)
  }

  private async cleanupExpiredReservations(): Promise<void> {
    for (const allocation of this.repository.listExpiredReservations(new Date().toISOString())) {
      if (await loopbackPortAvailable(allocation.port)) {
        this.repository.releaseReservation(allocation.id)
      } else {
        // Expiry is not proof of safety: an occupied endpoint stays quarantined instead of being reassigned.
        this.repository.extendReservation(allocation.id, new Date(Date.now() + RESERVATION_TTL_MS).toISOString())
      }
    }
  }

  private async verifyLocalRegistration(id: string): Promise<void> {
    const record = this.repository.getInstance(id)
    if (!record || record.kind !== "local-tui" || record.state === "stopped") return
    try {
      const identity = await this.runtime.inspect(record)
      if (!identity.running || !identity.matched || !identity.portOwnerMatched || identity.portOwnedByOther) {
        throw new ManagerError("INSTANCE_IDENTITY_UNVERIFIED", "Local TUI ready，但 process identity 或 port owner 無法核對。", 409)
      }
      const health = await this.runtime.readiness(record)
      const current = this.repository.getInstance(id)
      if (!current || current.state === "stopped") return
      current.state = "ready"
      current.healthVersion = health.version
      current.error = null
      this.repository.saveInstance(current)
    } catch (error) {
      const current = this.repository.getInstance(id)
      if (!current || current.state === "stopped") return
      current.state = "unreachable"
      current.error = safeRuntimeCode(error, "LOCAL_TUI_VERIFICATION_FAILED").code
      this.repository.saveInstance(current)
    }
  }

  private async present(record: InstanceRecord): Promise<ManagedInstance> {
    let summary: RuntimeSummary = { ...EMPTY_SUMMARY, sessions: [] }
    let stopAllowed = false
    let state = record.state
    if (record.state !== "stopped" && record.pid != null) {
      let identity: InspectResult | null = null
      try {
        identity = await this.runtime.inspect(record)
      } catch {
        state = "unreachable"
        summary = { ...EMPTY_SUMMARY, error: "INSTANCE_IDENTITY_CHECK_FAILED", sessions: [] }
      }
      if (identity) {
        stopAllowed = (record.kind ?? "headless") === "headless" && identity.running && identity.matched && !identity.portOwnedByOther
        if (!identity.running || !identity.matched || !identity.portOwnerMatched || identity.portOwnedByOther) {
          state = "unreachable"
          summary = { ...EMPTY_SUMMARY, error: "INSTANCE_IDENTITY_UNVERIFIED", sessions: [] }
        } else {
          try {
            const result = await this.runtime.summary(record)
            summary = {
              ...result,
              error: result.error === null ? null : "INSTANCE_SUMMARY_PARTIAL",
            }
          } catch {
            state = "unreachable"
            summary = { ...EMPTY_SUMMARY, error: "INSTANCE_SUMMARY_FAILED", sessions: [] }
          }
        }
      }
      if (record.state === "ready" && summary.activity === "unknown") state = "unreachable"
    }
    return {
      id: record.id,
      kind: record.kind ?? "headless",
      projectName: record.projectName,
      projectDirectory: record.projectDirectory,
      state,
      endpoint: record.endpoint,
      port: record.port,
      pid: record.pid,
      launchedAt: record.launchedAt,
      healthVersion: record.healthVersion,
      stopAllowed,
      remoteUrlUnavailableReason: this.runtime.remoteUrlUnavailableReason?.(record) ?? null,
      error: summary.error ?? safeStoredError(record.error),
      summary: {
        activity: summary.activity,
        busySessions: summary.busySessions,
        pendingQuestions: summary.pendingQuestions,
        pendingPermissions: summary.pendingPermissions,
        error: summary.error,
      },
      sessions: summary.sessions,
    }
  }

  private async requireFreshEndpointIdentity(record: InstanceRecord): Promise<InspectResult> {
    let identity: InspectResult
    try {
      identity = await this.runtime.inspect(record)
    } catch {
      throw new ManagerError("INSTANCE_IDENTITY_UNVERIFIED", "Instance process identity 無法核對。", 409)
    }
    if (!identity.running || !identity.matched || !identity.portOwnerMatched || identity.portOwnedByOther) {
      throw new ManagerError("INSTANCE_IDENTITY_UNVERIFIED", "Instance process identity 或 endpoint owner 無法核對。", 409)
    }
    return identity
  }
}

function newInstanceRecord(allocation: PortAllocation, directory: string, clientInvocationId: string | null): InstanceRecord {
  return {
    id: allocation.id,
    kind: allocation.kind,
    clientInvocationId,
    projectName: path.basename(directory) || directory,
    projectDirectory: directory,
    state: "starting",
    endpoint: `http://127.0.0.1:${allocation.port}`,
    port: allocation.port,
    pid: null,
    creationTimeUtc: null,
    creationTimeTicks: null,
    executable: null,
    launchedAt: new Date().toISOString(),
    healthVersion: null,
    stoppedAt: null,
    error: null,
    stderrSummary: null,
  }
}

function reservationResponse(allocation: PortAllocation): LauncherReservationResponse {
  return {
    reservationId: allocation.id,
    hostname: "127.0.0.1",
    port: allocation.port,
    expiresAt: allocation.expiresAt,
    status: allocation.instanceId === null ? "reserved" : "registered",
  }
}

function localRegistrationState(instance: InstanceRecord): LauncherRegistrationResponse["state"] {
  if (instance.state === "stopped") return "stopped"
  return instance.state === "ready" ? "ready" : "starting"
}

async function canonicalDirectory(input: string): Promise<string> {
  if (typeof input !== "string" || !input.trim()) throw new ManagerError("DIRECTORY_REQUIRED", "請提供目錄路徑。", 400)
  try {
    const canonical = await realpath(path.resolve(input.trim()))
    if (!(await stat(canonical)).isDirectory()) throw new Error("路徑不是目錄")
    await readdir(canonical)
    return path.normalize(canonical)
  } catch (error) {
    throw new ManagerError("DIRECTORY_NOT_ACCESSIBLE", `目錄不存在、不是目錄或無法存取：${safeMessage(error)}`, 400)
  }
}

function validName(input: string): string {
  const value = typeof input === "string" ? input.trim() : ""
  if (!value || value.length > 80) throw new ManagerError("SHORTCUT_NAME_INVALID", "Shortcut 名稱須為 1 到 80 個字元。", 400)
  return value
}

function dedupeSessions<T extends { id: string }>(sessions: T[]): T[] {
  return [...new Map(sessions.map((session) => [session.id, session])).values()]
}

function matchesFilter(instance: ManagedInstance, filter: OverviewFilter): boolean {
  if (filter === "active") return instance.state === "starting" || (instance.summary.busySessions ?? 0) > 0
  if (filter === "attention") return (instance.summary.pendingQuestions ?? 0) > 0 || (instance.summary.pendingPermissions ?? 0) > 0
  if (filter === "unreachable") return instance.state === "unreachable" || instance.state === "failed" || instance.summary.activity === "unknown"
  return true
}

function matchesQuery(instance: ManagedInstance, query: string): boolean {
  if (!query) return true
  return [
    instance.projectName,
    instance.projectDirectory,
    instance.id,
    ...instance.sessions.flatMap((session) => [session.title, session.id]),
  ].some((value) => value.toLocaleLowerCase("zh-TW").includes(query))
}

function loopbackPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") return resolve(false)
      reject(error)
    })
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => error ? reject(error) : resolve(true))
    })
  })
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

function hasExactIdentity(record: InstanceRecord): boolean {
  return record.pid !== null
    && record.creationTimeUtc !== null
    && record.creationTimeTicks !== null
    && record.executable !== null
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeRuntimeCode(error: unknown, fallback: string): { code: string; statusCode: number } {
  return error instanceof ManagerError
    ? { code: error.code, statusCode: error.statusCode }
    : { code: fallback, statusCode: 500 }
}

function safeStoredError(value: string | null): string | null {
  if (value === null) return null
  const codes = value.split("；")
  // 既有 DB 內容是不受信任的資料；不可只因長得像 error code 就直接送到 HTTP。
  return codes.length <= 2 && codes.every((code) => SAFE_STORED_ERROR_CODES.has(code))
    ? value
    : "INSTANCE_DIAGNOSTIC_REDACTED"
}

const SAFE_STORED_ERROR_CODES = new Set([
  "INSTANCE_IDENTITY_CHECK_FAILED",
  "INSTANCE_IDENTITY_UNVERIFIED",
  "INSTANCE_READINESS_FAILED",
  "INSTANCE_START_FAILED",
  "INSTANCE_START_TIMEOUT",
  "LOCAL_TUI_VERIFICATION_FAILED",
  "PROCESS_CONTROL_FAILED",
  "PROCESS_CONTROL_INVALID_RESPONSE",
  "PROCESS_DID_NOT_START",
  "PROCESS_EXITED_BEFORE_IDENTITY",
  "PROCESS_EXITED_DURING_IDENTITY",
  "PROCESS_IDENTITY_INCOMPLETE",
  "PROCESS_IDENTITY_MISMATCH",
  "STARTUP_CLEANUP_FAILED",
  "STARTUP_CLEANUP_UNRESOLVED",
  "UNTRUSTED_INSTANCE_ENDPOINT",
])
