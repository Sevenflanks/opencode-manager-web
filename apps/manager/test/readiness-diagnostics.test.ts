import assert from "node:assert/strict"
import { tmpdir } from "node:os"
import { performance } from "node:perf_hooks"
import test from "node:test"
import { ManagerError } from "../src/errors.js"
import type { ReadinessDiagnostic } from "../src/lifecycle-diagnostics.js"
import { OpenCodeRuntime, type LaunchResult } from "../src/runtime.js"

const instance: LaunchResult = {
  instanceId: "10000000-0000-4000-8000-000000000090", pid: 90,
  creationTimeUtc: "2026-10-01T00:00:00Z", creationTimeTicks: "1", executable: process.execPath,
  endpoint: "http://127.0.0.1:42001", directory: "C:\\private-project",
}
const healthy = { healthy: true, version: "private-version" }
function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })
}
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

test("initial readiness uses the outer budget and can prove ready after its former 15 second limit", async (t) => {
  let now = 1_380 // inspect/listener 已消耗預算
  const records: ReadinessDiagnostic[] = []
  t.mock.method(performance, "now", () => now)
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 })
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (now < 17_380) throw new TypeError("not ready yet")
    return json(url.endsWith("/global/health") ? healthy : { directory: instance.directory })
  })
  const runtime = new OpenCodeRuntime({ executable: process.execPath, dataDirectory: tmpdir(), readinessDiagnostics: (record) => records.push(record) })
  const pending = runtime.readiness(instance, { attempt: 1, deadline: 30_000, signal: new AbortController().signal })
  const outcome = pending.then((value) => value, (error) => error)
  await settle()
  assert.equal(records[0]?.remainingMs, 28_620)
  now = 17_380
  t.mock.timers.tick(16_000)
  await settle()
  assert.deepEqual(await outcome, { version: healthy.version, directory: instance.directory })
  assert.equal(records.at(-1)?.remainingMs, 12_620)
})

test("readiness diagnostics preserve request order, one body read, scopes and monotonic timings", async (t) => {
  const records: ReadinessDiagnostic[] = []
  let now = 100
  let bodyReads = 0
  const urls: string[] = []
  t.mock.method(performance, "now", () => now)
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    urls.push(url)
    assert.equal(options.redirect, "error")
    assert.deepEqual(options.headers, { accept: "application/json" })
    assert.ok(options.signal instanceof AbortSignal)
    now += 20
    const response = json(url.endsWith("/global/health") ? healthy : { directory: instance.directory })
    const read = response.json.bind(response)
    t.mock.method(response, "json", async () => { bodyReads++; now += 5; return read() })
    return response
  })
  const runtime = new OpenCodeRuntime({ executable: process.execPath, dataDirectory: tmpdir(), readinessDiagnostics: (record) => records.push(record) })
  assert.deepEqual(await runtime.readiness(instance, { attempt: 2, deadline: 15_100, signal: new AbortController().signal }), { version: healthy.version, directory: instance.directory })
  assert.deepEqual(records.map(({ event, stage, result }) => [event.replace("opencode_readiness_", ""), stage, result]), [
    ["request_started", "health", "pending"], ["response_received", "health", "pending"],
    ["request_completed", "health", "success"], ["validation_completed", "health", "success"],
    ["request_started", "path", "pending"], ["response_received", "path", "pending"],
    ["request_completed", "path", "success"], ["validation_completed", "path", "success"],
    ["finished", "readiness", "success"],
  ])
  assert.deepEqual(records.filter((record) => record.event.endsWith("request_completed")).map((record) => record.stageElapsedMs), [25, 25])
  assert.equal(records.at(-1)?.elapsedMs, 50)
  assert.equal(records.at(-1)?.remainingMs, 14_950)
  for (const record of records) {
    assert.equal(record.scope, "initial_local_tui")
    assert.equal(record.verificationAttempt, 2)
    assert.equal(record.attempt, 1)
    assert.equal(record.instanceId, instance.instanceId)
  }
  assert.deepEqual(urls, [`${instance.endpoint}/global/health`, `${instance.endpoint}/path`])
  assert.equal(bodyReads, 2)
  assert.doesNotMatch(JSON.stringify(records), /private-|127\.0\.0\.1|healthy|directory":/)
  records.length = 0
  // Wall clock 回退不影響 diagnostic duration；既有 runtime deadline 仍用 Date.now。
  t.mock.method(Date, "now", () => 1)
  await runtime.readiness(instance)
  assert.ok(records.every((record) => record.scope === "other" && record.verificationAttempt === undefined))
  assert.equal(records.at(-1)?.elapsedMs, 50)
})

