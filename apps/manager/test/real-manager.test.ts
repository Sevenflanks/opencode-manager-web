import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { buildApp } from "../src/app.js"
import { ManagerRepository, type InstanceRecord } from "../src/repository.js"
import { OpenCodeRuntime } from "../src/runtime.js"
import { ManagerService } from "../src/service.js"

const enabled = process.env.OMW_REAL_OPENCODE_TEST === "1"
const authority = { hostname: "127.0.0.1", port: 4174 }
const readHeaders = { host: "127.0.0.1:4174" }
const mutationHeaders = { ...readHeaders, origin: "http://127.0.0.1:4174", "x-omw-csrf": "1" }

test("Manager restart releases a real exited Windows child allocation for reuse", { skip: process.platform !== "win32", timeout: 20_000 }, async () => {
  const sandbox = path.join(tmpdir(), `omw-real-reclaim-${randomUUID()}`)
  const project = path.join(sandbox, "project")
  const database = path.join(sandbox, "manager.sqlite")
  const nodeExecutable = realpathSync(process.execPath)
  await mkdir(project, { recursive: true })
  const port = await freePort()
  const child = spawn(nodeExecutable, ["-e", `require("node:net").createServer().listen(${port}, "127.0.0.1")`], {
    stdio: "ignore",
    windowsHide: true,
  })
  assert.ok(child.pid)
  let repository: ManagerRepository | null = null

  try {
    await waitForPort(port, true, 5_000)
    const runtime = new OpenCodeRuntime({ executable: nodeExecutable, dataDirectory: path.join(sandbox, "data") })
    const id = randomUUID()
    const identity = await runtime.adoptLocal!(project, port, id, child.pid).catch((error: unknown) => {
      throw new Error("real child identity setup failed", { cause: error })
    })
    repository = new ManagerRepository(database)
    const allocation = {
      id,
      kind: "headless" as const,
      clientInvocationId: null,
      projectDirectory: project,
      port,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
      instanceId: null,
    }
    assert.equal(repository.tryCreateAllocation(allocation), true)
    repository.createReservedInstance(id, {
      id,
      kind: "headless",
      clientInvocationId: null,
      projectName: path.basename(project),
      projectDirectory: project,
      state: "ready",
      endpoint: identity.endpoint,
      port,
      pid: identity.pid,
      creationTimeUtc: identity.creationTimeUtc,
      creationTimeTicks: identity.creationTimeTicks,
      executable: identity.executable,
      launchedAt: new Date().toISOString(),
      healthVersion: null,
      stoppedAt: null,
      error: null,
      stderrSummary: null,
    })
    repository.close()
    repository = null

    child.kill()
    await waitForExit(child)
    await waitForPort(port, false, 5_000)

    repository = new ManagerRepository(database)
    const restarted = new ManagerService(repository, new OpenCodeRuntime({ executable: nodeExecutable, dataDirectory: path.join(sandbox, "data") }), { min: port, max: port })
    await restarted.reconcile().catch((error: unknown) => {
      throw new Error("restart reconciliation failed", { cause: error })
    })
    assert.equal(repository.getInstance(id)?.state, "stopped")
    assert.equal(repository.getAllocation(id), null)
    const reservation = await restarted.reserveLocal({
      clientInvocationId: randomUUID(),
      directory: project,
      requestedPort: port,
    })
    assert.equal(reservation.port, port)
  } finally {
    if (child.exitCode === null) child.kill()
    await waitForExit(child).catch(() => undefined)
    repository?.close()
    await rm(sandbox, { recursive: true, force: true })
  }
})

