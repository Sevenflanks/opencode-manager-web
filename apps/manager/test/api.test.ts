import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { buildApp } from "../src/app.js"
import { SeparateRequestAuthenticator, type StoredCredentials } from "../src/auth.js"
import { ManagerRepository, type InstanceRecord } from "../src/repository.js"
import { ManagerService } from "../src/service.js"
import type { LaunchResult, RuntimePort, RuntimeSummary } from "../src/runtime.js"

const mutationHeaders = {
  host: "127.0.0.1:4174",
  origin: "http://127.0.0.1:5173",
  "x-omw-csrf": "1",
}
const readHeaders = { host: "127.0.0.1:4174" }

class FakeRuntime implements RuntimePort {
  launchCount = 0
  identityMatches = true
  portOwnerMatched = true
  portOwnedByOther = false
  inspectFails = false
  reachable = true
  cleanupCount = 0
  cleanupSucceeds = true
  adoptedCount = 0
  adoptedCreationTimeUtc: string | null = null
  readinessError: Error | null = null
  readinessGate: Promise<void> | null = null
  releaseReadiness: (() => void) | null = null
  summaries = new Map<string, RuntimeSummary>()
  sessionMetadata = new Map<string, Array<{ id: string; title: string; parentID?: string }>>()
  summaryCalls = 0
  sessionCalls = 0
  childrenCalls = 0
  openUrlCalls = 0

  async launch(directory: string, port: number, instanceId: string): Promise<LaunchResult> {
    this.launchCount++
    return {
      pid: 4100 + this.launchCount,
      creationTimeUtc: "2026-09-17T00:00:00.000Z",
      creationTimeTicks: String(638936640000000000n + BigInt(this.launchCount)),
      executable: "C:\\tools\\opencode.exe",
      endpoint: `http://127.0.0.1:${port}`,
      directory,
      instanceId,
    }
  }

  async readiness(launch: LaunchResult) {
    if (this.readinessGate) await this.readinessGate
    if (this.readinessError) throw this.readinessError
    if (!this.reachable) throw new Error("health endpoint unavailable")
    return { version: "1.18.31", directory: launch.directory }
  }

  async adoptLocal(directory: string, port: number, instanceId: string, pid: number): Promise<LaunchResult> {
    this.adoptedCount++
    return {
      pid,
      creationTimeUtc: this.adoptedCreationTimeUtc ?? new Date().toISOString(),
      creationTimeTicks: String(638936640000100000n + BigInt(this.adoptedCount)),
      executable: "C:\\tools\\opencode.exe",
      endpoint: `http://127.0.0.1:${port}`,
      directory,
      instanceId,
    }
  }

  blockReadiness(): void {
    this.readinessGate = new Promise((resolve) => { this.releaseReadiness = resolve })
  }

  async inspect() {
    if (this.inspectFails) throw new Error("identity probe unavailable")
    return {
      matched: this.identityMatches,
      portOwnerMatched: this.portOwnerMatched,
      portOwnedByOther: this.portOwnedByOther,
      running: true,
    }
  }

  async stop() {
    return this.identityMatches
      ? { stopped: true, reason: null }
      : { stopped: false, reason: "process identity mismatch" }
  }

  async cleanupLaunch() {
    this.cleanupCount++
    return this.cleanupSucceeds
      ? { stopped: true, reason: null }
      : { stopped: false, reason: "descendant still running" }
  }

  async sessions(instance: InstanceRecord) {
    this.sessionCalls++
    const configured = this.sessionMetadata.get(instance.projectDirectory)
    if (configured) return configured
    return [
      { id: "root", title: "主工作" },
      { id: "child", title: "子工作", parentID: "root" },
      { id: "orphan", title: "未知父層", parentID: "missing" },
    ]
  }

  async children(_instance: unknown, sessionId: string) {
    this.childrenCalls++
    return sessionId === "root" ? [{ id: "child", title: "子工作", parentID: "root" }] : []
  }

