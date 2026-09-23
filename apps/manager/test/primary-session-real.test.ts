import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomInt, randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { prepareIsolatedEnvironment } from "../src/isolation.js"
import { ManagerRepository, type InstanceRecord } from "../src/repository.js"
import {
  OpenCodeRuntime,
  type RuntimeActivityEvent,
  type RuntimeActivityEvidence,
  type RuntimeActivityObserver,
} from "../src/runtime.js"
import { ManagerService } from "../src/service.js"

const enabled = process.env.OMW_REAL_OPENCODE_TEST === "1"
const WAIT_MS = 15_000
const execFileAsync = promisify(execFile)

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

interface ActivityGate {
  started: Deferred<void>
  released: Deferred<void>
}

class RecordingOpenCodeRuntime extends OpenCodeRuntime {
  readonly observed: Array<{ instanceId: string; event: RuntimeActivityEvent }> = []
  readonly handled: Array<{ instanceId: string; event: RuntimeActivityEvent }> = []
  readonly evidence: Array<{ instanceId: string; busySessionIds: string[] }> = []
  private readonly gates = new Map<string, ActivityGate>()

  deferNextActivity(instanceId: string): { started: Promise<void>; release(): void } {
    const gate = { started: deferred<void>(), released: deferred<void>() }
    this.gates.set(instanceId, gate)
    return { started: gate.started.promise, release: () => gate.released.resolve() }
  }

  override async activity(instance: InstanceRecord): Promise<RuntimeActivityEvidence> {
    const gate = this.gates.get(instance.id)
    if (gate) {
      this.gates.delete(instance.id)
      gate.started.resolve()
      await gate.released.promise
    }
    const result = await super.activity(instance)
    this.evidence.push({ instanceId: instance.id, busySessionIds: [...result.busySessionIds] })
    return result
  }

  override observeActivity(
    instance: InstanceRecord,
    onEvent: (event: RuntimeActivityEvent) => Promise<void> | void,
  ): RuntimeActivityObserver {
    return super.observeActivity(instance, async (event) => {
      this.observed.push({ instanceId: instance.id, event })
      await onEvent(event)
      this.handled.push({ instanceId: instance.id, event })
    })
  }

  releaseAll(): void {
    for (const gate of this.gates.values()) gate.released.resolve()
    this.gates.clear()
  }
}

