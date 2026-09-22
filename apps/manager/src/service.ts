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
  PrimarySession,
  SessionChildrenResponse,
  SessionMetadata,
  SessionRootsResponse,
} from "@omw/contracts"
import type { InstancePortPoolConfig } from "./config.js"
import { ManagerError } from "./errors.js"
import type { InstanceRecord, PortAllocation } from "./repository.js"
import { ManagerRepository } from "./repository.js"
import type { InspectResult, RuntimeActivityEvent, RuntimeActivityObserver, RuntimePort, RuntimeSummary } from "./runtime.js"

const EMPTY_SUMMARY = {
  activity: "unknown" as const,
  busySessions: null,
  pendingQuestions: null,
  pendingPermissions: null,
  error: null,
}
const RESERVATION_TTL_MS = 10_000
const OVERVIEW_CONCURRENCY = 4
const OBSERVER_RETRY_DELAYS_MS = [250, 1_000, 2_000] as const

interface ActivityObserverState {
  attempts: number
  observer: RuntimeActivityObserver | null
  retryTimer: NodeJS.Timeout | null
}

export class ManagerService {
  private readonly overviewInFlight = new Map<boolean, Promise<ManagedInstance[]>>()
  private readonly activityObservers = new Map<string, ActivityObserverState>()
  private readonly instanceMutations = new Map<string, Promise<void>>()
  private shuttingDown = false

  constructor(
    private readonly repository: ManagerRepository,
    private readonly runtime: RuntimePort,
    private readonly portPool: InstancePortPoolConfig = { min: 42_000, max: 42_099 },
    private readonly verifyRemoteUrl?: (port: number) => Promise<void>,
  ) {}

