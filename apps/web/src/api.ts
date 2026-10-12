import type {
  ConnectivityInfo,
  DirectoryListing,
  DirectoryShortcut,
  ManagedInstance,
  OpenUrlResponse,
  OverviewFilter,
  OverviewResponse,
  SessionChildrenResponse,
  SessionRootsResponse,
  PrimaryTodosResponse,
  HistoryResponse,
  CoordinatorOverview,
} from "@omw/contracts"
import { createOverviewTransport } from "./overview-transport"

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly details?: unknown) {
    super(message)
  }
}

export interface WorkerCapacity {
  state: "available" | "occupied" | "unknown"
  maxInstances: number
}

// 啟用後同一頁面的 polling 立即需要 Basic；只保留於記憶體，reload 後交回瀏覽器登入。
let transientAuthorization: string | undefined
function basicAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`)
  return `Basic ${btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))}`
}

async function sendRequest<T>(url: string, init?: RequestInit, desktop = true): Promise<T> {
  const mutation = init?.method && init.method !== "GET"
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    headers: {
      accept: "application/json",
      ...(desktop && transientAuthorization ? { authorization: transientAuthorization } : {}),
      ...(mutation ? { "x-omw-csrf": "1", ...(init?.body ? { "content-type": "application/json" } : {}) } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: { code: "HTTP_ERROR", message: `HTTP ${response.status}` } }))
    throw new ApiError(body.error?.code ?? "HTTP_ERROR", body.error?.message ?? `HTTP ${response.status}`, response.status, body.error?.details)
  }
  if (response.status === 204) return undefined as T
  return await response.json() as T
}

export function createManagerApi(prefix = "", canMutate: () => boolean = () => true) {
  let disposed = false
  const controllers = new Set<AbortController>()
  async function request<T>(url: string, init?: RequestInit): Promise<T> {
    if (disposed) throw new DOMException("Aborted", "AbortError")
    // 每個 client 固定對應一次 execution；human Basic 不得跟進 Worker proxy。
    if (prefix && init?.method && init.method !== "GET" && !canMutate()) {
      throw new ApiError("COORDINATOR_WORKER_UNAVAILABLE", "COORDINATOR_WORKER_UNAVAILABLE", 409)
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    init?.signal?.addEventListener("abort", abort, { once: true })
    if (init?.signal?.aborted) controller.abort()
    controllers.add(controller)
    try { return await sendRequest<T>(`${prefix}${url}`, { ...init, signal: controller.signal }, !prefix) }
    finally { controllers.delete(controller); init?.signal?.removeEventListener("abort", abort) }
  }
  const overviewTransport = createOverviewTransport((url, signal) => request<OverviewResponse>(url, { signal }))

  return {
  dispose() { disposed = true; for (const controller of controllers) controller.abort(); controllers.clear() },
  async updateCredentials(payload: { currentPassword: string; username: string; password: string }) {
    await request<void>("/api/v1/settings/credentials", { method: "PATCH", body: JSON.stringify(payload) })
    if (!prefix && transientAuthorization) transientAuthorization = basicAuthorization(payload.username, payload.password)
  },
  async enableRemoteAccess(username: string, password: string) {
    if (prefix) throw new ApiError("COORDINATOR_WORKER_UNAVAILABLE", "COORDINATOR_WORKER_UNAVAILABLE", 409)
    transientAuthorization = basicAuthorization(username, password)
    try {
      return await request<ConnectivityInfo>("/api/v1/connectivity/enable", { method: "POST", body: JSON.stringify({ confirmed: true }) })
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) transientAuthorization = undefined
      throw error
    }
  },
  shutdown() {
    return request<{ stopping: true }>("/api/v1/manager/shutdown", { method: "POST", body: "{}" })
  },
  connectivity(signal?: AbortSignal) {
    return request<ConnectivityInfo>("/api/v1/connectivity", { signal: signal ?? null })
  },
  async workerCapacity(signal?: AbortSignal): Promise<WorkerCapacity> {
    const capacity = await request<WorkerCapacity>("/api/v1/worker/capacity", { cache: "no-store", ...(signal ? { signal } : {}) })
    // 舊 Manager 或缺欄位的回應不可被當成空閒；只接受目前 execution 的完整 capacity 契約。
    if ((prefix ? !Number.isInteger(capacity?.maxInstances) || capacity.maxInstances < 1 : capacity?.maxInstances !== 1) || !["available", "occupied", "unknown"].includes(capacity.state)) {
      throw new ApiError("WORKER_CAPACITY_UNAVAILABLE", "WORKER_CAPACITY_UNAVAILABLE", 503)
    }
    return capacity
  },
  registerConnectivity() {
    return request<ConnectivityInfo>("/api/v1/connectivity/register", { method: "POST", body: "{}" })
  },
  overview(query: string, filter: OverviewFilter, includeHidden = false, signal?: AbortSignal) {
    const params = new URLSearchParams({ q: query, filter, view: "compact", scope: "current" })
    if (includeHidden) params.set("includeHidden", "true")
    return overviewTransport.overview(`/api/v1/overview?${params}`, signal)
  },
  notificationOverview(signal?: AbortSignal) {
    // 通知不能沿用畫面搜尋或 filter；已停止追蹤的 Instance 不屬於通知範圍。
    return overviewTransport.notifications(signal)
  },
  history(query: string, includeHidden: boolean, offset = 0, revision?: string, signal?: AbortSignal) {
    const params = new URLSearchParams({ q: query, includeHidden: String(includeHidden), offset: String(offset) })
    if (revision) params.set("revision", revision)
    return request<HistoryResponse>(`/api/v1/instances/history?${params}`, signal ? { signal } : undefined)
  },
  instance(id: string, signal?: AbortSignal) {
    return request<ManagedInstance | null>(`/api/v1/instances/${encodeURIComponent(id)}`, signal ? { signal } : undefined)
  },
  browse(directory: string) {
    return request<DirectoryListing>(`/api/v1/directories?path=${encodeURIComponent(directory)}`)
  },
  createShortcut(payload: { name: string; directory: string }) {
    return request<DirectoryShortcut>("/api/v1/shortcuts", { method: "POST", body: JSON.stringify(payload) })
  },
  updateShortcut(id: string, payload: { name: string; directory: string }) {
    return request<DirectoryShortcut>(`/api/v1/shortcuts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) })
  },
  deleteShortcut(id: string) {
    return request<void>(`/api/v1/shortcuts/${encodeURIComponent(id)}`, { method: "DELETE" })
  },
  start(directory: string) {
    return request<ManagedInstance>("/api/v1/instances", { method: "POST", body: JSON.stringify({ directory }) })
  },
  stop(id: string) {
    return request<ManagedInstance>(`/api/v1/instances/${encodeURIComponent(id)}/stop`, { method: "POST", body: "{}" })
  },
  recheck(id: string) {
    return request<ManagedInstance>(`/api/v1/instances/${encodeURIComponent(id)}/recheck`, { method: "POST" })
  },
  resume(id: string) {
    return request<ManagedInstance>(`/api/v1/instances/${encodeURIComponent(id)}/resume`, { method: "POST" })
  },
  setTracking(id: string, hidden: boolean) {
    return request<ManagedInstance>(`/api/v1/instances/${encodeURIComponent(id)}/tracking`, {
      method: "POST",
      body: JSON.stringify({ hidden }),
    })
  },
  remove(id: string) {
    return request<void>(`/api/v1/instances/${encodeURIComponent(id)}`, { method: "DELETE" })
  },
  sessions(id: string) {
    return request<SessionRootsResponse>(`/api/v1/instances/${encodeURIComponent(id)}/sessions`)
  },
  primaryTodos(id: string) {
    return request<PrimaryTodosResponse>(`/api/v1/instances/${encodeURIComponent(id)}/primary-todos`)
  },
  createSession(id: string) {
    return request<OpenUrlResponse>(`/api/v1/instances/${encodeURIComponent(id)}/sessions`, { method: "POST" })
  },
  selectPrimarySession(id: string, sessionId: string) {
    return request<OpenUrlResponse>(`/api/v1/instances/${encodeURIComponent(id)}/primary-session`, {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    })
  },
  children(id: string, sessionId: string) {
    return request<SessionChildrenResponse>(`/api/v1/instances/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}/children`)
  },
  openUrl(id: string, sessionId?: string) {
    return request<OpenUrlResponse>(`/api/v1/instances/${encodeURIComponent(id)}/open-url`, {
      method: "POST",
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    })
  },
}
}

export type ManagerApi = ReturnType<typeof createManagerApi>
export const managerApi = createManagerApi()
export const coordinatorApi = {
  overview(signal?: AbortSignal) {
    return sendRequest<CoordinatorOverview>("/api/v1/coordinator/overview", { signal: signal ?? null, cache: "no-store" }, false)
  },
  check(id: string, generation: string, signal?: AbortSignal) {
    return sendRequest<CoordinatorOverview>(`/api/v1/coordinator/workers/${encodeURIComponent(id)}/${encodeURIComponent(generation)}/check`, { method: "POST", signal: signal ?? null }, false)
  },
}