test("initial readiness cancellation stops pending fetch, body and retry without late success", async (t) => {
  for (const phase of ["fetch", "body", "retry"] as const) {
    await t.test(phase, async (t) => {
      const records: ReadinessDiagnostic[] = []
      const controller = new AbortController()
      let release!: () => void
      let requestSignal!: AbortSignal
      let fetches = 0
      t.mock.method(performance, "now", () => 0)
      t.mock.timers.enable({ apis: ["setTimeout"] })
      const gate = new Promise<void>((resolve) => { release = resolve })
      t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
        fetches++
        requestSignal = options.signal!
        if (phase === "retry") throw new TypeError("temporarily unavailable")
        if (phase === "fetch") await gate // 模擬不理 abort 的 late completion
        const response = json(healthy)
        if (phase === "body") t.mock.method(response, "json", async () => { await gate; return healthy })
        return response
      })
      const runtime = new OpenCodeRuntime({ executable: process.execPath, dataDirectory: tmpdir(), readinessDiagnostics: (record) => records.push(record) })
      let rejection: unknown
      const pending = runtime.readiness(instance, { attempt: 1, deadline: 30_000, signal: controller.signal }).catch((error) => { rejection = error })
      await settle()
      const reason = new Error("cancel initial verification")
      controller.abort(reason)
      await settle()
      assert.equal(rejection, reason, "readiness must settle on cancel rather than wait for the old operation")
      assert.equal(requestSignal.aborted, true)
      assert.equal(records.at(-1)?.result, "cancelled")
      const count = records.length
      release()
      t.mock.timers.tick(60_000)
      await pending
      await settle()
      assert.equal(fetches, 1)
      assert.equal(records.length, count)
    })
  }
})

test("initial readiness bounds fetch and body by the remaining outer budget rather than a fresh HTTP timeout", async (t) => {
  for (const phase of ["fetch", "body", "retry"] as const) {
    await t.test(phase, async (t) => {
      let now = 29_750
      let fetches = 0
      let release!: () => void
      let requestSignal!: AbortSignal
      const timeouts: number[] = []
      const records: ReadinessDiagnostic[] = []
      const gate = new Promise<void>((resolve) => { release = resolve })
      t.mock.method(performance, "now", () => now)
      t.mock.timers.enable({ apis: ["setTimeout"] })
      t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
        timeouts.push(milliseconds)
        const controller = new AbortController()
        setTimeout(() => controller.abort(new DOMException("HTTP timeout", "TimeoutError")), milliseconds)
        return controller.signal
      })
      t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
        fetches++
        requestSignal = options.signal!
        if (phase === "retry") { now = 29_900; throw new TypeError("not ready") }
        if (phase === "fetch") await gate
        const response = json(healthy)
        if (phase === "body") t.mock.method(response, "json", async () => { await gate; return healthy })
        return response
      })
      const runtime = new OpenCodeRuntime({ executable: process.execPath, dataDirectory: tmpdir(), readinessDiagnostics: (record) => records.push(record) })
      let rejected = false
      const outcome = assert.rejects(runtime.readiness(instance, {
        attempt: 1, deadline: 30_000, signal: new AbortController().signal,
      }), (error: unknown) => {
        rejected = true
        return error instanceof ManagerError && error.code === "LOCAL_TUI_VERIFICATION_TIMEOUT"
      })
      await settle()
      assert.deepEqual(timeouts, [250])
      assert.equal(records[0]?.remainingMs, 250)
      now = 30_000
      t.mock.timers.tick(phase === "retry" ? 100 : 250)
      await settle()
      assert.equal(rejected, true)
      await outcome
      assert.equal(records.at(-1)?.result, "deadline")
      assert.equal(records.at(-1)?.remainingMs, 0)
      if (phase !== "retry") {
        assert.equal(requestSignal.aborted, true)
        assert.equal(records.find((record) => record.event === "opencode_readiness_request_completed")?.result, "deadline")
      }
      const count = records.length
      release()
      t.mock.timers.tick(60_000)
      await settle()
      assert.equal(fetches, 1)
      assert.equal(records.length, count)
    })
  }
})