  async summary(instance: InstanceRecord) {
    this.summaryCalls++
    const configured = this.summaries.get(instance.projectDirectory)
    if (configured) return configured
    return {
      activity: "busy" as const,
      busySessions: 1,
      pendingQuestions: 1,
      pendingPermissions: 1,
      error: null,
      sessions: [{ id: "root", title: "主工作" }],
    }
  }

  openUrl(instance: { endpoint: string; projectDirectory: string }, sessionId?: string) {
    this.openUrlCalls++
    const url = new URL("/", instance.endpoint)
    url.searchParams.set("directory", instance.projectDirectory)
    if (sessionId) url.searchParams.set("session", sessionId)
    return url.toString()
  }
}

async function fixture(t: test.TestContext, access?: {
  publicOrigin?: string
  credentials?: StoredCredentials
  launcherCredentials?: StoredCredentials
  portPool?: { min: number; max: number }
}) {
  const root = await mkdtemp(path.join(tmpdir(), "omw-api-"))
  const project = path.join(root, "project")
  const childDirectory = path.join(project, "child")
  await mkdir(childDirectory, { recursive: true })
  await writeFile(path.join(root, "index.html"), "<!doctype html><title>OMW</title>", "utf8")
  const repository = new ManagerRepository(path.join(root, "omw.sqlite"))
  const runtime = new FakeRuntime()
  const service = new ManagerService(repository, runtime, access?.portPool)
  const app = buildApp({
    service,
    authority: { hostname: "127.0.0.1", port: 4174 },
    allowedOrigins: new Set([mutationHeaders.origin]),
    ...(access?.publicOrigin && access.credentials ? {
      publicOrigin: access.publicOrigin,
      allowedOrigins: new Set([mutationHeaders.origin, access.publicOrigin]),
      authenticator: new SeparateRequestAuthenticator(access.credentials),
    } : {}),
    ...(access?.launcherCredentials ? {
      launcherAuthenticator: new SeparateRequestAuthenticator(access.launcherCredentials),
    } : {}),
    webRoot: root,
  })
  t.after(async () => {
    await app.close()
    repository.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, project, childDirectory, repository, runtime, service, app }
}

test("remote entry requires OMW Basic auth and never trusts forwarded authority", async (t) => {
  const credentials: StoredCredentials = {
    manager: { username: "omw-user", password: "manager-test-password" },
    openCode: { username: "opencode-user", password: "opencode-test-password" },
    launcherToken: "launcher-test-token-that-is-not-browser-auth",
  }
  const publicOrigin = "https://device.example.ts.net:8443"
  const { app } = await fixture(t, { publicOrigin, credentials })
  const authority = new URL(publicOrigin).host
  const validAuthorization = `Basic ${Buffer.from("omw-user:manager-test-password").toString("base64")}`

  const unauthorized = await app.inject({ method: "GET", url: "/api/v1/overview", headers: { host: authority } })
  assert.equal(unauthorized.statusCode, 401)
  assert.equal(unauthorized.headers["www-authenticate"], 'Basic realm="OMW", charset="UTF-8"')

  const launcherIsSeparate = await app.inject({
    method: "GET",
    url: "/api/v1/overview",
    headers: { host: authority, "x-omw-launcher-token": credentials.launcherToken },
  })
  assert.equal(launcherIsSeparate.statusCode, 401)

  const authorized = await app.inject({
    method: "GET",
    url: "/api/v1/overview",
    headers: { host: authority, authorization: validAuthorization },
  })
  assert.equal(authorized.statusCode, 200)

  const forwardedSpoof = await app.inject({
    method: "GET",
    url: "/api/v1/overview",
    headers: { host: "attacker.example", "x-forwarded-host": authority, "x-forwarded-proto": "https", authorization: validAuthorization },
  })
  assert.equal(forwardedSpoof.statusCode, 403)
  assert.equal(forwardedSpoof.json().error.code, "UNTRUSTED_AUTHORITY")
})

test("launcher API is local-token-only, idempotent, asynchronous, and observe-only", async (t) => {
  const credentials: StoredCredentials = {
    manager: { username: "omw-user", password: "manager-test-password" },
    openCode: { username: "opencode-user", password: "opencode-test-password" },
    launcherToken: "launcher-test-token-that-is-not-browser-auth",
  }
  const { app, project, runtime, service } = await fixture(t, {
    launcherCredentials: credentials,
    portPool: { min: 42_000, max: 42_001 },
  })
  const launcherHeaders = { ...readHeaders, "x-omw-launcher-token": credentials.launcherToken }
  const invocationId = "11111111-1111-4111-8111-111111111111"
  const payload = { clientInvocationId: invocationId, directory: project, requestedPort: 42_000 }

  const browserBasic = `Basic ${Buffer.from("omw-user:manager-test-password").toString("base64")}`
  const browserDenied = await app.inject({
    method: "POST",
    url: "/api/v1/launcher/reservations",
    headers: { ...readHeaders, authorization: browserBasic },
    payload,
  })
  assert.equal(browserDenied.statusCode, 401)
  const browserOriginDenied = await app.inject({
    method: "POST",
    url: "/api/v1/launcher/reservations",
    headers: { ...launcherHeaders, origin: mutationHeaders.origin },
    payload,
  })
  assert.equal(browserOriginDenied.statusCode, 403)

  const arbitraryExecutableDenied = await app.inject({
    method: "POST",
    url: "/api/v1/launcher/reservations",
    headers: launcherHeaders,
    payload: { ...payload, executable: "C:\\attacker.exe" },
  })
  assert.equal(arbitraryExecutableDenied.statusCode, 400)

  const [first, repeated] = await Promise.all([
    app.inject({ method: "POST", url: "/api/v1/launcher/reservations", headers: launcherHeaders, payload }),
    app.inject({ method: "POST", url: "/api/v1/launcher/reservations", headers: launcherHeaders, payload }),
  ])
  assert.equal(first.statusCode, 201)
  assert.equal(repeated.statusCode, 201)
  assert.equal(first.json().reservationId, repeated.json().reservationId)
  assert.equal(first.json().port, 42_000)

  const invocationConflict = await app.inject({
    method: "POST",
    url: "/api/v1/launcher/reservations",
    headers: launcherHeaders,
    payload: { ...payload, requestedPort: 42_001 },
  })
  assert.equal(invocationConflict.statusCode, 409)
  assert.equal(invocationConflict.json().error.code, "INVOCATION_CONFLICT")

  const collision = await app.inject({
    method: "POST",
    url: "/api/v1/launcher/reservations",
    headers: launcherHeaders,
    payload: { clientInvocationId: "22222222-2222-4222-8222-222222222222", directory: project, requestedPort: 42_000 },
  })
  assert.equal(collision.statusCode, 409)
  assert.equal(collision.json().error.code, "PORT_UNAVAILABLE")

  const staleInvocationId = "33333333-3333-4333-8333-333333333333"
  const staleReservation = await app.inject({
    method: "POST",
    url: "/api/v1/launcher/reservations",
    headers: launcherHeaders,
    payload: { clientInvocationId: staleInvocationId, directory: project, requestedPort: 42_001 },
  })
  assert.equal(staleReservation.statusCode, 201)
  runtime.adoptedCreationTimeUtc = "2000-01-01T00:00:00.000Z"
  const staleRegistration = await app.inject({
    method: "POST",
    url: `/api/v1/launcher/reservations/${staleReservation.json().reservationId}/register`,
    headers: launcherHeaders,
    payload: { clientInvocationId: staleInvocationId, pid: 4311 },
  })
  assert.equal(staleRegistration.statusCode, 409)
  assert.equal(staleRegistration.json().error.code, "LOCAL_PROCESS_NOT_FRESH")
  runtime.adoptedCreationTimeUtc = null

  runtime.blockReadiness()
  const reservationId = first.json().reservationId as string
  const registration = app.inject({
    method: "POST",
    url: `/api/v1/launcher/reservations/${reservationId}/register`,
    headers: launcherHeaders,
    payload: { clientInvocationId: invocationId, pid: 4312 },
  })
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("register waited for readiness")), 250))
  const registered = await Promise.race([registration, timeout])
  assert.equal(registered.statusCode, 202)
  assert.equal(registered.json().state, "starting")
  await assert.rejects(service.stop(reservationId), (error: unknown) => (
    typeof error === "object" && error !== null && "code" in error && error.code === "LOCAL_TUI_OBSERVE_ONLY"
  ))

  const finalized = await app.inject({
    method: "POST",
    url: `/api/v1/launcher/reservations/${reservationId}/finalize`,
    headers: launcherHeaders,
    payload: { clientInvocationId: invocationId, pid: 4312 },
  })
  assert.equal(finalized.statusCode, 200)
  assert.equal(finalized.json().state, "stopped")
  runtime.releaseReadiness?.()
})

