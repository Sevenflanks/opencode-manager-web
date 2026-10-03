import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { firstSseEvent } from "./stream-proof.mjs"

async function fixture(action, verify) {
  const server = createServer(action)
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  try { await verify(`http://127.0.0.1:${server.address().port}/event`) }
  finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

test("SSE 證據跨 chunk／CRLF／comment 解析第一事件且取消長連線", { timeout: 5_000 }, async () => {
  let disconnected
  const closed = new Promise((resolve) => { disconnected = resolve })
  await fixture((request, response) => {
    request.on("close", disconnected)
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(": heartbeat\r\n\r\ndata: {\"type\":\"server.con")
    setImmediate(() => response.write('nected\",\"properties\":{\"private\":\"do-not-record\"}}\r\n\r\n'))
  }, async (url) => {
    assert.deepEqual(await firstSseEvent(url, { timeout: 1_000 }), { transport: "SSE", status: 200, firstEventType: "server.connected", bodyRecorded: false })
    await closed
  })
})

test("SSE 非串流回應不能算可觀察連線證據", { timeout: 5_000 }, async () => {
  await fixture((_, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end("native shell") }, async (url) => {
    await assert.rejects(firstSseEvent(url, { timeout: 1_000 }), { code: "ERR_ASSERTION", actual: "text/html", operator: "match" })
  })
})

test("SSE 第一事件 deadline 取消無事件的 live HTTP request", { timeout: 5_000 }, async () => {
  let disconnected
  const closed = new Promise((resolve) => { disconnected = resolve })
  await fixture((request, response) => {
    request.on("close", disconnected)
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.flushHeaders()
  }, async (url) => {
    await assert.rejects(firstSseEvent(url, { timeout: 100 }), /deadline exceeded/)
    await closed
  })
})
