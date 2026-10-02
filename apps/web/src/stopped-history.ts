import type { HistoryResponse, HistorySummary, ManagedInstance } from "@omw/contracts"
import { ref } from "vue"

export function createStoppedHistory(read: (query: string, hidden: boolean, offset: number, revision: string | undefined, signal: AbortSignal) => Promise<HistoryResponse>) {
  const query = ref("")
  const appliedQuery = ref("")
  const instances = ref<ManagedInstance[]>([])
  const total = ref<number | null>(null)
  const loading = ref(false)
  const loaded = ref(false)
  const failure = ref<unknown>(null)
  const nextOffset = ref<number | null>(null)
  let committedQuery = ""
  let hidden = false
  let revision: string | undefined
  let stale = true
  let generation = 0
  let controller: AbortController | null = null

  function scope(includeHidden: boolean): void {
    if (hidden === includeHidden) return
    hidden = includeHidden
    generation++
    controller?.abort()
    controller = null
    instances.value = []
    loaded.value = false
    loading.value = false
    total.value = null
    revision = undefined
    stale = true
  }

  function observe(summary: HistorySummary): boolean {
    if (revision && revision !== summary.revision) stale = true
    if (!loaded.value && !committedQuery.trim()) total.value = summary.total
    return stale
  }

  async function load(more = false, force = false): Promise<void> {
    if (loading.value && !force) return
    if (!more && loaded.value && !stale && appliedQuery.value === committedQuery && !force) return
    if (more && nextOffset.value === null) return
    const current = ++generation
    controller?.abort()
    const request = new AbortController()
    controller = request
    const timeout = setTimeout(() => request.abort(), 15_000)
    // query 是可編輯草稿；刷新、續頁與重開只重讀已提交查詢，失敗重試也不可偷偷提交新草稿。
    const requestedQuery = committedQuery
    const requestedHidden = hidden
    const replacing = !more || stale || appliedQuery.value !== requestedQuery
    // 刷新保留使用者已載入的頁數；只有完整 replacement 成功才換掉可用內容。
    const target = replacing && appliedQuery.value === requestedQuery ? Math.max(20, instances.value.length) : 20
    loading.value = true
    failure.value = null
    try {
      let offset = replacing ? 0 : nextOffset.value ?? 0
      let requestedRevision = replacing ? undefined : revision
      let combined: ManagedInstance[] = replacing ? [] : [...instances.value]
      let page: HistoryResponse
      do {
        page = await read(requestedQuery, requestedHidden, offset, requestedRevision, request.signal)
        if (current !== generation) return
        combined.push(...page.instances)
        requestedRevision = page.revision
        offset = page.nextOffset ?? 0
      } while (replacing && combined.length < target && page.nextOffset !== null)
      instances.value = combined
      total.value = page.total
      nextOffset.value = page.nextOffset
      revision = page.revision
      appliedQuery.value = requestedQuery
      loaded.value = true
      stale = false
    } catch (cause) {
      if (current !== generation) return
      if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "HISTORY_CHANGED") stale = true
      failure.value = cause
    } finally {
      clearTimeout(timeout)
      if (current === generation) { loading.value = false; controller = null }
    }
  }

  function submit(): Promise<void> {
    committedQuery = query.value
    return load(false, true)
  }

  function searchState(): { draft: string; committed: string } {
    return { draft: query.value, committed: committedQuery }
  }

  function restoreSearch(draft: unknown, committed: unknown): boolean {
    query.value = typeof draft === "string" ? draft : ""
    // 舊 History entry 只有草稿，沒有證據可推定它已提交；採預設未篩選查詢，保留草稿供明確提交。
    const next = typeof committed === "string" ? committed : ""
    if (committedQuery === next) return false
    committedQuery = next
    generation++
    controller?.abort()
    controller = null
    loading.value = false
    failure.value = null
    stale = true
    return true
  }

  return { query, appliedQuery, instances, total, loading, loaded, failure, nextOffset, scope, observe, load, submit, searchState, restoreSearch,
    dispose() { generation++; controller?.abort() } }
}
