import assert from "node:assert/strict"
import test from "node:test"
import http from "node:http"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { WorkerRegistrar, workerCoordinatorRegistration } from "../src/worker/registration.js"
import { deriveWorkerKey, workerProof } from "../src/coordinator/identity.js"
import { buildApp } from "../src/app.js"
import { ManagerRepository } from "../src/repository.js"
import { ManagerService } from "../src/service.js"
import { WorkerRuntime } from "../src/worker/runtime.js"
import { SeparateRequestAuthenticator } from "../src/auth.js"

const credentials = { username: "worker", password: "fixture-worker-password" }
const key = deriveWorkerKey("fixture-master-registration-secret", "one")
const nativeOrigin = "https://omw-job-one-code.example.test"
const publicOrigin = "https://manager.example.test"

test("worker-only identity authenticates fixed id/PodUID and never returns key; legacy Worker does not expose proof", { timeout: 5_000 }, async () => {
  const repository = new ManagerRepository(":memory:")
  const service = new ManagerService(repository, new WorkerRuntime({ controlOrigin: "http://execution:4175", token: "fixture", nativeOrigin }), { min: 4096, max: 4096 })
  const app = buildApp({ service, authority: { hostname: "127.0.0.1", port: 4174 }, allowedOrigins: new Set([publicOrigin]), publicOrigin,
    worker: { nativeOrigin, identity: { id: "one", generation: "uid-1", key } }, authenticator: new SeparateRequestAuthenticator({ manager: credentials, launcherToken: "unused" }) })
  const legacy = buildApp({ service, authority: { hostname: "127.0.0.1", port: 4174 }, allowedOrigins: new Set([publicOrigin]), publicOrigin,
    worker: { nativeOrigin }, authenticator: new SeparateRequestAuthenticator({ manager: credentials, launcherToken: "unused" }) })
  const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`
  try {
    assert.equal((await app.inject({ url: "/api/v1/worker/identity?nonce=n", headers: { host: "manager.example.test" } })).statusCode, 401)
    const result = await app.inject({ url: "/api/v1/worker/identity?nonce=fixed-nonce", headers: { host: "manager.example.test", authorization } })
    assert.deepEqual(result.json(), { id: "one", generation: "uid-1", nonce: "fixed-nonce", proof: workerProof(key, "fixed-nonce", "one", "uid-1") })
    assert.doesNotMatch(result.body, new RegExp(key))
    assert.equal((await app.inject({ url: "/api/v1/worker/identity?nonce=a%0Ab", headers: { host: "manager.example.test", authorization } })).statusCode, 400)
    assert.equal((await legacy.inject({ url: "/api/v1/worker/identity?nonce=n", headers: { host: "manager.example.test", authorization } })).statusCode, 404)
  } finally { await app.close(); await legacy.close(); repository.close() }
})

test("opt-in registration reads only own key, requires literal address/generation, returns immediately and cancels stalled renewal on close", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "omw-registrar-"))
  const file = path.join(directory, "worker-key")
  await writeFile(file, key, { mode: 0o600 })
  let seen: { body: Record<string, unknown>; headers: http.IncomingHttpHeaders } | undefined
  let received!: () => void
  const ready = new Promise<void>((resolve) => { received = resolve })
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => { seen = { body: JSON.parse(Buffer.concat(chunks).toString()), headers: request.headers }; received() })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  const env = { OMW_COORDINATOR_URL: `http://127.0.0.1:${address.port}`, OMW_COORDINATOR_WORKER_ID: "one",
    OMW_COORDINATOR_GENERATION: "uid-1", OMW_COORDINATOR_WORKER_KIND: "resident", OMW_COORDINATOR_ADVERTISE_ADDRESS: "127.0.0.2",
    OMW_COORDINATOR_WORKER_KEY_FILE: file }
  let registrar: WorkerRegistrar | undefined
  try {
    assert.equal(await workerCoordinatorRegistration({}, publicOrigin, nativeOrigin, credentials), undefined)
    for (const patch of [{ OMW_COORDINATOR_GENERATION: "" }, { OMW_COORDINATOR_ADVERTISE_ADDRESS: "localhost" }, { OMW_COORDINATOR_WORKER_KIND: "other" }]) {
      await assert.rejects(workerCoordinatorRegistration({ ...env, ...patch }, publicOrigin, nativeOrigin, credentials))
    }
    const config = (await workerCoordinatorRegistration(env, publicOrigin, nativeOrigin, credentials))!
    registrar = new WorkerRegistrar(config)
    registrar.start()
    await ready
    assert.equal(seen?.headers.origin, undefined)
    assert.equal(seen?.headers.host, "manager.example.test")
    assert.equal(seen?.headers.authorization, `Bearer ${key}`)
    assert.deepEqual(seen?.body, { id: "one", generation: "uid-1", kind: "resident", address: "127.0.0.2", nativeOrigin, browser: credentials })
    await registrar.close()
  } finally { await registrar?.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }) }
})