test("an occupied OS port cannot be reserved from the fixed pool", async (t) => {
  const listener = net.createServer()
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject)
    listener.listen(0, "127.0.0.1", resolve)
  })
  try {
    const address = listener.address()
    assert.ok(address && typeof address !== "string")
    const credentials: StoredCredentials = {
      manager: { username: "unused", password: "unused-password" },
      openCode: { username: "unused", password: "unused-password" },
      launcherToken: "launcher-test-token-that-is-not-browser-auth",
    }
    const { app, project } = await fixture(t, {
      launcherCredentials: credentials,
      portPool: { min: address.port, max: address.port },
    })
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/launcher/reservations",
      headers: { ...readHeaders, "x-omw-launcher-token": credentials.launcherToken },
      payload: { clientInvocationId: "33333333-3333-4333-8333-333333333333", directory: project, requestedPort: address.port },
    })
    assert.equal(response.statusCode, 409)
    assert.equal(response.json().error.code, "PORT_UNAVAILABLE")
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))
  }
})

test("SQLite transactions keep one active owner per port across repository connections", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-port-registry-"))
  const filename = path.join(root, "omw.sqlite")
  const first = new ManagerRepository(filename)
  const second = new ManagerRepository(filename)
  t.after(async () => {
    first.close()
    second.close()
    await rm(root, { recursive: true, force: true })
  })
  const base = {
    kind: "local-tui" as const,
    clientInvocationId: null,
    projectDirectory: root,
    port: 42_010,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10_000).toISOString(),
    instanceId: null,
  }
  assert.equal(first.tryCreateAllocation({ ...base, id: "allocation-a" }), true)
  assert.equal(second.tryCreateAllocation({ ...base, id: "allocation-b" }), false)
})

