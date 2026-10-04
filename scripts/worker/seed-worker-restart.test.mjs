import assert from "node:assert/strict"
import { createServer } from "node:http"
import test from "node:test"
import { publicWorkerRequest } from "./verify-seed-workers.mjs"

async function fixture(action, verify) {
  const calls = []
  const server = createServer((request, response) => {
    calls.push({ method: request.method, path: request.url })
    response.setHeader("content-type", "application/json")
    action(request, response)
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    await verify(publicWorkerRequest({ managerUrl: url, nativeUrl: url, headers: {}, deadlineAt: Date.now() + 3_000 }), calls)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

test("execution restart 的 occupied／unknown capacity 拒絕 Start；錯誤唯一定位且不重送 POST", { timeout: 5_000 }, async () => {
  for (const capacity of ["occupied", "unknown"]) {
    await fixture((_, response) => {
      // reserveScopedExecution 只接受 available；舊 stopped record 並非 capacity 已釋放的證據。
      response.writeHead(409)
      response.end(JSON.stringify({ error: { code: "WORKER_CAPACITY_UNAVAILABLE", message: `private-${capacity}` } }))
    }, async (request, calls) => {
      await assert.rejects(request(false, "/api/v1/instances", { directory: "/workspace/seed-check" }), error => {
        assert.equal(error.message, "PUBLIC_HTTP_409 POST /api/v1/instances WORKER_CAPACITY_UNAVAILABLE")
        assert.deepEqual(error.publicRequest, { method: "POST", path: "/api/v1/instances", httpStatus: 409, errorCode: "WORKER_CAPACITY_UNAVAILABLE" })
        return true
      })
      assert.equal(calls.length, 1)
    })
  }
})

test("已啟動且綁 primary 後的 Stop 409 與 Start 409 可區別；不以錯誤推斷 stopped", { timeout: 5_000 }, async () => {
  let state = "stopped", primary = null
  await fixture((request, response) => {
    if (request.url === "/api/v1/instances") {
      assert.equal(state, "stopped")
      state = "ready"
      response.writeHead(201); response.end(JSON.stringify({ id: "restart-instance", state }))
    } else if (request.url.endsWith("/primary-session")) {
      primary = "old-primary"
      response.end(JSON.stringify({ sessionId: primary }))
    } else {
      // fresh inspect 不確定時 Stop fail closed；ready 與 primary 仍留在 DB。
      assert.equal(request.url, "/api/v1/instances/restart-instance/stop")
      response.writeHead(409); response.end(JSON.stringify({ error: { code: "PROCESS_IDENTITY_MISMATCH" } }))
    }
  }, async (request, calls) => {
    const started = await request(false, "/api/v1/instances", { directory: "/workspace/seed-check" })
    await request(false, `/api/v1/instances/${started.id}/primary-session`, { sessionId: "old-primary" })
    await assert.rejects(request(false, `/api/v1/instances/${started.id}/stop`, {}), error => {
      assert.equal(error.message, "PUBLIC_HTTP_409 POST /api/v1/instances/restart-instance/stop PROCESS_IDENTITY_MISMATCH")
      return true
    })
    assert.equal(state, "ready"); assert.equal(primary, "old-primary")
    assert.equal(calls.length, 3)
  })
})

test("失敗 diagnostics 排除 query／body／headers，只接受 bounded error code", { timeout: 5_000 }, async () => {
  for (const payload of [{ error: { code: "BAD\nprivate-token", message: "private-body" } }, { error: "private-body" }, null]) {
    await fixture((_, response) => { response.writeHead(409); response.end(JSON.stringify(payload)) }, async (request, calls) => {
      await assert.rejects(request(true, "/session/session-id/message?token=private-query", { private: "private-request-body" }), error => {
        assert.equal(error.message, "PUBLIC_HTTP_409 POST /session/session-id/message PUBLIC_ERROR_REDACTED")
        assert.equal(JSON.stringify(error.publicRequest).includes("private"), false)
        return true
      })
      assert.equal(calls.length, 1)
    })
  }
})

test("POST 回應中斷的 startup 結果未知，request 不自行重送", { timeout: 5_000 }, async () => {
  await fixture((request) => { request.socket.destroy() }, async (request, calls) => {
    await assert.rejects(request(false, "/api/v1/instances/old-instance/resume", {}))
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], { method: "POST", path: "/api/v1/instances/old-instance/resume" })
  })
})
