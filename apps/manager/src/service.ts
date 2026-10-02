import { createHash, randomUUID } from "node:crypto"
import { canonicalDirectory, localDirectories } from "./directory.js"
import net from "node:net"
import path from "node:path"
import { performance } from "node:perf_hooks"
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
  HistoryResponse,
  PrimarySession,
  PrimaryTodosResponse,
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
import type { LocalVerificationDiagnostic } from "./lifecycle-diagnostics.js"

const RESERVATION_TTL_MS = 10_000
const OBSERVER_RETRY_DELAYS_MS = [250, 1_000, 2_000] as const
const RESUME_BINDING_DEADLINE_MS = 15_000
const INITIAL_LOCAL_VERIFICATION_BUDGET_MS = 30_000
const LOCAL_VERIFICATION_INTERVAL_MS = 200
const RESUME_BINDING_RETRY_DELAYS_MS = [0, 250, 1_000, 2_000] as const

interface LocalVerification {
  controller: AbortController
  deadline: number
  timer: NodeJS.Timeout
  startedAt: number
  stageStartedAt: number
  stage: LocalVerificationDiagnostic["stage"]
  attempt: number
  phasePending: boolean
  finished: boolean
}

interface ResumeBinding {
  controller: AbortController
  timer: NodeJS.Timeout
}

interface ResumeIntent {
  sessionId: string
  record: InstanceRecord
  deadline: number | null
  attempts: number
}

interface BufferedResumeCandidate {
  intent: ResumeIntent
  binding: ResumeBinding
  connectionToken: object
  sessionId: string
  activity: RuntimeActivityEvent | null
}

interface ActivityObserverState {
  attempts: number
  observer: RuntimeActivityObserver | null
  retryTimer: NodeJS.Timeout | null
  connectionToken: object | null
  candidate: { sessionId: string; expectedPrimary: PrimarySession; resumeBinding?: ResumeBinding } | null
  pendingResumeCandidate: BufferedResumeCandidate | null
}

export class ManagerService {
  private readonly instanceRuntimes = new Map<string, RuntimePort>()
  private readonly snapshots: InstanceOverview
  private readonly activityObservers = new Map<string, ActivityObserverState>()
  private readonly localVerifications = new Map<string, LocalVerification>()
  private readonly resumeBindings = new Map<string, ResumeBinding>()
  private readonly resumeIntents = new Map<string, ResumeIntent>()
  private readonly instanceMutations = new Map<string, Promise<void>>()
  private shuttingDown = false