test("mutation rejects requests without the loopback Origin and CSRF header", async (t) => {
  const { app, project } = await fixture(t)
  const response = await app.inject({ method: "POST", url: "/api/v1/instances", headers: readHeaders, payload: { directory: project } })
  assert.equal(response.statusCode, 403)
  assert.equal(response.json().error.code, "MUTATION_ORIGIN_REJECTED")
})

test("every HTTP entry rejects an untrusted authority or supplied Origin", async (t) => {
  const { app } = await fixture(t)
  const attackerAuthority = await app.inject({
    method: "GET",
    url: "/api/v1/overview",
    headers: { host: "attacker.example", origin: "http://attacker.example" },
  })
  assert.equal(attackerAuthority.statusCode, 403)
  assert.equal(attackerAuthority.json().error.code, "UNTRUSTED_AUTHORITY")

  const attackerOrigin = await app.inject({
    method: "GET",
    url: "/api/v1/overview",
    headers: { ...readHeaders, origin: "http://attacker.example" },
  })
  assert.equal(attackerOrigin.statusCode, 403)
  assert.equal(attackerOrigin.json().error.code, "UNTRUSTED_ORIGIN")

  const trustedNavigation = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.equal(trustedNavigation.statusCode, 200)

  const attackerStatic = await app.inject({ method: "GET", url: "/", headers: { host: "attacker.example" } })
  assert.equal(attackerStatic.statusCode, 403)
  const trustedStatic = await app.inject({ method: "GET", url: "/", headers: readHeaders })
  assert.equal(trustedStatic.statusCode, 200)
  assert.match(trustedStatic.body, /<title>OMW<\/title>/)
})

