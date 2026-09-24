import type { PrimaryTodosResponse, SessionTodo } from "@omw/contracts"
import { ref } from "vue"

interface Target { instanceId: string; sessionId: string }
interface Options {
  read: (instanceId: string) => Promise<PrimaryTodosResponse>
  start?: (callback: () => void, milliseconds: number) => number
  stop?: (timer: number) => void
}

export function createSessionTodoRefresh(options: Options) {
  const todos = ref<SessionTodo[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const stale = ref(false)
  const error = ref("")
  const start = options.start ?? ((callback, milliseconds) => window.setInterval(callback, milliseconds))
  const stop = options.stop ?? ((timer) => window.clearInterval(timer))
  let target: Target | null = null
  let generation = 0
  let timer: number | undefined
  const inFlight = new Map<string, Promise<void>>()
  let queued = false
  let disposed = false
  const keyOf = (value: Target) => `${value.instanceId}\0${value.sessionId}`

  function reload(): void {
    if (!target || disposed) return
    const key = keyOf(target)
    loading.value = !loaded.value
    if (inFlight.has(key)) {
      queued = true
      return
    }
    const current = target
    const requestGeneration = generation
    // 保留失敗時最後一次成功的資料，但新讀取開始時不能讓 stale 標記消失。
    const promise = (async () => {
      try {
        const response = await options.read(current.instanceId)
        if (requestGeneration !== generation || disposed) return
        if (response.instanceId !== current.instanceId || response.sessionId !== current.sessionId) {
          throw new Error("主要 Session 綁定已變更，請重新載入。")
        }
        todos.value = response.todos
        loaded.value = true
        stale.value = false
        error.value = ""
      } catch (cause) {
        if (requestGeneration !== generation || disposed) return
        error.value = cause instanceof Error ? cause.message : "讀取失敗"
        stale.value = loaded.value
      } finally {
        if (requestGeneration === generation && !disposed) loading.value = false
      }
    })()
    inFlight.set(key, promise)
    void promise.then(() => {
      if (inFlight.get(key) !== promise) return
      inFlight.delete(key)
      if (queued && target && keyOf(target) === key && !disposed) {
        queued = false
        reload()
      }
    })
  }

  function focus(next: Target | null): void {
    if (disposed) return
    if (next && target && keyOf(next) === keyOf(target)) return
    generation++
    if (timer !== undefined) stop(timer)
    timer = undefined
    queued = false
    target = next
    todos.value = []
    loading.value = false
    loaded.value = false
    stale.value = false
    error.value = ""
    if (next) {
      reload()
      timer = start(reload, 5_000)
    }
  }

  function dispose(): void {
    focus(null)
    disposed = true
    generation++
  }

  return { todos, loading, loaded, stale, error, focus, reload, dispose }
}
