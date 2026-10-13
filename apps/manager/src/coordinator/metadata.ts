import type { AgentCapabilities, CoordinatorWorker, InstanceSummary, ManagedInstance, PrimarySessionSummary, SessionMetadata } from "@omw/contracts"

type ObjectValue = Record<string, unknown>
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("WORKER_METADATA_INVALID")
  return value as ObjectValue
}
function text(value: unknown, maximum = 4096): string {
  if (typeof value !== "string" || value.length > maximum) throw new Error("WORKER_METADATA_INVALID")
  return value
}
function nullableText(value: unknown, maximum = 4096): string | null { return value === null ? null : text(value, maximum) }
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("WORKER_METADATA_INVALID")
  return value
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error("WORKER_METADATA_INVALID")
  return value
}
function count(value: unknown): number | null { return value === null ? null : integer(value) }
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw new Error("WORKER_METADATA_INVALID")
  return value as T
}
function summary(value: unknown): InstanceSummary {
  const input = object(value)
  const error = nullableText(input.error)
  return { activity: choice(input.activity, ["busy", "reported-non-busy", "none-reported", "unknown"]),
    busySessions: count(input.busySessions), pendingQuestions: count(input.pendingQuestions), pendingPermissions: count(input.pendingPermissions),
    error: error ? "WORKER_METADATA_ERROR" : null }
}
function primarySummary(value: unknown): PrimarySessionSummary {
  const input = object(value)
  return { ...summary(input), scope: choice(input.scope, ["known", "unbound", "unknown"]), retrySessions: count(input.retrySessions) }
}
function session(value: unknown): SessionMetadata {
  const input = object(value)
  return { id: text(input.id, 2048), title: text(input.title),
    ...(input.parentID !== undefined ? { parentID: text(input.parentID, 2048) } : {}),
    ...(input.updatedAt !== undefined ? { updatedAt: integer(input.updatedAt) } : {}) }
}
function capabilities(value: unknown): AgentCapabilities {
  const input = object(value)
  const output: AgentCapabilities = {}
  for (const name of ["sessions", "sessionCreation", "activity", "pendingQuestions", "pendingPermissions", "nativeWeb"] as const) {
    if (input[name] === undefined) continue
    const capability = object(input[name])
    const state = choice(capability.state, ["supported", "unsupported", "unavailable"])
    output[name] = state === "unavailable" ? { state, reason: text(capability.reason) } : { state }
  }
  return output
}

// Worker 回應不是 public DTO：逐層投影已知欄位，避免 extra credentials/token 進入 overview 與私有 checkpoint。
// 不以 secret substring 篩正常 Session 文字；必要欄位壞掉則整批 snapshot 保留為 stale。
export function projectInstance(value: unknown): ManagedInstance {
  const input = object(value)
  const recovery = object(input.recovery)
  const primary = input.primarySession === null ? null : object(input.primarySession)
  const error = nullableText(input.error)
  const port = integer(input.port, 65535)
  if (port === 0) throw new Error("WORKER_METADATA_INVALID")
  const output: ManagedInstance = {
    id: text(input.id, 2048), kind: choice(input.kind, ["headless", "local-tui"]),
    projectName: text(input.projectName), projectDirectory: text(input.projectDirectory),
    state: choice(input.state, ["starting", "ready", "failed", "unreachable", "stopped"]), endpoint: text(input.endpoint), port,
    pid: input.pid === null ? null : integer(input.pid), launchedAt: text(input.launchedAt, 128), healthVersion: nullableText(input.healthVersion, 256),
    stopAllowed: boolean(input.stopAllowed), remoteUrlUnavailableReason: nullableText(input.remoteUrlUnavailableReason), error: error ? "WORKER_INSTANCE_ERROR" : null,
    summary: summary(input.summary), primarySummary: primarySummary(input.primarySummary),
    primarySession: primary ? { sessionId: text(primary.sessionId, 2048), title: text(primary.title),
      source: choice(primary.source, ["activity", "new-session", "manual"]), boundAt: text(primary.boundAt, 128) } : null,
    trackingHidden: boolean(input.trackingHidden), recovery: { recheckAllowed: boolean(recovery.recheckAllowed), resumeAllowed: boolean(recovery.resumeAllowed),
      hideAllowed: boolean(recovery.hideAllowed), removeAllowed: boolean(recovery.removeAllowed) },
  }
  if (!output.id) throw new Error("WORKER_METADATA_INVALID")
  if (input.agentFamily !== undefined) output.agentFamily = text(input.agentFamily, 256)
  if (input.capabilities !== undefined) output.capabilities = capabilities(input.capabilities)
  if (input.sessions !== undefined) {
    if (!Array.isArray(input.sessions) || input.sessions.length > 1000) throw new Error("WORKER_METADATA_INVALID")
    output.sessions = input.sessions.map(session)
  }
  return output
}
export function projectInstances(value: unknown): ManagedInstance[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error("WORKER_METADATA_INVALID")
  return value.map(projectInstance)
}
export function projectCapacity(value: unknown): NonNullable<CoordinatorWorker["capacity"]> {
  const input = object(value)
  const maxInstances = integer(input.maxInstances)
  if (!maxInstances) throw new Error("WORKER_METADATA_INVALID")
  return { state: choice(input.state, ["available", "occupied", "unknown"]), maxInstances }
}

export function projectStoredWorker(value: unknown): CoordinatorWorker {
  const input = object(value)
  return { id: text(input.id, 50), generation: text(input.generation, 128), name: text(input.name, 80),
    kind: choice(input.kind, ["task", "resident"]), health: choice(input.health, ["connecting", "online", "unstable", "offline"]),
    address: text(input.address, 15), nativeOrigin: text(input.nativeOrigin, 4096), registeredAt: text(input.registeredAt, 128),
    lastCheckedAt: nullableText(input.lastCheckedAt, 128), lastHealthyAt: nullableText(input.lastHealthyAt, 128),
    consecutiveFailures: integer(input.consecutiveFailures), endedAt: nullableText(input.endedAt, 128),
    dataUpdatedAt: nullableText(input.dataUpdatedAt, 128), freshness: choice(input.freshness, ["fresh", "stale", "unknown"]),
    instanceCount: count(input.instanceCount), capacity: input.capacity === null ? null : projectCapacity(input.capacity),
    diagnosticCode: nullableText(input.diagnosticCode, 128) }
}
