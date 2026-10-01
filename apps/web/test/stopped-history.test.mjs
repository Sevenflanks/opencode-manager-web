import assert from "node:assert/strict"
import test from "node:test"
import { createStoppedHistory } from "../src/stopped-history.ts"

const rows = Array.from({ length: 45 }, (_, index) => ({ id: String(index) }))
test("history preserves pages on reopen/refresh; search covers backend scope and failed load keeps content", async () => {
  const calls = []
  let fail = false, revision = "v1"
  const history = createStoppedHistory(async (query, hidden, offset, requestedRevision) => {
    calls.push({ query, hidden, offset, requestedRevision })
    if (fail) throw new Error("fixture")
    const data = query ? rows.filter((item) => item.id === query) : rows
    return { instances: data.slice(offset, offset + 20), total: data.length, revision, nextOffset: offset + 20 < data.length ? offset + 20 : null }
  })
  await history.load()
  assert.equal(history.instances.value.length, 20)
  await history.load()
  assert.equal(calls.length, 1, "reopen does not refetch")
  await history.load(true)
  assert.equal(history.instances.value.length, 40)
  fail = true
  await history.load(true)
  assert.equal(history.instances.value.length, 40)
  assert.ok(history.failure.value)
  fail = false
  revision = "v2"
  history.observe({ total: 45, revision })
  await history.load()
  assert.deepEqual(calls.slice(-2).map((call) => call.offset), [0, 20])
  assert.equal(history.instances.value.length, 40, "invalidation refills the loaded progress atomically")
  history.query.value = "44"
  await history.load(false, true)
  assert.deepEqual(history.instances.value.map((item) => item.id), ["44"])
  assert.equal(history.total.value, 1)
  history.dispose()
})

test("scope/query changes discard out-of-order pages and cancel last operation", async () => {
  let finish, signal
  const history = createStoppedHistory((_query, _hidden, _offset, _revision, requested) => {
    signal = requested
    return new Promise((resolve) => { finish = resolve })
  })
  const old = history.load()
  history.scope(true)
  assert.equal(signal.aborted, true)
  finish({ instances: rows, total: 45, revision: "old", nextOffset: null })
  await old
  assert.deepEqual(history.instances.value, [])
  assert.equal(history.loaded.value, false)
  const current = history.load()
  history.dispose()
  assert.equal(signal.aborted, true)
  finish({ instances: [], total: 0, revision: "new", nextOffset: null })
  await current
})
