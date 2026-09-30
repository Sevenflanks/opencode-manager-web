import assert from "node:assert/strict"
import test from "node:test"
import { createOverviewRefresh } from "../src/overview-refresh.ts"

test("overview failure, timeout and successful drain replace the entire presented error", async () => {
  const originalWindow = globalThis.window
  let expire
  globalThis.window = { setTimeout(callback) { expire = callback; return 1 }, clearTimeout() {} }
  let reads = 0
  const view = { shortcuts: [], instances: [] }
  const refresh = createOverviewRefresh({
    query: () => ({ query: "", filter: "all", includeHidden: false }),
    visible: () => true, mutationPending: () => false,
    read: async (_, signal) => {
      reads++
      if (reads === 1) throw new Error("first diagnostic")
      if (reads === 2) return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }))
      return view // 後續兩次分別是 drain 與 fresh read。
    },
    captureRoute: () => null,
    prepare: async (overview) => ({ overview, query: "", filter: "all" }),
    applied: async () => {}, userAction: () => {},
    errorMessage: () => ({ summary: "前次摘要", summaryKey: "error.unknown", code: "INSTANCE_START_TIMEOUT", diagnostic: null }),
    timeoutMessage: () => ({ summary: "逾時", summaryKey: "error.overviewTimeout", code: null, diagnostic: null }),
  })
  try {
    assert.equal(await refresh.load(), false)
    assert.equal(refresh.error.value.code, "INSTANCE_START_TIMEOUT")
    const pending = refresh.load()
    expire()
    assert.equal(await pending, false)
    assert.deepEqual(refresh.error.value, { summary: "逾時", summaryKey: "error.overviewTimeout", code: null, diagnostic: null })
    assert.equal(await refresh.load(), true)
    assert.equal(reads, 4)
    assert.equal(refresh.error.value, null)
  } finally {
    refresh.dispose()
    globalThis.window = originalWindow
  }
})