  async overview(query = "", filter: OverviewFilter = "all", includeHidden = false): Promise<OverviewResponse> {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-TW")
    const instances = await this.loadOverviewInstances(includeHidden)
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

  async start(directoryInput: string, observeActivity = true): Promise<ManagedInstance> {
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
      if (!identity.running || !identity.matched || !identity.portOwnerMatched || identity.portOwnedByOther) {
        throw new ManagerError("INSTANCE_IDENTITY_UNVERIFIED", "OpenCode process identity 或 port owner 無法核對。", 409)
      }
      const health = await this.runtime.readiness(launch)
      record.state = "ready"
      record.healthVersion = health.version
      this.repository.saveInstance(record)
      if (observeActivity) this.ensureActivityObserver(record)
      return await this.present(record)
    } catch (error) {
      const failure = safeRuntimeCode(error, "INSTANCE_START_FAILED")
      let cleanupError: string | null = null
      let cleanupStopped = false
      try {
        const cleanup = await this.runtime.cleanupLaunch(allocation.id)
        cleanupStopped = cleanup.stopped
        if (!cleanup.stopped) cleanupError = "STARTUP_CLEANUP_UNRESOLVED"
      } catch (cleanupFailure) {
        cleanupError = safeRuntimeCode(cleanupFailure, "STARTUP_CLEANUP_FAILED").code
      }
      record.state = "failed"
      record.error = [
        failure.code,
        cleanupError,
      ].filter(Boolean).join("；")
      record.stderrSummary = null
      this.repository.saveInstance(record)
      if (cleanupStopped) {
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
      this.closeActivityObserver(record.id)
      this.repository.releaseAllocationForInstance(record.id)
      return { instanceId: record.id, state: "stopped" }
    }
    record.state = "unreachable"
    record.error = "Launcher 已回報結束，但 loopback port 仍由 process 使用；保留 allocation 等待 reconcile。"
    this.repository.saveInstance(record)
    return { instanceId: record.id, state: "starting" }
  }

  async stop(id: string): Promise<ManagedInstance> {
    return await this.withInstanceMutation(id, async () => await this.stopUnlocked(id))
  }

  private async stopUnlocked(id: string): Promise<ManagedInstance> {
    const record = this.requireInstance(id)
    if (record.state === "stopped") return await this.present(record)
    if ((record.kind ?? "headless") !== "headless") {
      throw new ManagerError("LOCAL_TUI_OBSERVE_ONLY", "Local TUI Instance 僅可觀察與開啟，不提供 Stop authority。", 409)
    }
    if (!hasExactIdentity(record)) {
      throw new ManagerError("PROCESS_IDENTITY_INCOMPLETE", "Instance 缺少可安全核對的 process identity。", 409)
    }
    const result = await this.runtime.stop(record)
    if (!result.stopped) {
      throw new ManagerError("PROCESS_IDENTITY_MISMATCH", "拒絕停止：process identity 無法安全核對。", 409)
    }
    record.state = "stopped"
    record.stoppedAt = new Date().toISOString()
    record.error = null
    this.repository.saveInstance(record)
    this.closeActivityObserver(record.id)
    if (await loopbackPortAvailable(record.port)) this.repository.releaseAllocationForInstance(record.id)
    return await this.present(record)
  }

  async recheck(id: string): Promise<ManagedInstance> {
    return await this.withInstanceMutation(id, async () => await this.recheckUnlocked(id))
  }

  async setTrackingHidden(id: string, hidden: boolean): Promise<ManagedInstance> {
    return await this.withInstanceMutation(id, async () => {
      let record = this.requireInstance(id)
      if (hidden && record.state !== "unreachable" && record.state !== "failed") {
        await this.recheckUnlocked(id)
        record = this.requireInstance(id)
      }
      if (hidden && record.state !== "unreachable" && record.state !== "failed") {
        throw new ManagerError("INSTANCE_TRACKING_HIDE_UNAVAILABLE", "只有 unreachable 或 failed Instance 可停止追蹤。", 409)
      }
      if (hidden) this.closeActivityObserver(id)
      const updated = this.repository.setTrackingHidden(id, hidden)
      if (!updated) throw new ManagerError("INSTANCE_NOT_FOUND", "找不到 Instance。", 404)
      if (!hidden && updated.state === "ready") this.ensureActivityObserver(updated)
      return await this.present(updated)
    })
  }

  async deleteInstance(id: string): Promise<void> {
    await this.withInstanceMutation(id, async () => {
      const record = this.requireInstance(id)
      if (record.state !== "stopped") {
        throw new ManagerError("INSTANCE_REMOVAL_UNSAFE", "只有確認 stopped 的 Instance 可移除追蹤紀錄。", 409)
      }
      if (this.repository.getAllocationForInstance(id)) {
        throw new ManagerError("INSTANCE_REMOVAL_UNSAFE", "Instance port allocation 尚未安全釋放；請隱藏追蹤而非刪除。", 409)
      }
      this.closeActivityObserver(id)
      const result = this.repository.deleteStoppedInstance(id)
      if (result === "not-found") throw new ManagerError("INSTANCE_NOT_FOUND", "找不到 Instance。", 404)
      if (result === "not-stopped") {
        throw new ManagerError("INSTANCE_REMOVAL_UNSAFE", "只有確認 stopped 的 Instance 可移除追蹤紀錄。", 409)
      }
      if (result === "allocated") {
        throw new ManagerError("INSTANCE_REMOVAL_UNSAFE", "Instance port allocation 尚未安全釋放；請隱藏追蹤而非刪除。", 409)
      }
    })
  }

  async resume(id: string): Promise<ManagedInstance> {
    return await this.withInstanceMutation(id, async () => {
      let original = this.requireInstance(id)
      if (original.state === "unreachable") {
        await this.recheckUnlocked(id)
        original = this.requireInstance(id)
      }
      if (original.state !== "unreachable" && original.state !== "stopped") {
        throw new ManagerError("INSTANCE_RESUME_UNAVAILABLE", "只有 unreachable 或 stopped Instance 可接續。", 409)
      }
      const primary = this.repository.getPrimarySession(id)
      if (!primary) throw new ManagerError("INSTANCE_PRIMARY_SESSION_REQUIRED", "接續需要既有 primary Session。", 409)

      const launched = await this.start(original.projectDirectory, false)
      const created = this.requireInstance(launched.id)
      try {
        const sessions = dedupeSessions(await this.runtime.sessions(created))
        const root = sessions.find((session) => session.id === primary.sessionId && !session.parentID)
        if (!root) throw new Error("primary root Session missing")
        this.repository.replacePrimarySession(created.id, { ...primary, title: root.title })
      } catch {
        throw new ManagerError(
          "INSTANCE_RESUME_BIND_FAILED",
          "新 Instance 已啟動但未接續，勿重複啟動。",
          409,
          { newInstanceId: created.id, retrySafe: false },
        )
      }
      return await this.present(created)
    })
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
    await this.requireRemoteUrl(record)
    const selectedSessionId = sessionId ?? this.repository.getPrimarySession(id)?.sessionId
    if (selectedSessionId) {
      const sessions = await this.runtime.sessions(record)
      if (!sessions.some((session) => session.id === selectedSessionId)) {
        throw new ManagerError("SESSION_NOT_FOUND", "所選 Session 不存在於此 Project metadata。", 404)
      }
    }
    return {
      url: this.runtime.openUrl(record, selectedSessionId),
      instanceId: id,
      sessionId: selectedSessionId ?? null,
    }
  }

  async createSession(id: string): Promise<OpenUrlResponse> {
    const record = this.requireInstance(id)
    await this.requireFreshEndpointIdentity(record)
    await this.requireRemoteUrl(record)
    this.runtime.openUrl(record)
    if (!this.runtime.createSession) {
      throw new ManagerError("SESSION_CREATE_UNAVAILABLE", "Runtime 不支援建立 Session。", 501)
    }
    let session: SessionMetadata
    try {
      session = await this.runtime.createSession(record)
    } catch (error) {
      throw new ManagerError("SESSION_CREATE_FAILED", "OpenCode Session 建立失敗或回應無效；原綁定保持不變。", 502, {
        retrySafe: false,
        cause: safeMessage(error),
      })
    }
    if (session.parentID) {
      throw new ManagerError("SESSION_CREATE_RESPONSE_INVALID", "OpenCode 未回傳新 root Session；原綁定保持不變。", 502, {
        sessionId: session.id,
        retrySafe: false,
      })
    }
    const primarySession = primarySessionFrom(session, "new-session")
    this.repository.replacePrimarySession(id, primarySession)
    this.invalidateOverviewSnapshots()
    this.closeActivityObserver(id)
    try {
      return { url: this.runtime.openUrl(record, session.id), instanceId: id, sessionId: session.id }
    } catch (error) {
      throw new ManagerError("SESSION_CREATED_URL_FAILED", "Session 已建立並設為 primary，但 URL 產生失敗；請勿重複建立。", 502, {
        sessionId: session.id,
        cause: safeMessage(error),
      })
    }
  }

  async selectPrimarySession(id: string, sessionId: string): Promise<OpenUrlResponse> {
    const record = this.requireInstance(id)
    await this.requireFreshEndpointIdentity(record)
    await this.requireRemoteUrl(record)
    const sessions = dedupeSessions(await this.runtime.sessions(record))
    const session = sessions.find((candidate) => candidate.id === sessionId)
    if (!session) throw new ManagerError("SESSION_NOT_FOUND", "所選 Session 不存在於此 Project metadata。", 404)
    if (session.parentID) throw new ManagerError("SESSION_NOT_ROOT", "Primary Session 必須是 root Session。", 409)
    const url = this.runtime.openUrl(record, session.id)
    this.repository.replacePrimarySession(id, primarySessionFrom(session, "manual"))
    this.invalidateOverviewSnapshots()
    this.closeActivityObserver(id)
    return { url, instanceId: id, sessionId: session.id }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    const observers = [...this.activityObservers.values()]
    for (const state of observers) {
      if (state.retryTimer) clearTimeout(state.retryTimer)
      state.observer?.close()
    }
    this.activityObservers.clear()
    await Promise.allSettled(observers.map(async (state) => {
      if (!state.observer) return
      await Promise.race([state.observer.done, delay(2_500)])
    }))
  }

  async reconcile(): Promise<void> {
    await this.cleanupExpiredReservations()
    for (const record of this.repository.listInstances().filter((instance) => instance.state !== "stopped")) {
      record.state = "unreachable"
      record.healthVersion = null
      record.error = "Manager 已重啟，正在重新核對 Instance。"
      this.repository.saveInstance(record)
      if (!hasExactIdentity(record)) {
        // 沒有 exact identity 就無法證明 process tree 已消失；port 是否空閒不能替代 cleanup 證據。
        record.error = "Instance 未留下 exact process identity；保留 allocation，不授予 Stop authority。"
        this.repository.saveInstance(record)
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
      if (identity.processState === "not-found") {
        if (await loopbackPortAvailable(record.port)) {
          record.state = "stopped"
          record.stoppedAt = new Date().toISOString()
          record.error = null
          record.pid = null
          record.creationTimeUtc = null
          record.creationTimeTicks = null
          record.executable = null
          this.repository.saveInstance(record)
          this.closeActivityObserver(record.id)
          this.repository.releaseAllocationForInstance(record.id)
        } else {
          record.error = "INSTANCE_IDENTITY_UNVERIFIED"
          this.repository.saveInstance(record)
        }
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
      if (record.state === "ready") this.ensureActivityObserver(record)
    }
  }

  private async recheckUnlocked(id: string): Promise<ManagedInstance> {
    const record = this.requireInstance(id)
    if (record.state === "stopped") return await this.present(record)
    record.state = "unreachable"
    record.healthVersion = null
    record.error = "INSTANCE_IDENTITY_UNVERIFIED"

    if (!hasExactIdentity(record)) {
      this.repository.saveInstance(record)
      this.closeActivityObserver(id)
      return await this.present(record)
    }

    let identity: InspectResult
    try {
      identity = await this.runtime.inspect(record)
    } catch {
      record.error = "INSTANCE_IDENTITY_CHECK_FAILED"
      this.repository.saveInstance(record)
      this.closeActivityObserver(id)
      return await this.present(record)
    }

    if (identity.processState === "not-found") {
      if (await loopbackPortAvailable(record.port)) {
        record.state = "stopped"
        record.stoppedAt = new Date().toISOString()
        record.error = null
        record.pid = null
        record.creationTimeUtc = null
        record.creationTimeTicks = null
        record.executable = null
        this.repository.saveInstance(record)
        this.closeActivityObserver(id)
        this.repository.releaseAllocationForInstance(id)
      } else {
        this.repository.saveInstance(record)
        this.closeActivityObserver(id)
      }
      return await this.present(record)
    }

    if (!identity.running || !identity.matched || !identity.portOwnerMatched || identity.portOwnedByOther) {
      this.repository.saveInstance(record)
      this.closeActivityObserver(id)
      return await this.present(record)
    }

    try {
      const health = await this.runtime.readiness(record)
      record.state = "ready"
      record.healthVersion = health.version
      record.error = null
      this.repository.saveInstance(record)
      this.ensureActivityObserver(record)
    } catch {
      record.error = "INSTANCE_READINESS_FAILED"
      this.repository.saveInstance(record)
      this.closeActivityObserver(id)
    }
    return await this.present(record)
  }

  private requireInstance(id: string): InstanceRecord {
    const record = this.repository.getInstance(id)
    if (!record) throw new ManagerError("INSTANCE_NOT_FOUND", "找不到 Instance。", 404)
    return record
  }

  private async loadOverviewInstances(includeHidden: boolean): Promise<ManagedInstance[]> {
    const inFlight = this.overviewInFlight.get(includeHidden)
    if (inFlight) return await inFlight
    const records = this.repository.listInstances().filter((record) => includeHidden || !record.trackingHidden)
    const request = mapWithConcurrency(
      records,
      OVERVIEW_CONCURRENCY,
      async (record) => await this.present(record, { refreshRemoteUrl: true }),
    )
    this.overviewInFlight.set(includeHidden, request)
    try {
      const instances = await request
      return instances.filter((instance) => this.repository.getInstance(instance.id) !== null)
    } finally {
      if (this.overviewInFlight.get(includeHidden) === request) this.overviewInFlight.delete(includeHidden)
    }
  }

  private async withInstanceMutation<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.instanceMutations.get(id) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.catch(() => undefined).then(async () => await gate)
    this.instanceMutations.set(id, tail)
    await previous.catch(() => undefined)
    try {
      const result = await action()
      this.invalidateOverviewSnapshots()
      return result
    } finally {
      release()
      if (this.instanceMutations.get(id) === tail) this.instanceMutations.delete(id)
    }
  }

  private invalidateOverviewSnapshots(): void {
    // 成功 mutation 後的 refresh 不可共用 mutation 前的 snapshot；舊 request 的 identity check 會保留後來的新 entry。
    this.overviewInFlight.clear()
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
      this.ensureActivityObserver(current)
    } catch (error) {
      const current = this.repository.getInstance(id)
      if (!current || current.state === "stopped") return
      current.state = "unreachable"
      current.error = safeRuntimeCode(error, "LOCAL_TUI_VERIFICATION_FAILED").code
      this.repository.saveInstance(current)
    }
  }

  private ensureActivityObserver(record: InstanceRecord): void {
    if (this.shuttingDown || record.trackingHidden || record.state !== "ready" || this.repository.getPrimarySession(record.id)
      || !this.runtime.activity || !this.runtime.observeActivity || this.activityObservers.has(record.id)) return
    const state: ActivityObserverState = { attempts: 0, observer: null, retryTimer: null }
    this.activityObservers.set(record.id, state)
    this.startActivityObserver(record.id, state)
  }

  private startActivityObserver(id: string, state: ActivityObserverState): void {
    if (this.shuttingDown || this.activityObservers.get(id) !== state) return
    const record = this.repository.getInstance(id)
    if (!record || record.trackingHidden || record.state !== "ready" || this.repository.getPrimarySession(id) || !this.runtime.observeActivity) {
      this.closeActivityObserver(id)
      return
    }
    let observer: RuntimeActivityObserver
    try {
      observer = this.runtime.observeActivity(record, async (event) => await this.handleActivityEvent(id, state, event))
    } catch {
      this.activityObserverEnded(id, state)
      return
    }
    state.observer = observer
    void observer.done.then(
      () => this.activityObserverEnded(id, state),
      () => this.activityObserverEnded(id, state),
    )
  }

  private activityObserverEnded(id: string, state: ActivityObserverState): void {
    if (this.activityObservers.get(id) !== state) return
    state.observer = null
    if (this.shuttingDown || this.repository.getPrimarySession(id)) {
      this.closeActivityObserver(id)
      return
    }
    const retryDelay = OBSERVER_RETRY_DELAYS_MS[state.attempts++]
    if (retryDelay === undefined) {
      this.activityObservers.delete(id)
      return
    }
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null
      this.startActivityObserver(id, state)
    }, retryDelay)
  }

  private async handleActivityEvent(id: string, observerState: ActivityObserverState, event: RuntimeActivityEvent): Promise<void> {
    if (event.type !== "activity" || event.sessionIds.length === 0 || this.shuttingDown
      || this.activityObservers.get(id) !== observerState
      || this.repository.getPrimarySession(id)) return
    try {
      const record = this.repository.getInstance(id)
      if (!record || record.state !== "ready") return
      await this.requireFreshEndpointIdentity(record)
      const evidenceIds = new Set(event.sessionIds)
      if (event.source === "event" && this.runtime.activity) {
        for (const sessionId of (await this.runtime.activity(record)).busySessionIds) evidenceIds.add(sessionId)
      }
      const root = resolveActivityRoot([...evidenceIds], await this.runtime.sessions(record))
      if (!root || this.shuttingDown || this.activityObservers.get(id) !== observerState
        || this.repository.getPrimarySession(id)) return
      const current = this.repository.getInstance(id)
      if (!current || current.state !== "ready") return
      await this.requireFreshEndpointIdentity(current)
      // Await 後先淘汰 shutdown/disposed observer，避免 repository 關閉後仍讀寫。
      if (this.shuttingDown || this.activityObservers.get(id) !== observerState) return
      const latest = this.repository.getInstance(id)
      if (!latest || latest.state !== "ready" || !sameInstanceIdentity(latest, current)
        || this.repository.getPrimarySession(id)) return
      // Metadata/identity checks是非同步的；CAS再防止最後同步區段與 explicit choice 競爭。
      if (this.repository.bindPrimarySessionIfAbsent(id, primarySessionFrom(root, "activity"))) {
        this.closeActivityObserver(id)
      }
    } catch {
      // Unknown, conflicting, or stale evidence deliberately leaves the binding null.
    }
  }

  private closeActivityObserver(id: string): void {
    const state = this.activityObservers.get(id)
    if (!state) return
    this.activityObservers.delete(id)
    if (state.retryTimer) clearTimeout(state.retryTimer)
    state.observer?.close()
  }

  private async requireRemoteUrl(record: InstanceRecord): Promise<void> {
    try {
      await this.verifyRemoteUrl?.(record.port)
    } catch {
      throw new ManagerError("REMOTE_URL_UNAVAILABLE", "Tailscale Serve 映射尚未通過最新驗證。", 409)
    }
    const unavailableReason = this.runtime.remoteUrlUnavailableReason?.(record) ?? null
    if (unavailableReason) throw new ManagerError("REMOTE_URL_UNAVAILABLE", unavailableReason, 409)
  }

  private async present(record: InstanceRecord, options: { refreshRemoteUrl?: boolean } = {}): Promise<ManagedInstance> {
    const primaryBeforeProbe = this.repository.getPrimarySession(record.id)
    let summary: RuntimeSummary = { ...EMPTY_SUMMARY, sessions: [] }
    let stopAllowed = false
    let state = record.state
    let metadataVerified = false
    if (!record.trackingHidden && record.state !== "stopped" && record.pid != null) {
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
            metadataVerified = true
          } catch {
            state = "unreachable"
            summary = { ...EMPTY_SUMMARY, error: "INSTANCE_SUMMARY_FAILED", sessions: [] }
          }
        }
      }
      if (record.state === "ready" && summary.activity === "unknown") state = "unreachable"
    }
    if (metadataVerified && primaryBeforeProbe) {
      const currentMetadata = summary.sessions.find((session) => session.id === primaryBeforeProbe.sessionId)
      if (currentMetadata && currentMetadata.title !== primaryBeforeProbe.title) {
        this.repository.updatePrimarySessionTitle(record.id, primaryBeforeProbe, currentMetadata.title)
      }
    }
    const primarySession = this.repository.getPrimarySession(record.id)
    const trackingHidden = record.trackingHidden ?? false
    const removeAllowed = state === "stopped" && this.repository.getAllocationForInstance(record.id) === null
    let remoteUrlVerificationFailure: string | null = null
    if (options.refreshRemoteUrl) {
      try {
        // Runtime probes may outlive the Connectivity TTL; verify after them so the synchronous gate below reads fresh state.
        await this.verifyRemoteUrl?.(record.port)
      } catch {
        remoteUrlVerificationFailure = "Tailscale Serve 映射尚未通過驗證。"
      }
    }
    const remoteUrlUnavailableReason = this.runtime.remoteUrlUnavailableReason?.(record) ?? remoteUrlVerificationFailure
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
      remoteUrlUnavailableReason,
      primarySession,
      trackingHidden,
      recovery: {
        recheckAllowed: state === "unreachable" || state === "failed",
        resumeAllowed: primarySession !== null && (state === "unreachable" || state === "stopped"),
        hideAllowed: trackingHidden || state === "unreachable" || state === "failed",
        removeAllowed,
      },
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
    if (record.state === "stopped") {
      throw new ManagerError("INSTANCE_STOPPED", "Stopped Instance 不可開啟或變更 primary Session。", 409)
    }
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

