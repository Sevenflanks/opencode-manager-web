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
    if (!loaded.value && !query.value.trim()) total.value = summary.total
    return stale
  }

  async function load(more = false, force = false): Promise<void> {
    if (loading.value && !force) return
    if (!more && loaded.value && !stale && appliedQuery.value === query.value && !force) return
    if (more && nextOffset.value === null) return
    const current = ++generation
    controller?.abort()
    const request = new AbortController()
    controller = request
    const timeout = setTimeout(() => request.abort(), 15_000)
    const requestedQuery = query.value
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

  return { query, appliedQuery, instances, total, loading, loaded, failure, nextOffset, scope, observe, load,
    dispose() { generation++; controller?.abort() } }
}
