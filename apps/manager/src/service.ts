import { randomUUID } from "node:crypto"
import { readdir, realpath, stat } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { primarySessionDisposition } from "@omw/contracts"
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
import type { InspectResult, RuntimeActivityEvent, RuntimeActivityObserver, RuntimeCapabilities, RuntimePort } from "./runtime.js"
import { primarySessionFrom, resolveActivityRoot } from "./session-projection.js"
import { capabilitiesFor, supports } from "./capabilities.js"
import { InstanceOverview } from "./overview.js"

const RESERVATION_TTL_MS = 10_000
const OBSERVER_RETRY_DELAYS_MS = [250, 1_000, 2_000] as const
const LOCAL_VERIFICATION_DEADLINE_MS = 15_000
const LOCAL_VERIFICATION_INTERVAL_MS = 200

interface LocalVerification {
  controller: AbortController
  deadline: number
  timer: NodeJS.Timeout
}

interface ActivityObserverState {
  attempts: number
  observer: RuntimeActivityObserver | null
  retryTimer: NodeJS.Timeout | null
  connectionToken: object | null
  candidate: { sessionId: string; expectedPrimary: PrimarySession } | null
}

export class ManagerService {
  private readonly instanceRuntimes = new Map<string, RuntimePort>()
  private readonly snapshots: InstanceOverview
  private readonly activityObservers = new Map<string, ActivityObserverState>()
  private readonly localVerifications = new Map<string, LocalVerification>()
  private readonly instanceMutations = new Map<string, Promise<void>>()
  private shuttingDown = false

  constructor(
    private readonly repository: ManagerRepository,
    private readonly runtime: RuntimePort | ((instance: InstanceRecord) => RuntimePort),
    private readonly portPool: InstancePortPoolConfig = { min: 42_000, max: 42_099 },
    private readonly verifyRemoteUrl?: (port: number) => Promise<void>,
  ) {
    this.snapshots = new InstanceOverview(repository, (record) => this.runtimeFor(record), verifyRemoteUrl)
  }

  private runtimeFor(instance: InstanceRecord): RuntimePort {
    // 選定後綁在 Instance identity 上；selector 後續改變不可將 Stop 送往別的 runtime。
    const selected = this.instanceRuntimes.get(instance.id)
    if (selected) return selected
    const adapter = typeof this.runtime === "function" ? this.runtime(instance) : this.runtime
    this.instanceRuntimes.set(instance.id, adapter)
    return adapter
  }

  private capabilitiesFor(instance: InstanceRecord): RuntimeCapabilities {
    return capabilitiesFor(this.runtimeFor(instance), instance)
  }

