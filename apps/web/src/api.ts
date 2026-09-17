import type {
  DirectoryListing,
  DirectoryShortcut,
  ManagedInstance,
  OpenUrlResponse,
  OverviewFilter,
  OverviewResponse,
  SessionChildrenResponse,
  SessionRootsResponse,
} from "@omw/contracts"

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message)
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const mutation = init?.method && init.method !== "GET"
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      ...(mutation ? { "x-omw-csrf": "1", ...(init?.body ? { "content-type": "application/json" } : {}) } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: { code: "HTTP_ERROR", message: `HTTP ${response.status}` } }))
    throw new ApiError(body.error?.code ?? "HTTP_ERROR", body.error?.message ?? `HTTP ${response.status}`, response.status)
  }
  if (response.status === 204) return undefined as T
  return await response.json() as T
}

export const managerApi = {
  overview(query: string, filter: OverviewFilter) {
    const params = new URLSearchParams({ q: query, filter })
    return request<OverviewResponse>(`/api/v1/overview?${params}`)
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
  sessions(id: string) {
    return request<SessionRootsResponse>(`/api/v1/instances/${encodeURIComponent(id)}/sessions`)
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
