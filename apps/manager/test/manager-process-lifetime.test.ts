import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { prepareIsolatedEnvironment } from "../src/isolation.js"
import { ManagerRepository, type InstanceRecord } from "../src/repository.js"
import { OpenCodeRuntime } from "../src/runtime.js"

const enabled = process.platform === "win32" && process.env.OMW_REAL_OPENCODE_TEST === "1"
const fixture = fileURLToPath(new URL("./manager-process-lifetime.fixture.js", import.meta.url))

test("native headless Instance survives Manager OS exit and reconciles with the same exact identity", {
  skip: !enabled, timeout: 120_000,
}, async (t) => {
  const nativeOpenCode = process.env.OMW_OPENCODE_EXECUTABLE
  assert.ok(nativeOpenCode, "OMW_OPENCODE_EXECUTABLE is required")
  const sandbox = path.join(tmpdir(), `omw-manager-lifetime-${randomUUID()}`)
  const project = path.join(sandbox, "project")
  await mkdir(project, { recursive: true })
  const isolation = await prepareIsolatedEnvironment({ mode: "test", root: sandbox, sourceEnvironment: process.env })
  const [managerPort, instancePort] = await distinctFreePorts()
  const origin = `http://127.0.0.1:${managerPort}`
  const username = `manager-fixture-${randomUUID()}`
  const password = randomUUID()
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  const environment = {
    ...isolation.environment,
    OMW_PORT: String(managerPort),
    OMW_INSTANCE_PORT_MIN: String(instancePort),
    OMW_INSTANCE_PORT_MAX: String(instancePort),
    OMW_OPENCODE_EXECUTABLE: nativeOpenCode,
    OMW_REMOTE_ACCESS: "0",
    OMW_TEST_MANAGER_USERNAME: username,
    OMW_TEST_MANAGER_PASSWORD: password,
  }
  const database = path.join(isolation.paths.omwData, "omw.sqlite")
  const runtime = new OpenCodeRuntime({ executable: nativeOpenCode, dataDirectory: isolation.paths.omwData, environment: isolation.environment })
  const managers: OwnedManager[] = []
  let instanceId: string | null = null
  let original: InstanceRecord | null = null
  let operationFailure: unknown
  const cleanupFailures: unknown[] = []

  try {
    const first = await startManager(environment, origin, authorization)
    managers.push(first)
    const started = await request(origin, authorization, "POST", "/api/v1/instances", { directory: project })
    assert.equal(started.status, 201, JSON.stringify(started.body))
    instanceId = (started.body as { id: string }).id
    const repository = new ManagerRepository(database)
    try { original = repository.getInstance(instanceId) } finally { repository.close() }
    assert.ok(original?.pid && original.creationTimeTicks && original.executable)
    assert.equal(original.state, "ready")
    assert.equal(original.port, instancePort)
    assert.equal(original.projectDirectory.toLowerCase(), project.toLowerCase())
    assert.equal(realpathSync(original.executable).toLowerCase(), realpathSync(nativeOpenCode).toLowerCase())
    t.diagnostic(`owned Manager #1 PID=${first.pid}; native OpenCode PID=${original.pid}; ports=${managerPort},${instancePort}`)

    const before = await request(origin, authorization, "GET", "/api/v1/overview")
    assert.equal(before.status, 200, JSON.stringify(before.body))
    assert.equal(findInstance(before.body, instanceId)?.state, "ready")
    await stopManager(first)
    assert.equal(first.child.exitCode, 0, `first Manager did not exit cleanly: ${first.stderr}`)
    assert.equal(processExists(first.pid), false, "the first Manager OS process must have exited")
    assert.equal(await portReachable(managerPort), false)
    assert.equal(await portReachable(instancePort), true, "headless OpenCode must outlive the Manager OS process")

    const second = await startManager(environment, origin, authorization)
    managers.push(second)
    t.diagnostic(`owned Manager #2 PID=${second.pid}; first Manager OS exit verified; OpenCode port remained reachable`)
    const reconciled = await request(origin, authorization, "GET", "/api/v1/overview")
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body))
    const same = findInstance(reconciled.body, instanceId)
    assert.ok(same)
    assert.equal(same.state, "ready")
    assert.equal(same.pid, original.pid)
    assert.equal(same.port, original.port)
    assert.equal(same.id, original.id)
    assert.equal(same.stopAllowed, true)
    const reopened = new ManagerRepository(database)
    try {
      const persisted = reopened.getInstance(instanceId)
      assert.ok(persisted)
      assert.deepEqual(
        [persisted.pid, persisted.creationTimeTicks, persisted.executable, persisted.endpoint],
        [original.pid, original.creationTimeTicks, original.executable, original.endpoint],
      )
    } finally { reopened.close() }
    const stopped = await request(origin, authorization, "POST", `/api/v1/instances/${instanceId}/stop`)
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body))
    await waitForPort(instancePort, false)
    await stopManager(second)
    assert.equal(second.child.exitCode, 0, `second Manager did not exit cleanly: ${second.stderr}`)
    assert.equal(processExists(second.pid), false, "the second Manager OS process must have exited")
  } catch (error) {
    operationFailure = error
  } finally {
    // 先只關閉本測試持有的 Manager handle，避免子程序繼續改寫 registry。
    for (const manager of managers.reverse()) {
      try {
        await stopManager(manager)
        assert.ok(manager.child.exitCode !== null || manager.child.signalCode !== null)
        assert.equal(processExists(manager.pid), false, `owned Manager PID ${manager.pid} remains alive`)
      } catch (error) { cleanupFailures.push(error) }
    }
    try {
      const repository = new ManagerRepository(database)
      try {
        for (const record of repository.listInstances()) {
          if (record.projectDirectory.toLowerCase() !== project.toLowerCase() || record.port !== instancePort
            || !record.executable || realpathSync(record.executable).toLowerCase() !== realpathSync(nativeOpenCode).toLowerCase()
            || !record.pid || !record.creationTimeTicks) continue
          if (!processExists(record.pid)) continue
          const result = await runtime.stop(record) // 依 PID、建立時間戳、執行檔與連接埠擁有者精確辨識目標程序。
          assert.equal(result.stopped, true, `owned OpenCode cleanup unresolved: ${result.reason}`)
        }
      } finally { repository.close() }
    } catch (error) { cleanupFailures.push(error) }
    try {
      assert.equal(await portReachable(managerPort), false, "Manager test port remains occupied")
      assert.equal(await portReachable(instancePort), false, "OpenCode test port remains occupied")
    } catch (error) { cleanupFailures.push(error) }
    if (cleanupFailures.length === 0) {
      try { await rm(sandbox, { recursive: true, force: true }) } catch (error) { cleanupFailures.push(error) }
    }
    if (cleanupFailures.length === 0) t.diagnostic(`cleanup: ${managers.length} Manager child handles exited; owned OpenCode stopped; ports ${managerPort},${instancePort} free; sandbox removed`)
  }
  if (operationFailure || cleanupFailures.length) throw new AggregateError(
    [...(operationFailure ? [operationFailure] : []), ...cleanupFailures],
    `Manager process lifetime verification failed; cleanup errors=${cleanupFailures.length}${cleanupFailures.length ? `; sandbox=${sandbox}` : ""}`,
  )
  assert.ok(original && instanceId)
})

