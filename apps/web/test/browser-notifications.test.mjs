import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { runInNewContext } from "node:vm"
import { createPendingTracker, createNotificationPreference } from "../src/browser-notifications.ts"

const instance = (id, questions, permissions, extra = {}) => ({
  id, state: "ready", summary: { pendingQuestions: questions, pendingPermissions: permissions },
  primarySummary: { pendingQuestions: 0, pendingPermissions: 0 }, ...extra,
})

test("baseline, instance-wide pending rounds, deduplication and rearming", () => {
  const tracker = createPendingTracker()
  assert.deepEqual(tracker.observe([instance("a", 2, 0), instance("b", 0, 0)]), [])
  assert.deepEqual(tracker.observe([instance("a", 3, 0), instance("b", 1, 1)]), [
    { instanceId: "b", count: 2 },
  ])
  assert.deepEqual(tracker.observe([instance("a", 0, 0), instance("b", 2, 1)]), [])
  assert.deepEqual(tracker.observe([instance("a", 1, 0), instance("b", 2, 1)]), [
    { instanceId: "a", count: 1 },
  ])
  assert.deepEqual(tracker.observe([instance("a", 1, 1), instance("b", 2, 1)]), [], "new permission in the same round does not notify again")
})

test("unknown, disconnect, failed poll and enable start new baselines, never treat unknown as zero", () => {
  const tracker = createPendingTracker()
  tracker.observe([instance("a", 0, 0)])
  assert.deepEqual(tracker.observe([instance("a", null, 1)]), [])
  assert.deepEqual(tracker.observe([instance("a", 1, 1)]), [], "unknown question needs a new baseline")
  tracker.observe([instance("a", 0, 0)])
  assert.deepEqual(tracker.observe([instance("a", 2, 3, { state: "unreachable" })]), [])
  assert.deepEqual(tracker.observe([instance("a", 2, 3)]), [], "reconnect baselines both signals")
  tracker.reset()
  assert.deepEqual(tracker.observe([instance("a", 0, 0)]), [])
  assert.deepEqual(tracker.observe([instance("a", 1, 0)]), [{ instanceId: "a", count: 1 }])
  tracker.reset()
  assert.deepEqual(tracker.observe([instance("a", 2, 0)]), [])
  tracker.observe([])
  assert.deepEqual(tracker.observe([instance("a", 1, 0)]), [], "returning instance is a new baseline")
})

test("only instance-wide counts trigger, including unbound and non-primary sessions", () => {
  const tracker = createPendingTracker()
  tracker.observe([instance("a", 0, 0, { primarySummary: { pendingQuestions: 10, pendingPermissions: 10 } })])
  assert.deepEqual(tracker.observe([instance("a", 1, 1, { primarySummary: { pendingQuestions: 1, pendingPermissions: 1 } })]), [
    { instanceId: "a", count: 2 },
  ], "one notification per instance-wide round, never add primary counts")
})

test("stopped tracking instances do not generate notification edges", () => {
  const tracker = createPendingTracker()
  tracker.observe([instance("a", 0, 0)])
  assert.deepEqual(tracker.observe([instance("a", 1, 0, { trackingHidden: true })]), [])
  assert.deepEqual(tracker.observe([instance("a", 1, 0)]), [], "return to tracking requires a fresh baseline")
})

test("preference defaults off, requests permission only on user enable and persists locally", async () => {
  const values = new Map()
  let calls = 0
  let permission = "default"
  const options = {
    storage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
    supported: () => true,
    permission: () => permission,
    requestPermission: () => { calls++; permission = "granted"; return Promise.resolve(permission) },
  }
  const preference = createNotificationPreference(options)
  assert.equal(preference.enabled(), false)
  assert.equal(calls, 0)
  assert.equal(await preference.enable(), true)
  assert.equal(calls, 1)
  assert.equal(values.size, 1)
  assert.equal(createNotificationPreference(options).enabled(), true)
  preference.disable()
  assert.equal(preference.enabled(), false)
  assert.equal(createNotificationPreference(options).enabled(), false)
})

test("denied, unsupported and unavailable storage never pretend notifications are enabled", async () => {
  const values = new Map([["omw-browser-notifications", "true"]])
  let permission = "denied"
  let calls = 0
  const preference = createNotificationPreference({
    storage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
    supported: () => true,
    permission: () => permission,
    requestPermission: () => { calls++; return Promise.resolve("denied") },
  })
  assert.equal(preference.enabled(), false)
  assert.equal(await preference.enable(), false)
  assert.equal(calls, 0)
  assert.equal(values.has("omw-browser-notifications"), false)
  permission = "granted"
  const unsupported = createNotificationPreference({
    storage: { getItem: () => "true", setItem: () => {}, removeItem: () => {} },
    supported: () => false,
    permission: () => permission,
    requestPermission: () => { calls++; return Promise.resolve("granted") },
  })
  assert.equal(unsupported.enabled(), false)
  assert.equal(await unsupported.enable(), false)
  assert.equal(calls, 0)
})

test("disable during an outstanding permission prompt cannot re-enable the preference", async () => {
  let resolve
  let granted = false
  const values = new Map()
  const preference = createNotificationPreference({
    storage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
    supported: () => true,
    permission: () => granted ? "granted" : "default",
    requestPermission: () => new Promise((done) => { resolve = done }),
  })
  const enable = preference.enable()
  preference.disable()
  granted = true
  resolve("granted")
  assert.equal(await enable, false)
  assert.equal(values.size, 0)
})

test("unavailable localStorage is reported instead of claiming notifications are on", async () => {
  let requests = 0
  const preference = createNotificationPreference({
    storage: { getItem: () => { throw new Error("blocked") }, setItem: () => {}, removeItem: () => {} },
    supported: () => true,
    permission: () => "granted",
    requestPermission: () => { requests++; return Promise.resolve("granted") },
  })
  assert.equal(preference.status(), "unavailable")
  assert.equal(await preference.enable(), false)
  assert.equal(requests, 0)
})

test("service worker notification click navigates an open page to the instance", async () => {
  const source = await readFile(new URL("../public/notification-sw.js", import.meta.url), "utf8")
  let handler
  const calls = []
  const existing = {
    url: "https://example.test/",
    navigate: async (url) => { calls.push(["navigate", url]); return existing },
    focus: async () => { calls.push(["focus"]) },
  }
  const self = {
    location: { origin: "https://example.test" },
    addEventListener: (_, callback) => { handler = callback },
    clients: { matchAll: async () => [existing], openWindow: async () => { throw new Error("should reuse window") } },
  }
  runInNewContext(source, { self, URL })
  let pending
  handler({ notification: { data: { url: "https://example.test/#instance=a" }, close: () => calls.push(["close"]) }, waitUntil: (promise) => { pending = promise } })
  await pending
  assert.deepEqual(calls, [["close"], ["navigate", "https://example.test/#instance=a"], ["focus"]])
})