test("real OpenCode SSE pins each instance's first native activity without UI polling", {
  skip: !enabled,
  timeout: 90_000,
}, async (t) => {
  const executable = process.env.OMW_OPENCODE_EXECUTABLE
  assert.ok(executable, "OMW_OPENCODE_EXECUTABLE is required")
  const sandbox = path.join(tmpdir(), `omw-primary-real-${randomUUID()}`)
  const project = path.join(sandbox, "project")
  const config = path.join(sandbox, "config")
  const data = path.join(sandbox, "data")
  const managerDatabase = path.join(sandbox, "manager.sqlite")
  await Promise.all([mkdir(project, { recursive: true }), mkdir(config, { recursive: true }), mkdir(data, { recursive: true })])

  const provider = await startMockProvider()
  const configFile = path.join(config, "opencode.json")
  await writeFile(configFile, `${JSON.stringify(mockConfig(provider.port), null, 2)}\n`, "utf8")
  const isolation = await prepareIsolatedEnvironment({ mode: "test", root: sandbox, configFile, sourceEnvironment: process.env })
  const { stdout: versionOutput } = await execFileAsync(executable, ["--version"], { env: isolation.environment, timeout: 10_000 })
  const expectedVersion = versionOutput.trim()
  assert.match(expectedVersion, /^\d+\.\d+\.\d+$/, "the selected OpenCode executable must report a version")
  const [portMin, portMax] = await freeAdjacentPorts()
  const runtime = new RecordingOpenCodeRuntime({
    executable,
    dataDirectory: data,
    environment: isolation.environment,
  })
  const repository = new ManagerRepository(managerDatabase)
  const service = new ManagerService(repository, runtime, { min: portMin, max: portMax })
  const owned: Array<{ id: string; pid: number; port: number }> = []
  let testError: unknown = null
  const cleanupErrors: string[] = []

  try {
    const first = await service.start(project)
    const firstRecord = requiredRecord(repository, first.id)
    assert.ok(firstRecord.pid)
    owned.push({ id: first.id, pid: firstRecord.pid, port: firstRecord.port })
    const second = await service.start(project)
    const secondRecord = requiredRecord(repository, second.id)
    assert.ok(secondRecord.pid)
    owned.push({ id: second.id, pid: secondRecord.pid, port: secondRecord.port })
    assert.equal(first.healthVersion, expectedVersion)
    assert.equal(second.healthVersion, expectedVersion)
    assert.equal(first.primarySession, null)
    assert.equal(second.primarySession, null)

    await waitFor("both Manager SSE observers to connect", () =>
      [first.id, second.id].every((id) => runtime.handled.some((item) =>
        item.instanceId === id && item.event.type === "activity" && item.event.source === "snapshot")))

    assert.deepEqual(await nativeSessions(firstRecord), [])
    assert.deepEqual(await nativeSessions(secondRecord), [])

    const firstSession = await nativeCreateRoot(firstRecord, "First native activity")
    await waitFor("first root metadata to be shared", async () =>
      (await nativeSessions(secondRecord)).some((session) => session.id === firstSession.id))
    const firstSnapshot = runtime.deferNextActivity(first.id)
    await nativePrompt(firstRecord, firstSession.id)
    await Promise.all([provider.waitForRequest(1), firstSnapshot.started])
    provider.release(1)
    await waitFor("first native activity to finish", async () => !Object.hasOwn(await nativeStatuses(firstRecord), firstSession.id))
    firstSnapshot.release()
    await waitForHandledBusy(runtime, first.id, firstSession.id)

    let overview = await service.overview()
    assert.equal(overview.instances.find((instance) => instance.id === first.id)?.primarySession?.sessionId, firstSession.id)
    assert.equal(overview.instances.find((instance) => instance.id === first.id)?.primarySession?.source, "activity")
    assert.equal(overview.instances.find((instance) => instance.id === second.id)?.primarySession, null)
    assert.deepEqual(lastEvidence(runtime, first.id).busySessionIds, [])

    const secondSession = await nativeCreateRoot(secondRecord, "Second native activity")
    const secondSnapshot = runtime.deferNextActivity(second.id)
    await nativePrompt(secondRecord, secondSession.id)
    await Promise.all([provider.waitForRequest(2), secondSnapshot.started])
    provider.release(2)
    await waitFor("second native activity to finish", async () => !Object.hasOwn(await nativeStatuses(secondRecord), secondSession.id))
    secondSnapshot.release()
    await waitForHandledBusy(runtime, second.id, secondSession.id)

    overview = await service.overview()
    assert.equal(overview.instances.find((instance) => instance.id === first.id)?.primarySession?.sessionId, firstSession.id)
    assert.equal(overview.instances.find((instance) => instance.id === second.id)?.primarySession?.sessionId, secondSession.id)
    assert.equal(overview.instances.find((instance) => instance.id === second.id)?.primarySession?.source, "activity")
    assert.deepEqual(lastEvidence(runtime, second.id).busySessionIds, [])
    assert.ok(runtime.observed.some((item) => isBusyEvent(item, first.id, firstSession.id)))
    assert.ok(runtime.observed.some((item) => isBusyEvent(item, second.id, secondSession.id)))

    t.diagnostic(JSON.stringify({
      openCodeVersion: first.healthVersion,
      instances: owned,
      providerPort: provider.port,
      observedBusySessionIds: [firstSession.id, secondSession.id],
      boundSessionIds: [firstSession.id, secondSession.id],
      followUpSnapshotsBusySessionIds: [lastEvidence(runtime, first.id).busySessionIds, lastEvidence(runtime, second.id).busySessionIds],
    }))
  } catch (error) {
    testError = error
  } finally {
    runtime.releaseAll()
    provider.releaseAll()
    for (const instance of [...owned].reverse()) {
      try {
        const current = repository.getInstance(instance.id)
        if (current && current.state !== "stopped") await service.stop(instance.id)
      } catch (error) {
        cleanupErrors.push(`instance ${instance.id}: ${safeMessage(error)}`)
      }
    }
    try {
      await service.shutdown()
    } catch (error) {
      cleanupErrors.push(`service: ${safeMessage(error)}`)
    }
    repository.close()
    try {
      await provider.close()
    } catch (error) {
      cleanupErrors.push(`provider: ${safeMessage(error)}`)
    }
    for (const instance of owned) {
      if (await portReachable(instance.port)) cleanupErrors.push(`instance port ${instance.port} remains reachable`)
    }
    if (await portReachable(provider.port)) cleanupErrors.push(`provider port ${provider.port} remains reachable`)
    try {
      await rm(sandbox, { recursive: true, force: true })
    } catch (error) {
      cleanupErrors.push(`sandbox: ${safeMessage(error)}`)
    }
    t.diagnostic(JSON.stringify({ cleanup: { instances: owned, providerPort: provider.port, errors: cleanupErrors } }))
  }

  if (testError) throw testError
  assert.deepEqual(cleanupErrors, [])
})

