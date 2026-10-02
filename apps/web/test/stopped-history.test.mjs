import assert from "node:assert/strict"
import test from "node:test"
import { createStoppedHistory } from "../src/stopped-history.ts"

const rows = Array.from({ length: 45 }, (_, index) => ({ id: String(index) }))
test("an unsubmitted history draft does not replace loaded pages during refresh, continuation or reopen", async () => {
  const calls = []
  let revision = "v1"
  const history = createStoppedHistory(async (query, _hidden, offset) => {
    calls.push({ query, offset })
    const data = query === "B" ? [{ id: "B-only" }] : rows
    return { instances: data.slice(offset, offset + 20), total: data.length, revision,
      nextOffset: offset + 20 < data.length ? offset + 20 : null }
  })
  try {
    await history.load()
    await history.load(true)
    history.query.value = "B"
    await history.load(false, true)
    assert.equal(history.instances.value.length, 40, "refresh preserves the committed results and loaded pages")
    assert.equal(history.appliedQuery.value, "")
    assert.equal(history.query.value, "B", "refresh preserves the unsubmitted draft")
    assert.deepEqual(calls.slice(-2), [{ query: "", offset: 0 }, { query: "", offset: 20 }])
    await history.load(true)
    assert.equal(history.instances.value.length, 45)
    assert.deepEqual(calls.at(-1), { query: "", offset: 40 })
    revision = "v2"
    history.observe({ total: 45, revision })
    await history.load()
    assert.equal(history.instances.value.length, 45)
    assert.deepEqual(calls.slice(-3).map((call) => call.query), ["", "", ""])
    const beforeReopen = calls.length
    await history.load()
    assert.equal(calls.length, beforeReopen, "reopen must not submit the draft or refetch fresh pages")
    assert.equal(history.query.value, "B")
  } finally { history.dispose() }
})

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
  await history.submit()
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

test("only explicit history submission commits A/B; a failed submit retains A and retry snapshots B rather than draft C", async () => {
  const calls = []
  let failB = true, releaseB
  const history = createStoppedHistory(async (query, _hidden, offset) => {
    calls.push({ query, offset })
    if (query === "B" && failB) throw new Error("submitted B fixture failure")
    if (query === "B") await new Promise((resolve) => { releaseB = resolve })
    const data = query === "A" ? rows : query === "B" ? [{ id: "B0" }, { id: "B1" }, { id: "B2" }] : []
    return { instances: data.slice(offset, offset + 20), total: data.length, revision: "v1",
      nextOffset: offset + 20 < data.length ? offset + 20 : null }
  })
  try {
    history.query.value = "A"
    await history.submit()
    await history.load(true)
    assert.equal(history.instances.value.length, 40)
    history.query.value = "B"
    await history.submit()
    assert.ok(history.failure.value)
    assert.equal(history.appliedQuery.value, "A", "a failed submit must not relabel the retained successful A result")
    assert.equal(history.instances.value.length, 40)
    history.query.value = "C"
    failB = false
    const retry = history.load(false, true)
    assert.deepEqual(calls.at(-1), { query: "B", offset: 0 }, "retry uses the explicit submission, not new draft C")
    releaseB()
    await retry
    assert.equal(history.appliedQuery.value, "B")
    assert.equal(history.query.value, "C", "completion preserves the draft edited during the request")
    assert.deepEqual(history.instances.value.map((instance) => instance.id), ["B0", "B1", "B2"])
    assert.equal(history.failure.value, null)
    const beforeReopen = calls.length
    await history.load()
    assert.equal(calls.length, beforeReopen)
    history.query.value = "C"
    await history.submit()
    assert.equal(history.appliedQuery.value, "C")
    assert.equal(history.instances.value.length, 0)
  } finally { history.dispose() }
})

test("history search state restores draft and committed scope separately, including legacy and failed submissions", async () => {
  const calls = []
  let failB = false
  const read = async (query, _hidden, offset) => {
    calls.push({ query, offset })
    if (query === "B" && failB) throw new Error("restore submitted B failure")
    const data = query === "A" ? rows : query === "B" ? [{ id: "B-only" }] : [...rows, { id: "unfiltered-extra" }]
    return { instances: data.slice(offset, offset + 20), total: data.length, revision: "v1",
      nextOffset: offset + 20 < data.length ? offset + 20 : null }
  }
  const original = createStoppedHistory(read)
  const restored = createStoppedHistory(read)
  try {
    original.query.value = "A"
    await original.submit()
    original.query.value = "B"
    const saved = original.searchState()
    assert.deepEqual(saved, { draft: "B", committed: "A" })
    const beforeRestore = calls.length
    restored.restoreSearch(saved.draft, saved.committed)
    assert.equal(calls.length, beforeRestore, "restore supplies context without implicitly submitting or requesting")
    assert.equal(restored.appliedQuery.value, "", "restoration is not evidence of a successful load")
    await restored.load()
    assert.deepEqual(calls.at(-1), { query: "A", offset: 0 })
    assert.equal(restored.total.value, 45)
    assert.equal(restored.query.value, "B")
    restored.restoreSearch("B", undefined)
    await restored.load()
    assert.deepEqual(calls.at(-1), { query: "", offset: 0 }, "legacy draft alone must not be treated as submitted")
    assert.equal(restored.total.value, 46)
    assert.equal(restored.appliedQuery.value, "")
    assert.equal(restored.query.value, "B")
    failB = true
    original.query.value = "B"
    await original.submit()
    assert.equal(original.appliedQuery.value, "A")
    original.query.value = "C"
    const failed = original.searchState()
    assert.deepEqual(failed, { draft: "C", committed: "B" }, "snapshot retains failed submission intent, not prior successful A")
    restored.restoreSearch(failed.draft, failed.committed)
    await restored.load()
    assert.ok(restored.failure.value)
    assert.deepEqual(calls.at(-1), { query: "B", offset: 0 })
    failB = false
    await restored.load(false, true)
    assert.equal(restored.appliedQuery.value, "B")
    assert.equal(restored.query.value, "C")
    assert.equal(restored.total.value, 1)
  } finally { original.dispose(); restored.dispose() }
})

test("restoring another committed history scope aborts an older flight and discards its response", async () => {
  let finish, signal
  const history = createStoppedHistory((query, _hidden, _offset, _revision, requested) => {
    if (query === "B") return Promise.resolve({ instances: [{ id: "B-only" }], total: 1, revision: "v2", nextOffset: null })
    signal = requested
    return new Promise((resolve) => { finish = resolve })
  })
  try {
    history.restoreSearch("A-draft", "A")
    const old = history.load()
    history.restoreSearch("C-draft", "B")
    assert.equal(signal.aborted, true)
    await history.load()
    finish({ instances: rows, total: 45, revision: "old", nextOffset: null })
    await old
    assert.equal(history.appliedQuery.value, "B")
    assert.equal(history.query.value, "C-draft")
    assert.deepEqual(history.instances.value.map((instance) => instance.id), ["B-only"])
  } finally { history.dispose() }
})
