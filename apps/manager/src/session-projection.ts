import type { PrimarySession, PrimarySessionSummary, SessionMetadata } from "@omw/contracts"
import type { RuntimeSummary } from "./runtime.js"

export function primarySessionFrom(session: SessionMetadata, source: PrimarySession["source"]): PrimarySession {
  return {
    sessionId: session.id,
    title: session.title,
    source,
    boundAt: new Date().toISOString(),
  }
}

export function resolveActivityRoot(sessionIds: string[], sessions: SessionMetadata[]): SessionMetadata | null {
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

export function summarizePrimarySession(summary: RuntimeSummary, primary: PrimarySession | null): PrimarySessionSummary {
  if (!primary) {
    return {
      scope: "unbound",
      activity: summary.activity,
      busySessions: null,
      retrySessions: null,
      pendingQuestions: null,
      pendingPermissions: null,
      error: summary.error,
    }
  }
  if (summary.sessionsKnown !== true) return unknownPrimarySummary()

  const byId = new Map(summary.sessions.map((session) => [session.id, session]))
  const root = byId.get(primary.sessionId)
  if (!root || root.parentID || !hasCompleteSessionHierarchy(byId)) return unknownPrimarySummary()

  const scopedIds = new Set<string>([root.id])
  let changed = true
  while (changed) {
    changed = false
    for (const session of summary.sessions) {
      if (session.parentID && scopedIds.has(session.parentID) && !scopedIds.has(session.id)) {
        scopedIds.add(session.id)
        changed = true
      }
    }
  }

  const signalSessionIds = [
    ...(summary.sessionStatuses ?? []).map((status) => status.sessionId),
    ...(summary.invalidStatusSessionIds ?? []),
    ...(summary.questionRequests ?? []).map((request) => request.sessionId),
    ...(summary.invalidQuestionSessionIds ?? []),
    ...(summary.permissionRequests ?? []).map((request) => request.sessionId),
    ...(summary.invalidPermissionSessionIds ?? []),
  ]
  if (signalSessionIds.some((sessionId) => !byId.has(sessionId))) return unknownPrimarySummary()

  const statuses = signalKnownInScope(summary.sessionStatuses, summary.invalidStatusSessionIds, scopedIds)
    ? summary.sessionStatuses!.filter((status) => scopedIds.has(status.sessionId))
    : null
  const busySessions = statuses?.filter((status) => status.type === "busy").length ?? null
  const retrySessions = statuses?.filter((status) => status.type === "retry").length ?? null
  const pendingQuestions = scopedRequestCount(summary.questionRequests, summary.invalidQuestionSessionIds, scopedIds)
  const pendingPermissions = scopedRequestCount(summary.permissionRequests, summary.invalidPermissionSessionIds, scopedIds)
  const signalUnknown = statuses === null || pendingQuestions === null || pendingPermissions === null
  return {
    scope: "known",
    activity: statuses === null
      ? "unknown"
      : busySessions! > 0
        ? "busy"
        : statuses.length > 0 ? "reported-non-busy" : "none-reported",
    busySessions,
    retrySessions,
    pendingQuestions,
    pendingPermissions,
    error: signalUnknown ? "PRIMARY_SESSION_SCOPE_UNKNOWN" : null,
  }
}

function signalKnownInScope<T>(
  values: T[] | null | undefined,
  invalidSessionIds: string[] | null | undefined,
  scopedIds: Set<string>,
): values is T[] {
  return values != null
    && invalidSessionIds !== null
    && !invalidSessionIds?.some((sessionId) => scopedIds.has(sessionId))
}

function hasCompleteSessionHierarchy(byId: Map<string, SessionMetadata>): boolean {
  // 缺父層的 Session 可能仍屬於 binding root；忽略它會把不完整 scope 誤報成可靠的零 busy。
  for (const session of byId.values()) {
    const visited = new Set<string>()
    let current: SessionMetadata | undefined = session
    while (current.parentID) {
      if (visited.has(current.id)) return false
      visited.add(current.id)
      current = byId.get(current.parentID)
      if (!current) return false
    }
    if (visited.has(current.id)) return false
  }
  return true
}

function scopedRequestCount(
  requests: RuntimeSummary["questionRequests"],
  invalidSessionIds: string[] | null | undefined,
  scopedIds: Set<string>,
): number | null {
  if (!signalKnownInScope(requests, invalidSessionIds, scopedIds)) return null
  return new Set(requests.filter((request) => scopedIds.has(request.sessionId)).map((request) => request.id)).size
}

function unknownPrimarySummary(): PrimarySessionSummary {
  return {
    scope: "unknown",
    activity: "unknown",
    busySessions: null,
    retrySessions: null,
    pendingQuestions: null,
    pendingPermissions: null,
    error: "PRIMARY_SESSION_SCOPE_UNKNOWN",
  }
}