function isBusyEvent(
  item: { instanceId: string; event: RuntimeActivityEvent },
  instanceId: string,
  sessionId: string,
): boolean {
  return item.instanceId === instanceId && item.event.type === "activity"
    && item.event.source === "event" && item.event.sessionIds.includes(sessionId)
}

async function waitForHandledBusy(runtime: RecordingOpenCodeRuntime, instanceId: string, sessionId: string): Promise<void> {
  await waitFor(`Manager to handle busy SSE for ${instanceId}`, () =>
    runtime.handled.some((item) => isBusyEvent(item, instanceId, sessionId)))
}

function lastEvidence(runtime: RecordingOpenCodeRuntime, instanceId: string): { instanceId: string; busySessionIds: string[] } {
  const evidence = runtime.evidence.filter((item) => item.instanceId === instanceId).at(-1)
  assert.ok(evidence)
  return evidence
}

function requiredRecord(repository: ManagerRepository, id: string): InstanceRecord {
  const record = repository.getInstance(id)
  assert.ok(record)
  return record
}

interface NativeSession { id: string }

async function nativeCreateRoot(instance: InstanceRecord, title: string): Promise<NativeSession> {
  const result = await nativeRequest(instance, "/session", { method: "POST", body: { title } }) as NativeSession
  assert.equal(typeof result.id, "string")
  return result
}

