export type InstanceState = "starting" | "ready" | "failed" | "unreachable" | "stopped"
export type InstanceKind = "headless" | "local-tui"
export type OverviewFilter = "all" | "active" | "attention" | "unreachable"
export type ActivityState = "busy" | "reported-non-busy" | "none-reported" | "unknown"

// unsupported 是固定能力差異；unavailable 是暫時不可用且必須提供原因。
// 查詢失敗／未知使用既有 summary 的 null + error，不可當成已知為零。
export type AgentCapability = { state: "supported" } | { state: "unsupported" } | { state: "unavailable"; reason: string }
export type AgentCapabilities = Partial<Record<"sessions" | "sessionCreation" | "activity" | "pendingQuestions" | "pendingPermissions" | "nativeWeb", AgentCapability>>

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown }
}

export interface DirectoryShortcut {
  id: string
  name: string
  directory: string
  createdAt: string
  updatedAt: string
}

export interface DirectoryEntry { name: string; path: string }
export interface DirectoryListing {
  current: string
  parent: string | null
  children: DirectoryEntry[]
  errors: Array<{ path: string; message: string }>
}

export interface SessionMetadata {
  id: string
  title: string
  parentID?: string
  updatedAt?: number
}

export interface InstanceSummary {
  activity: ActivityState
  busySessions: number | null
  pendingQuestions: number | null
  pendingPermissions: number | null
  error: string | null
}

export interface PrimarySessionSummary extends InstanceSummary {
  scope: "known" | "unbound" | "unknown"
  retrySessions: number | null
}

export type PrimarySessionDisposition = "attention" | "unknown" | "busy" | "retry"

export function primarySessionDisposition(summary: PrimarySessionSummary): PrimarySessionDisposition {
  if (summary.scope === "unbound") return "attention"
  if (summary.scope === "unknown"
    || summary.activity === "unknown"
    || [summary.busySessions, summary.retrySessions, summary.pendingQuestions, summary.pendingPermissions].some((value) => value === null)) return "unknown"
  if (summary.pendingQuestions! > 0 || summary.pendingPermissions! > 0) return "attention"
  if (summary.busySessions === 0 && summary.retrySessions === 0) return "attention"
  return summary.busySessions! > 0 ? "busy" : "retry"
}

export interface PrimarySession {
  sessionId: string
  title: string
  source: "activity" | "new-session" | "manual"
  boundAt: string
}

export interface ManagedInstance {
  id: string
  agentFamily?: string
  capabilities?: AgentCapabilities
  kind: InstanceKind
  projectName: string
  projectDirectory: string
  state: InstanceState
  endpoint: string
  port: number
  pid: number | null
  launchedAt: string
  healthVersion: string | null
  stopAllowed: boolean
  remoteUrlUnavailableReason: string | null
  error: string | null
  summary: InstanceSummary
  primarySummary: PrimarySessionSummary
  sessions: SessionMetadata[]
  primarySession: PrimarySession | null
  trackingHidden: boolean
  recovery: {
    recheckAllowed: boolean
    resumeAllowed: boolean
    hideAllowed: boolean
    removeAllowed: boolean
  }
}

export interface OverviewResponse { shortcuts: DirectoryShortcut[]; instances: ManagedInstance[] }
export interface SessionRootsResponse { roots: SessionMetadata[]; unknownParent: SessionMetadata[] }
export interface SessionChildrenResponse {
  parentID: string
  children: SessionMetadata[]
  loadedDirectChildren: number
}
export interface OpenUrlResponse { url: string; instanceId: string; sessionId: string | null }

export interface LauncherReservationRequest {
  clientInvocationId: string
  directory: string
  requestedPort?: number
}

export interface LauncherReservationResponse {
  reservationId: string
  hostname: "127.0.0.1"
  port: number
  expiresAt: string | null
  status: "reserved" | "registered"
}

export interface LauncherRegistrationRequest {
  clientInvocationId: string
  pid: number
}

export interface LauncherRegistrationResponse {
  instanceId: string
  state: "starting" | "ready" | "stopped"
}

export interface ConnectivityInfo {
  remoteAccess?: "available" | "enabled" | "disabled"
  checkedAt: string
  mode: "loopback" | "tailnet"
  manager: { localUrl: string; publicUrl: string | null; version?: string }
  tailscale: {
    state: "connected" | "offline" | "needs-login" | "unavailable" | "unknown"
    dnsName: string | null
    version: string | null
  }
  serve: {
    state: "verified" | "mismatch" | "unknown" | "not-configured"
    managerMapped: boolean | null
    mappedInstancePorts: number | null
    expectedInstancePorts: number
    funnel: "disabled" | "enabled" | "unknown"
  }
  registration: {
    state: "not-configured" | "idle" | "registering" | "verified" | "failed"
    trigger: "startup" | "manual" | null
    diagnostic: {
      code: string
      message: string
      nextStep: string
    } | null
  }
  nodeVersion: string
}
