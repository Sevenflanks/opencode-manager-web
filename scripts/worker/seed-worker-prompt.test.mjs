import assert from "node:assert/strict"
import { createServer } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import { observeNativePrompt, publicWorkerRequest } from "./verify-seed-workers.mjs"

async function waitFor(predicate, deadlineAt) {
  while (!predicate()) {
    assert.ok(Date.now() < deadlineAt, "LOCAL_EVENT_TEST_DEADLINE")
    await delay(10)
  }
}

async function fixture(verify, abortFails = false) {
  const calls = [], detail = {}, deadlineAt = Date.now() + 3_000
  let stream, monitor
  const server = createServer((request, response) => {
    calls.push({ method: request.method, path: request.url })
    if (request.url === "/event") {
      stream = response
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.write('data: {"type":"server.connected"}\n\n')
    } else {
      response.writeHead(abortFails ? 503 : 200, { "content-type": "application/json" })
      response.end(JSON.stringify(abortFails ? { error: { code: "ABORT_FAILED" } } : {}))
    }
  })
  const close = () => { server.closeAllConnections(); server.close() }
  // fixture 自己持有 server，deadline 與 finally 都只關閉本次 listener／connections。
  const timer = setTimeout(close, 3_000)
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
    const url = `http://127.0.0.1:${server.address().port}`
    const request = publicWorkerRequest({ managerUrl: url, nativeUrl: url, headers: {}, deadlineAt })
    monitor = await observeNativePrompt({ url, headers: {}, sessionId: "ses_owned", deadlineAt, detail,
      onRetry: () => request(true, "/session/ses_owned/abort", {}) })
    await verify({ stream, monitor, detail, calls, deadlineAt })
  } finally {
    clearTimeout(timer)
    if (monitor) await monitor.stop()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

const retryFrame = sessionID => `data: ${JSON.stringify({ type: "session.status", properties: { sessionID, status: { type: "retry" } } })}\r\n\r\n`

test("foreign session retry 不觸發 abort；分片 CRLF SSE 的首個 owned retry 只 abort 一次", { timeout: 5_000 }, async () => {
  await fixture(async ({ stream, monitor, detail, calls, deadlineAt }) => {
    stream.write(retryFrame("ses_peer"))
    const owned = retryFrame("ses_owned")
    stream.write(owned.slice(0, -1))
    await delay(20)
    assert.equal(detail.retryEventCount, 0)
    assert.deepEqual(calls, [{ method: "GET", path: "/event" }])
    stream.write(owned.slice(-1)); stream.write(retryFrame("ses_owned"))
    await waitFor(() => detail.retryEventCount === 2, deadlineAt)
    await monitor.stop()
    assert.equal(detail.retryAborted, true)
    assert.equal(Boolean(detail.eventObservationFailed), false)
    assert.deepEqual(calls, [{ method: "GET", path: "/event" }, { method: "POST", path: "/session/ses_owned/abort" }])
  })
})

test("SSE reader transport failure 必須留下 failed observation，不能當成零 retry 通過", { timeout: 5_000 }, async () => {
  await fixture(async ({ stream, monitor, detail, calls, deadlineAt }) => {
    stream.destroy()
    await waitFor(() => detail.eventObservationFailed, deadlineAt)
    await monitor.stop()
    assert.equal(detail.retryEventCount, 0)
    assert.equal(detail.eventObservationFailed, true)
    assert.deepEqual(calls, [{ method: "GET", path: "/event" }])
  })
})

test("首個 retry 的 native abort 失敗即 fail closed，不重送 abort／prompt", { timeout: 5_000 }, async () => {
  await fixture(async ({ stream, monitor, detail, calls, deadlineAt }) => {
    stream.write(retryFrame("ses_owned")); stream.write(retryFrame("ses_owned"))
    await waitFor(() => detail.eventObservationFailed, deadlineAt)
    await monitor.stop()
    assert.equal(detail.retryEventCount, 1)
    assert.equal(detail.retryAborted, undefined)
    assert.equal(detail.eventObservationFailed, true)
    assert.deepEqual(calls, [{ method: "GET", path: "/event" }, { method: "POST", path: "/session/ses_owned/abort" }])
  }, true)
})
