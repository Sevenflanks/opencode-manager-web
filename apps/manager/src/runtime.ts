import type { AgentCapabilities, InstanceSummary, SessionMetadata } from "@omw/contracts"
import type { InstanceRecord } from "./repository.js"

// 保留既有 import contract；Agent 協定與啟動細節只存在 adapter namespace。
export { OpenCodeRuntime, managedServerEnvironment } from "./agents/opencode/runtime.js"
export { runProcessHelper } from "./process-control.js"

export interface LaunchResult {
  pid: number
  creationTimeUtc: string
  creationTimeTicks: string
  executable: string
  endpoint: string
  directory: string
  instanceId: string
}
export interface InspectResult {
  processState?: "running" | "not-found" | "unknown"
  running: boolean
  matched: boolean
  portOwnerMatched: boolean
  portOwnedByOther: boolean
}
export interface StopResult { stopped: boolean; reason: string | null }
export interface RuntimeSessionStatus { sessionId: string; type: "busy" | "idle" | "retry" }
export interface RuntimePendingRequest { id: string; sessionId: string }
export interface RuntimeSummary extends InstanceSummary {
  retrySessions?: number | null
  sessions: SessionMetadata[]
  sessionsKnown?: boolean
  sessionStatuses?: RuntimeSessionStatus[] | null
  invalidStatusSessionIds?: string[] | null
  questionRequests?: RuntimePendingRequest[] | null
  invalidQuestionSessionIds?: string[] | null
  permissionRequests?: RuntimePendingRequest[] | null
  invalidPermissionSessionIds?: string[] | null
}
export interface RuntimeActivityEvidence { busySessionIds: string[] }
export type RuntimeActivityEvent =
  | { type: "activity"; source: "snapshot" | "event"; sessionIds: string[] }
  | { type: "session-created"; sessionId: string }
export interface RuntimeActivityObserver { close(): void; done: Promise<void> }
export type RuntimeCapabilities = AgentCapabilities

export interface RuntimePort {
  // legacy OpenCode adapter 可省略 metadata；其他 family 須宣告可用能力。
  readonly agentFamily?: string
  capabilities?(instance: InstanceRecord): RuntimeCapabilities
  launch(directory: string, port: number, instanceId: string): Promise<LaunchResult>
  adoptLocal?(directory: string, port: number, instanceId: string, pid: number): Promise<LaunchResult>
  cleanupLaunch(instanceId: string): Promise<StopResult>
  readiness(instance: LaunchResult | InstanceRecord): Promise<{ version: string; directory: string }>
  inspect(instance: InstanceRecord | LaunchResult): Promise<InspectResult>
  // Stop 的充分證據由 OMW process-control 核對；失聯不可解讀成已停止。
  stop(instance: InstanceRecord): Promise<StopResult>
  sessions(instance: InstanceRecord): Promise<SessionMetadata[]>
  children(instance: InstanceRecord, sessionId: string): Promise<SessionMetadata[]>
  // 聚合只探測 adapter 支援且目前可用的訊號；缺少任一訊號不可遮蔽其他訊號。
  summary(instance: InstanceRecord): Promise<RuntimeSummary>
  activity?(instance: InstanceRecord): Promise<RuntimeActivityEvidence>
  observeActivity?(instance: InstanceRecord, onEvent: (event: RuntimeActivityEvent) => Promise<void> | void): RuntimeActivityObserver
  createSession?(instance: InstanceRecord): Promise<SessionMetadata>
  openUrl(instance: Pick<InstanceRecord, "endpoint" | "projectDirectory" | "port">, sessionId?: string): string
  remoteUrlUnavailableReason?(instance: Pick<InstanceRecord, "port">): string | null
}