test("shortcut CRUD persists and directory browsing is not limited to shortcuts", async (t) => {
  const { app, project, childDirectory, repository, runtime } = await fixture(t)
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/shortcuts",
    headers: mutationHeaders,
    payload: { name: "工作區", directory: childDirectory },
  })
  assert.equal(created.statusCode, 201)
  const shortcut = created.json()

  const browse = await app.inject({ method: "GET", url: `/api/v1/directories?path=${encodeURIComponent(project)}`, headers: readHeaders })
  assert.equal(browse.statusCode, 200)
  assert.deepEqual(browse.json().children.map((entry: { name: string }) => entry.name), ["child"])
  assert.equal(typeof browse.json().parent, "string")

  const updated = await app.inject({
    method: "PATCH",
    url: `/api/v1/shortcuts/${shortcut.id}`,
    headers: mutationHeaders,
    payload: { name: "主要工作區", directory: project },
  })
  assert.equal(updated.json().name, "主要工作區")

  const secondRepository = new ManagerRepository(repository.filename)
  assert.equal(secondRepository.listShortcuts()[0]?.name, "主要工作區")
  secondRepository.close()

  const started = await app.inject({
    method: "POST",
    url: "/api/v1/instances",
    headers: mutationHeaders,
    payload: { directory: project },
  })
  assert.equal(started.statusCode, 201)

  const deleted = await app.inject({ method: "DELETE", url: `/api/v1/shortcuts/${shortcut.id}`, headers: mutationHeaders })
  assert.equal(deleted.statusCode, 204)
  assert.equal(runtime.launchCount, 1)
  assert.equal(repository.listInstances().length, 1)
})

test("each Start creates a new Instance and overview exposes independent summary signals", async (t) => {
  const { app, project, runtime } = await fixture(t)
  const first = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  const second = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  assert.equal(first.statusCode, 201)
  assert.equal(second.statusCode, 201)
  assert.notEqual(first.json().id, second.json().id)
  assert.equal(runtime.launchCount, 2)

  const overview = await app.inject({ method: "GET", url: "/api/v1/overview?filter=attention&q=%E4%B8%BB%E5%B7%A5%E4%BD%9C", headers: readHeaders })
  assert.equal(overview.statusCode, 200)
  assert.equal(overview.json().instances.length, 2)
  assert.deepEqual(overview.json().instances[0].summary, {
    activity: "busy",
    busySessions: 1,
    pendingQuestions: 1,
    pendingPermissions: 1,
    error: null,
  })
})

test("API preserves partial status failures, distinct request counts, and Project-scoped metadata", async (t) => {
  const { app, project, childDirectory, runtime } = await fixture(t)
  runtime.sessionMetadata.set(project, [{ id: "session-a", title: "Alpha Session" }])
  runtime.sessionMetadata.set(childDirectory, [{ id: "session-b", title: "Beta Session" }])
  runtime.summaries.set(project, {
    activity: "busy",
    busySessions: 1,
    pendingQuestions: null,
    pendingPermissions: 2,
    error: "question: HTTP 503",
    sessions: [{ id: "session-a", title: "Alpha Session" }],
  })
  runtime.summaries.set(childDirectory, {
    activity: "none-reported",
    busySessions: 0,
    pendingQuestions: 3,
    pendingPermissions: null,
    error: "permission: HTTP 503",
    sessions: [{ id: "session-b", title: "Beta Session" }],
  })

  const first = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  const second = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: childDirectory } })
  assert.equal(first.statusCode, 201)
  assert.equal(second.statusCode, 201)

  const overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  const byDirectory = new Map(overview.json().instances.map((item: { projectDirectory: string }) => [item.projectDirectory, item]))
  assert.deepEqual((byDirectory.get(project) as { summary: unknown }).summary, {
    activity: "busy",
    busySessions: 1,
    pendingQuestions: null,
    pendingPermissions: 2,
    error: "INSTANCE_SUMMARY_PARTIAL",
  })
  assert.deepEqual((byDirectory.get(childDirectory) as { summary: unknown }).summary, {
    activity: "none-reported",
    busySessions: 0,
    pendingQuestions: 3,
    pendingPermissions: null,
    error: "INSTANCE_SUMMARY_PARTIAL",
  })

  const search = await app.inject({ method: "GET", url: "/api/v1/overview?q=Alpha%20Session", headers: readHeaders })
  assert.deepEqual(search.json().instances.map((item: { projectDirectory: string }) => item.projectDirectory), [project])
  const secondRoots = await app.inject({ method: "GET", url: `/api/v1/instances/${second.json().id}/sessions`, headers: readHeaders })
  assert.deepEqual(secondRoots.json().roots.map((item: { id: string }) => item.id), ["session-b"])
})

