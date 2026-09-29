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
} from "@omw/contracts"

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly details?: unknown) {
    super(message)
  }
}

// 啟用後同一頁面的 polling 立即需要 Basic；只保留於記憶體，reload 後交回瀏覽器登入。
let transientAuthorization: string | undefined
function basicAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`)
  return `Basic ${btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))}`
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const mutation = init?.method && init.method !== "GET"
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    headers: {
      accept: "application/json",
      ...(transientAuthorization ? { authorization: transientAuthorization } : {}),
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

export const managerApi = {
  async updateCredentials(payload: { currentPassword: string; username: string; password: string }) {
    await request<void>("/api/v1/settings/credentials", { method: "PATCH", body: JSON.stringify(payload) })
    if (transientAuthorization) transientAuthorization = basicAuthorization(payload.username, payload.password)
  },
  async enableRemoteAccess(username: string, password: string) {
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
  connectivity() {
    return request<ConnectivityInfo>("/api/v1/connectivity")
  },
  registerConnectivity() {
    return request<ConnectivityInfo>("/api/v1/connectivity/register", { method: "POST", body: "{}" })
  },
  overview(query: string, filter: OverviewFilter, includeHidden = false, signal?: AbortSignal) {
    const params = new URLSearchParams({ q: query, filter })
    if (includeHidden) params.set("includeHidden", "true")
    return request<OverviewResponse>(`/api/v1/overview?${params}`, signal ? { signal } : undefined)
  },
  notificationOverview(signal?: AbortSignal) {
    // 通知不能沿用畫面搜尋或 filter；已停止追蹤的 Instance 不屬於通知範圍。
    return request<OverviewResponse>("/api/v1/overview?q=&filter=all", signal ? { signal } : undefined)
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
