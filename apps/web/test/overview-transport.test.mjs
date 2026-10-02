import assert from "node:assert/strict"
import test from "node:test"
import { createOverviewTransport } from "../src/overview-transport.ts"

test("UI search and notification share one full-scope projection; independent cancellation and next round", async () => {
  let reads = 0, complete
  let transportSignal
  const transport = createOverviewTransport((_url, signal) => {
    reads++
    transportSignal = signal
    return new Promise((resolve) => { complete = resolve })
  })
  const uiController = new AbortController()
  const ui = transport.overview("/api/v1/overview?q=filtered&view=compact", uiController.signal)
  const notification = transport.notifications()
  uiController.abort()
  await assert.rejects(ui, { name: "AbortError" })
  assert.equal(transportSignal.aborted, false)
  complete({ instances: [], notifications: [{ id: "outside-search" }] })
  assert.equal((await notification).notifications[0].id, "outside-search")
  assert.equal(reads, 1)
  const next = transport.notifications()
  assert.equal(reads, 2, "a new round does not reuse a stored snapshot")
  complete({ notifications: [] })
  await next
})

test("last subscriber cancellation terminates the transport and rejects stale results", async () => {
  let signal
  const transport = createOverviewTransport((_url, requested) => { signal = requested; return new Promise(() => {}) })
  const controller = new AbortController()
  const pending = transport.notifications(controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: "AbortError" })
  assert.equal(signal.aborted, true)
})