test("initial readiness keeps a normal 2 second request timeout distinct from the shared deadline", async (t) => {
  let now = 0
  const records: ReadinessDiagnostic[] = []
  const controller = new AbortController()
  t.mock.method(performance, "now", () => now)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.equal(milliseconds, 2_000)
    const request = new AbortController()
    setTimeout(() => request.abort(new DOMException("HTTP timeout", "TimeoutError")), milliseconds)
    return request.signal
  })
  t.mock.method(globalThis, "fetch", () => new Promise<Response>(() => {}))
  const runtime = new OpenCodeRuntime({ executable: process.execPath, dataDirectory: tmpdir(), readinessDiagnostics: (record) => records.push(record) })
  const reason = new Error("cancel after request timeout")
  const outcome = assert.rejects(runtime.readiness(instance, { attempt: 1, deadline: 30_000, signal: controller.signal }), (error) => error === reason)
  await settle()
  now = 2_000
  t.mock.timers.tick(2_000)
  await settle()
  assert.equal(records.find((record) => record.event === "opencode_readiness_request_completed")?.result, "http_timeout")
  assert.equal(records.at(-1)?.event, "opencode_readiness_retry")
  assert.equal(records.at(-1)?.remainingMs, 28_000)
  controller.abort(reason)
  await outcome
})

test("request diagnostics preserve explicit cancellation when its continuation crosses the deadline", async (t) => {
  let now = 0
  const records: ReadinessDiagnostic[] = []
  const controller = new AbortController()
  t.mock.method(performance, "now", () => now)
  t.mock.method(globalThis, "fetch", () => new Promise<Response>(() => {}))
  const runtime = new OpenCodeRuntime({ executable: process.execPath, dataDirectory: tmpdir(), readinessDiagnostics: (record) => records.push(record) })
  const reason = new Error("explicit cancellation")
  const outcome = assert.rejects(runtime.readiness(instance, { attempt: 1, deadline: 30_000, signal: controller.signal }), (error) => error === reason)
  await settle()
  controller.abort(reason)
  now = 30_000
  await outcome
  assert.equal(records.find((record) => record.event === "opencode_readiness_request_completed")?.result, "cancelled")
  assert.equal(records.at(-1)?.event, "opencode_readiness_finished")
  assert.equal(records.at(-1)?.result, "cancelled")
})