test("Manager restart reconciles two real OpenCode processes and refuses stale identity or port reuse", { skip: !enabled, timeout: 90_000 }, async () => {
  const executable = process.env.OMW_OPENCODE_EXECUTABLE
  assert.ok(executable, "OMW_OPENCODE_EXECUTABLE is required")
  const sandbox = path.join(tmpdir(), `omw-real-manager-${randomUUID()}`)
  const project = path.join(sandbox, "project")
  const config = path.join(sandbox, "config")
  const data = path.join(sandbox, "data")
  const database = path.join(sandbox, "manager.sqlite")
  await Promise.all([mkdir(project, { recursive: true }), mkdir(config, { recursive: true }), mkdir(data, { recursive: true })])
  await writeFile(path.join(config, "opencode.json"), "{\"plugin\":[]}\n", "utf8")
  isolateEnvironment(sandbox, config)

  const runtime = new OpenCodeRuntime({ executable, dataDirectory: data })
  let repository = new ManagerRepository(database)
  let service = new ManagerService(repository, runtime)
  let app = buildApp({ service, authority, allowedOrigins: new Set([mutationHeaders.origin]) })
  let safeRecords: InstanceRecord[] = []
  let occupiedPortServer: net.Server | null = null

  try {
    const first = await startInstance(app, project)
    const second = await startInstance(app, project)
    assert.notEqual(first.id, second.id)
    safeRecords = [repository.getInstance(first.id), repository.getInstance(second.id)].filter((record): record is InstanceRecord => record !== null)
    assert.equal(safeRecords.length, 2)

    await app.close()
    repository.close()
    assert.equal(await portReachable(safeRecords[0]!.port), true)
    assert.equal(await portReachable(safeRecords[1]!.port), true)

    repository = new ManagerRepository(database)
    service = new ManagerService(repository, new OpenCodeRuntime({ executable, dataDirectory: data }))
    await service.reconcile()
    app = buildApp({ service, authority, allowedOrigins: new Set([mutationHeaders.origin]) })
    assert.deepEqual(repository.listInstances().map((item) => item.state).sort(), ["ready", "ready"])

    const reconciled = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
    assert.equal(reconciled.statusCode, 200)
    assert.equal(reconciled.json().instances.length, 2)
    assert.equal(reconciled.json().instances.every((item: { stopAllowed: boolean }) => item.stopAllowed), true, reconciled.body)

    const stoppedFirst = await app.inject({ method: "POST", url: `/api/v1/instances/${first.id}/stop`, headers: mutationHeaders })
    assert.equal(stoppedFirst.statusCode, 200)
    assert.equal(await portReachable(safeRecords[0]!.port), false)

    const currentSecond = repository.getInstance(second.id)
    assert.ok(currentSecond)
    const staleIdentity = { ...currentSecond, creationTimeTicks: String(BigInt(currentSecond.creationTimeTicks ?? "0") + 1n) }
    repository.saveInstance(staleIdentity)
    const staleStop = await app.inject({ method: "POST", url: `/api/v1/instances/${second.id}/stop`, headers: mutationHeaders })
    assert.equal(staleStop.statusCode, 409)
    assert.equal(await portReachable(safeRecords[1]!.port), true)
    repository.saveInstance(currentSecond)

    occupiedPortServer = net.createServer()
    const occupiedPort = await listen(occupiedPortServer)
    repository.saveInstance({ ...currentSecond, port: occupiedPort, endpoint: `http://127.0.0.1:${occupiedPort}` })
    const reusedPortStop = await app.inject({ method: "POST", url: `/api/v1/instances/${second.id}/stop`, headers: mutationHeaders })
    assert.equal(reusedPortStop.statusCode, 409)
    assert.equal(await portReachable(safeRecords[1]!.port), true)
    repository.saveInstance(currentSecond)

    const stoppedSecond = await app.inject({ method: "POST", url: `/api/v1/instances/${second.id}/stop`, headers: mutationHeaders })
    assert.equal(stoppedSecond.statusCode, 200)
    assert.equal(await portReachable(safeRecords[1]!.port), false)
  } finally {
    if (occupiedPortServer) await closeServer(occupiedPortServer)
    for (const record of safeRecords) {
      if (await portReachable(record.port)) await runtime.stop(record).catch(() => undefined)
    }
    await app.close().catch(() => undefined)
    repository.close()
    await rm(sandbox, { recursive: true, force: true })
  }
})

async function startInstance(app: ReturnType<typeof buildApp>, directory: string): Promise<{ id: string }> {
  const response = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory } })
  assert.equal(response.statusCode, 201, response.body)
  return response.json()
}

function isolateEnvironment(sandbox: string, config: string): void {
  const sensitive = /^(?:OPENCODE|OTUI)|(?:_API_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIAL|AUTH|^AWS_|^AZURE_|^GOOGLE_|^GITHUB_|^GITLAB_|^ANTHROPIC_|^OPENAI_)/i
  for (const name of Object.keys(process.env)) if (sensitive.test(name)) delete process.env[name]
  const home = path.join(sandbox, "home")
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: path.join(sandbox, "xdg-config"),
    XDG_DATA_HOME: path.join(sandbox, "xdg-data"),
    XDG_CACHE_HOME: path.join(sandbox, "xdg-cache"),
    XDG_STATE_HOME: path.join(sandbox, "xdg-state"),
    OPENCODE_DB: path.join(sandbox, "opencode.sqlite"),
    OPENCODE_CONFIG: path.join(config, "opencode.json"),
    OPENCODE_CONFIG_DIR: config,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_PRUNE: "1",
    OPENCODE_AUTO_SHARE: "false",
  })
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      resolve(typeof address === "object" && address ? address.port : 0)
    })
  })
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    child.once("exit", () => resolve())
    child.once("error", reject)
  })
}

function freePort(): Promise<number> {
  const server = net.createServer()
  return listen(server).then((port) => closeServer(server).then(() => port))
}

async function waitForPort(port: number, expectedOpen: boolean, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await portReachable(port) === expectedOpen) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Port ${port} did not become ${expectedOpen ? "open" : "closed"} within ${timeout} ms`)
}

function portReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port })
    const finish = (value: boolean) => { socket.destroy(); resolve(value) }
    socket.setTimeout(300)
    socket.once("connect", () => finish(true))
    socket.once("timeout", () => finish(false))
    socket.once("error", () => finish(false))
  })
}
