import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createServer } from "node:net"
import { startWorker } from "../src/worker/server.js"

test("public probe reports bootstrap readiness, drains, and exposes no control routes or status on other methods", { timeout: 10_000 }, async () => {
  const { startHealthServer } = await import("../src/worker/health.js")
  const health = await startHealthServer(0)
  assert.ok(health)
  const lifetime = setTimeout(() => { void health.close() }, 8_000)
  const origin = `http://127.0.0.1:${health.port}`
  const request = (pathname: string, method = "GET") => fetch(`${origin}${pathname}`, { method, signal: AbortSignal.timeout(1_000) })
  try {
    const live = await request("/health/live")
    assert.equal(live.status, 200)
    assert.deepEqual(await live.json(), { status: "ok" })
    assert.equal((await request("/health/ready")).status, 503, "bootstrap not yet complete")
    health.ready()
    const ready = await request("/health/ready")
    assert.equal(ready.status, 200, "no Instance/provider/login is required")
    assert.deepEqual(await ready.json(), { status: "ok" })
    for (const route of ["/v1/execution", "/api/v1/instances", "/", "/health/ready?secret=hidden"]) {
      const response = await request(route)
      assert.equal(response.status, 404)
      assert.equal(await response.text(), "")
    }
    for (const method of ["HEAD", "POST", "OPTIONS", "DELETE"]) {
      const response = await request("/health/ready", method)
      assert.equal(response.status, 404)
      assert.equal(await response.text(), "")
    }
    health.drain()
    health.ready()
    assert.equal((await request("/health/ready")).status, 503, "draining cannot become ready again")
    assert.equal((await request("/health/live")).status, 200)
  } finally {
    clearTimeout(lifetime)
    await health.close()
  }
  await assert.rejects(request("/health/live"), "close releases the listener")
  assert.equal(await startHealthServer(undefined), undefined, "opt-out does not open a listener")
})

async function unusedPort() {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

test("Worker manager is ready without an Instance or reachable execution, retains auth, releases DB/listeners on close and opts out by default", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-worker-health-"))
  const port = await unusedPort(), healthPort = await unusedPort()
  const environment = {
    OMW_DATA_DIR: root, OMW_PORT: String(port), OMW_HEALTH_PORT: String(healthPort),
    OMW_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, OMW_NATIVE_ORIGIN: "http://127.0.0.1:4180",
    OMW_EXECUTION_ORIGIN: "http://127.0.0.1:1", OMW_EXECUTION_TOKEN_FILE: path.join(root, "control"),
    OMW_BROWSER_USERNAME: "fixture", OMW_BROWSER_PASSWORD_FILE: path.join(root, "browser"),
  }
  await writeFile(environment.OMW_EXECUTION_TOKEN_FILE, "synthetic-control-token-32-characters")
  await writeFile(environment.OMW_BROWSER_PASSWORD_FILE, "synthetic-browser-password")
  let app: Awaited<ReturnType<typeof startWorker>> | undefined
  const lifetime = setTimeout(() => { void app?.close() }, 12_000)
  const probe = () => fetch(`http://127.0.0.1:${healthPort}/health/ready`, { signal: AbortSignal.timeout(1_000) })
  try {
    app = await startWorker(environment, "fixture", root)
    assert.equal((await probe()).status, 200)
    const response = await fetch(`${environment.OMW_PUBLIC_ORIGIN}/api/v1/overview`, { signal: AbortSignal.timeout(1_000) })
    assert.equal(response.status, 401, "probe cannot bypass manager auth")
    await app.close()
    await assert.rejects(probe())
    app = await startWorker({ ...environment, OMW_HEALTH_PORT: undefined }, "fixture", root)
    await assert.rejects(probe(), "Compose/local default opens no health listener")
    const instances = await app.inject({ url: "/api/v1/overview", headers: {
      host: `127.0.0.1:${port}`, authorization: `Basic ${Buffer.from("fixture:synthetic-browser-password").toString("base64")}`,
    } })
    assert.equal(instances.statusCode, 200, instances.body)
    assert.deepEqual(instances.json().instances, [])
  } finally {
    clearTimeout(lifetime)
    await app?.close()
    await rm(root, { recursive: true, force: true })
  }
})
