export type InstanceState = "starting" | "ready" | "failed" | "unreachable" | "stopped"
export type InstanceKind = "headless" | "local-tui"
export type OverviewFilter = "all" | "active" | "attention" | "unreachable"
export type ActivityState = "busy" | "reported-non-busy" | "none-reported" | "unknown"

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

export interface PrimarySession {
  sessionId: string
  title: string
  source: "activity" | "new-session" | "manual"
  boundAt: string
}

export interface ManagedInstance {
  id: string
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
  checkedAt: string
  mode: "loopback" | "tailnet"
  manager: { localUrl: string; publicUrl: string | null }
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
  nodeVersion: string
}
