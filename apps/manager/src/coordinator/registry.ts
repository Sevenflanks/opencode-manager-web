import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile, rm, stat } from "node:fs/promises"
import path from "node:path"
import type { CoordinatorInstance, CoordinatorOverview, CoordinatorWorker } from "@omw/contracts"
import { ManagerError } from "../errors.js"
import { addressAllowed, validateCoordinatorConfig, type CoordinatorConfig } from "./config.js"
import { deriveWorkerKey, equalSecret, validGeneration, validWorkerId, workerProof } from "./identity.js"
import { workerJson, type WorkerTarget } from "./transport.js"
import { projectCapacity, projectInstance, projectInstances, projectStoredWorker } from "./metadata.js"

export interface WorkerRegistration extends WorkerTarget { kind: "task" | "resident"; name?: string }
type RecordEntry = { worker: CoordinatorWorker; instances: CoordinatorInstance[]; target?: WorkerTarget; retirement: AbortController }
type Snapshot = { version: 1; records: Array<{ worker: CoordinatorWorker; instances: CoordinatorInstance[] }>; retired: Array<[string, string[]]> }
const MAX_PENDING_ADMISSIONS = 64
const MAX_STORE_BYTES = 8 * 1024 * 1024

// 全部 probes（包含准入與手動 check）共用最多四條 lanes；單一 Worker 的 metadata 不可拖垮 overview。
class ProbePool {
  private active = 0
  private readonly waiters: Array<() => void> = []
  constructor(private readonly lanes = 4, private readonly maximumWaiters = 128) {}
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.lanes) {
      if (this.waiters.length >= this.maximumWaiters) throw new ManagerError("COORDINATOR_PROBE_BUSY", "Coordinator 檢查暫時滿載。", 503)
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    else this.active++
    try { return await operation() }
    finally { const next = this.waiters.shift(); if (next) next(); else this.active-- }
  }
}

export class CoordinatorRegistry {
  private readonly records = new Map<string, RecordEntry>()
  private readonly retired = new Map<string, Set<string>>()
  private readonly pendingAdmissions = new Set<string>()
  private readonly checks = new Map<RecordEntry, Promise<void>>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly pool = new ProbePool()
  // Admission 最多佔兩條共享 lanes；其餘有界候選不佔 health waiter，避免 renew flood 餓死健康檢查。
  private readonly admissionPool = new ProbePool(2, MAX_PENDING_ADMISSIONS)
  private readonly shutdown = new AbortController()
  private persistence: Promise<void> = Promise.resolve()
  private timer: NodeJS.Timeout | undefined
  private closed = false
  private constructor(readonly config: CoordinatorConfig) {}