interface OwnedManager { child: ChildProcess; pid: number; stderr: string }

async function startManager(env: NodeJS.ProcessEnv, origin: string, authorization: string): Promise<OwnedManager> {
  const child = spawn(process.execPath, [fixture], { env, stdio: ["pipe", "ignore", "pipe"], windowsHide: true })
  assert.ok(child.pid)
  const owned: OwnedManager = { child, pid: child.pid, stderr: "" }
  child.stderr?.on("data", (chunk: Buffer) => { owned.stderr = (owned.stderr + chunk.toString("utf8")).slice(-4096) })
  try {
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Manager exited before HTTP readiness: ${owned.stderr}`)
      try { return (await request(origin, authorization, "GET", "/api/v1/connectivity")).status === 200 } catch { return false }
    }, 20_000)
    return owned
  } catch (error) {
    await stopManager(owned).catch((cleanupError: unknown) => { throw new AggregateError([error, cleanupError], "Manager startup and cleanup failed") })
    throw error
  }
}

async function stopManager(manager: OwnedManager): Promise<void> {
  const { child } = manager
  if (child.exitCode !== null || child.signalCode !== null) return
  child.stdin?.end()
  try { await waitForExit(child, 8_000) } catch (error) {
    // 後備處理只使用原始 child handle，不以重建的 PID 操作程序。
    child.kill()
    await waitForExit(child, 5_000).catch((fallback: unknown) => { throw new AggregateError([error, fallback], "Manager child failed to exit") })
  }
}

function waitForExit(child: ChildProcess, ms: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Manager child did not exit within ${ms} ms`)), ms)
    const onExit = () => finish()
    const onError = (error: Error) => finish(error)
    function finish(error?: Error) {
      clearTimeout(timeout)
      child.off("exit", onExit)
      child.off("error", onError)
      if (error) reject(error); else resolve()
    }
    child.once("exit", onExit)
    child.once("error", onError)
  })
}

function processExists(pid: number): boolean {
  const result = spawnSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `try { $p = [Diagnostics.Process]::GetProcessById(${pid}); try { if ($p.HasExited) { exit 1 }; exit 0 } finally { $p.Dispose() } } catch { exit 1 }`,
  ], { windowsHide: true, timeout: 3_000 })
  if (result.error) throw result.error
  assert.ok(result.status === 0 || result.status === 1, `OS process query failed: ${result.stderr}`)
  return result.status === 0
}

async function request(origin: string, authorization: string, method: "GET" | "POST", route: string, payload?: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: { authorization, ...(method === "POST" ? { origin, "x-omw-csrf": "1" } : {}), ...(payload ? { "content-type": "application/json" } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    signal: AbortSignal.timeout(35_000),
  })
  return { status: response.status, body: await response.json() }
}

function findInstance(body: unknown, id: string): { id: string; state: string; pid: number; port: number; stopAllowed: boolean } | undefined {
  return (body as { instances: Array<{ id: string; state: string; pid: number; port: number; stopAllowed: boolean }> }).instances.find((entry) => entry.id === id)
}

async function distinctFreePorts(): Promise<[number, number]> {
  const manager = await freePort()
  let instance = await freePort()
  while (instance === manager) instance = await freePort()
  return [manager, instance]
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close((error) => error ? reject(error) : resolve(typeof address === "object" && address ? address.port : 0))
    })
  })
}

async function waitForPort(port: number, open: boolean): Promise<void> {
  await waitFor(async () => await portReachable(port) === open, 10_000)
}

async function waitFor(predicate: () => Promise<boolean>, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Condition was not met within ${ms} ms`)
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