test("foreign or stale identity never queries its endpoint and a fresh service can recover the verified identity", async (t) => {
  const { app, project, repository, runtime } = await fixture(t)
  const started = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  assert.equal(started.statusCode, 201)
  const id = started.json().id as string
  runtime.summaryCalls = 0
  runtime.sessionCalls = 0
  runtime.childrenCalls = 0
  runtime.openUrlCalls = 0
  runtime.identityMatches = false
  runtime.portOwnerMatched = false
  runtime.portOwnedByOther = true

  const overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.equal(overview.statusCode, 200)
  assert.equal(overview.json().instances[0].state, "unreachable")
  assert.equal(overview.json().instances[0].summary.activity, "unknown")
  assert.deepEqual(overview.json().instances[0].sessions, [])
  assert.equal(runtime.summaryCalls, 0)

  const roots = await app.inject({ method: "GET", url: `/api/v1/instances/${id}/sessions`, headers: readHeaders })
  const children = await app.inject({ method: "GET", url: `/api/v1/instances/${id}/sessions/root/children`, headers: readHeaders })
  const open = await app.inject({ method: "POST", url: `/api/v1/instances/${id}/open-url`, headers: mutationHeaders, payload: { sessionId: "root" } })
  for (const response of [roots, children, open]) {
    assert.equal(response.statusCode, 409)
    assert.equal(response.json().error.code, "INSTANCE_IDENTITY_UNVERIFIED")
  }
  assert.equal(runtime.sessionCalls, 0)
  assert.equal(runtime.childrenCalls, 0)
  assert.equal(runtime.openUrlCalls, 0)

  const reopened = new ManagerRepository(repository.filename)
  try {
    const restarted = new ManagerService(reopened, runtime)
    await restarted.reconcile()
    assert.equal(reopened.getInstance(id)?.state, "unreachable")
    runtime.identityMatches = true
    runtime.portOwnerMatched = true
    runtime.portOwnedByOther = false
    await restarted.reconcile()
    const recovered = await restarted.overview()
    assert.equal(recovered.instances[0]?.state, "ready")
    assert.equal(recovered.instances[0]?.summary.activity, "busy")
  } finally {
    reopened.close()
  }
})

test("runtime failures never persist or return credential-shaped plaintext", async (t) => {
  const { app, project, root, repository, runtime } = await fixture(t)
  const password = "fixture-password-do-not-store"
  const authorization = "Basic Zml4dHVyZS11c2VyOmZpeHR1cmUtcGFzc3dvcmQ="
  runtime.readinessError = new Error(`OPENCODE_SERVER_PASSWORD=${password} Authorization: ${authorization}`)

  const response = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  assert.equal(response.statusCode, 500)
  assert.doesNotMatch(response.body, new RegExp(`${password}|${authorization}`))
  const record = repository.listInstances()[0]
  assert.ok(record)
  assert.doesNotMatch(`${record.error ?? ""}${record.stderrSummary ?? ""}`, new RegExp(`${password}|${authorization}`))
  const overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.equal("stderrSummary" in overview.json().instances[0], false)
  assert.doesNotMatch(overview.body, new RegExp(`${password}|${authorization}`))

  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const content = await readFile(path.join(entry.parentPath, entry.name))
    assert.equal(content.includes(password) || content.includes(authorization), false, `secret leaked to ${entry.name}`)
  }
})