async function nativePrompt(instance: InstanceRecord, sessionId: string): Promise<void> {
  await nativeRequest(instance, `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
    method: "POST",
    expectedStatus: 204,
    body: {
      model: { providerID: "localmock", modelID: "mock" },
      tools: { bash: false, edit: false, write: false, patch: false, webfetch: false, task: false },
      parts: [{ type: "text", text: "LOCAL_PRIMARY_SESSION_FIXTURE" }],
    },
  })
}

async function nativeSessions(instance: InstanceRecord): Promise<NativeSession[]> {
  return await nativeRequest(instance, "/session") as NativeSession[]
}

async function nativeStatuses(instance: InstanceRecord): Promise<Record<string, unknown>> {
  return await nativeRequest(instance, "/session/status") as Record<string, unknown>
}

async function nativeRequest(
  instance: InstanceRecord,
  pathname: string,
  options: { method?: string; body?: unknown; expectedStatus?: number } = {},
): Promise<unknown> {
  const url = new URL(pathname, instance.endpoint)
  url.searchParams.set("directory", instance.projectDirectory)
  const response = await fetch(url, {
    method: options.method ?? "GET",
    ...(options.body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options.body),
    }),
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  })
  const text = await response.text()
  assert.equal(response.status, options.expectedStatus ?? 200, `${options.method ?? "GET"} ${pathname}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

function mockConfig(providerPort: number): object {
  return {
    $schema: "https://opencode.ai/config.json",
    plugin: [],
    model: "localmock/mock",
    small_model: "localmock/mock",
    provider: {
      localmock: {
        npm: "@ai-sdk/openai-compatible",
        name: "Local Mock Fixture",
        options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "test-only-dummy" },
        models: { mock: { name: "Local Mock Fixture", limit: { context: 32_768, output: 2_048 } } },
      },
    },
    permission: { bash: "deny", edit: "deny", write: "deny", external_directory: "deny", webfetch: "deny" },
  }
}

interface MockProvider {
  port: number
  waitForRequest(ordinal: number): Promise<void>
  release(ordinal: number): void
  releaseAll(): void
  close(): Promise<void>
}

async function startMockProvider(): Promise<MockProvider> {
  const gates = new Map<number, Deferred<void>>()
  const arrivals = new Set<number>()
  let requestCount = 0
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      if (request.method === "GET" && url.pathname === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ object: "list", data: [{ id: "mock", object: "model" }] }))
        return
      }
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        response.writeHead(404).end()
        return
      }
      const body = await readJson(request)
      const ordinal = ++requestCount
      const gate = deferred<void>()
      gates.set(ordinal, gate)
      arrivals.add(ordinal)
      await gate.promise
      if (body.stream === true) writeCompletionStream(response, body.model)
      else writeCompletionJson(response, body.model)
    } catch {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: "Local mock provider failed" } }))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  return {
    port: address.port,
    waitForRequest: async (ordinal) => await waitFor(`mock provider request ${ordinal}`, () => arrivals.has(ordinal)),
    release: (ordinal) => gates.get(ordinal)?.resolve(),
    releaseAll: () => { for (const gate of gates.values()) gate.resolve() },
    close: async () => await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

async function readJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 1024 * 1024) throw new Error("Mock provider body exceeds 1 MiB")
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
}

function writeCompletionStream(response: http.ServerResponse, model: unknown): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" })
  response.write(`data: ${JSON.stringify(completionChunk(model, { role: "assistant" }))}\n\n`)
  response.write(`data: ${JSON.stringify(completionChunk(model, { content: "LOCAL_MOCK_RESPONSE" }))}\n\n`)
  response.write(`data: ${JSON.stringify(completionChunk(model, {}, "stop"))}\n\n`)
  response.end("data: [DONE]\n\n")
}

function writeCompletionJson(response: http.ServerResponse, model: unknown): void {
  response.writeHead(200, { "content-type": "application/json" })
  response.end(JSON.stringify({
    id: "chatcmpl-local-fixture",
    object: "chat.completion",
    created: 0,
    model: typeof model === "string" ? model : "mock",
    choices: [{ index: 0, message: { role: "assistant", content: "LOCAL_MOCK_RESPONSE" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
  }))
}

function completionChunk(model: unknown, delta: object, finishReason: string | null = null): object {
  return {
    id: "chatcmpl-local-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: typeof model === "string" ? model : "mock",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function waitFor(description: string, predicate: () => boolean | Promise<boolean>, timeoutMs = WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`${description} was not observed within ${timeoutMs} ms`)
}

async function freeAdjacentPorts(): Promise<[number, number]> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const first = randomInt(20_000, 55_000)
    if (first === 42_000 || first === 42_001 || first === 4_310) continue
    const servers = [net.createServer(), net.createServer()]
    try {
      await Promise.all(servers.map((server, index) => listen(server, first + index)))
      return [first, first + 1]
    } catch {
      // Try another pair; both temporary listeners are always closed below.
    } finally {
      await Promise.all(servers.map(async (server) => await closeServer(server)))
    }
  }
  throw new Error("Could not reserve an adjacent dynamic port pair")
}

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  })
}

function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve) => server.close(() => resolve()))
}

function portReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port })
    const finish = (reachable: boolean) => { socket.destroy(); resolve(reachable) }
    socket.setTimeout(300)
    socket.once("connect", () => finish(true))
    socket.once("timeout", () => finish(false))
    socket.once("error", () => finish(false))
  })
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
