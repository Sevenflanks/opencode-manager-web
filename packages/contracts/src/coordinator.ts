import type { ManagedInstance } from "./index.js"

export type CoordinatorWorkerKind = "resident" | "task"
export type CoordinatorWorkerHealth = "connecting" | "online" | "unstable" | "offline"
export type CoordinatorDataFreshness = "fresh" | "stale" | "unknown"

/** Coordinator 投影不包含機器間 credentials；capacity 與 health 是不同觀察。 */
export interface CoordinatorWorker {
  id: string
  generation: string
  name: string
  kind: CoordinatorWorkerKind
  health: CoordinatorWorkerHealth
  registeredAt: string
  lastCheckedAt: string | null
  lastHealthyAt: string | null
  consecutiveFailures: number
  endedAt: string | null
  dataUpdatedAt: string | null
  freshness: CoordinatorDataFreshness
  instanceCount: number | null
  capacity: { state: "available" | "occupied" | "unknown"; maxInstances: number } | null
  diagnosticCode: string | null
  address: string
  nativeOrigin: string
}

export interface CoordinatorInstance {
  workerId: string
  generation: string
  workerName: string
  freshness: CoordinatorDataFreshness
  observedAt: string
  instance: ManagedInstance
}

export interface CoordinatorOverview {
  checkedAt: string
  workers: CoordinatorWorker[]
  instances: CoordinatorInstance[]
}