test("opening an existing database preserves legacy diagnostics while HTTP projects a safe code", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-legacy-db-"))
  const filename = path.join(root, "omw.sqlite")
  const legacyStderr = "legacy stderr contains fixture-existing-secret"
  const legacyErrors = new Map([
    ["legacy-uppercase", "SECRET_TOKEN_12345678"],
    ["legacy-key-name", "API_KEY"],
    ["legacy-mixed", "INSTANCE_START_FAILED；SECRET_TOKEN_12345678"],
    ["legacy-freeform", "legacy error contains fixture-existing-secret"],
  ])
  const knownErrors = new Map([
    ["known-identity", "INSTANCE_IDENTITY_CHECK_FAILED"],
    ["known-cleanup", "INSTANCE_START_FAILED；STARTUP_CLEANUP_UNRESOLVED"],
  ])
  const seeded = new ManagerRepository(filename)
  let port = 42_000
  for (const id of [...legacyErrors.keys(), ...knownErrors.keys()]) {
    seeded.createInstance({
      id,
      kind: "headless",
      clientInvocationId: null,
      projectName: "legacy-project",
      projectDirectory: root,
      state: "failed",
      endpoint: `http://127.0.0.1:${port}`,
      port: port++,
      pid: null,
      creationTimeUtc: null,
      creationTimeTicks: null,
      executable: null,
      launchedAt: "2026-09-17T00:00:00.000Z",
      healthVersion: null,
      stoppedAt: null,
      error: null,
      stderrSummary: null,
    })
  }
  seeded.close()

  const raw = new DatabaseSync(filename)
  const seedDiagnostic = raw.prepare("UPDATE managed_instances SET error = ?, stderr_summary = ? WHERE id = ?")
  for (const [id, error] of [...legacyErrors, ...knownErrors]) seedDiagnostic.run(error, legacyStderr, id)
  raw.exec("PRAGMA user_version = 0")
  raw.close()

  const repository = new ManagerRepository(filename)
  const app = buildApp({
    service: new ManagerService(repository, new FakeRuntime()),
    authority: { hostname: "127.0.0.1", port: 4174 },
    allowedOrigins: new Set([mutationHeaders.origin]),
  })
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
    assert.equal(response.statusCode, 200)
    const byId = new Map(response.json().instances.map((instance: { id: string; error: string }) => [instance.id, instance.error]))
    for (const id of legacyErrors.keys()) assert.equal(byId.get(id), "INSTANCE_DIAGNOSTIC_REDACTED")
    for (const [id, error] of knownErrors) assert.equal(byId.get(id), error)
    assert.doesNotMatch(response.body, /fixture-existing-secret|SECRET_TOKEN_12345678|API_KEY/)
  } finally {
    await app.close()
    repository.close()
  }

  const verified = new DatabaseSync(filename)
  try {
    const rows = verified.prepare("SELECT id, error, stderr_summary FROM managed_instances ORDER BY id").all() as Array<{
      id: string
      error: string
      stderr_summary: string
    }>
    const stored = new Map(rows.map((row) => [row.id, row]))
    for (const [id, error] of [...legacyErrors, ...knownErrors]) {
      assert.equal(stored.get(id)?.error, error)
      assert.equal(stored.get(id)?.stderr_summary, legacyStderr)
    }
  } finally {
    verified.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("Session API keeps unknown-parent children separate and loads direct children on demand", async (t) => {
  const { app, project } = await fixture(t)
  const started = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  const id = started.json().id
  const roots = await app.inject({ method: "GET", url: `/api/v1/instances/${id}/sessions`, headers: readHeaders })
  assert.deepEqual(roots.json().roots.map((session: { id: string }) => session.id), ["root"])
  assert.deepEqual(roots.json().unknownParent.map((session: { id: string }) => session.id), ["orphan"])

  const children = await app.inject({ method: "GET", url: `/api/v1/instances/${id}/sessions/root/children`, headers: readHeaders })
  assert.equal(children.json().loadedDirectChildren, 1)
  assert.equal(children.json().children[0].parentID, "root")

  const open = await app.inject({
    method: "POST",
    url: `/api/v1/instances/${id}/open-url`,
    headers: mutationHeaders,
    payload: { sessionId: "child" },
  })
  assert.equal(new URL(open.json().url).searchParams.get("session"), "child")
})

test("Stop refuses an identity mismatch without terminating the process", async (t) => {
  const { app, project, runtime } = await fixture(t)
  const started = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  runtime.identityMatches = false
  const stopped = await app.inject({ method: "POST", url: `/api/v1/instances/${started.json().id}/stop`, headers: mutationHeaders })
  assert.equal(stopped.statusCode, 409)
  assert.equal(stopped.json().error.code, "PROCESS_IDENTITY_MISMATCH")
})

test("an identity-matched owned process remains stoppable after its listener disappears", async (t) => {
  const { app, project, runtime } = await fixture(t)
  const started = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  runtime.portOwnerMatched = false

  const overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.equal(overview.json().instances[0].stopAllowed, true)
  assert.equal(runtime.portOwnedByOther, false)
  assert.equal(started.statusCode, 201)
})

test("one failed identity probe stays unreachable without blocking reconciliation or overview", async (t) => {
  const { app, project, runtime, service } = await fixture(t)
  await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  runtime.inspectFails = true

  await assert.doesNotReject(service.reconcile())
  const overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.equal(overview.statusCode, 200)
  const instance = overview.json().instances[0]
  assert.equal(instance.state, "unreachable")
  assert.equal(instance.stopAllowed, false)
  assert.equal(instance.error, "INSTANCE_IDENTITY_CHECK_FAILED")
})

test("readiness failure performs bounded owned-launch cleanup and persists cleanup failure evidence", async (t) => {
  const { app, project, repository, runtime } = await fixture(t)
  runtime.reachable = false
  runtime.cleanupSucceeds = false

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/instances",
    headers: mutationHeaders,
    payload: { directory: project },
  })

  assert.equal(response.statusCode, 500)
  assert.equal(runtime.cleanupCount, 1)
  const [record] = repository.listInstances()
  assert.equal(record?.state, "failed")
  assert.equal(record?.error, "INSTANCE_START_FAILED；STARTUP_CLEANUP_UNRESOLVED")
})