  constructor(
    private readonly repository: ManagerRepository,
    private readonly runtime: RuntimePort | ((instance: InstanceRecord) => RuntimePort),
    private readonly portPool: InstancePortPoolConfig = { min: 42_000, max: 42_099 },
    private readonly verifyRemoteUrl?: (port: number) => Promise<void>,
    private readonly localVerificationDiagnostics?: (details: LocalVerificationDiagnostic) => void,
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

  async overview(query = "", filter: OverviewFilter = "all", includeHidden = false,
    view: "legacy" | "compact" | "notifications" = "legacy", scope: "all" | "current" = "all"): Promise<OverviewResponse> {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-TW")
    const instances = await this.snapshots.load(includeHidden, scope === "current" || view === "notifications")
    const filtered = instances.filter((instance) => matchesFilter(instance, filter) && matchesQuery(instance, normalizedQuery))
    return {
      shortcuts: view === "notifications" ? [] : this.repository.listShortcuts(),
      instances: view === "notifications" ? [] : view === "compact" ? filtered.map(compactInstance) : filtered,
      ...(view !== "legacy" ? {
        history: this.historyRecords(includeHidden).summary,
        // 通知永遠投影未篩選且未隱藏的 Instance，不能把畫面的搜尋子集當作通知全貌。
        notifications: instances.filter((instance) => !instance.trackingHidden).map((instance) => ({
          id: instance.id, state: instance.state, trackingHidden: instance.trackingHidden,
          summary: { pendingQuestions: instance.summary.pendingQuestions, pendingPermissions: instance.summary.pendingPermissions },
        })),
      } : {}),
    }
  }

  private historyRecords(includeHidden: boolean, query = "") {
    const normalized = query.trim().toLocaleLowerCase("zh-TW")
    const records = this.repository.listInstances().filter((record) => record.state === "stopped" && (includeHidden || !record.trackingHidden))
      .sort((left, right) => Date.parse(right.launchedAt) - Date.parse(left.launchedAt) || left.id.localeCompare(right.id))
    const entries = records.map((record) => ({ record, primary: this.repository.getPrimarySession(record.id) }))
    const revision = createHash("sha256").update(JSON.stringify([includeHidden, entries])).digest("hex")
    const matches = entries.filter(({ record, primary }) => !normalized || [record.projectName, record.projectDirectory, record.id,
      primary?.sessionId ?? "", primary?.title ?? ""].some((value) => value.toLocaleLowerCase("zh-TW").includes(normalized)))
    return { records: matches.map((entry) => entry.record), summary: { total: matches.length, revision } }
  }

  async history(query = "", includeHidden = false, offset = 0, revision?: string): Promise<HistoryResponse> {
    const page = this.historyRecords(includeHidden, query)
    // 分頁前確認 membership 未改變；不能用舊 offset 接上新清單而漏列或重複。
    if (revision && revision !== page.summary.revision) throw new ManagerError("HISTORY_CHANGED", "停止歷史已更新，請重新載入。", 409)
    const records = page.records.slice(offset, offset + 20)
    return { ...page.summary, instances: await Promise.all(records.map(async (record) => compactInstance(await this.snapshots.present(record)))),
      nextOffset: offset + records.length < page.summary.total ? offset + records.length : null }
  }

  async instance(id: string): Promise<ManagedInstance | null> {
    const record = this.requireInstance(id)
    // 此 seam 只補 current 投影之外的持久 stopped detail；active 已在當輪 overview 探測過，不可再完整 probe。
    return record.state === "stopped" ? compactInstance(await this.snapshots.present(record)) : null
  }

  async browse(directory: string): Promise<DirectoryListing> {
    return await this.directories.browse(directory)
  }

  private get directories() {
    return (typeof this.runtime === "function" ? undefined : this.runtime.directories) ?? localDirectories
  }

  async createShortcut(input: { name: string; directory: string }): Promise<DirectoryShortcut> {
    const now = new Date().toISOString()
    return this.repository.createShortcut({
      id: randomUUID(),
      name: validName(input.name),
      directory: await this.directories.resolve(input.directory),
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
      directory: await this.directories.resolve(input.directory),
      updatedAt: new Date().toISOString(),
    })
    if (!updated) throw new ManagerError("SHORTCUT_NOT_FOUND", "找不到 Directory Shortcut。", 404)
    return updated
  }

  deleteShortcut(id: string): void {
    if (!this.repository.deleteShortcut(id)) throw new ManagerError("SHORTCUT_NOT_FOUND", "找不到 Directory Shortcut。", 404)
  }

  async start(directoryInput: string, observeActivity = true, resumeRuntime?: RuntimePort): Promise<ManagedInstance> {
    const runtime = resumeRuntime ?? (typeof this.runtime === "function" ? undefined : this.runtime)
    const directory = await (runtime?.directories ?? this.directories).resolve(directoryInput)
    const allocation = runtime?.allocationScope
      ? await this.reserveScopedExecution(directory, runtime)
      : await this.reservePort("headless", directory, null)
    const record = newInstanceRecord(allocation, directory, null)
    this.repository.createReservedInstance(allocation.id, record)
    if (resumeRuntime) this.instanceRuntimes.set(record.id, resumeRuntime)

    try {
      const launch = await this.runtimeFor(record).launch(directory, allocation.port, allocation.id, allocation.allocationScope)
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
    // 註冊時先保留 explicit -s；starting 的 recheck 會取消初次驗證，但不可一起遺失使用者指定的 target。
    if (input.resumedSessionId) this.resumeIntents.set(record.id, {
      record, sessionId: input.resumedSessionId, deadline: null, attempts: 0,
    })
    // Local TUI owns the console. Readiness proof runs independently and never grants OMW Stop authority.
    const controller = new AbortController()
    const startedAt = performance.now()
    const deadline = startedAt + INITIAL_LOCAL_VERIFICATION_BUDGET_MS
    const timer = setTimeout(() => {
      // readiness 的底層 Promise 可能仍未完成；外層到期就留下 terminal，不能等舊 async 回來報成功。
      this.finishLocalVerificationDiagnostic(record.id, verification, "timeout")
      controller.abort(new ManagerError("LOCAL_TUI_VERIFICATION_TIMEOUT", "Local TUI 初次驗證超時。", 409))
    }, INITIAL_LOCAL_VERIFICATION_BUDGET_MS)
    const verification: LocalVerification = {
      controller, deadline, timer, startedAt, stageStartedAt: startedAt,
      stage: "inspect", attempt: 0, phasePending: false, finished: false,
    }
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
    this.cancelResumeBinding(record.id)
    this.resumeIntents.delete(record.id)
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
    this.resumeIntents.delete(record.id)
    this.closeActivityObserver(record.id)
    if (await loopbackPortAvailable(record.port)) this.repository.releaseAllocationForInstance(record.id)
    return await this.present(record)
  }

  async recheck(id: string): Promise<ManagedInstance> {
    const interrupted = this.localVerifications.has(id)
    const registration = interrupted ? this.repository.getInstance(id) : null
    this.cancelLocalVerification(id)
    this.cancelResumeBinding(id)
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
    if (hidden) {
      this.cancelLocalVerification(id)
      this.cancelResumeBinding(id)
      this.resumeIntents.delete(id)
    }
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
      this.resumeIntents.delete(id)
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

  async primaryTodos(id: string): Promise<PrimaryTodosResponse> {
    const record = this.requireInstance(id)
    const primary = this.repository.getPrimarySession(id)
    if (!primary) return { instanceId: id, sessionId: null, todos: [] }
    this.requireCapability(record, "sessions")
    const runtime = this.runtimeFor(record)
    if (!runtime.todos) throw new ManagerError("AGENT_CAPABILITY_UNSUPPORTED", "Runtime 不支援 Session todo。", 501)
    await this.requireFreshEndpointIdentity(record)
    // 只用 Instance 綁定的 root ID；不接受外部 session ID，也不以共用 Project 歷史推斷歸屬。
    if (this.repository.getPrimarySession(id)?.sessionId !== primary.sessionId) {
      throw new ManagerError("SESSION_BINDING_CHANGED", "主要 Session 綁定已變更，請重新載入。", 409)
    }
    let todos
    try {
      todos = await runtime.todos(record, primary.sessionId)
    } catch {
      throw new ManagerError("SESSION_TODOS_UNAVAILABLE", "目前無法讀取主 Session todo。", 502)
    }
    if (this.repository.getPrimarySession(id)?.sessionId !== primary.sessionId) {
      throw new ManagerError("SESSION_BINDING_CHANGED", "主要 Session 綁定已變更，請重新載入。", 409)
    }
    return { instanceId: id, sessionId: primary.sessionId, todos }
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
    for (const id of this.resumeBindings.keys()) this.cancelResumeBinding(id)
    this.resumeIntents.clear()
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
    this.cancelResumeBinding(id)
    const record = this.requireInstance(id)
    if (record.state === "stopped") return await this.present(record)
    record.state = "unreachable"
    record.healthVersion = null
    record.error = "INSTANCE_IDENTITY_UNVERIFIED"

    if (!hasExactIdentity(record)) {
      this.rejectResumeBinding(id)
      this.repository.saveInstance(record)
      this.closeActivityObserver(id)
      return await this.present(record)
    }

    let identity: InspectResult
    try {
      identity = await this.runtimeFor(record).inspect(record)
    } catch {
      this.rejectResumeBinding(id)
      record.error = "INSTANCE_IDENTITY_CHECK_FAILED"
      this.repository.saveInstance(record)
      this.closeActivityObserver(id)
      return await this.present(record)
    }

    if (identity.processState === "not-found" && !identity.portOwnedByOther) {
      this.rejectResumeBinding(id)
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
      this.rejectResumeBinding(id)
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
      this.continueResumeBinding(id)
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

  async workerCapacity(): Promise<import("@omw/contracts").WorkerCapacity> {
    if (typeof this.runtime === "function" || !this.runtime.allocationScope) throw new ManagerError("WORKER_UNSUPPORTED", "目前 Runtime 不提供 Worker capacity。", 409)
    try {
      const authority = await this.runtime.allocationScope()
      const reserved = this.repository.allocationScopes().some((allocation) => allocation.scope === null || allocation.scope === authority.scope)
      return { state: authority.state === "available" && reserved ? "unknown" : authority.state, maxInstances: 1 }
    } catch { return { state: "unknown", maxInstances: 1 } }
  }

  private async reserveScopedExecution(directory: string, runtime: RuntimePort): Promise<PortAllocation> {
    const previous = this.repository.allocationScopes()
    const authority = await runtime.allocationScope!()
    if (authority.state !== "available") throw new ManagerError("WORKER_CAPACITY_UNAVAILABLE", "Worker execution 目前忙碌或狀態未知。", 409)
    const allocation: PortAllocation = { id: randomUUID(), kind: "headless", clientInvocationId: null,
      projectDirectory: directory, port: this.portPool.min, createdAt: new Date().toISOString(), expiresAt: null,
      instanceId: null, allocationScope: authority.scope }
    const obsolete = previous.filter((entry) => entry.scope !== null && entry.scope !== authority.scope).map((entry) => entry.id)
    if (!this.repository.tryCreateAllocation(allocation, obsolete)) throw new ManagerError("WORKER_CAPACITY_UNAVAILABLE", "Worker execution 啟動 slot 尚未釋放。", 409)
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
    this.finishLocalVerificationDiagnostic(id, verification, "cancelled")
    this.localVerifications.delete(id)
    clearTimeout(verification.timer)
    verification.controller.abort()
  }

  private cancelResumeBinding(id: string): void {
    const observerState = this.activityObservers.get(id)
    // Root 綁定後已重放但還在非同步核對的 /new，也不可跨 recheck 世代繼續換綁。
    if (observerState?.candidate?.resumeBinding) observerState.candidate = null
    const binding = this.resumeBindings.get(id)
    if (!binding) return
    this.resumeBindings.delete(id)
    if (observerState?.pendingResumeCandidate?.binding === binding) observerState.pendingResumeCandidate = null
    clearTimeout(binding.timer)
    binding.controller.abort()
  }

  private rejectResumeBinding(id: string): void {
    const intent = this.resumeIntents.get(id)
    if (intent) intent.attempts = RESUME_BINDING_RETRY_DELAYS_MS.length
    this.cancelResumeBinding(id)
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

  private recordLocalVerificationDiagnostic(id: string, verification: LocalVerification, event: LocalVerificationDiagnostic["event"], result: LocalVerificationDiagnostic["result"]): void {
    try {
      const now = performance.now()
      this.localVerificationDiagnostics?.({
        event, instanceId: id, attempt: verification.attempt, stage: verification.stage, result,
        elapsedMs: Math.max(0, now - verification.startedAt),
        stageElapsedMs: Math.max(0, now - verification.stageStartedAt),
        remainingMs: Math.max(0, verification.deadline - now),
      })
    } catch { /* sink throw 不可改變 identity、deadline 或取消行為 */ }
  }

  private startLocalVerificationPhase(id: string, verification: LocalVerification, stage: LocalVerificationDiagnostic["stage"]): void {
    verification.stage = stage
    verification.stageStartedAt = performance.now()
    verification.phasePending = true
    this.recordLocalVerificationDiagnostic(id, verification, "local_tui_verify_phase_started", "pending")
  }

  private completeLocalVerificationPhase(id: string, verification: LocalVerification, result: LocalVerificationDiagnostic["result"]): void {
    if (verification.finished || !verification.phasePending) return
    verification.phasePending = false
    this.recordLocalVerificationDiagnostic(id, verification, "local_tui_verify_phase_completed", result)
  }

  private finishLocalVerificationDiagnostic(id: string, verification: LocalVerification, result: "success" | "timeout" | "failed" | "cancelled"): void {
    if (verification.finished) return
    this.completeLocalVerificationPhase(id, verification, result)
    verification.finished = true
    this.recordLocalVerificationDiagnostic(id, verification, "local_tui_verify_finished", result)
  }

  private async verifyLocalRegistration(id: string, verification: LocalVerification): Promise<void> {
    const record = this.repository.getInstance(id)
    try {
      if (!record || record.kind !== "local-tui") return
      while (this.localVerificationCurrent(id, record, verification)) {
        if (performance.now() >= verification.deadline) break
        verification.attempt++
        this.startLocalVerificationPhase(id, verification, "inspect")
        let identity: InspectResult
        try {
          identity = await awaitLocalVerification(this.runtimeFor(record).inspect(record), verification.controller.signal)
        } catch (error) {
          // 只有當前世代的 inspect 真正失敗才終止 resume；recheck 取消舊 await 不得毒化新驗證。
          if (this.localVerificationCurrent(id, record, verification)) this.rejectResumeBinding(id)
          throw error
        }
        if (!this.localVerificationCurrent(id, record, verification)) return
        if (performance.now() >= verification.deadline) break
        if (!identity.running || !identity.matched || identity.portOwnedByOther) {
          this.completeLocalVerificationPhase(id, verification, "identity_unverified")
          this.rejectResumeBinding(id)
          throw new ManagerError("INSTANCE_IDENTITY_UNVERIFIED", "Local TUI process identity 或 port owner 無法核對。", 409)
        }
        this.completeLocalVerificationPhase(id, verification, identity.portOwnerMatched ? "listener_confirmed" : "listener_pending")
        if (identity.portOwnerMatched) {
          this.startLocalVerificationPhase(id, verification, "readiness")
          const runtime = this.runtimeFor(record)
          const health = await awaitLocalVerification(runtime.readiness(record, {
            attempt: verification.attempt, deadline: verification.deadline, signal: verification.controller.signal,
          }), verification.controller.signal)
          if (!this.localVerificationCurrent(id, record, verification)) return
          if (performance.now() >= verification.deadline) break
          this.completeLocalVerificationPhase(id, verification, "completed")
          const current = this.repository.getInstance(id)!
          current.state = "ready"
          current.healthVersion = health.version
          current.error = null
          this.repository.saveInstance(current)
          this.continueResumeBinding(current.id)
          this.ensureActivityObserver(current)
          this.finishLocalVerificationDiagnostic(id, verification, "success")
          return
        }
        // #65: exact process 已核對但 listener 尚未出現；不可把無 foreign owner 當成 ready 證據。
        this.startLocalVerificationPhase(id, verification, "listener_wait")
        await awaitLocalVerification(delay(Math.min(LOCAL_VERIFICATION_INTERVAL_MS, verification.deadline - performance.now())), verification.controller.signal)
        if (this.localVerificationCurrent(id, record, verification) && performance.now() < verification.deadline) {
          this.completeLocalVerificationPhase(id, verification, "completed")
        }
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
      this.finishLocalVerificationDiagnostic(id, verification, current.error === "LOCAL_TUI_VERIFICATION_TIMEOUT" ? "timeout" : "failed")
    } finally {
      this.finishLocalVerificationDiagnostic(id, verification, "cancelled")
      if (this.localVerifications.get(id) === verification) this.localVerifications.delete(id)
      clearTimeout(verification.timer)
      verification.controller.abort()
    }
  }

  private continueResumeBinding(id: string): void {
    const intent = this.resumeIntents.get(id)
    if (!intent || this.shuttingDown || this.resumeBindings.has(id) || intent.attempts >= RESUME_BINDING_RETRY_DELAYS_MS.length) return
    const current = this.repository.getInstance(id)
    if (!current || current.state !== "ready" || current.trackingHidden || !sameInstanceIdentity(current, intent.record)
      || this.repository.getPrimarySession(id)) return
    // 首次核對為 ready 才起算；之後的 recheck 只接續剩餘額度，過期 callback 不得延長期限。
    const deadline = intent.deadline ?? (intent.deadline = Date.now() + RESUME_BINDING_DEADLINE_MS)
    if (Date.now() >= deadline) return
    const controller = new AbortController()
    // recheck 僅暫停舊 callback，不能重設原先的時間或嘗試次數上限。
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()))
    const binding = { controller, timer }
    this.resumeBindings.set(id, binding)
    void this.bindExplicitResume(intent, binding)
  }

  private resumeBindingCurrent(intent: ResumeIntent, binding: ResumeBinding): boolean {
    const current = this.repository.getInstance(intent.record.id)
    return !this.shuttingDown && this.resumeIntents.get(intent.record.id) === intent
      && this.resumeBindings.get(intent.record.id) === binding && intent.deadline !== null && Date.now() < intent.deadline
      && !binding.controller.signal.aborted && current?.state === "ready" && !current.trackingHidden
      && sameInstanceIdentity(current, intent.record) && !this.repository.getPrimarySession(intent.record.id)
  }

  private async bindExplicitResume(intent: ResumeIntent, binding: ResumeBinding): Promise<void> {
    const { record, sessionId } = intent
    try {
      while (intent.attempts < RESUME_BINDING_RETRY_DELAYS_MS.length) {
        const wait = RESUME_BINDING_RETRY_DELAYS_MS[intent.attempts]!
        if (wait) await awaitLocalVerification(delay(wait), binding.controller.signal)
        if (!this.resumeBindingCurrent(intent, binding)) return
        intent.attempts++
        // #85: 只以 launcher 明確的 -s 及當前 Instance 的 scoped metadata 找 root；idle 和共用 Project 清單不是歸屬證據。
        try {
          await awaitLocalVerification(this.requireFreshEndpointIdentity(record), binding.controller.signal)
        } catch {
          if (this.resumeBindingCurrent(intent, binding)) intent.attempts = RESUME_BINDING_RETRY_DELAYS_MS.length
          return // Identity/owner 失敗不可藉由 metadata retry 放寬。
        }
        if (!this.resumeBindingCurrent(intent, binding)) return
        let root: SessionMetadata | null
        try {
          this.requireCapability(record, "sessions")
          const sessions = await awaitLocalVerification(this.runtimeFor(record).sessions(record), binding.controller.signal)
          if (!this.resumeBindingCurrent(intent, binding)) return
          root = resolveActivityRoot([sessionId], sessions)
        } catch {
          // 暫時不可讀或解析不完整時僅重試固定次數，絕不猜測最近的 Session。
          continue
        }
        if (!root) continue
        try {
          await awaitLocalVerification(this.requireFreshEndpointIdentity(record), binding.controller.signal)
        } catch {
          if (this.resumeBindingCurrent(intent, binding)) intent.attempts = RESUME_BINDING_RETRY_DELAYS_MS.length
          return // Metadata 後的 identity 失敗也必須立即拒絕，不可當成 metadata 暫時失敗重試。
        }
        if (!this.resumeBindingCurrent(intent, binding)) return
        this.requireCapability(record, "sessions")
        // Await 之後只用 absent CAS；後來的 manual choice 或其他有效綁定都不可被延遲結果覆寫。
        // 既有持久化 schema 只接受 activity/new-session/manual；resume 也是自動建立的綁定。
        const primarySession = primarySessionFrom(root, "activity")
        if (this.repository.bindPrimarySessionIfAbsent(record.id, primarySession)) {
          const observerState = this.activityObservers.get(record.id)
          const buffered = observerState?.pendingResumeCandidate
          this.invalidateOverviewSnapshots()
          this.primarySessionChanged(record)
          // #89: -s 的 metadata 查詢期間若收到 /new created，保留同一世代的候選；
          // busy 已到才重放，否則等真正的後續 activity，兩者都走原 candidate 驗證與 CAS。
          if (buffered?.intent === intent && buffered.binding === binding
            && observerState && this.activityObservers.get(record.id) === observerState
            && observerState.connectionToken === buffered.connectionToken) {
            observerState.candidate = { sessionId: buffered.sessionId, expectedPrimary: primarySession, resumeBinding: binding }
            if (buffered.activity) void this.handleActivityEvent(record.id, observerState, buffered.connectionToken, buffered.activity)
          }
        }
        return
      }
    } catch {
      // finalize、shutdown 或後來的明確改選會中止尚在等待的非同步查詢。
    } finally {
      if (this.resumeBindings.get(record.id) === binding) this.resumeBindings.delete(record.id)
      const observerState = this.activityObservers.get(record.id)
      if (observerState?.pendingResumeCandidate?.binding === binding) observerState.pendingResumeCandidate = null
      clearTimeout(binding.timer)
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
      pendingResumeCandidate: null,
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
    state.pendingResumeCandidate = null
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
    const intent = this.resumeIntents.get(id)
    if (intent) {
      const binding = this.resumeBindings.get(id)
      if (!binding || !this.resumeBindingCurrent(intent, binding)) return
      if (event.type === "session-created") {
        observerState.pendingResumeCandidate = event.sessionId === intent.sessionId ? null
          : { intent, binding, connectionToken, sessionId: event.sessionId, activity: null }
      } else {
        const candidate = observerState.pendingResumeCandidate
        if (candidate?.intent === intent && candidate.binding === binding
          && event.sessionIds.includes(candidate.sessionId)) {
          candidate.activity = { ...event, sessionIds: [...event.sessionIds] }
        }
      }
      return
    }
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
    this.cancelResumeBinding(record.id)
    this.resumeIntents.delete(record.id)
    const observerState = this.activityObservers.get(record.id)
    if (observerState) {
      observerState.candidate = null
      observerState.pendingResumeCandidate = null
    }
    if ((record.kind ?? "headless") === "local-tui") this.ensureActivityObserver(record)
    else this.closeActivityObserver(record.id)
  }

  private closeActivityObserver(id: string): void {
    const state = this.activityObservers.get(id)
    if (!state) return
    this.activityObservers.delete(id)
    state.connectionToken = null
    state.pendingResumeCandidate = null
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
    ...(instance.sessions ?? []).flatMap((session) => [session.title, session.id]),
  ].some((value) => value.toLocaleLowerCase("zh-TW").includes(query))
}

function compactInstance(instance: ManagedInstance): ManagedInstance {
  const { sessions: _sessions, ...compact } = instance
  return compact
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
  if (process.platform !== "win32") return path.resolve(left) === path.resolve(right)
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