  static async open(config: CoordinatorConfig): Promise<CoordinatorRegistry> {
    validateCoordinatorConfig(config)
    const registry = new CoordinatorRegistry(config)
    await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 })
    try {
      if ((await stat(registry.file)).size > MAX_STORE_BYTES) throw new Error("COORDINATOR_STORE_INVALID")
      const contents = await readFile(registry.file, "utf8")
      if (Buffer.byteLength(contents) > MAX_STORE_BYTES) throw new Error("COORDINATOR_STORE_INVALID")
      const stored = JSON.parse(contents) as Snapshot
      if (stored.version !== 1 || !Array.isArray(stored.records) || !Array.isArray(stored.retired)) throw new Error("COORDINATOR_STORE_INVALID")
      for (const [id, generations] of stored.retired) {
        if (!validWorkerId(id) || registry.retired.has(id) || !Array.isArray(generations) || !generations.every(validGeneration)) throw new Error("COORDINATOR_STORE_INVALID")
        registry.retired.set(id, new Set(generations))
      }
      for (const record of stored.records) {
        const w = projectStoredWorker(record.worker)
        if (!validWorkerId(w.id) || !validGeneration(w.generation) || !addressAllowed(w.address, config.allowedCidrs)
          || registry.records.has(w.id) || registry.isRetired(w.id, w.generation) || !Array.isArray(record.instances) || record.instances.length > 1000
          || w.nativeOrigin !== `${new URL(config.publicOrigin).protocol}//omw-job-${w.id}-code.${config.nativeHostSuffix}`) throw new Error("COORDINATOR_STORE_INVALID")
        const instances: CoordinatorInstance[] = record.instances.map((item) => {
          if (item.workerId !== w.id || item.generation !== w.generation || item.workerName !== w.name
            || !["fresh", "stale", "unknown"].includes(item.freshness)
            || (item.observedAt !== null && (typeof item.observedAt !== "string" || item.observedAt.length > 128))) throw new Error("COORDINATOR_STORE_INVALID")
          return { workerId: w.id, generation: w.generation, workerName: w.name, freshness: item.freshness, observedAt: item.observedAt,
            instance: projectInstance(item.instance) }
        })
        if (w.instanceCount !== null && w.instanceCount !== instances.length) throw new Error("COORDINATOR_STORE_INVALID")
        // Credentials 只在 memory；重啟後等待 Worker re-register，不從歷史 metadata 推定在線。
        registry.records.set(w.id, { retirement: new AbortController(), worker: { ...w, health: "connecting", freshness: w.dataUpdatedAt ? "stale" : "unknown",
          capacity: null, diagnosticCode: "WORKER_REGISTRATION_REQUIRED" }, instances })
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("COORDINATOR_STORE_INVALID") }
    return registry
  }

  private get file() { return path.join(this.config.dataDirectory, "coordinator.json") }
  private isRetired(id: string, generation: string) { return this.retired.get(id)?.has(generation) === true }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.finally(() => this.operations.delete(operation)).catch(() => {})
    return operation
  }
  private signal(timeoutMs: number) { return AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(timeoutMs)]) }

  validateRegistration(body: unknown): WorkerRegistration {
    const input = body as WorkerRegistration
    if (!input || typeof input !== "object" || Object.keys(input).some((key) => !["id", "generation", "kind", "name", "address", "nativeOrigin", "browser"].includes(key))
      || !validWorkerId(input.id) || !validGeneration(input.generation) || !["task", "resident"].includes(input.kind)
      || (input.name !== undefined && (typeof input.name !== "string" || !input.name.length || input.name.length > 80))
      || typeof input.address !== "string" || !addressAllowed(input.address, this.config.allowedCidrs)
      || input.nativeOrigin !== `${new URL(this.config.publicOrigin).protocol}//omw-job-${input.id}-code.${this.config.nativeHostSuffix}`
      || !input.browser || Object.keys(input.browser).some((key) => !["username", "password"].includes(key))
      || typeof input.browser.username !== "string" || !input.browser.username.length || input.browser.username.length > 256 || /[:\r\n\0]/.test(input.browser.username)
      || typeof input.browser.password !== "string" || input.browser.password.length < 16 || input.browser.password.length > 4096 || /[\r\n\0]/.test(input.browser.password)) {
      throw new ManagerError("WORKER_REGISTRATION_INVALID", "Worker 註冊格式或 endpoint 不符合設定。", 400)
    }
    return structuredClone(input)
  }

  register(body: unknown, key: string): Promise<void> {
    return this.track(this.registerCandidate(body, key))
  }
  private async registerCandidate(body: unknown, key: string): Promise<void> {
    if (this.closed) throw new ManagerError("COORDINATOR_DRAINING", "Coordinator 正在關閉。", 503)
    // 先驗 id-bound key，再解析 address/credentials；不送 master key 到候選 endpoint。
    const id = (body as WorkerRegistration | null)?.id
    if (!validWorkerId(id) || !equalSecret(key, deriveWorkerKey(this.config.registrationSecret, id))) throw new ManagerError("WORKER_AUTH_REQUIRED", "需要有效的 Worker key。", 401)
    // 先 auth，且在 clone credentials 前取得有界 reservation；同 id 不排無上限的密碼 body。
    if (this.pendingAdmissions.has(id)) throw new ManagerError("WORKER_REGISTRATION_BUSY", "此 Worker 正在註冊，請稍後重試。", 429)
    if (this.pendingAdmissions.size >= MAX_PENDING_ADMISSIONS) throw new ManagerError("WORKER_REGISTRATION_BUSY", "Coordinator 註冊暫時滿載。", 503)
    this.pendingAdmissions.add(id)
    try { await this.admit(this.validateRegistration(body), key) }
    finally { this.pendingAdmissions.delete(id) }
  }
  private async admit(candidate: WorkerRegistration, key: string): Promise<void> {
    const id = candidate.id
    if (this.isRetired(id, candidate.generation)) throw new ManagerError("WORKER_GENERATION_RETIRED", "Worker generation 已退役。", 409)
    const previous = this.records.get(id)
    if (previous?.worker.generation === candidate.generation) {
      const w = previous.worker
      if (w.address !== candidate.address || w.kind !== candidate.kind || w.nativeOrigin !== candidate.nativeOrigin
        || (previous.target && (previous.target.browser.username !== candidate.browser.username || !equalSecret(previous.target.browser.password, candidate.browser.password)))) {
        throw new ManagerError("WORKER_REGISTRATION_CONFLICT", "同一 generation 的身分與 endpoint 不可改寫。", 409)
      }
    }
    const renewal = previous?.worker.generation === candidate.generation
    await this.admissionPool.run(() => this.pool.run(async () => {
      if (this.closed) throw new ManagerError("COORDINATOR_DRAINING", "Coordinator 正在關閉。", 503)
      try { await this.prove(candidate, key, this.signal(this.config.healthTimeoutMs)) }
      catch { throw new ManagerError("WORKER_PROOF_UNAVAILABLE", "無法驗證 Worker 身分。", 503) }
    }))
    await this.publish(async () => {
      if (this.closed) throw new ManagerError("COORDINATOR_DRAINING", "Coordinator 正在關閉。", 503)
      if (this.isRetired(id, candidate.generation) || this.records.get(id) !== previous) throw new ManagerError("WORKER_GENERATION_RETIRED", "Worker generation 已變更。", 409)
      if (renewal && previous) {
        // Renew 不改 durable metadata，也不是 health poll；重啟後只恢復 memory credentials。
        previous.target = candidate
        return
      }
      const now = new Date().toISOString()
      const replacement: RecordEntry = { retirement: new AbortController(), target: candidate, instances: [], worker: { id, generation: candidate.generation,
        name: candidate.name ?? id, kind: candidate.kind, address: candidate.address, nativeOrigin: candidate.nativeOrigin, health: "online", registeredAt: now,
        lastCheckedAt: now, lastHealthyAt: now, consecutiveFailures: 0, endedAt: null, dataUpdatedAt: null,
        freshness: "unknown", instanceCount: null, capacity: null, diagnosticCode: null } }
      const generations = new Set(this.retired.get(id))
      if (previous) generations.add(previous.worker.generation)
      // 新 record 與 fence 必須在同一次 durable commit；失敗前不改 maps、不撤銷 old stream/lookup。
      await this.writeSnapshot(this.snapshot(id, replacement, generations))
      this.records.set(id, replacement)
      this.retired.set(id, generations)
      previous?.retirement.abort()
    })
  }

  private async prove(target: WorkerTarget, key: string, signal: AbortSignal): Promise<void> {
    const nonce = randomBytes(24).toString("base64url")
    const proof = await workerJson(target, this.config.publicOrigin, `/api/v1/worker/identity?nonce=${nonce}`, signal) as Record<string, unknown>
    if (proof?.id !== target.id || proof.generation !== target.generation || proof.nonce !== nonce || typeof proof.proof !== "string"
      || !equalSecret(proof.proof, workerProof(key, nonce, target.id, target.generation))) throw new Error("WORKER_PROOF_INVALID")
  }

  lookup(id: string, generation: string): WorkerTarget {
    const record = this.record(id, generation)
    if (!record.target || !["online", "unstable"].includes(record.worker.health)) throw new ManagerError("WORKER_OFFLINE", "Worker 暫時無法連線。", 503)
    return structuredClone(record.target)
  }
  retirementSignal(id: string, generation: string): AbortSignal { return this.record(id, generation).retirement.signal }
  private record(id: string, generation: string): RecordEntry {
    const record = this.records.get(id)
    if (this.isRetired(id, generation) || (record && record.worker.generation !== generation)) throw new ManagerError("WORKER_GENERATION_RETIRED", "Worker generation 已變更。", 409)
    if (!record) throw new ManagerError("WORKER_NOT_FOUND", "找不到已註冊的 Worker。", 404)
    return record
  }
  nativeTarget(host: string): WorkerTarget {
    const match = /^omw-job-([a-z0-9-]+)-code\.(.+)$/.exec(host)
    if (!match || !validWorkerId(match[1]) || match[2] !== this.config.nativeHostSuffix) throw new ManagerError("WORKER_NOT_FOUND", "找不到已註冊的 Worker host。", 404)
    const record = this.records.get(match[1])
    if (!record || new URL(record.worker.nativeOrigin).host !== host) throw new ManagerError("WORKER_NOT_FOUND", "找不到已註冊的 Worker host。", 404)
    return this.lookup(record.worker.id, record.worker.generation)
  }

  check(id: string, generation: string): Promise<void> {
    const record = this.record(id, generation)
    const pending = this.checks.get(record)
    if (pending) return pending
    const operation = this.track(this.pool.run(() => this.probe(record)))
    this.checks.set(record, operation)
    void operation.finally(() => this.checks.delete(record)).catch(() => {})
    return operation
  }
  private async probe(record: RecordEntry): Promise<void> {
    if (this.closed) return
    const { worker, target } = record
    if (!target) return
    const current = () => !this.closed && this.records.get(worker.id) === record && !this.isRetired(worker.id, worker.generation)
    let healthy = false
    try { await this.prove(target, deriveWorkerKey(this.config.registrationSecret, worker.id), this.signal(this.config.healthTimeoutMs)); healthy = true }
    catch { /* health 只採 proof endpoint，不採 metadata 或 registration renewal。 */ }
    if (!current()) return
    await this.updateRecord(record, () => {
      const now = new Date().toISOString()
      const next = { ...record.worker, lastCheckedAt: now }
      if (healthy) {
        next.health = "online"; next.consecutiveFailures = 0; next.lastHealthyAt = now; next.endedAt = null; next.diagnosticCode = null
      } else {
        next.consecutiveFailures++
        next.health = next.consecutiveFailures >= this.config.failureThreshold ? "offline" : "unstable"
        next.freshness = next.dataUpdatedAt ? "stale" : "unknown"; next.capacity = null
        next.diagnosticCode = next.health === "offline" && next.kind === "task" ? "WORKER_RESULT_UNKNOWN" : "WORKER_HEALTH_UNAVAILABLE"
        if (next.health === "offline" && next.kind === "task") next.endedAt ??= now
      }
      return { worker: next }
    })
    if (!healthy || !current()) return
    // Optional metadata 共用另一個 bounded deadline；缺值不改 health，更不能把 unknown 說成 zero。
    const signal = this.signal(this.config.healthTimeoutMs)
    const [overview, capacity] = await Promise.allSettled([
      workerJson(target, this.config.publicOrigin, "/api/v1/overview?view=compact&includeHidden=true", signal),
      workerJson(target, this.config.publicOrigin, "/api/v1/worker/capacity", signal),
    ])
    if (!current()) return
    const data = overview.status === "fulfilled" ? overview.value as { instances?: unknown } : undefined
    let instances: ReturnType<typeof projectInstances> | undefined
    let projectedCapacity: CoordinatorWorker["capacity"] = null
    try { instances = projectInstances(data?.instances) } catch { /* 非完整 public metadata，保留上一份 snapshot。 */ }
    try { if (capacity.status === "fulfilled") projectedCapacity = projectCapacity(capacity.value) } catch { /* Capacity 缺值是 unknown，不是零。 */ }
    await this.updateRecord(record, () => {
      const next = { ...record.worker, capacity: projectedCapacity }
      if (!instances) return { worker: { ...next, freshness: next.dataUpdatedAt ? "stale" : "unknown" } }
      const observedAt = new Date().toISOString()
      const projected: CoordinatorInstance[] = instances.map((instance) => ({ workerId: next.id, generation: next.generation,
        workerName: next.name, freshness: "fresh", observedAt, instance }))
      return { instances: projected, worker: { ...next, instanceCount: projected.length, dataUpdatedAt: observedAt, freshness: "fresh" } }
    })
  }

  overview(): CoordinatorOverview {
    return structuredClone({ checkedAt: new Date().toISOString(), workers: [...this.records.values()].map(({ worker }) => worker),
      instances: [...this.records.values()].flatMap((record) => record.instances.map((instance) => ({ ...instance, freshness: record.worker.freshness }))) })
  }
  start(): void {
    if (this.timer || this.closed) return
    const poll = async () => {
      try { await Promise.allSettled([...this.records.values()].map(({ worker }) => Promise.resolve().then(() => this.check(worker.id, worker.generation)))) }
      finally { if (!this.closed) { this.timer = setTimeout(() => { void poll().catch(() => {}) }, this.config.healthIntervalMs); this.timer.unref() } }
    }
    this.timer = setTimeout(() => { void poll().catch(() => {}) }, 0); this.timer.unref()
  }
  // 全部 state publication 共用一條 queue；snapshot 取最新 state，durable write 成功才更新 maps。
  // 不 rollback 全域 maps，避免失敗的 Worker registration 回收另一 Worker 已成功的 metadata。
  private publish(write: () => Promise<void>): Promise<void> {
    const operation = this.persistence.then(write)
    this.persistence = operation.catch(() => {})
    return operation
  }
  private snapshot(id: string, replacement: RecordEntry, generations?: Set<string>): Snapshot {
    const records = new Map(this.records)
    records.set(id, replacement)
    const retired = new Map(this.retired)
    if (generations) retired.set(id, generations)
    return { version: 1, records: [...records.values()].map(({ worker, instances }) => ({ worker, instances })),
      retired: [...retired].map(([workerId, values]) => [workerId, [...values]]) }
  }
  private updateRecord(record: RecordEntry, update: () => { worker: CoordinatorWorker; instances?: CoordinatorInstance[] }): Promise<void> {
    return this.publish(async () => {
      if (this.closed || this.records.get(record.worker.id) !== record || this.isRetired(record.worker.id, record.worker.generation)) return
      const next = update()
      await this.writeSnapshot(this.snapshot(record.worker.id, { ...record, ...next }))
      record.worker = next.worker
      if (next.instances) record.instances = next.instances
    })
  }
  private async writeSnapshot(snapshot: Snapshot): Promise<void> {
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      const contents = JSON.stringify(snapshot)
      if (Buffer.byteLength(contents) > MAX_STORE_BYTES) throw new Error("COORDINATOR_STORE_LIMIT")
      await writeFile(temporary, contents, { mode: 0o600, flag: "wx" })
      await rename(temporary, this.file)
    } catch { throw new ManagerError("COORDINATOR_STORE_UNAVAILABLE", "Coordinator 無法儲存工作紀錄，請稍後重試。", 503) }
    finally { await rm(temporary, { force: true }).catch(() => {}) }
  }
  async close(): Promise<void> {
    if (!this.closed) { this.closed = true; clearTimeout(this.timer); this.shutdown.abort() }
    await Promise.allSettled([...this.operations]); await this.persistence
  }
}