function primarySessionFrom(session: SessionMetadata, source: PrimarySession["source"]): PrimarySession {
  return {
    sessionId: session.id,
    title: session.title,
    source,
    boundAt: new Date().toISOString(),
  }
}

function resolveActivityRoot(sessionIds: string[], sessions: SessionMetadata[]): SessionMetadata | null {
  const byId = new Map<string, SessionMetadata>()
  for (const session of sessions) {
    if (!session.id || byId.has(session.id)) return null
    byId.set(session.id, session)
  }
  const roots = new Set<string>()
  for (const sessionId of new Set(sessionIds)) {
    let current = byId.get(sessionId)
    if (!current) return null
    const visited = new Set<string>()
    while (current.parentID) {
      if (visited.has(current.id)) return null
      visited.add(current.id)
      current = byId.get(current.parentID)
      if (!current) return null
    }
    if (visited.has(current.id)) return null
    roots.add(current.id)
  }
  if (roots.size !== 1) return null
  return byId.get([...roots][0]!) ?? null
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

async function mapWithConcurrency<T, U>(values: T[], concurrency: number, mapper: (value: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(values.length)
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++
      results[index] = await mapper(values[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => await worker()))
  return results
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

function sameInstanceIdentity(left: InstanceRecord, right: InstanceRecord): boolean {
  return left.id === right.id
    && left.projectDirectory === right.projectDirectory
    && left.endpoint === right.endpoint
    && left.port === right.port
    && left.pid === right.pid
    && left.creationTimeUtc === right.creationTimeUtc
    && left.creationTimeTicks === right.creationTimeTicks
    && left.executable === right.executable
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