test("readiness diagnostics classify endpoint failures and retain the same 200ms retry", async (t) => {
  const failures = ["http_timeout", "network", "http_status", "content_type", "json_parse", "health_invalid", "directory_mismatch"] as const
  for (const failure of failures) {
    for (const target of failure === "health_invalid" ? ["health"] : failure === "directory_mismatch" ? ["path"] : ["health", "path"]) {
      await t.test(`${target}/${failure}`, async (t) => {
        const records: ReadinessDiagnostic[] = []
        let failed = false
        let fetches = 0
        let controller: AbortController
        t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 })
        t.mock.method(AbortSignal, "timeout", (ms: number) => {
          assert.equal(ms, 2000)
          controller = new AbortController()
          return controller.signal
        })
        t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
          fetches++
          const stage = url.endsWith("/global/health") ? "health" : "path"
          if (!failed && stage === target) {
            failed = true
            if (failure === "http_timeout") {
              // 使用真正已 aborted 的 request-owned signal，避免依 error.message 分類。
              controller.abort(new DOMException("private-timeout", "TimeoutError"))
              throw options.signal!.reason
            }
            if (failure === "network") throw new TypeError("private-network https://private.test Authorization: secret")
            if (failure === "http_status") return new Response("private-body", { status: 503 })
            if (failure === "content_type") return new Response("private-body", { headers: { "content-type": "text/plain" } })
            if (failure === "json_parse") return new Response("private-invalid-json", { headers: { "content-type": "application/json" } })
            if (failure === "health_invalid") return json({ healthy: false, version: "private-version" })
            return json({ directory: "C:\\private-wrong-directory" })
          }
          return json(stage === "health" ? healthy : { directory: instance.directory })
        })
        const runtime = new OpenCodeRuntime({ executable: process.execPath, dataDirectory: tmpdir(), readinessDiagnostics: (record) => records.push(record) })
        const pending = runtime.readiness(instance)
        await settle()
        assert.equal(records.at(-1)?.event, "opencode_readiness_retry")
        assert.equal(records.at(-1)?.result, failure)
        assert.equal(records.at(-1)?.stage, target)
        assert.equal(records.at(-1)?.attempt, 1)
        const failedEvent = records.find((record) => record.result === failure && !record.event.endsWith("retry"))!
        assert.equal(failedEvent.event, failure === "health_invalid" || failure === "directory_mismatch"
          ? "opencode_readiness_validation_completed" : "opencode_readiness_request_completed")
        if (failure === "http_status") assert.equal(failedEvent.httpStatus, 503)
        const beforeRetry = fetches
        t.mock.timers.tick(199)
        await settle()
        assert.equal(fetches, beforeRetry)
        t.mock.timers.tick(1)
        assert.deepEqual(await pending, { version: healthy.version, directory: instance.directory })
        assert.equal(records.at(-1)?.result, "success")
        assert.equal(records.at(-1)?.attempt, 2)
        assert.equal(fetches, target === "health" ? 3 : 4)
        assert.doesNotMatch(JSON.stringify(records), /private-|Authorization|secret/)
      })
    }
  }
})

test("readiness diagnostics classify body timeout/network without converting them to JSON parse errors", async (t) => {
  for (const aborted of [false, true]) {
    await t.test(String(aborted), async (t) => {
      const records: ReadinessDiagnostic[] = []
      let controller: AbortController
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 })
      t.mock.method(AbortSignal, "timeout", () => {
        controller = new AbortController()
        return controller.signal
      })
      t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
        const response = json(healthy)
        t.mock.method(response, "json", async () => {
          if (aborted) controller.abort()
          throw new TypeError("private-body-stream-failure")
        })
        return response
      })
      const runtime = new OpenCodeRuntime({ executable: process.execPath, dataDirectory: tmpdir(), readinessDiagnostics: (record) => records.push(record) })
      const pending = assert.rejects(runtime.readiness(instance), (error: unknown) => error instanceof ManagerError && error.code === "INSTANCE_START_TIMEOUT")
      await settle()
      assert.equal(records.at(-1)?.result, aborted ? "http_timeout" : "network")
      t.mock.timers.tick(15_000)
      await pending
      assert.equal(records.at(-1)?.result, "deadline")
    })
  }
})

test("readiness diagnostic sink throws preserve success, retry and original deadline error", async (t) => {
  for (const outcome of ["success", "retry", "deadline"] as const) {
    await t.test(outcome, async (t) => {
      let calls = 0
      let fetches = 0
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 })
      t.mock.method(globalThis, "fetch", async (url: string) => {
        fetches++
        if (outcome === "deadline" || (outcome === "retry" && fetches === 1)) throw new Error("private-failure")
        return json(url.endsWith("/global/health") ? healthy : { directory: instance.directory })
      })
      const runtime = new OpenCodeRuntime({ executable: process.execPath, dataDirectory: tmpdir(), readinessDiagnostics: () => { calls++; throw new Error("private-sink") } })
      const pending = runtime.readiness(instance)
      const rejected = outcome === "deadline" ? assert.rejects(pending, (error: unknown) => error instanceof ManagerError
        && error.code === "INSTANCE_START_TIMEOUT" && error.statusCode === 504 && error.message === "OpenCode 未在 15000 ms 內證明 ready。") : null
      await settle()
      if (outcome !== "success") t.mock.timers.tick(outcome === "retry" ? 200 : 15_000)
      if (rejected) await rejected
      else assert.deepEqual(await pending, { version: healthy.version, directory: instance.directory })
      assert.ok(calls > 0)
      assert.equal(fetches, outcome === "deadline" ? 1 : outcome === "retry" ? 3 : 2)
    })
  }
})