  async overview(query = "", filter: OverviewFilter = "all", includeHidden = false): Promise<OverviewResponse> {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-TW")
    const instances = await this.snapshots.load(includeHidden)
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

  async start(directoryInput: string, observeActivity = true, resumeRuntime?: RuntimePort): Promise<ManagedInstance> {
    const directory = await canonicalDirectory(directoryInput)
    const allocation = await this.reservePort("headless", directory, null)
    const record = newInstanceRecord(allocation, directory, null)
    this.repository.createReservedInstance(allocation.id, record)
    if (resumeRuntime) this.instanceRuntimes.set(record.id, resumeRuntime)

    try {
      const launch = await this.runtimeFor(record).launch(directory, allocation.port, allocation.id)
      // Persist exact identity before any readiness work so a startup failure remains safely stoppable.
      Object.assign(record, {
        pid: launch.pid,
        creationTimeUtc: launch.creationTimeUtc,
        creationTimeTicks: launch.creationTimeTicks,
        executable: launch.executable,
        endpoint: launch.endpoint,
      })
      this.repository.saveInstance(record)
      const identity = await this.runtimeFor(record).inspect(record)
      if (!identity.running || !identity.matched || !identity.portOwnerMatched || identity.portOwnedByOther) {
        throw new ManagerError("INSTANCE_IDENTITY_UNVERIFIED", "OpenCode process identity 或 port owner 無法核對。", 409)
      }
      const health = await this.runtimeFor(record).readiness(launch)
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
        const cleanup = await this.runtimeFor(record).cleanupLaunch(allocation.id)
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
    const adapter = this.runtimeFor(newInstanceRecord(allocation, allocation.projectDirectory, input.clientInvocationId))
    if (!adapter.adoptLocal) throw new ManagerError("LOCAL_REGISTRATION_UNAVAILABLE", "Runtime 不支援 Local TUI identity registration。", 501)
    const launch = await adapter.adoptLocal(allocation.projectDirectory, allocation.port, allocation.id, input.pid)
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
    const controller = new AbortController()
    const deadline = Date.now() + LOCAL_VERIFICATION_DEADLINE_MS
    const timer = setTimeout(() => controller.abort(new ManagerError(
      "LOCAL_TUI_VERIFICATION_TIMEOUT", "Local TUI 初次驗證超時。", 409,
    )), LOCAL_VERIFICATION_DEADLINE_MS)
    const verification = { controller, deadline, timer }
    this.localVerifications.set(record.id, verification)
    void this.verifyLocalRegistration(record.id, verification)
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
    const interrupted = this.localVerifications.has(record.id)
    this.cancelLocalVerification(record.id)
    let portAvailable: boolean
    try {
      portAvailable = await loopbackPortAvailable(record.port)
    } catch (error) {
      this.failInterruptedLocalVerification(record.id, record, interrupted)
      throw error
    }
    if (portAvailable) {
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
    // Manager 先核對 fresh process/port ownership，避免只信任 adapter 的樂觀 Stop 回報。
    // 這不是原子保證：adapter Stop 仍須在 helper 內再次核對 identity/port owner，防止 TOCTOU。
    let identity: InspectResult
    const runtime = this.runtimeFor(record)
    try {
      identity = await runtime.inspect(record)
    } catch {
      throw new ManagerError("INSTANCE_IDENTITY_CHECK_FAILED", "拒絕停止：無法核對 process identity。", 409)
    }
    if (identity.processState === "not-found" && !identity.portOwnedByOther) {
      // 已消失的 process 只經由既有 recheck 的再次核對與 port-free 規則釋放 allocation。
      const rechecked = await this.recheckUnlocked(id)
      if (rechecked.state === "stopped") return rechecked
    }
    if (identity.processState === "unknown" || identity.processState === "not-found" || !identity.running || !identity.matched || identity.portOwnedByOther) {
      throw new ManagerError("PROCESS_IDENTITY_MISMATCH", "拒絕停止：process identity 無法安全核對。", 409)
    }
    // listener 消失時 portOwnerMatched 可為 false；只要 port 未由他人佔用仍可停止 matching root。
    const result = await runtime.stop(record)
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
    const interrupted = this.localVerifications.has(id)
    const registration = interrupted ? this.repository.getInstance(id) : null
    this.cancelLocalVerification(id)
    return await this.withInstanceMutation(id, async () => {
      try {
        return await this.recheckUnlocked(id)
      } catch (error) {
        this.failInterruptedLocalVerification(id, registration, interrupted)
        throw error
      }
    })
  }

  async setTrackingHidden(id: string, hidden: boolean): Promise<ManagedInstance> {
    const interruptedRegistration = hidden && this.localVerifications.has(id)
    if (hidden) this.cancelLocalVerification(id)
    return await this.withInstanceMutation(id, async () => {
      let record = this.requireInstance(id)
      if (hidden && record.state !== "unreachable" && record.state !== "failed") {
        try {
          await this.recheckUnlocked(id)
        } catch (error) {
          this.failInterruptedLocalVerification(id, record, interruptedRegistration)
          throw error
        }
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
      this.instanceRuntimes.delete(id)
    })
  }

  async resume(id: string): Promise<ManagedInstance> {
    return await this.withInstanceMutation(id, async () => {
      let original = this.requireInstance(id)
      // 在配置 port／啟動新程序前拒絕不可讀 Session 的 adapter，避免產生無法接續的孤立 Instance。
      this.requireCapability(original, "sessions")
      if (original.state === "unreachable") {
        await this.recheckUnlocked(id)
        original = this.requireInstance(id)
      }
      if (original.state !== "unreachable" && original.state !== "stopped") {
        throw new ManagerError("INSTANCE_RESUME_UNAVAILABLE", "只有 unreachable 或 stopped Instance 可接續。", 409)
      }
      const primary = this.repository.getPrimarySession(id)
      if (!primary) throw new ManagerError("INSTANCE_PRIMARY_SESSION_REQUIRED", "接續需要既有 primary Session。", 409)

      this.requireCapability(original, "sessions")
      const launched = await this.start(original.projectDirectory, false, this.runtimeFor(original))
      const created = this.requireInstance(launched.id)
      try {
        const sessions = dedupeSessions(await this.runtimeFor(created).sessions(created))
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
    this.requireCapability(record, "sessions")
    await this.requireFreshEndpointIdentity(record)
    const sessions = dedupeSessions(await this.runtimeFor(record).sessions(record))
    const ids = new Set(sessions.map((session) => session.id))
    return {
      roots: sessions.filter((session) => !session.parentID),
      unknownParent: sessions.filter((session) => session.parentID && !ids.has(session.parentID)),
    }
  }

  async sessionChildren(id: string, sessionId: string): Promise<SessionChildrenResponse> {
    const record = this.requireInstance(id)
    this.requireCapability(record, "sessions")
    await this.requireFreshEndpointIdentity(record)
    const children = dedupeSessions(await this.runtimeFor(record).children(record, sessionId))
      .filter((session) => session.parentID === sessionId)
    return { parentID: sessionId, children, loadedDirectChildren: children.length }
  }

  async openUrl(id: string, sessionId?: string): Promise<OpenUrlResponse> {
    const record = this.requireInstance(id)
    this.requireCapability(record, "nativeWeb")
    if (sessionId ?? this.repository.getPrimarySession(id)?.sessionId) this.requireCapability(record, "sessions")
    await this.requireFreshEndpointIdentity(record)
    await this.requireRemoteUrl(record)
    const selectedSessionId = sessionId ?? this.repository.getPrimarySession(id)?.sessionId
    if (selectedSessionId) {
      const sessions = await this.runtimeFor(record).sessions(record)
      if (!sessions.some((session) => session.id === selectedSessionId)) {
        throw new ManagerError("SESSION_NOT_FOUND", "所選 Session 不存在於此 Project metadata。", 404)
      }
    }
    return {
      url: this.runtimeFor(record).openUrl(record, selectedSessionId),
      instanceId: id,
      sessionId: selectedSessionId ?? null,
    }
  }

  async createSession(id: string): Promise<OpenUrlResponse> {
    const record = this.requireInstance(id)
    this.requireCapability(record, "sessionCreation")
    this.requireCapability(record, "nativeWeb")
    await this.requireFreshEndpointIdentity(record)
    await this.requireRemoteUrl(record)
    const adapter = this.runtimeFor(record)
    adapter.openUrl(record)
    if (!adapter.createSession) {
      throw new ManagerError("SESSION_CREATE_UNAVAILABLE", "Runtime 不支援建立 Session。", 501)
    }
    let session: SessionMetadata
    try {
      session = await adapter.createSession(record)
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
    this.primarySessionChanged(record)
    try {
      return { url: adapter.openUrl(record, session.id), instanceId: id, sessionId: session.id }
    } catch (error) {
      throw new ManagerError("SESSION_CREATED_URL_FAILED", "Session 已建立並設為 primary，但 URL 產生失敗；請勿重複建立。", 502, {
        sessionId: session.id,
        cause: safeMessage(error),
      })
    }
  }

  async selectPrimarySession(id: string, sessionId: string): Promise<OpenUrlResponse> {
    const record = this.requireInstance(id)
    this.requireCapability(record, "sessions")
    this.requireCapability(record, "nativeWeb")
    await this.requireFreshEndpointIdentity(record)
    await this.requireRemoteUrl(record)
    const sessions = dedupeSessions(await this.runtimeFor(record).sessions(record))
    const session = sessions.find((candidate) => candidate.id === sessionId)
    if (!session) throw new ManagerError("SESSION_NOT_FOUND", "所選 Session 不存在於此 Project metadata。", 404)
    if (session.parentID) throw new ManagerError("SESSION_NOT_ROOT", "Primary Session 必須是 root Session。", 409)
    const url = this.runtimeFor(record).openUrl(record, session.id)
    this.repository.replacePrimarySession(id, primarySessionFrom(session, "manual"))
    this.invalidateOverviewSnapshots()
    this.primarySessionChanged(record)
    return { url, instanceId: id, sessionId: session.id }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    for (const id of this.localVerifications.keys()) this.cancelLocalVerification(id)
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
    this.instanceRuntimes.clear()
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
        identity = await this.runtimeFor(record).inspect(record)
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
        const health = await this.runtimeFor(record).readiness(record)
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
      identity = await this.runtimeFor(record).inspect(record)
    } catch {
      record.error = "INSTANCE_IDENTITY_CHECK_FAILED"
      this.repository.saveInstance(record)
      this.closeActivityObserver(id)
      return await this.present(record)
    }

    if (identity.processState === "not-found" && !identity.portOwnedByOther) {
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
      const health = await this.runtimeFor(record).readiness(record)
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
    this.snapshots.invalidate()
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

  private cancelLocalVerification(id: string): void {
    const verification = this.localVerifications.get(id)
    if (!verification) return
    this.localVerifications.delete(id)
    clearTimeout(verification.timer)
    verification.controller.abort()
  }

  private failInterruptedLocalVerification(id: string, registration: InstanceRecord | null, interrupted: boolean): void {
    if (!interrupted || !registration || this.shuttingDown) return
    const current = this.repository.getInstance(id)
    // recheck 或 port probe 可能在寫入前失敗；取消初次驗證後不能留下無人處理的 starting。
    if (current?.state !== "starting" || !sameInstanceIdentity(current, registration)) return
    current.state = "unreachable"
    current.error = "INSTANCE_IDENTITY_CHECK_FAILED"
    this.repository.saveInstance(current)
    this.invalidateOverviewSnapshots()
  }

  private localVerificationCurrent(id: string, record: InstanceRecord, verification: LocalVerification): boolean {
    const current = this.repository.getInstance(id)
    // 世代檢查擋掉取消後的結果；deadline 另走 timeout 錯誤路徑，不能把超時當成取消而留下 starting。
    return !this.shuttingDown && this.localVerifications.get(id) === verification
      && !verification.controller.signal.aborted
      && current?.state === "starting" && !current.trackingHidden && sameInstanceIdentity(current, record)
  }

  private async verifyLocalRegistration(id: string, verification: LocalVerification): Promise<void> {
    const record = this.repository.getInstance(id)
    try {
      if (!record || record.kind !== "local-tui") return
      while (this.localVerificationCurrent(id, record, verification)) {
        if (Date.now() >= verification.deadline) break
        const identity = await awaitLocalVerification(this.runtimeFor(record).inspect(record), verification.controller.signal)
        if (!this.localVerificationCurrent(id, record, verification)) return
        if (Date.now() >= verification.deadline) break
        if (!identity.running || !identity.matched || identity.portOwnedByOther) {
          throw new ManagerError("INSTANCE_IDENTITY_UNVERIFIED", "Local TUI process identity 或 port owner 無法核對。", 409)
        }
        if (identity.portOwnerMatched) {
          const health = await awaitLocalVerification(this.runtimeFor(record).readiness(record), verification.controller.signal)
          if (!this.localVerificationCurrent(id, record, verification)) return
          if (Date.now() >= verification.deadline) break
          const current = this.repository.getInstance(id)!
          current.state = "ready"
          current.healthVersion = health.version
          current.error = null
          this.repository.saveInstance(current)
          this.ensureActivityObserver(current)
          return
        }
        // #65: exact process 已核對但 listener 尚未出現；不可把無 foreign owner 當成 ready 證據。
        await awaitLocalVerification(delay(Math.min(LOCAL_VERIFICATION_INTERVAL_MS, verification.deadline - Date.now())), verification.controller.signal)
      }
      if (this.localVerifications.get(id) !== verification) return
      throw new ManagerError("LOCAL_TUI_VERIFICATION_TIMEOUT", "Local TUI 初次驗證超時。", 409)
    } catch (error) {
      if (this.shuttingDown || this.localVerifications.get(id) !== verification) return
      const current = this.repository.getInstance(id)
      if (!record || !current || current.state !== "starting" || current.trackingHidden || !sameInstanceIdentity(current, record)) return
      current.state = "unreachable"
      current.error = safeRuntimeCode(error, "LOCAL_TUI_VERIFICATION_FAILED").code
      this.repository.saveInstance(current)
    } finally {
      if (this.localVerifications.get(id) === verification) this.localVerifications.delete(id)
      clearTimeout(verification.timer)
    }
  }

  private ensureActivityObserver(record: InstanceRecord): void {
    if (!supports(this.capabilitiesFor(record), "activity") || !supports(this.capabilitiesFor(record), "sessions")) {
      this.closeActivityObserver(record.id)
      return
    }
    if (this.shuttingDown || record.trackingHidden || record.state !== "ready"
      || ((record.kind ?? "headless") !== "local-tui" && this.repository.getPrimarySession(record.id))
      || !this.runtimeFor(record).activity || !this.runtimeFor(record).observeActivity || this.activityObservers.has(record.id)) return
    const state: ActivityObserverState = {
      attempts: 0,
      observer: null,
      retryTimer: null,
      connectionToken: null,
      candidate: null,
    }
    this.activityObservers.set(record.id, state)
    this.startActivityObserver(record.id, state)
  }

  private startActivityObserver(id: string, state: ActivityObserverState): void {
    if (this.shuttingDown || this.activityObservers.get(id) !== state) return
    const record = this.repository.getInstance(id)
    if (!record || record.trackingHidden || record.state !== "ready"
      || !supports(this.capabilitiesFor(record), "activity") || !supports(this.capabilitiesFor(record), "sessions")
      || ((record.kind ?? "headless") !== "local-tui" && this.repository.getPrimarySession(id))
      || !this.runtimeFor(record).observeActivity) {
      this.closeActivityObserver(id)
      return
    }
    const connectionToken = {}
    state.connectionToken = connectionToken
    let observer: RuntimeActivityObserver
    try {
      observer = this.runtimeFor(record).observeActivity!(
        record,
        async (event) => await this.handleActivityEvent(id, state, connectionToken, event),
      )
    } catch {
      this.activityObserverEnded(id, state, connectionToken)
      return
    }
    state.observer = observer
    void observer.done.then(
      () => this.activityObserverEnded(id, state, connectionToken),
      () => this.activityObserverEnded(id, state, connectionToken),
    )
  }

  private activityObserverEnded(id: string, state: ActivityObserverState, connectionToken: object): void {
    if (this.activityObservers.get(id) !== state || state.connectionToken !== connectionToken) return
    // 先讓這條 connection 的 pending callbacks失效，避免它們在 reconnect 後寫入或清掉新候選。
    state.connectionToken = null
    state.observer = null
    state.candidate = null
    const record = this.repository.getInstance(id)
    if (this.shuttingDown || !record || record.trackingHidden || record.state !== "ready"
      || !supports(this.capabilitiesFor(record), "activity") || !supports(this.capabilitiesFor(record), "sessions")
      || ((record.kind ?? "headless") !== "local-tui" && this.repository.getPrimarySession(id))) {
      this.closeActivityObserver(id)
      return
    }
    let retryDelay = OBSERVER_RETRY_DELAYS_MS[state.attempts++]
    // Local TUI 必須持續追蹤後續 /new；暫時斷線只把 backoff 固定在上限，不可停止觀察。
    if (retryDelay === undefined && record.kind === "local-tui") {
      retryDelay = OBSERVER_RETRY_DELAYS_MS[OBSERVER_RETRY_DELAYS_MS.length - 1]
    }
    if (retryDelay === undefined) {
      this.activityObservers.delete(id)
      return
    }
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null
      this.startActivityObserver(id, state)
    }, retryDelay)
  }

  private async handleActivityEvent(
    id: string,
    observerState: ActivityObserverState,
    connectionToken: object,
    event: RuntimeActivityEvent,
  ): Promise<void> {
    if (this.shuttingDown || this.activityObservers.get(id) !== observerState
      || observerState.connectionToken !== connectionToken) return
    const observed = this.repository.getInstance(id)
    if (!observed || !supports(this.capabilitiesFor(observed), "activity") || !supports(this.capabilitiesFor(observed), "sessions")) {
      this.closeActivityObserver(id)
      return
    }
    if (event.type === "session-created") {
      observerState.candidate = null
      const record = this.repository.getInstance(id)
      const primary = this.repository.getPrimarySession(id)
      if (record?.kind === "local-tui" && record.state === "ready" && primary && primary.sessionId !== event.sessionId) {
        observerState.candidate = { sessionId: event.sessionId, expectedPrimary: primary }
      }
      return
    }
    if (event.sessionIds.length === 0) return
    const candidate = observerState.candidate
    try {
      const record = this.repository.getInstance(id)
      if (!record || record.state !== "ready") return
      if (!supports(this.capabilitiesFor(record), "activity") || !supports(this.capabilitiesFor(record), "sessions")) {
        this.closeActivityObserver(id)
        return
      }
      const currentPrimary = this.repository.getPrimarySession(id)
      if (currentPrimary && (record.kind !== "local-tui" || !candidate)) return
      const expectedPrimary = currentPrimary ? candidate?.expectedPrimary ?? null : null
      await this.requireFreshEndpointIdentity(record)
      this.requireCapability(record, "activity")
      this.requireCapability(record, "sessions")
      const evidenceIds = new Set(event.sessionIds)
      if (event.source === "event" && this.runtimeFor(record).activity) {
        for (const sessionId of (await this.runtimeFor(record).activity!(record)).busySessionIds) evidenceIds.add(sessionId)
      }
      this.requireCapability(record, "sessions")
      const root = resolveActivityRoot([...evidenceIds], await this.runtimeFor(record).sessions(record))
      if (!root || this.shuttingDown || this.activityObservers.get(id) !== observerState
        || observerState.connectionToken !== connectionToken
        || (candidate && observerState.candidate !== candidate)
        || (expectedPrimary && root.id !== candidate?.sessionId)) return
      const current = this.repository.getInstance(id)
      if (!current || current.state !== "ready") return
      await this.requireFreshEndpointIdentity(current)
      // Await 後先淘汰 shutdown/disposed observer，避免 repository 關閉後仍讀寫。
      if (this.shuttingDown || this.activityObservers.get(id) !== observerState
        || observerState.connectionToken !== connectionToken) return
      const latest = this.repository.getInstance(id)
      if (!latest || latest.state !== "ready" || !sameInstanceIdentity(latest, current)
        || (candidate && observerState.candidate !== candidate)) return
      this.requireCapability(latest, "activity")
      this.requireCapability(latest, "sessions")
      // Metadata/identity checks是非同步的；CAS避免較早 candidate 覆寫後來的 explicit choice。
      const primarySession = primarySessionFrom(root, "activity")
      const bindingChanged = expectedPrimary
        ? this.repository.replacePrimarySessionIfUnchanged(id, expectedPrimary, primarySession)
        : this.repository.bindPrimarySessionIfAbsent(id, primarySession)
      if (bindingChanged) {
        observerState.candidate = null
        if ((latest.kind ?? "headless") !== "local-tui") this.closeActivityObserver(id)
      }
    } catch {
      // Identity/metadata 驗證失敗後不可沿用 candidate，避免 endpoint 恢復時誤配舊 created event。
      if (this.activityObservers.get(id) === observerState
        && observerState.connectionToken === connectionToken
        && observerState.candidate === candidate) observerState.candidate = null
    }
  }

  private primarySessionChanged(record: InstanceRecord): void {
    const observerState = this.activityObservers.get(record.id)
    if (observerState) observerState.candidate = null
    if ((record.kind ?? "headless") === "local-tui") this.ensureActivityObserver(record)
    else this.closeActivityObserver(record.id)
  }

  private closeActivityObserver(id: string): void {
    const state = this.activityObservers.get(id)
    if (!state) return
    this.activityObservers.delete(id)
    state.connectionToken = null
    if (state.retryTimer) clearTimeout(state.retryTimer)
    state.observer?.close()
  }

  private async requireRemoteUrl(record: InstanceRecord): Promise<void> {
    try {
      await this.verifyRemoteUrl?.(record.port)
    } catch {
      throw new ManagerError("REMOTE_URL_UNAVAILABLE", "Tailscale Serve 映射尚未通過最新驗證。", 409)
    }
    const unavailableReason = this.runtimeFor(record).remoteUrlUnavailableReason?.(record) ?? null
    if (unavailableReason) throw new ManagerError("REMOTE_URL_UNAVAILABLE", unavailableReason, 409)
  }

  private async present(record: InstanceRecord, options: { refreshRemoteUrl?: boolean } = {}): Promise<ManagedInstance> {
    return await this.snapshots.present(record, options.refreshRemoteUrl)
  }

  private async requireFreshEndpointIdentity(record: InstanceRecord): Promise<InspectResult> {
    if (record.state === "stopped") {
      throw new ManagerError("INSTANCE_STOPPED", "Stopped Instance 不可開啟或變更 primary Session。", 409)
    }
    let identity: InspectResult
    try {
      identity = await this.runtimeFor(record).inspect(record)
    } catch {
      throw new ManagerError("INSTANCE_IDENTITY_UNVERIFIED", "Instance process identity 無法核對。", 409)
    }
    if (!identity.running || !identity.matched || !identity.portOwnerMatched || identity.portOwnedByOther) {
      throw new ManagerError("INSTANCE_IDENTITY_UNVERIFIED", "Instance process identity 或 endpoint owner 無法核對。", 409)
    }
    return identity
  }

  private requireCapability(record: InstanceRecord, name: keyof RuntimeCapabilities): void {
    const capability = this.capabilitiesFor(record)[name]
    if (!capability || capability.state === "supported") return
    if (capability.state === "unsupported") {
      throw new ManagerError("AGENT_CAPABILITY_UNSUPPORTED", `Runtime 不支援 ${name}。`, 501)
    }
    throw new ManagerError("AGENT_CAPABILITY_UNAVAILABLE", `Runtime 的 ${name} 暫時不可用。`, 503, { reason: capability.reason })
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

async function awaitLocalVerification<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => undefined)
    throw signal.reason
  }
  let onAbort!: () => void
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener("abort", onAbort)
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
  if (filter === "active") {
    return instance.state === "starting"
      || (instance.primarySummary.scope === "known" && (instance.primarySummary.busySessions ?? 0) > 0)
  }
  if (filter === "attention") return instance.state === "ready" && primarySessionDisposition(instance.primarySummary) === "attention"
  if (filter === "unreachable") return instance.state === "unreachable" || instance.state === "failed" || instance.primarySummary.activity === "unknown"
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
