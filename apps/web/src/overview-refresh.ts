import type { OverviewFilter, OverviewResponse } from "@omw/contracts"
import { ref } from "vue"

type Source = "user" | "background"
type Query = { query: string; filter: OverviewFilter; includeHidden: boolean }
type Request = { key: string; result: Promise<boolean>; controller: AbortController; afterMutation: boolean }

interface PreparedOverview {
  overview: OverviewResponse
  query: string
  filter: OverviewFilter
}

interface RefreshOptions<Route> {
  query: () => Query
  visible: () => boolean
  mutationPending: () => boolean
  read: (query: Query, signal: AbortSignal) => Promise<OverviewResponse>
  captureRoute: () => Route
  prepare: (overview: OverviewResponse, query: Query, route: Route, signal: AbortSignal, current: () => boolean) => Promise<PreparedOverview>
  applied: (result: PreparedOverview, query: Query, route: Route, source: Source, current: () => boolean) => Promise<void>
  userAction: () => void
  errorMessage: (cause: unknown) => string
}

const OVERVIEW_WAIT_MS = 15_000

export function createOverviewRefresh<Route>(options: RefreshOptions<Route>) {
  const overview = ref<OverviewResponse>({ shortcuts: [], instances: [] })
  const loading = ref(true)
  const error = ref("")
  const lastSucceededAt = ref("")
  const stale = ref(false)
  const refreshing = ref(false)
  let generation = 0
  let request: Request | null = null
  let obsoleteRequest: Request | null = null
  let foregroundRefresh: Promise<boolean> | null = null
  let visibilityEpoch = 0
  let needsDrain = false
  let disposed = false

  function invalidate(reason: "changed" | "mutation" = "mutation"): void {
    generation++
    // Abort 只會停止瀏覽器等待；Manager 仍可能合併舊 inspect，下一次讀取必須先丟棄舊 snapshot。
    if (request || obsoleteRequest) needsDrain = true
    request?.controller.abort()
    request = null
    if (lastSucceededAt.value) stale.value = true
    refreshing.value = reason === "mutation" && Boolean(lastSucceededAt.value)
  }

  function refreshAfterMutation(): Promise<boolean> {
    invalidate()
    return load(false, "background", true)
  }

  function load(showLoading = true, source: Source = "user", afterMutation = false): Promise<boolean> {
    if (disposed || (source === "background" && !options.visible())) return Promise.resolve(false)
    if (source === "user") {
      options.userAction()
      refreshing.value = true
      error.value = ""
      if (lastSucceededAt.value) stale.value = true
    }
    if (source === "user" && obsoleteRequest && !foregroundRefresh) foreground()
    if (source === "user" && foregroundRefresh) return foregroundRefresh
    const requested = options.query()
    const key = JSON.stringify([requested.query, requested.filter, requested.includeHidden])
    if (request?.key === key) return request.result
    const currentGeneration = ++generation
    const controller = new AbortController()
    const result = fetchOverview(currentGeneration, controller, requested, showLoading, source, afterMutation)
    const nextRequest = { key, result, controller, afterMutation }
    request = nextRequest
    void result.finally(() => { if (request === nextRequest) request = null })
    return result
  }

  async function fetchOverview(currentGeneration: number, controller: AbortController, query: Query, showLoading: boolean, source: Source, afterMutation: boolean): Promise<boolean> {
    const route = options.captureRoute()
    const startedDuringMutation = options.mutationPending()
    const current = () => !disposed && currentGeneration === generation && (source !== "background" || options.visible())
    if (showLoading && !lastSucceededAt.value) loading.value = true
    const timeout = window.setTimeout(() => controller.abort(), OVERVIEW_WAIT_MS)
    try {
      if (needsDrain) {
        // 超時或取消後 Manager 的 in-flight probe 可能仍是舊快照；drain 不可解除 stale。
        await options.read(query, controller.signal)
        if (!current()) return false
        needsDrain = false
      }
      if (!current()) return false
      const next = await options.read(query, controller.signal)
      if (!current()) return false
      const prepared = await options.prepare(next, query, route, controller.signal, current)
      if (!current()) return false
      overview.value = prepared.overview
      lastSucceededAt.value = new Date().toISOString()
      // 操作期間起始的 snapshot 即使在操作結束後才回來，也不能替代操作後的驗證。
      stale.value = !afterMutation && (startedDuringMutation || options.mutationPending())
      refreshing.value = false
      error.value = ""
      await options.applied(prepared, query, route, source, current)
      return current()
    } catch (cause) {
      if (!current()) return false
      if (controller.signal.aborted) needsDrain = true
      error.value = controller.signal.aborted ? "更新逾時，請重試。" : options.errorMessage(cause)
      stale.value = Boolean(lastSucceededAt.value)
      refreshing.value = false
      return false
    } finally {
      window.clearTimeout(timeout)
      if (current()) loading.value = false
    }
  }

  function foreground(): void {
    if (disposed) return
    if (!options.visible()) {
      visibilityEpoch++
      if (request) {
        // 不 abort：Manager 可能仍合併這筆 inspect。前景需等它完成再讀新 snapshot。
        obsoleteRequest = request
        generation++
        request = null
      }
      return
    }
    stale.value = Boolean(lastSucceededAt.value)
    refreshing.value = true
    if (foregroundRefresh) return
    const refresh = (async (): Promise<boolean> => {
      while (!disposed && options.visible()) {
        const epoch = visibilityEpoch
        const previous = obsoleteRequest ?? request
        obsoleteRequest = null
        if (previous) {
          if (request === previous) {
            generation++
            request = null
          }
          const expectedGeneration = generation
          await previous.result
          if (previous.controller.signal.aborted) needsDrain = true
          if (epoch === visibilityEpoch && expectedGeneration !== generation) return false
        }
        if (disposed || !options.visible()) return false
        if (epoch !== visibilityEpoch) continue
        const refreshed = await load(false, "background", previous?.afterMutation ?? false)
        if (epoch === visibilityEpoch) return refreshed
      }
      return false
    })()
    foregroundRefresh = refresh
    void refresh.finally(() => { if (foregroundRefresh === refresh) foregroundRefresh = null })
  }

  function dispose(): void {
    disposed = true
    generation++
    request?.controller.abort()
    obsoleteRequest?.controller.abort()
    request = null
    obsoleteRequest = null
  }

  return { overview, loading, error, lastSucceededAt, stale, refreshing, invalidate, refreshAfterMutation, load, foreground, dispose }
}