test("reconcile releases an old free allocation without ever trusting incomplete process identity", async (t) => {
  const { project, repository, service } = await fixture(t)
  const launchedAt = new Date(Date.now() - 30_000).toISOString()
  const allocation = {
    id: "incomplete-identity-instance",
    kind: "headless" as const,
    clientInvocationId: null,
    projectDirectory: project,
    port: 42_050,
    createdAt: launchedAt,
    expiresAt: new Date(Date.now() + 10_000).toISOString(),
    instanceId: null,
  }
  assert.equal(repository.tryCreateAllocation(allocation), true)
  repository.createReservedInstance(allocation.id, {
    id: allocation.id,
    kind: "headless",
    clientInvocationId: null,
    projectName: path.basename(project),
    projectDirectory: project,
    state: "starting",
    endpoint: `http://127.0.0.1:${allocation.port}`,
    port: allocation.port,
    pid: null,
    creationTimeUtc: null,
    creationTimeTicks: null,
    executable: null,
    launchedAt,
    healthVersion: null,
    stoppedAt: null,
    error: null,
    stderrSummary: null,
  })

  await service.reconcile()

  assert.equal(repository.getInstance(allocation.id)?.state, "stopped")
  assert.equal(repository.getAllocation(allocation.id), null)
})

test("a fresh repository and service re-check persisted identity and health before restoring ready", async (t) => {
  const { project, repository, runtime } = await fixture(t)
  const firstService = new ManagerService(repository, runtime)
  const started = await firstService.start(project)
  const database = repository.filename
  repository.close()

  const reopened = new ManagerRepository(database)
  const restartedService = new ManagerService(reopened, runtime)
  try {
    await restartedService.reconcile()
    const overview = await restartedService.overview()
    assert.equal(overview.instances[0]?.id, started.id)
    assert.equal(overview.instances[0]?.state, "ready")
    assert.equal(overview.instances[0]?.stopAllowed, true)
  } finally {
    reopened.close()
  }
})
