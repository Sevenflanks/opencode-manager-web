import type { ManagedInstance } from "@omw/contracts"
import type { InstanceRecord, ManagerRepository } from "./repository.js"
import type { InspectResult, RuntimePort, RuntimeSummary } from "./runtime.js"
import { availableSummary, capabilitiesFor, supports } from "./capabilities.js"
import { summarizePrimarySession } from "./session-projection.js"

const EMPTY_SUMMARY: RuntimeSummary = {
  activity: "unknown", busySessions: null, pendingQuestions: null, pendingPermissions: null, error: null, sessions: [],
}

// Snapshot singleflight、probe concurrency 與呈現降級由 OMW 一起持有；mutation 只需宣告 invalidation，
// 不必知道 snapshot key 或清理順序，adapter 也不能改變 snapshot freshness。
export class InstanceOverview {
  private readonly inFlight = new Map<boolean, Promise<ManagedInstance[]>>()

  constructor(
    private readonly repository: ManagerRepository,
    private readonly runtimeFor: (record: InstanceRecord) => RuntimePort,
    private readonly verifyRemoteUrl?: (port: number) => Promise<void>,
  ) {}

  invalidate(): void { this.inFlight.clear() }

  async load(includeHidden: boolean): Promise<ManagedInstance[]> {
    const existing = this.inFlight.get(includeHidden)
    if (existing) return await existing
    const records = this.repository.listInstances().filter((record) => includeHidden || !record.trackingHidden)
    const request = this.probe(records)
    this.inFlight.set(includeHidden, request)
    try {
      return (await request).filter((instance) => this.repository.getInstance(instance.id) !== null)
    } finally {
      // Mutation 後可能已建立新 snapshot；舊 request 不可清掉新 generation。
      if (this.inFlight.get(includeHidden) === request) this.inFlight.delete(includeHidden)
    }
  }

  private async probe(records: InstanceRecord[]): Promise<ManagedInstance[]> {
    const results = new Array<ManagedInstance>(records.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(4, records.length) }, async () => {
      while (next < records.length) {
        const index = next++
        results[index] = await this.present(records[index]!, true)
      }
    }))
    return results
  }

  async present(record: InstanceRecord, refreshRemoteUrl = false): Promise<ManagedInstance> {
    const runtime = this.runtimeFor(record)
    const capabilities = capabilitiesFor(runtime, record)
    const primaryBeforeProbe = this.repository.getPrimarySession(record.id)
    let summary: RuntimeSummary = { ...EMPTY_SUMMARY, sessions: [] }
    let stopAllowed = false
    let state = record.state
    let metadataVerified = false
    let remoteFailure: string | null = null
    // 每次 overview 仍須重新驗證 remote；立即附上 rejection handler，避免 summary 等待期間的 unhandled rejection。
    const verifyRemote = () => Promise.resolve().then(() => this.verifyRemoteUrl?.(record.port))
      .catch(() => { remoteFailure = "Tailscale Serve 映射尚未通過驗證。" })
    let remoteVerification: Promise<void> | undefined
    if (!record.trackingHidden && record.state !== "stopped" && record.pid != null) {
      let identity: InspectResult | null = null
      try { identity = await runtime.inspect(record) } catch {
        state = "unreachable"
        summary.error = "INSTANCE_IDENTITY_CHECK_FAILED"
      }
      if (refreshRemoteUrl) remoteVerification = verifyRemote()
      if (identity) {
        // Listener 暫時消失仍可停止已核對的原 root；他人占用 port 則 fail closed。
        stopAllowed = (record.kind ?? "headless") === "headless" && identity.running && identity.matched && !identity.portOwnedByOther
        if (!identity.running || !identity.matched || !identity.portOwnerMatched || identity.portOwnedByOther) {
          state = "unreachable"
          summary.error = "INSTANCE_IDENTITY_UNVERIFIED"
        } else {
          try {
            const readable = (["sessions", "activity", "pendingQuestions", "pendingPermissions"] as const)
              .some((name) => supports(capabilities, name))
            const result = availableSummary(readable ? await runtime.summary(record) : { ...EMPTY_SUMMARY }, capabilities)
            summary = { ...result, error: result.error === null ? null : "INSTANCE_SUMMARY_PARTIAL" }
            metadataVerified = true
          } catch {
            state = "unreachable"
            summary = { ...EMPTY_SUMMARY, sessions: [], error: "INSTANCE_SUMMARY_FAILED" }
          }
        }
      }
    }
    if (metadataVerified && primaryBeforeProbe) {
      const metadata = summary.sessions.find((session) => session.id === primaryBeforeProbe.sessionId)
      if (metadata && metadata.title !== primaryBeforeProbe.title) {
        this.repository.updatePrimarySessionTitle(record.id, primaryBeforeProbe, metadata.title)
      }
    }
    const primarySession = this.repository.getPrimarySession(record.id)
    const primarySummary = summarizePrimarySession(summary, primarySession)
    // Scope 不完整只降級 scoped summary；原始 activity 仍可靠時不污染 lifecycle。
    if (record.state === "ready" && supports(capabilities, "activity") && primarySummary.activity === "unknown"
      && (primarySummary.scope !== "unknown" || summary.activity === "unknown")) state = "unreachable"
    const trackingHidden = record.trackingHidden ?? false
    const removeAllowed = state === "stopped" && this.repository.getAllocationForInstance(record.id) === null
    if (refreshRemoteUrl) {
      await (remoteVerification ?? verifyRemote())
    }
    const remoteUrlUnavailableReason = capabilities.nativeWeb?.state === "unsupported"
      ? "Runtime 不支援原生 Web URL。"
      : capabilities.nativeWeb?.state === "unavailable" ? capabilities.nativeWeb.reason
        : runtime.remoteUrlUnavailableReason?.(record) ?? remoteFailure
    return {
      id: record.id,
      agentFamily: runtime.agentFamily ?? "opencode",
      ...(Object.keys(capabilities).length ? { capabilities } : {}),
      kind: record.kind ?? "headless", projectName: record.projectName, projectDirectory: record.projectDirectory,
      state, endpoint: record.endpoint, port: record.port, pid: record.pid, launchedAt: record.launchedAt,
      healthVersion: record.healthVersion, stopAllowed, remoteUrlUnavailableReason, primarySession, primarySummary, trackingHidden,
      recovery: {
        recheckAllowed: state === "unreachable" || state === "failed",
        resumeAllowed: supports(capabilities, "sessions") && primarySession !== null && (state === "unreachable" || state === "stopped"),
        hideAllowed: trackingHidden || state === "unreachable" || state === "failed", removeAllowed,
      },
      error: summary.error ?? safeStoredError(record.error),
      summary: { activity: summary.activity, busySessions: summary.busySessions, pendingQuestions: summary.pendingQuestions,
        pendingPermissions: summary.pendingPermissions, error: summary.error },
      sessions: summary.sessions,
    }
  }
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
  "LOCAL_TUI_VERIFICATION_TIMEOUT",
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
