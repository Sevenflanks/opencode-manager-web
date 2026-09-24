import assert from "node:assert/strict"
import test from "node:test"
import { createSessionTodoRefresh } from "../src/session-todo-refresh.ts"

const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test("visible focus loads immediately, polls at five seconds without overlapping, stops off-detail and resumes immediately", async () => {
  const requests = []
  let pulse
  let delay
  const refresh = createSessionTodoRefresh({
    read: (instanceId) => { const request = deferred(); requests.push({ instanceId, ...request }); return request.promise },
    start: (callback, milliseconds) => { pulse = callback; delay = milliseconds; return 1 },
    stop: () => { pulse = undefined },
  })
  refresh.focus({ instanceId: "one", sessionId: "root" })
  assert.equal(requests.length, 1)
  assert.equal(refresh.loading.value, true)
  assert.equal(delay, 5_000)
  pulse(); pulse()
  assert.equal(requests.length, 1)
  requests[0].resolve({ instanceId: "one", sessionId: "root", todos: [] })
  await tick()
  pulse()
  assert.equal(requests.length, 2)
  refresh.focus(null)
  assert.equal(pulse, undefined)
  requests[1].resolve({ instanceId: "one", sessionId: "root", todos: [{ content: "舊", status: "completed", priority: "low" }] })
  await tick()
  assert.deepEqual(refresh.todos.value, [])
  refresh.focus({ instanceId: "one", sessionId: "root" })
  assert.equal(requests.length, 3)
  refresh.dispose()
})

test("switch clears prior todos and late response cannot replace a new binding; failures mark retained data stale", async () => {
  const requests = []
  const refresh = createSessionTodoRefresh({
    read: () => { const request = deferred(); requests.push(request); return request.promise },
    start: () => 1,
    stop: () => {},
  })
  refresh.focus({ instanceId: "one", sessionId: "old" })
  refresh.focus({ instanceId: "one", sessionId: "new" })
  assert.deepEqual(refresh.todos.value, [])
  requests[1].resolve({ instanceId: "one", sessionId: "new", todos: [{ content: "新", status: "completed", priority: "high" }] })
  await tick()
  requests[0].resolve({ instanceId: "one", sessionId: "old", todos: [{ content: "舊", status: "pending", priority: "low" }] })
  await tick()
  assert.equal(refresh.todos.value[0].content, "新")
  refresh.reload()
  requests[2].reject(new Error("read failed"))
  await tick()
  assert.equal(refresh.todos.value[0].content, "新")
  assert.equal(refresh.stale.value, true)
  assert.equal(refresh.error.value, "read failed")
  refresh.focus({ instanceId: "two", sessionId: "other" })
  assert.deepEqual(refresh.todos.value, [])
  assert.equal(refresh.stale.value, false)
  refresh.dispose()
})

test("returning to the same target while its old request is still running queues one fresh read", async () => {
  const requests = []
  const refresh = createSessionTodoRefresh({
    read: (instanceId) => { const request = deferred(); requests.push({ instanceId, ...request }); return request.promise },
    start: () => 1,
    stop: () => {},
  })
  refresh.focus({ instanceId: "one", sessionId: "root" })
  refresh.focus(null) // backgrounded or left detail
  refresh.focus({ instanceId: "one", sessionId: "root" })
  assert.equal(requests.length, 1)
  assert.equal(refresh.loading.value, true)
  requests[0].resolve({ instanceId: "one", sessionId: "root", todos: [{ content: "過期", status: "completed", priority: "high" }] })
  await tick()
  assert.equal(requests.length, 2)
  assert.deepEqual(refresh.todos.value, [])
  requests[1].resolve({ instanceId: "one", sessionId: "root", todos: [{ content: "最新", status: "pending", priority: "low" }] })
  await tick()
  assert.equal(refresh.todos.value[0].content, "最新")
  refresh.dispose()
})
