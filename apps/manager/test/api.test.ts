import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import { buildApp } from "../src/app.js"
import { SeparateRequestAuthenticator, type StoredCredentials } from "../src/auth.js"
import { CredentialController } from "../src/credential-controller.js"
import type { CredentialStore } from "../src/credential-store.js"
import { ManagerError } from "../src/errors.js"
import { ManagerRepository, type InstanceRecord } from "../src/repository.js"
import { ManagerService } from "../src/service.js"
import type {
  LaunchResult,
  RuntimeActivityEvent,
  RuntimeActivityObserver,
  RuntimePort,
  RuntimeSummary,
} from "../src/runtime.js"

const mutationHeaders = {
  host: "127.0.0.1:4174",
  origin: "http://127.0.0.1:5173",
  "x-omw-csrf": "1",
}
const readHeaders = { host: "127.0.0.1:4174" }

class FakeRuntime implements RuntimePort {
  launchCount = 0
  launchError: Error | null = null
  identityMatches = true
  portOwnerMatched = true
  portOwnedByOther = false
  inspectFails = false
  inspectError: Error | null = null
  processState: "running" | "not-found" | "unknown" = "running"
  inspectDelayMs = 0
  inspectCalls = 0
  activeInspects = 0
  maxActiveInspects = 0
  deferredInspectCall: number | null = null
  deferredInspectStarted = false
  inspectGate: Promise<void> | null = null
  releaseInspect: (() => void) | null = null
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
  deferredSummaryCall: number | null = null
  summaryGate: Promise<void> | null = null
  releaseSummary: (() => void) | null = null
  summaryStarted = false
  sessionCalls = 0
  childrenCalls = 0
  openUrlCalls = 0
  activityCalls = 0
  createSessionCalls = 0
  observerCloseCount = 0
  stopCount = 0
  createSessionError: Error | null = null
  failCreatedSessionUrl = false
  remoteUrlError: string | null = null
  activityBusySessions = new Map<string, string[]>()
  activityError: Error | null = null
  activityGate: Promise<void> | null = null
  releaseActivity: (() => void) | null = null
  observers = new Map<string, (event: RuntimeActivityEvent) => Promise<void> | void>()
  observerEnds = new Map<string, () => void>()
  inspectResults = new Map<string, Partial<{
    processState: "running" | "not-found" | "unknown"
    matched: boolean
    portOwnerMatched: boolean
    portOwnedByOther: boolean
  }>>()

  async launch(directory: string, port: number, instanceId: string): Promise<LaunchResult> {
    this.launchCount++
    if (this.launchError) throw this.launchError
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

  async inspect(instance: InstanceRecord | LaunchResult) {
    this.inspectCalls++
    const call = this.inspectCalls
    this.activeInspects++
    this.maxActiveInspects = Math.max(this.maxActiveInspects, this.activeInspects)
    try {
      if (call === this.deferredInspectCall && this.inspectGate) {
        this.deferredInspectStarted = true
        await this.inspectGate
      }
      if (this.inspectDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.inspectDelayMs))
      if (this.inspectError) throw this.inspectError
      if (this.inspectFails) throw new Error("identity probe unavailable")
      const configured = this.inspectResults.get("instanceId" in instance ? instance.instanceId : instance.id)
      const processState = configured?.processState ?? this.processState
      return {
        processState,
        matched: configured?.matched ?? this.identityMatches,
        portOwnerMatched: configured?.portOwnerMatched ?? this.portOwnerMatched,
        portOwnedByOther: configured?.portOwnedByOther ?? this.portOwnedByOther,
        running: processState === "running",
      }
    } finally {
      this.activeInspects--
    }
  }

  async stop() {
    this.stopCount++
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
    this.summaryStarted = true
    const configured = this.summaries.get(instance.projectDirectory)
    const snapshot = configured ?? {
      activity: "busy" as const,
      busySessions: 1,
      pendingQuestions: 1,
      pendingPermissions: 1,
      error: null,
      sessions: [{ id: "root", title: "主工作" }],
    }
    if (this.summaryCalls === this.deferredSummaryCall && this.summaryGate) await this.summaryGate
    return { ...snapshot, sessions: snapshot.sessions.map((session) => ({ ...session })) }
  }

  blockSummary(): void {
    this.deferredSummaryCall = this.summaryCalls + 1
    this.summaryGate = new Promise((resolve) => { this.releaseSummary = resolve })
  }

  deferInspect(call: number): void {
    this.deferredInspectCall = call
    this.inspectGate = new Promise((resolve) => { this.releaseInspect = resolve })
  }

  async activity(instance: InstanceRecord) {
    this.activityCalls++
    if (this.activityGate) await this.activityGate
    if (this.activityError) throw this.activityError
    return { busySessionIds: this.activityBusySessions.get(instance.id) ?? [] }
  }

  observeActivity(instance: InstanceRecord, onEvent: (event: RuntimeActivityEvent) => Promise<void> | void): RuntimeActivityObserver {
    this.observers.set(instance.id, onEvent)
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    this.observerEnds.set(instance.id, resolveDone)
    return {
      done,
      close: () => {
        if (this.observerEnds.get(instance.id) === resolveDone) {
          this.observerEnds.delete(instance.id)
          if (this.observers.delete(instance.id)) this.observerCloseCount++
        }
        resolveDone()
      },
    }
  }

  async emitActivity(instanceId: string, event: RuntimeActivityEvent): Promise<void> {
    await this.observers.get(instanceId)?.(event)
  }

  endActivityObserver(instanceId: string): void {
    this.observers.delete(instanceId)
    const resolveDone = this.observerEnds.get(instanceId)
    this.observerEnds.delete(instanceId)
    resolveDone?.()
  }

  blockActivity(): void {
    this.activityGate = new Promise((resolve) => { this.releaseActivity = resolve })
  }

  async createSession(instance: InstanceRecord) {
    this.createSessionCalls++
    if (this.createSessionError) throw this.createSessionError
    const session = { id: `created-${this.createSessionCalls}`, title: `New session ${this.createSessionCalls}` }
    const sessions = this.sessionMetadata.get(instance.projectDirectory) ?? []
    this.sessionMetadata.set(instance.projectDirectory, [...sessions, session])
    return session
  }

  openUrl(instance: { endpoint: string; projectDirectory: string }, sessionId?: string) {
    this.openUrlCalls++
    if (this.failCreatedSessionUrl && sessionId?.startsWith("created-")) throw new Error("fixture URL failure after create")
    const url = new URL("/", instance.endpoint)
    url.searchParams.set("directory", instance.projectDirectory)
    if (sessionId) url.searchParams.set("session", sessionId)
    return url.toString()
  }

  remoteUrlUnavailableReason() {
    return this.remoteUrlError
  }
}

async function listenOnLoopback(port: number): Promise<net.Server> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once("error", onError)
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError)
      resolve()
    })
  })
  return server
}

async function closeOwnedServer(server: net.Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

async function findFreeAdjacentPortPair(): Promise<[number, number]> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const probe = await listenOnLoopback(0)
    const address = probe.address()
    assert.ok(address && typeof address !== "string")
    const firstPort = address.port
    await closeOwnedServer(probe)
    if (firstPort >= 65_535) continue

    let first: net.Server | null = null
    let second: net.Server | null = null
    try {
      first = await listenOnLoopback(firstPort)
      second = await listenOnLoopback(firstPort + 1)
      return [firstPort, firstPort + 1]
    } catch {
      // Retry when another process wins either port between the probe and pair bind.
    } finally {
      if (second) await closeOwnedServer(second)
      if (first) await closeOwnedServer(first)
    }
  }
  throw new Error("unable to find an adjacent free loopback port pair")
}

async function dynamicPortPool(): Promise<{ min: number; max: number }> {
  const server = await listenOnLoopback(0)
  try {
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("dynamic loopback listener did not expose a port")
    const min = Math.min(address.port, 65_407)
    return { min, max: min + 128 }
  } finally {
    await closeOwnedServer(server)
  }
}

async function fixture(t: test.TestContext, access?: {
  publicOrigin?: string
  credentials?: StoredCredentials
  authenticator?: SeparateRequestAuthenticator
  launcherCredentials?: StoredCredentials
  portPool?: { min: number; max: number }
  credentialController?: CredentialController
  shutdownManager?: () => void
  verifyRemoteUrl?: (port: number) => Promise<void>
}) {
  const root = await mkdtemp(path.join(tmpdir(), "omw-api-"))
  const project = path.join(root, "project")
  const childDirectory = path.join(project, "child")
  await mkdir(childDirectory, { recursive: true })
  await writeFile(path.join(root, "index.html"), "<!doctype html><title>OMW</title>", "utf8")
  const repository = new ManagerRepository(path.join(root, "omw.sqlite"))
  const runtime = new FakeRuntime()
  const service = new ManagerService(repository, runtime, access?.portPool ?? await dynamicPortPool(), access?.verifyRemoteUrl)
  const app = buildApp({
    service,
    authority: { hostname: "127.0.0.1", port: 4174 },
    allowedOrigins: new Set([mutationHeaders.origin]),
    ...(access?.publicOrigin && access.credentials ? {
      publicOrigin: access.publicOrigin,
      allowedOrigins: new Set([mutationHeaders.origin, access.publicOrigin]),
      authenticator: access.authenticator ?? new SeparateRequestAuthenticator(access.credentials),
    } : {}),
    ...(access?.launcherCredentials ? {
      launcherAuthenticator: new SeparateRequestAuthenticator(access.launcherCredentials),
    } : {}),
    ...(access?.credentialController ? { credentialController: access.credentialController } : {}),
    ...(access?.shutdownManager ? { shutdownManager: access.shutdownManager } : {}),
    webRoot: root,
  })
  t.after(async () => {
    await app.close()
    repository.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, project, childDirectory, repository, runtime, service, app }
}

async function startLocalTui(
  service: ManagerService,
  runtime: FakeRuntime,
  project: string,
  clientInvocationId: string,
  pid: number,
): Promise<string> {
  const reservation = await service.reserveLocal({ clientInvocationId, directory: project })
  await service.registerLocal(reservation.reservationId, { clientInvocationId, pid })
  await waitFor(() => runtime.observers.has(reservation.reservationId), 500)
  return reservation.reservationId
}

test("remote entry requires OMW Basic auth and never trusts forwarded authority", async (t) => {
  const credentials: StoredCredentials = {
    manager: { username: "omw-user", password: "manager-test-password" },
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

test("credential update verifies the current password, preserves launcher token, and switches auth immediately", async (t) => {
  const initial: StoredCredentials = {
    manager: { username: "omw-user", password: "manager-test-password" },
    launcherToken: "launcher-test-token-that-is-not-browser-auth",
  }
  let saved: StoredCredentials | null = null
  const store: CredentialStore = {
    exists: () => true,
    load: async () => initial,
    save: async (value) => { saved = value },
  }
  const authenticator = new SeparateRequestAuthenticator(initial)
  const controller = new CredentialController(store, authenticator, initial)
  const publicOrigin = "https://device.example.ts.net:8443"
  const { app } = await fixture(t, { publicOrigin, credentials: initial, authenticator, credentialController: controller })
  const authority = new URL(publicOrigin).host
  const oldAuthorization = `Basic ${Buffer.from("omw-user:manager-test-password").toString("base64")}`
  const mutation = { host: authority, origin: publicOrigin, "x-omw-csrf": "1", authorization: oldAuthorization }

  const denied = await app.inject({
    method: "PATCH",
    url: "/api/v1/settings/credentials",
    headers: mutation,
    payload: { currentPassword: "wrong-current-password", username: "next-user", password: "next-manager-password" },
  })
  assert.equal(denied.statusCode, 401)
  assert.equal(saved, null)

  const updated = await app.inject({
    method: "PATCH",
    url: "/api/v1/settings/credentials",
    headers: mutation,
    payload: { currentPassword: "manager-test-password", username: "next-user", password: "next-manager-password" },
  })
  assert.equal(updated.statusCode, 204)
  assert.deepEqual(saved, {
    manager: { username: "next-user", password: "next-manager-password" },
    launcherToken: initial.launcherToken,
  })

  const oldRejected = await app.inject({ method: "GET", url: "/api/v1/overview", headers: { host: authority, authorization: oldAuthorization } })
  assert.equal(oldRejected.statusCode, 401)
  const nextAuthorization = `Basic ${Buffer.from("next-user:next-manager-password").toString("base64")}`
  const nextAccepted = await app.inject({ method: "GET", url: "/api/v1/overview", headers: { host: authority, authorization: nextAuthorization } })
  assert.equal(nextAccepted.statusCode, 200)
})

test("failed credential persistence keeps the old password usable", async (t) => {
  const initial: StoredCredentials = {
    manager: { username: "omw-user", password: "manager-test-password" },
    launcherToken: "launcher-test-token-that-is-not-browser-auth",
  }
  const store: CredentialStore = {
    exists: () => true,
    load: async () => initial,
    save: async () => { throw new Error("fixture write failure") },
  }
  const authenticator = new SeparateRequestAuthenticator(initial)
  const controller = new CredentialController(store, authenticator, initial)
  const publicOrigin = "https://device.example.ts.net:8443"
  const { app } = await fixture(t, { publicOrigin, credentials: initial, authenticator, credentialController: controller })
  const authority = new URL(publicOrigin).host
  const authorization = `Basic ${Buffer.from("omw-user:manager-test-password").toString("base64")}`
  const failed = await app.inject({
    method: "PATCH",
    url: "/api/v1/settings/credentials",
    headers: { host: authority, origin: publicOrigin, "x-omw-csrf": "1", authorization },
    payload: { currentPassword: "manager-test-password", username: "next-user", password: "next-manager-password" },
  })
  assert.equal(failed.statusCode, 500)
  const stillAccepted = await app.inject({ method: "GET", url: "/api/v1/overview", headers: { host: authority, authorization } })
  assert.equal(stillAccepted.statusCode, 200)
})

test("manager shutdown endpoint schedules only Manager shutdown", async (t) => {
  let shutdowns = 0
  const { app, runtime } = await fixture(t, { shutdownManager: () => { shutdowns++ } })
  const response = await app.inject({ method: "POST", url: "/api/v1/manager/shutdown", headers: mutationHeaders, payload: {} })
  assert.equal(response.statusCode, 202)
  assert.deepEqual(response.json(), { stopping: true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(shutdowns, 1)
  assert.equal(runtime.stopCount, 0)
})

test("launcher identity requires the launcher token and has an exact product marker", async (t) => {
  const credentials: StoredCredentials = {
    manager: { username: "omw-user", password: "manager-test-password" },
    launcherToken: "launcher-test-token-that-is-not-browser-auth",
  }
  const { app } = await fixture(t, { launcherCredentials: credentials })
  const denied = await app.inject({ method: "GET", url: "/api/v1/launcher/identity", headers: readHeaders })
  assert.equal(denied.statusCode, 401)
  const accepted = await app.inject({
    method: "GET",
    url: "/api/v1/launcher/identity",
    headers: { ...readHeaders, "x-omw-launcher-token": credentials.launcherToken },
  })
  assert.equal(accepted.statusCode, 200)
  assert.deepEqual(accepted.json(), { product: "omw-manager", protocolVersion: 1 })
})

test("launcher API rejects an invalid launcher token", async (t) => {
  const credentials: StoredCredentials = {
    manager: { username: "omw-user", password: "manager-test-password" },
    launcherToken: "launcher-test-token-that-is-not-browser-auth",
  }
  const { app, project } = await fixture(t, { launcherCredentials: credentials })
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/launcher/reservations",
    headers: { ...readHeaders, "x-omw-launcher-token": "wrong-launcher-token" },
    payload: {
      clientInvocationId: "11111111-1111-4111-8111-111111111111",
      directory: project,
    },
  })

  assert.equal(response.statusCode, 401)
})

test("launcher API is local-token-only, idempotent, asynchronous, and observe-only", async (t) => {
  const credentials: StoredCredentials = {
    manager: { username: "omw-user", password: "manager-test-password" },
    launcherToken: "launcher-test-token-that-is-not-browser-auth",
  }
  const [requestedPort, busyPort] = await findFreeAdjacentPortPair()
  const { app, project, runtime, service } = await fixture(t, {
    launcherCredentials: credentials,
    portPool: { min: requestedPort, max: busyPort },
  })
  const launcherHeaders = { ...readHeaders, "x-omw-launcher-token": credentials.launcherToken }
  const invocationId = "11111111-1111-4111-8111-111111111111"
  const payload = { clientInvocationId: invocationId, directory: project, requestedPort }

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
  assert.equal(first.json().port, requestedPort)

  const invocationConflict = await app.inject({
    method: "POST",
    url: "/api/v1/launcher/reservations",
    headers: launcherHeaders,
    payload: { ...payload, requestedPort: busyPort },
  })
  assert.equal(invocationConflict.statusCode, 409)
  assert.equal(invocationConflict.json().error.code, "INVOCATION_CONFLICT")

  const collision = await app.inject({
    method: "POST",
    url: "/api/v1/launcher/reservations",
    headers: launcherHeaders,
    payload: { clientInvocationId: "22222222-2222-4222-8222-222222222222", directory: project, requestedPort },
  })
  assert.equal(collision.statusCode, 409)
  assert.equal(collision.json().error.code, "PORT_UNAVAILABLE")

  const staleInvocationId = "33333333-3333-4333-8333-333333333333"
  const staleReservation = await app.inject({
    method: "POST",
    url: "/api/v1/launcher/reservations",
    headers: launcherHeaders,
    payload: { clientInvocationId: staleInvocationId, directory: project, requestedPort: busyPort },
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

test("primary summary scopes all signals to the bound root hierarchy and drives attention filtering", async (t) => {
  const { app, project, runtime } = await fixture(t)
  const sessions = [
    { id: "root-a", title: "Root A" },
    { id: "child-a", title: "Child A", parentID: "root-a" },
    { id: "grandchild-a", title: "Grandchild A", parentID: "child-a" },
    { id: "root-b", title: "Root B" },
    { id: "child-b", title: "Child B", parentID: "root-b" },
  ]
  runtime.sessionMetadata.set(project, sessions)
  runtime.summaries.set(project, {
    activity: "busy",
    busySessions: 2,
    retrySessions: 1,
    pendingQuestions: 2,
    pendingPermissions: 2,
    error: null,
    sessions,
    sessionsKnown: true,
    sessionStatuses: [
      { sessionId: "grandchild-a", type: "busy" },
      { sessionId: "root-b", type: "busy" },
      { sessionId: "child-b", type: "retry" },
    ],
    questionRequests: [
      { id: "question-a", sessionId: "grandchild-a" },
      { id: "question-b", sessionId: "root-b" },
    ],
    permissionRequests: [
      { id: "permission-a", sessionId: "child-a" },
      { id: "permission-b", sessionId: "child-b" },
    ],
  })

  const started = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  const id = started.json().id as string
  assert.equal(started.json().primarySummary.scope, "unbound")

  const bindA = await app.inject({
    method: "POST",
    url: `/api/v1/instances/${id}/primary-session`,
    headers: mutationHeaders,
    payload: { sessionId: "root-a" },
  })
  assert.equal(bindA.statusCode, 200)

  let overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.deepEqual(overview.json().instances[0].primarySummary, {
    scope: "known",
    activity: "busy",
    busySessions: 1,
    retrySessions: 0,
    pendingQuestions: 1,
    pendingPermissions: 1,
    error: null,
  })
  assert.deepEqual(overview.json().instances[0].summary, {
    activity: "busy",
    busySessions: 2,
    pendingQuestions: 2,
    pendingPermissions: 2,
    error: null,
  }, "the existing summary remains explicitly Instance-wide")
  let attention = await app.inject({ method: "GET", url: "/api/v1/overview?filter=attention", headers: readHeaders })
  assert.deepEqual(attention.json().instances.map((instance: { id: string }) => instance.id), [id], "in-scope question and permission take priority over busy")
  let active = await app.inject({ method: "GET", url: "/api/v1/overview?filter=active", headers: readHeaders })
  assert.deepEqual(active.json().instances.map((instance: { id: string }) => instance.id), [id], "busy and Q/P satisfy active and attention independently")

  runtime.summaries.set(project, {
    activity: "busy",
    busySessions: 1,
    retrySessions: 1,
    pendingQuestions: 0,
    pendingPermissions: 0,
    error: null,
    sessions,
    sessionsKnown: true,
    sessionStatuses: [
      { sessionId: "grandchild-a", type: "retry" },
      { sessionId: "root-b", type: "busy" },
    ],
    questionRequests: [],
    permissionRequests: [],
  })
  overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.deepEqual(overview.json().instances[0].primarySummary, {
    scope: "known",
    activity: "reported-non-busy",
    busySessions: 0,
    retrySessions: 1,
    pendingQuestions: 0,
    pendingPermissions: 0,
    error: null,
  })
  attention = await app.inject({ method: "GET", url: "/api/v1/overview?filter=attention", headers: readHeaders })
  assert.equal(attention.json().instances.length, 0, "an exact in-scope retry is not treated as zero-busy attention")
  active = await app.inject({ method: "GET", url: "/api/v1/overview?filter=active", headers: readHeaders })
  assert.equal(active.json().instances.length, 0, "busy from another root cannot make the bound scope active")

  const bindB = await app.inject({
    method: "POST",
    url: `/api/v1/instances/${id}/primary-session`,
    headers: mutationHeaders,
    payload: { sessionId: "root-b" },
  })
  assert.equal(bindB.statusCode, 200)
  overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.equal(overview.json().instances[0].primarySummary.busySessions, 1, "switching binding switches the projected scope")
  assert.equal(overview.json().instances[0].primarySummary.retrySessions, 0)
  active = await app.inject({ method: "GET", url: "/api/v1/overview?filter=active", headers: readHeaders })
  assert.deepEqual(active.json().instances.map((instance: { id: string }) => instance.id), [id])
})

test("primary attention distinguishes unbound, known zero-busy, and incomplete hierarchy", async (t) => {
  const { app, project, runtime } = await fixture(t)
  const root = { id: "root", title: "Bound root" }
  runtime.sessionMetadata.set(project, [root])
  runtime.summaries.set(project, {
    activity: "none-reported",
    busySessions: 0,
    retrySessions: 0,
    pendingQuestions: 0,
    pendingPermissions: 0,
    error: null,
    sessions: [root],
    sessionsKnown: true,
    sessionStatuses: [],
    questionRequests: [],
    permissionRequests: [],
  })

  const started = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  const id = started.json().id as string
  let attention = await app.inject({ method: "GET", url: "/api/v1/overview?filter=attention", headers: readHeaders })
  assert.equal(attention.json().instances[0].primarySummary.scope, "unbound")

  await app.inject({
    method: "POST",
    url: `/api/v1/instances/${id}/primary-session`,
    headers: mutationHeaders,
    payload: { sessionId: "root" },
  })
  attention = await app.inject({ method: "GET", url: "/api/v1/overview?filter=attention", headers: readHeaders })
  assert.deepEqual(attention.json().instances[0].primarySummary, {
    scope: "known",
    activity: "none-reported",
    busySessions: 0,
    retrySessions: 0,
    pendingQuestions: 0,
    pendingPermissions: 0,
    error: null,
  })

  runtime.summaries.set(project, {
    activity: "none-reported",
    busySessions: 0,
    retrySessions: 0,
    pendingQuestions: 0,
    pendingPermissions: 0,
    error: null,
    sessions: [{ id: "orphan", title: "Orphan", parentID: "missing" }],
    sessionsKnown: true,
    sessionStatuses: [],
    questionRequests: [],
    permissionRequests: [],
  })
  let overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.equal(overview.json().instances[0].state, "ready", "a healthy status snapshot is not a lifecycle failure when the binding root is missing")
  assert.equal(overview.json().instances[0].primarySummary.scope, "unknown", "a missing binding root is not zero busy")
  attention = await app.inject({ method: "GET", url: "/api/v1/overview?filter=attention", headers: readHeaders })
  assert.equal(attention.json().instances.length, 0)

  runtime.summaries.set(project, {
    activity: "none-reported",
    busySessions: 0,
    retrySessions: 0,
    pendingQuestions: 0,
    pendingPermissions: 0,
    error: null,
    sessions: [root, { id: "orphan", title: "Orphan", parentID: "missing" }],
    sessionsKnown: true,
    sessionStatuses: [],
    questionRequests: [],
    permissionRequests: [],
  })
  overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.equal(overview.json().instances[0].state, "ready", "an incomplete hierarchy keeps the healthy lifecycle state")
  assert.equal(overview.json().instances[0].primarySummary.scope, "unknown", "an incomplete hierarchy cannot prove the bound root scope")
})

test("primary summary excludes attributable malformed signals from another root", async (t) => {
  const { app, project, runtime } = await fixture(t)
  const sessions = [
    { id: "root-a", title: "Root A" },
    { id: "child-a", title: "Child A", parentID: "root-a" },
    { id: "root-b", title: "Root B" },
  ]
  runtime.sessionMetadata.set(project, sessions)
  runtime.summaries.set(project, {
    activity: "unknown",
    busySessions: null,
    retrySessions: null,
    pendingQuestions: null,
    pendingPermissions: null,
    error: "status: RESPONSE_INVALID；question: RESPONSE_INVALID；permission: RESPONSE_INVALID",
    sessions,
    sessionsKnown: true,
    sessionStatuses: [{ sessionId: "child-a", type: "idle" }],
    invalidStatusSessionIds: ["root-b"],
    questionRequests: [{ id: "question-a", sessionId: "child-a" }],
    invalidQuestionSessionIds: ["root-b"],
    permissionRequests: [{ id: "permission-a", sessionId: "child-a" }],
    invalidPermissionSessionIds: ["root-b"],
  })

  const started = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  const id = started.json().id as string
  await app.inject({
    method: "POST",
    url: `/api/v1/instances/${id}/primary-session`,
    headers: mutationHeaders,
    payload: { sessionId: "root-a" },
  })

  let overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.equal(overview.json().instances[0].state, "ready", "foreign malformed status cannot make the bound scope unreachable")
  assert.deepEqual(overview.json().instances[0].primarySummary, {
    scope: "known",
    activity: "reported-non-busy",
    busySessions: 0,
    retrySessions: 0,
    pendingQuestions: 1,
    pendingPermissions: 1,
    error: null,
  })

  await app.inject({
    method: "POST",
    url: `/api/v1/instances/${id}/primary-session`,
    headers: mutationHeaders,
    payload: { sessionId: "root-b" },
  })
  overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.equal(overview.json().instances[0].state, "unreachable", "a malformed status in the bound scope remains unknown")
  assert.equal(overview.json().instances[0].primarySummary.activity, "unknown")
  assert.equal(overview.json().instances[0].primarySummary.pendingQuestions, null)
  assert.equal(overview.json().instances[0].primarySummary.pendingPermissions, null)

  runtime.summaries.set(project, {
    activity: "reported-non-busy",
    busySessions: 0,
    retrySessions: 0,
    pendingQuestions: null,
    pendingPermissions: null,
    error: "question: RESPONSE_INVALID；permission: RESPONSE_INVALID",
    sessions,
    sessionsKnown: true,
    sessionStatuses: [{ sessionId: "root-b", type: "idle" }],
    invalidStatusSessionIds: [],
    questionRequests: [{ id: "question-a", sessionId: "child-a" }],
    invalidQuestionSessionIds: ["root-b"],
    permissionRequests: [{ id: "permission-a", sessionId: "child-a" }],
    invalidPermissionSessionIds: ["root-b"],
  })
  overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.equal(overview.json().instances[0].state, "ready", "malformed Q/P do not hide a healthy status response")
  assert.equal(overview.json().instances[0].primarySummary.activity, "reported-non-busy")
  assert.equal(overview.json().instances[0].primarySummary.pendingQuestions, null)
  assert.equal(overview.json().instances[0].primarySummary.pendingPermissions, null)

  runtime.summaries.set(project, {
    activity: "reported-non-busy",
    busySessions: 0,
    retrySessions: 0,
    pendingQuestions: null,
    pendingPermissions: null,
    error: "question: RESPONSE_INVALID；permission: RESPONSE_INVALID",
    sessions,
    sessionsKnown: true,
    sessionStatuses: [{ sessionId: "child-a", type: "idle" }],
    invalidStatusSessionIds: [],
    questionRequests: [{ id: "question-a", sessionId: "child-a" }],
    invalidQuestionSessionIds: null,
    permissionRequests: [{ id: "permission-a", sessionId: "child-a" }],
    invalidPermissionSessionIds: null,
  })
  await app.inject({
    method: "POST",
    url: `/api/v1/instances/${id}/primary-session`,
    headers: mutationHeaders,
    payload: { sessionId: "root-a" },
  })
  overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.equal(overview.json().instances[0].state, "ready")
  assert.equal(overview.json().instances[0].primarySummary.activity, "reported-non-busy")
  assert.equal(overview.json().instances[0].primarySummary.pendingQuestions, null, "unattributed malformed Q/P remain unknown")
  assert.equal(overview.json().instances[0].primarySummary.pendingPermissions, null)

  runtime.summaries.set(project, {
    activity: "unknown",
    busySessions: null,
    retrySessions: null,
    pendingQuestions: null,
    pendingPermissions: null,
    error: "status: RESPONSE_INVALID；question: RESPONSE_INVALID；permission: RESPONSE_INVALID",
    sessions,
    sessionsKnown: true,
    sessionStatuses: [{ sessionId: "child-a", type: "idle" }],
    invalidStatusSessionIds: null,
    questionRequests: [{ id: "question-a", sessionId: "child-a" }],
    invalidQuestionSessionIds: null,
    permissionRequests: [{ id: "permission-a", sessionId: "child-a" }],
    invalidPermissionSessionIds: null,
  })
  overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.equal(overview.json().instances[0].state, "unreachable")
  assert.equal(overview.json().instances[0].primarySummary.activity, "unknown", "an unattributed status failure remains unknown")
  assert.equal(overview.json().instances[0].primarySummary.pendingQuestions, null)
  assert.equal(overview.json().instances[0].primarySummary.pendingPermissions, null)
})

test("overlapping overview requests share a bounded probe round while another API request remains responsive", async (t) => {
  const { app, project, runtime } = await fixture(t)
  let firstInstanceId = ""
  for (let index = 0; index < 6; index++) {
    const started = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
    assert.equal(started.statusCode, 201)
    if (index === 0) firstInstanceId = started.json().id
  }
  runtime.inspectCalls = 0
  runtime.maxActiveInspects = 0
  runtime.inspectDelayMs = 250

  const firstOverview = app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  await waitFor(() => runtime.activeInspects > 0, 500)
  const secondOverview = app.inject({ method: "GET", url: "/api/v1/overview?filter=active", headers: readHeaders })
  const browse = await Promise.race([
    app.inject({ method: "GET", url: `/api/v1/directories?path=${encodeURIComponent(project)}`, headers: readHeaders }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("another API request was blocked by overview probes")), 150)),
  ])
  const stopped = await Promise.race([
    app.inject({ method: "POST", url: `/api/v1/instances/${firstInstanceId}/stop`, headers: mutationHeaders }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Stop was queued behind overview probes")), 150)),
  ])

  assert.equal(browse.statusCode, 200)
  assert.equal(stopped.statusCode, 200)
  const overviews = await Promise.all([firstOverview, secondOverview])
  assert.equal(overviews[0].statusCode, 200)
  assert.equal(overviews[1].statusCode, 200)
  assert.equal(runtime.inspectCalls, 6)
  assert.ok(runtime.maxActiveInspects <= 4, `expected at most 4 concurrent probes, saw ${runtime.maxActiveInspects}`)
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
  const restarted = new ManagerService(reopened, runtime)
  try {
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
    await restarted.shutdown()
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

test("primary Session binding is instance-owned and captures a short busy event without following later activity", async (t) => {
  const { app, project, runtime } = await fixture(t)
  runtime.sessionMetadata.set(project, [
    { id: "s1", title: "Shared history" },
    { id: "s2", title: "Second instance work" },
    { id: "s3", title: "Later unrelated work" },
  ])
  const first = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  const second = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  const firstId = first.json().id as string
  const secondId = second.json().id as string

  const selected = await app.inject({
    method: "POST",
    url: `/api/v1/instances/${firstId}/primary-session`,
    headers: mutationHeaders,
    payload: { sessionId: "s1" },
  })
  assert.equal(selected.statusCode, 200)
  assert.equal(selected.json().sessionId, "s1")

  let overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  const initially = new Map(overview.json().instances.map((instance: { id: string; primarySession: unknown }) => [instance.id, instance.primarySession]))
  const firstBinding = initially.get(firstId) as { sessionId: string; title: string; source: string; boundAt: string }
  assert.equal(firstBinding.sessionId, "s1")
  assert.equal(firstBinding.title, "Shared history")
  assert.equal(firstBinding.source, "manual")
  assert.ok(Date.parse(firstBinding.boundAt))
  assert.equal(initially.get(secondId), null)

  runtime.activityBusySessions.set(secondId, [])
  await runtime.emitActivity(secondId, { type: "activity", source: "event", sessionIds: ["s2"] })
  overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  const bound = overview.json().instances.find((instance: { id: string }) => instance.id === secondId)
  assert.equal(bound.primarySession.sessionId, "s2")
  assert.equal(bound.primarySession.title, "Second instance work")
  assert.equal(bound.primarySession.source, "activity")
  const openedPrimary = await app.inject({
    method: "POST",
    url: `/api/v1/instances/${secondId}/open-url`,
    headers: mutationHeaders,
    payload: {},
  })
  assert.equal(openedPrimary.json().sessionId, "s2")
  assert.equal(new URL(openedPrimary.json().url).searchParams.get("session"), "s2")

  await runtime.emitActivity(secondId, { type: "activity", source: "snapshot", sessionIds: [] })
  await runtime.emitActivity(secondId, { type: "activity", source: "event", sessionIds: ["s3"] })
  overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.equal(overview.json().instances.find((instance: { id: string }) => instance.id === secondId).primarySession.sessionId, "s2")

  const stopped = await app.inject({ method: "POST", url: `/api/v1/instances/${secondId}/stop`, headers: mutationHeaders })
  assert.equal(stopped.json().primarySession.sessionId, "s2")
  const stoppedRequests = await Promise.all([
    app.inject({ method: "POST", url: `/api/v1/instances/${secondId}/open-url`, headers: mutationHeaders, payload: { sessionId: "s2" } }),
    app.inject({ method: "POST", url: `/api/v1/instances/${secondId}/sessions`, headers: mutationHeaders }),
    app.inject({ method: "POST", url: `/api/v1/instances/${secondId}/primary-session`, headers: mutationHeaders, payload: { sessionId: "s2" } }),
  ])
  for (const response of stoppedRequests) {
    assert.equal(response.statusCode, 409)
    assert.equal(response.json().error.code, "INSTANCE_STOPPED")
  }
})

test("Local TUI follows each newly created root only after that Instance reports its activity", async (t) => {
  const { app, project, runtime, service } = await fixture(t)
  runtime.sessionMetadata.set(project, [
    { id: "root-a", title: "Root A" },
    { id: "root-b", title: "Root B" },
    { id: "root-c", title: "Root C" },
  ])
  const id = await startLocalTui(service, runtime, project, "10000000-0000-4000-8000-000000000001", 5101)
  await app.inject({
    method: "POST",
    url: `/api/v1/instances/${id}/primary-session`,
    headers: mutationHeaders,
    payload: { sessionId: "root-a" },
  })

  await runtime.emitActivity(id, { type: "session-created", sessionId: "root-b" })
  assert.equal((await service.overview()).instances[0]?.primarySession?.sessionId, "root-a", "created alone is not activity proof")

  await runtime.emitActivity(id, { type: "activity", source: "event", sessionIds: ["root-b"] })
  assert.equal((await service.overview()).instances[0]?.primarySession?.sessionId, "root-b")
  assert.equal(runtime.observers.has(id), true, "Local TUI observer remains active after rebinding")

  await runtime.emitActivity(id, { type: "activity", source: "event", sessionIds: ["root-c"] })
  assert.equal((await service.overview()).instances[0]?.primarySession?.sessionId, "root-b", "activity without a creation candidate cannot switch")
  await runtime.emitActivity(id, { type: "session-created", sessionId: "root-c" })
  await runtime.emitActivity(id, { type: "activity", source: "event", sessionIds: ["root-c"] })
  assert.equal((await service.overview()).instances[0]?.primarySession?.sessionId, "root-c")

  const created = await app.inject({ method: "POST", url: `/api/v1/instances/${id}/sessions`, headers: mutationHeaders })
  assert.equal(created.statusCode, 201)
  assert.equal((await service.overview()).instances[0]?.primarySession?.source, "new-session")
  assert.equal(runtime.observers.has(id), true, "OMW New Session does not stop Local TUI observation")
})

test("Local TUI candidates reject child, ambiguous, foreign-Instance, and pre-reconnect evidence", async (t) => {
  const { app, project, runtime, service } = await fixture(t)
  runtime.sessionMetadata.set(project, [
    { id: "root-a", title: "Root A" },
    { id: "root-b", title: "Root B" },
    { id: "root-c", title: "Root C" },
    { id: "child-b", title: "Child B", parentID: "root-b" },
  ])
  const firstId = await startLocalTui(service, runtime, project, "10000000-0000-4000-8000-000000000002", 5102)
  const secondId = await startLocalTui(service, runtime, project, "10000000-0000-4000-8000-000000000003", 5103)
  for (const id of [firstId, secondId]) {
    await app.inject({
      method: "POST",
      url: `/api/v1/instances/${id}/primary-session`,
      headers: mutationHeaders,
      payload: { sessionId: "root-a" },
    })
  }

  await runtime.emitActivity(firstId, { type: "session-created", sessionId: "root-b" })
  await runtime.emitActivity(secondId, { type: "activity", source: "event", sessionIds: ["root-b"] })
  assert.equal((await service.overview()).instances.find((instance) => instance.id === firstId)?.primarySession?.sessionId, "root-a")
  assert.equal((await service.overview()).instances.find((instance) => instance.id === secondId)?.primarySession?.sessionId, "root-a")

  await runtime.emitActivity(firstId, { type: "session-created", sessionId: "child-b" })
  await runtime.emitActivity(firstId, { type: "activity", source: "event", sessionIds: ["child-b"] })
  assert.equal((await service.overview()).instances.find((instance) => instance.id === firstId)?.primarySession?.sessionId, "root-a")

  await runtime.emitActivity(firstId, { type: "session-created", sessionId: "root-b" })
  await runtime.emitActivity(firstId, { type: "activity", source: "snapshot", sessionIds: ["root-b", "root-c"] })
  assert.equal((await service.overview()).instances.find((instance) => instance.id === firstId)?.primarySession?.sessionId, "root-a")

  await runtime.emitActivity(firstId, { type: "session-created", sessionId: "root-b" })
  runtime.identityMatches = false
  runtime.portOwnerMatched = false
  runtime.portOwnedByOther = true
  await runtime.emitActivity(firstId, { type: "activity", source: "event", sessionIds: ["root-b"] })
  runtime.identityMatches = true
  runtime.portOwnerMatched = true
  runtime.portOwnedByOther = false
  await runtime.emitActivity(firstId, { type: "activity", source: "event", sessionIds: ["root-b"] })
  assert.equal((await service.overview()).instances.find((instance) => instance.id === firstId)?.primarySession?.sessionId, "root-a")

  await runtime.emitActivity(firstId, { type: "session-created", sessionId: "root-b" })
  runtime.endActivityObserver(firstId)
  await waitFor(() => runtime.observers.has(firstId), 1_000)
  await runtime.emitActivity(firstId, { type: "activity", source: "event", sessionIds: ["root-b"] })
  assert.equal((await service.overview()).instances.find((instance) => instance.id === firstId)?.primarySession?.sessionId, "root-a")
  for (const timeout of [1_500, 2_500, 2_500]) {
    runtime.endActivityObserver(firstId)
    await waitFor(() => runtime.observers.has(firstId), timeout)
  }
  await runtime.emitActivity(firstId, { type: "session-created", sessionId: "root-b" })
  await runtime.emitActivity(firstId, { type: "activity", source: "event", sessionIds: ["root-b"] })
  assert.equal((await service.overview()).instances.find((instance) => instance.id === firstId)?.primarySession?.sessionId, "root-b")
})

test("a delayed Local TUI candidate cannot overwrite a newer manual binding", async (t) => {
  const { app, project, runtime, service } = await fixture(t)
  runtime.sessionMetadata.set(project, [
    { id: "root-a", title: "Root A" },
    { id: "root-b", title: "Root B" },
    { id: "root-manual", title: "Manual root" },
  ])
  const id = await startLocalTui(service, runtime, project, "10000000-0000-4000-8000-000000000004", 5104)
  await app.inject({
    method: "POST",
    url: `/api/v1/instances/${id}/primary-session`,
    headers: mutationHeaders,
    payload: { sessionId: "root-a" },
  })
  await runtime.emitActivity(id, { type: "session-created", sessionId: "root-b" })
  runtime.blockActivity()
  const activityCalls = runtime.activityCalls
  const delayed = runtime.emitActivity(id, { type: "activity", source: "event", sessionIds: ["root-b"] })
  await waitFor(() => runtime.activityCalls > activityCalls, 500)

  await app.inject({
    method: "POST",
    url: `/api/v1/instances/${id}/primary-session`,
    headers: mutationHeaders,
    payload: { sessionId: "root-manual" },
  })
  runtime.releaseActivity?.()
  await delayed

  assert.equal((await service.overview()).instances[0]?.primarySession?.sessionId, "root-manual")
  assert.equal((await service.overview()).instances[0]?.primarySession?.source, "manual")
  assert.equal(runtime.observers.has(id), true)
})

test("callbacks from an ended Local TUI connection cannot bind stale activity or clear a new candidate", async (t) => {
  const { app, project, runtime, service } = await fixture(t)
  runtime.sessionMetadata.set(project, [
    { id: "root-a", title: "Root A" },
    { id: "stale-root", title: "Stale root" },
    { id: "new-root", title: "New root" },
  ])
  const id = await startLocalTui(service, runtime, project, "10000000-0000-4000-8000-000000000005", 5105)

  runtime.blockActivity()
  let activityCalls = runtime.activityCalls
  const staleBinding = runtime.emitActivity(id, { type: "activity", source: "event", sessionIds: ["stale-root"] })
  await waitFor(() => runtime.activityCalls > activityCalls, 500)
  runtime.endActivityObserver(id)
  await waitFor(() => runtime.observers.has(id), 1_000)
  runtime.releaseActivity?.()
  await staleBinding
  assert.equal((await service.overview()).instances[0]?.primarySession, null)

  await app.inject({
    method: "POST",
    url: `/api/v1/instances/${id}/primary-session`,
    headers: mutationHeaders,
    payload: { sessionId: "root-a" },
  })
  await runtime.emitActivity(id, { type: "session-created", sessionId: "stale-root" })
  runtime.blockActivity()
  runtime.activityError = new Error("stale connection activity failed")
  activityCalls = runtime.activityCalls
  const staleRejection = runtime.emitActivity(id, { type: "activity", source: "event", sessionIds: ["stale-root"] })
  await waitFor(() => runtime.activityCalls > activityCalls, 500)
  runtime.endActivityObserver(id)
  await waitFor(() => runtime.observers.has(id), 1_500)
  await runtime.emitActivity(id, { type: "session-created", sessionId: "new-root" })
  runtime.releaseActivity?.()
  await staleRejection
  runtime.activityError = null

  await runtime.emitActivity(id, { type: "activity", source: "event", sessionIds: ["new-root"] })
  assert.equal((await service.overview()).instances[0]?.primarySession?.sessionId, "new-root")
})

test("Local TUI candidate CAS uses the binding captured by its creation event", async (t) => {
  const { app, project, repository, runtime, service } = await fixture(t)
  runtime.sessionMetadata.set(project, [
    { id: "root-a", title: "Root A" },
    { id: "root-b", title: "Root B" },
    { id: "root-newer", title: "Newer root" },
  ])
  const id = await startLocalTui(service, runtime, project, "10000000-0000-4000-8000-000000000006", 5106)
  await app.inject({
    method: "POST",
    url: `/api/v1/instances/${id}/primary-session`,
    headers: mutationHeaders,
    payload: { sessionId: "root-a" },
  })
  await runtime.emitActivity(id, { type: "session-created", sessionId: "root-b" })
  repository.replacePrimarySession(id, {
    sessionId: "root-newer",
    title: "Newer root",
    source: "manual",
    boundAt: "2026-09-22T12:00:00.000Z",
  })

  await runtime.emitActivity(id, { type: "activity", source: "event", sessionIds: ["root-b"] })
  assert.equal((await service.overview()).instances[0]?.primarySession?.sessionId, "root-newer")
})

test("activity binding resolves child ancestry but never guesses missing, cyclic, or multiple roots", async (t) => {
  const { project, runtime, service } = await fixture(t)

  runtime.sessionMetadata.set(project, [
    { id: "root", title: "Root" },
    { id: "child", title: "Child", parentID: "root" },
  ])
  const childActivity = await service.start(project)
  await runtime.emitActivity(childActivity.id, { type: "activity", source: "event", sessionIds: ["child"] })
  assert.equal((await service.overview()).instances.find((instance) => instance.id === childActivity.id)?.primarySession?.sessionId, "root")

  runtime.sessionMetadata.set(project, [
    { id: "root-a", title: "Root A" },
    { id: "root-b", title: "Root B" },
  ])
  const multipleRoots = await service.start(project)
  await runtime.emitActivity(multipleRoots.id, { type: "activity", source: "snapshot", sessionIds: ["root-a", "root-b"] })

  runtime.sessionMetadata.set(project, [{ id: "orphan", title: "Orphan", parentID: "missing" }])
  const missingParent = await service.start(project)
  await runtime.emitActivity(missingParent.id, { type: "activity", source: "event", sessionIds: ["orphan"] })

  runtime.sessionMetadata.set(project, [
    { id: "cycle-a", title: "Cycle A", parentID: "cycle-b" },
    { id: "cycle-b", title: "Cycle B", parentID: "cycle-a" },
  ])
  const cycle = await service.start(project)
  await runtime.emitActivity(cycle.id, { type: "activity", source: "event", sessionIds: ["cycle-a"] })

  const overview = await service.overview()
  for (const id of [multipleRoots.id, missingParent.id, cycle.id]) {
    assert.equal(overview.instances.find((instance) => instance.id === id)?.primarySession, null)
  }
})

test("explicit New Session and manual root switching update binding only after validated success", async (t) => {
  const { app, project, runtime } = await fixture(t)
  runtime.sessionMetadata.set(project, [
    { id: "root", title: "Existing root" },
    { id: "child", title: "Child", parentID: "root" },
  ])
  const started = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  const id = started.json().id as string

  const child = await app.inject({ method: "POST", url: `/api/v1/instances/${id}/primary-session`, headers: mutationHeaders, payload: { sessionId: "child" } })
  assert.equal(child.statusCode, 409)
  assert.equal(child.json().error.code, "SESSION_NOT_ROOT")
  const missing = await app.inject({ method: "POST", url: `/api/v1/instances/${id}/primary-session`, headers: mutationHeaders, payload: { sessionId: "missing" } })
  assert.equal(missing.statusCode, 404)

  const manual = await app.inject({ method: "POST", url: `/api/v1/instances/${id}/primary-session`, headers: mutationHeaders, payload: { sessionId: "root" } })
  assert.equal(manual.statusCode, 200)
  let overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.equal(overview.json().instances[0].primarySession.source, "manual")

  runtime.remoteUrlError = "public origin unavailable"
  const beforePreflight = runtime.createSessionCalls
  const preflightRejected = await app.inject({ method: "POST", url: `/api/v1/instances/${id}/sessions`, headers: mutationHeaders })
  assert.equal(preflightRejected.statusCode, 409)
  assert.equal(preflightRejected.json().error.code, "REMOTE_URL_UNAVAILABLE")
  assert.equal(runtime.createSessionCalls, beforePreflight)
  runtime.remoteUrlError = null

  runtime.createSessionError = new Error("fixture create rejected")
  const failed = await app.inject({ method: "POST", url: `/api/v1/instances/${id}/sessions`, headers: mutationHeaders })
  assert.equal(failed.statusCode, 502)
  assert.equal(failed.json().error.code, "SESSION_CREATE_FAILED")
  assert.equal(failed.json().error.details.retrySafe, false)
  overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.equal(overview.json().instances[0].primarySession.sessionId, "root")

  runtime.createSessionError = null
  const created = await app.inject({ method: "POST", url: `/api/v1/instances/${id}/sessions`, headers: mutationHeaders })
  assert.equal(created.statusCode, 201)
  assert.equal(created.json().sessionId, "created-2")
  assert.equal(new URL(created.json().url).searchParams.get("session"), "created-2")
  overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.equal(overview.json().instances[0].primarySession.source, "new-session")

  runtime.failCreatedSessionUrl = true
  const createdWithoutUrl = await app.inject({ method: "POST", url: `/api/v1/instances/${id}/sessions`, headers: mutationHeaders })
  assert.equal(createdWithoutUrl.statusCode, 502)
  assert.equal(createdWithoutUrl.json().error.code, "SESSION_CREATED_URL_FAILED")
  assert.equal(createdWithoutUrl.json().error.details.sessionId, "created-3")
  overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.equal(overview.json().instances[0].primarySession.sessionId, "created-3")
})

test("remote URL delivery awaits fresh connectivity verification without blocking local instance start", async (t) => {
  let remoteReady = false
  const verifiedPorts: number[] = []
  const { app, project, runtime } = await fixture(t, {
    verifyRemoteUrl: async (port) => {
      verifiedPorts.push(port)
      if (!remoteReady) throw new Error("stale connectivity fixture")
    },
  })
  const started = await app.inject({
    method: "POST",
    url: "/api/v1/instances",
    headers: mutationHeaders,
    payload: { directory: project },
  })
  assert.equal(started.statusCode, 201)
  assert.deepEqual(verifiedPorts, [], "local Instance start does not depend on remote readiness")
  const id = started.json().id as string
  const port = started.json().port as number
  runtime.openUrlCalls = 0

  const unavailable = await app.inject({ method: "POST", url: `/api/v1/instances/${id}/open-url`, headers: mutationHeaders, payload: {} })
  assert.equal(unavailable.statusCode, 409)
  assert.equal(unavailable.json().error.code, "REMOTE_URL_UNAVAILABLE")
  assert.equal(runtime.openUrlCalls, 0)

  remoteReady = true
  const available = await app.inject({ method: "POST", url: `/api/v1/instances/${id}/open-url`, headers: mutationHeaders, payload: {} })
  assert.equal(available.statusCode, 200)
  assert.deepEqual(verifiedPorts, [port, port])
  assert.equal(runtime.openUrlCalls, 1)
})

test("stale activity observation cannot replace an explicit binding and the binding survives SQLite reopen", async (t) => {
  const { app, project, repository, runtime } = await fixture(t)
  runtime.sessionMetadata.set(project, [
    { id: "auto", title: "Observed root" },
    { id: "manual", title: "Chosen root" },
  ])
  const started = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  const id = started.json().id as string
  runtime.activityBusySessions.set(id, [])
  runtime.blockActivity()
  const stale = runtime.emitActivity(id, { type: "activity", source: "event", sessionIds: ["auto"] })
  await waitFor(() => runtime.activityCalls > 0, 500)

  const selected = await app.inject({
    method: "POST",
    url: `/api/v1/instances/${id}/primary-session`,
    headers: mutationHeaders,
    payload: { sessionId: "manual" },
  })
  assert.equal(selected.statusCode, 200)
  runtime.releaseActivity?.()
  await stale

  const reopened = new ManagerRepository(repository.filename)
  const restarted = new ManagerService(reopened, runtime)
  try {
    assert.equal(reopened.getPrimarySession(id)?.sessionId, "manual")
    assert.equal(reopened.getPrimarySession(id)?.source, "manual")
    assert.equal((await restarted.overview()).instances[0]?.primarySession?.sessionId, "manual")
  } finally {
    await restarted.shutdown()
    reopened.close()
  }
})

test("activity observers reject foreign identity and are closed on Manager shutdown", async (t) => {
  const { project, runtime, service } = await fixture(t)
  const instance = await service.start(project)
  runtime.identityMatches = false
  runtime.portOwnerMatched = false
  runtime.portOwnedByOther = true
  const activityCalls = runtime.activityCalls
  await runtime.emitActivity(instance.id, { type: "activity", source: "event", sessionIds: ["root"] })
  assert.equal(runtime.activityCalls, activityCalls)
  assert.equal((await service.overview()).instances[0]?.primarySession, null)

  runtime.identityMatches = true
  runtime.portOwnerMatched = true
  runtime.portOwnedByOther = false
  await service.shutdown()
  assert.ok(runtime.observerCloseCount > 0)
  assert.equal(runtime.observers.size, 0)
})

test("shutdown invalidates a deferred activity identity check before repository close", async (t) => {
  const { project, repository, runtime, service } = await fixture(t)
  runtime.sessionMetadata.set(project, [{ id: "deferred-root", title: "Deferred root" }])
  const instance = await service.start(project)
  runtime.activityBusySessions.set(instance.id, [])
  runtime.deferInspect(runtime.inspectCalls + 2)

  let repositoryClosed = false
  let accessesAfterClose = 0
  let bindAttempts = 0
  const getInstance = repository.getInstance.bind(repository)
  const getPrimarySession = repository.getPrimarySession.bind(repository)
  const bindPrimarySessionIfAbsent = repository.bindPrimarySessionIfAbsent.bind(repository)
  repository.getInstance = (id) => {
    if (repositoryClosed) {
      accessesAfterClose++
      return null
    }
    return getInstance(id)
  }
  repository.getPrimarySession = (id) => {
    if (repositoryClosed) {
      accessesAfterClose++
      return null
    }
    return getPrimarySession(id)
  }
  repository.bindPrimarySessionIfAbsent = (id, primarySession) => {
    bindAttempts++
    if (repositoryClosed) {
      accessesAfterClose++
      return false
    }
    return bindPrimarySessionIfAbsent(id, primarySession)
  }

  const deferredActivity = runtime.emitActivity(instance.id, {
    type: "activity",
    source: "event",
    sessionIds: ["deferred-root"],
  })
  await waitFor(() => runtime.deferredInspectStarted, 500)
  await service.shutdown()
  assert.equal(repository.getPrimarySession(instance.id), null)
  repositoryClosed = true
  repository.close()
  runtime.releaseInspect?.()
  await deferredActivity

  assert.equal(bindAttempts, 0)
  assert.equal(accessesAfterClose, 0)
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

test("start rejects another owner on the Manager endpoint before readiness", async (t) => {
  const { app, project, runtime } = await fixture(t)
  runtime.portOwnedByOther = true
  runtime.readinessError = new Error("readiness must not run for a conflicting endpoint owner")

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/instances",
    headers: mutationHeaders,
    payload: { directory: project },
  })

  assert.equal(response.statusCode, 409)
  assert.equal(response.json().error.code, "INSTANCE_IDENTITY_UNVERIFIED")
  assert.equal(runtime.cleanupCount, 1)
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

test("a launch throw before identity assignment quarantines the allocation unless runtime proves cleanup", async (t) => {
  const { app, project, repository, runtime } = await fixture(t)
  runtime.launchError = new ManagerError(
    "STARTUP_CLEANUP_FAILED",
    "fixture cleanup detail must not reach HTTP",
    500,
  )
  runtime.cleanupSucceeds = false

  const response = await app.inject({
    method: "POST",
    url: "/api/v1/instances",
    headers: mutationHeaders,
    payload: { directory: project },
  })

  assert.equal(response.statusCode, 500)
  assert.equal(response.json().error.code, "STARTUP_CLEANUP_FAILED")
  assert.doesNotMatch(response.body, /fixture cleanup detail/)
  assert.equal(runtime.cleanupCount, 1)
  const [record] = repository.listInstances()
  assert.equal(record?.state, "failed")
  assert.equal(record?.pid, null)
  assert.equal(record?.error, "STARTUP_CLEANUP_FAILED；STARTUP_CLEANUP_UNRESOLVED")
  assert.notEqual(repository.getAllocationForInstance(record!.id), null)
})

test("a launch throw releases the allocation only from an explicit successful runtime cleanup", async (t) => {
  const { app, project, repository, runtime } = await fixture(t)
  runtime.launchError = new Error("spawn handshake failed")

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
  assert.equal(record?.error, "INSTANCE_START_FAILED")
  assert.equal(repository.getAllocationForInstance(record!.id), null)
})

test("reconcile keeps an old free allocation quarantined without exact process identity", async (t) => {
  const { project, repository, runtime, service } = await fixture(t)
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

  assert.equal(repository.getInstance(allocation.id)?.state, "unreachable")
  assert.notEqual(repository.getAllocation(allocation.id), null)
  const overview = await service.overview()
  assert.equal(overview.instances[0]?.stopAllowed, false)
  assert.equal(overview.instances[0]?.recovery.removeAllowed, false)
  await assert.rejects(service.stop(allocation.id), (error: unknown) => {
    assert.equal((error as ManagerError).code, "PROCESS_IDENTITY_INCOMPLETE")
    return true
  })
  assert.equal(runtime.stopCount, 0)
  await assert.rejects(service.deleteInstance(allocation.id), (error: unknown) => {
    assert.equal((error as ManagerError).code, "INSTANCE_REMOVAL_UNSAFE")
    return true
  })
  assert.equal((await service.setTrackingHidden(allocation.id, true)).trackingHidden, true)
  assert.equal((await service.setTrackingHidden(allocation.id, false)).trackingHidden, false)
})

test("reconcile releases an explicitly exited process only when its port is free and the next Start can reuse it", async (t) => {
  const port = await freePort()
  const { project, repository, runtime, service } = await fixture(t, { portPool: { min: port, max: port } })
  const first = await service.start(project)
  runtime.processState = "not-found"

  await service.reconcile()

  const stopped = repository.getInstance(first.id)
  assert.equal(stopped?.state, "stopped")
  assert.equal(stopped?.pid, null)
  assert.equal(stopped?.creationTimeTicks, null)
  assert.equal(stopped?.executable, null)
  assert.equal(repository.getAllocation(first.id), null)

  runtime.processState = "running"
  const second = await service.start(project)
  assert.equal(second.port, port)
  assert.notEqual(second.id, first.id)
})

test("reconcile quarantines an explicitly exited process while its recorded port is occupied", async (t) => {
  const listener = net.createServer()
  const port = await freePort()
  const { project, repository, runtime, service } = await fixture(t, { portPool: { min: port, max: port } })
  const instance = await service.start(project)
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject)
    listener.listen(port, "127.0.0.1", resolve)
  })
  t.after(() => new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())))
  runtime.processState = "not-found"

  await service.reconcile()

  assert.equal(repository.getInstance(instance.id)?.state, "unreachable")
  assert.notEqual(repository.getAllocation(instance.id), null)
  const overview = await service.overview()
  assert.equal(overview.instances[0]?.stopAllowed, false)
  await assert.rejects(service.deleteInstance(instance.id), (error: unknown) => {
    assert.equal((error as ManagerError).code, "INSTANCE_REMOVAL_UNSAFE")
    return true
  })
})

test("a fresh repository and service re-check persisted identity and health before restoring ready", async (t) => {
  const { project, repository, runtime, service } = await fixture(t)
  const started = await service.start(project)
  const database = repository.filename
  await service.shutdown()
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
    await restartedService.shutdown()
    reopened.close()
  }
})

test("recheck keeps unknown and failed probes unreachable, then releases only a confirmed missing process on a free port", async (t) => {
  const { app, project, repository, runtime } = await fixture(t)
  const started = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  const id = started.json().id as string

  runtime.inspectResults.set(id, {
    processState: "unknown",
    matched: false,
    portOwnerMatched: false,
    portOwnedByOther: false,
  })
  let response = await app.inject({ method: "POST", url: `/api/v1/instances/${id}/recheck`, headers: mutationHeaders })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().state, "unreachable")
  assert.deepEqual(response.json().recovery, {
    recheckAllowed: true,
    resumeAllowed: false,
    hideAllowed: true,
    removeAllowed: false,
  })
  assert.notEqual(repository.getAllocation(id), null)

  runtime.inspectResults.set(id, {
    processState: "running",
    matched: true,
    portOwnerMatched: true,
    portOwnedByOther: false,
  })
  runtime.readinessError = new Error("OpenCode /global/health returned HTTP 404")
  response = await app.inject({ method: "POST", url: `/api/v1/instances/${id}/recheck`, headers: mutationHeaders })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().state, "unreachable")
  assert.notEqual(repository.getAllocation(id), null)
  runtime.readinessError = null

  const secret = "fixture-recheck-secret-must-not-leak"
  runtime.inspectError = new Error(secret)
  response = await app.inject({ method: "POST", url: `/api/v1/instances/${id}/recheck`, headers: mutationHeaders })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().state, "unreachable")
  assert.doesNotMatch(response.body, new RegExp(secret))
  assert.notEqual(repository.getAllocation(id), null)

  runtime.inspectError = null
  runtime.inspectResults.set(id, {
    processState: "not-found",
    matched: false,
    portOwnerMatched: false,
    portOwnedByOther: false,
  })
  response = await app.inject({ method: "POST", url: `/api/v1/instances/${id}/recheck`, headers: mutationHeaders })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().state, "stopped")
  assert.equal(response.json().recovery.removeAllowed, true)
  assert.equal(repository.getAllocation(id), null)
})

test("tracking visibility persists, excludes hidden Instances before health probes, and can be restored", async (t) => {
  const { app, project, repository, runtime } = await fixture(t)
  const started = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  const id = started.json().id as string
  runtime.inspectResults.set(id, {
    processState: "unknown",
    matched: false,
    portOwnerMatched: false,
    portOwnedByOther: false,
  })
  await app.inject({ method: "POST", url: `/api/v1/instances/${id}/recheck`, headers: mutationHeaders })

  const hidden = await app.inject({
    method: "POST",
    url: `/api/v1/instances/${id}/tracking`,
    headers: mutationHeaders,
    payload: { hidden: true },
  })
  assert.equal(hidden.statusCode, 200)
  assert.equal(hidden.json().trackingHidden, true)
  const inspectCalls = runtime.inspectCalls

  const overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.deepEqual(overview.json().instances, [])
  assert.equal(runtime.inspectCalls, inspectCalls)

  const reopened = new ManagerRepository(repository.filename)
  const restarted = new ManagerService(reopened, runtime)
  try {
    const persisted = await restarted.overview("", "all", true)
    assert.equal(persisted.instances[0]?.trackingHidden, true)
  } finally {
    await restarted.shutdown()
    reopened.close()
  }

  const included = await app.inject({ method: "GET", url: "/api/v1/overview?includeHidden=true", headers: readHeaders })
  assert.equal(included.json().instances[0].id, id)
  const restored = await app.inject({
    method: "POST",
    url: `/api/v1/instances/${id}/tracking`,
    headers: mutationHeaders,
    payload: { hidden: false },
  })
  assert.equal(restored.statusCode, 200)
  assert.equal(restored.json().trackingHidden, false)
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })).json().instances[0].id, id)
})

test("DELETE rejects a live Instance and transactionally removes only a safely stopped OMW record", async (t) => {
  const { app, project, repository, runtime } = await fixture(t)
  runtime.sessionMetadata.set(project, [{ id: "kept-session", title: "Keep OpenCode history" }])
  const started = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  const id = started.json().id as string
  const live = await app.inject({ method: "DELETE", url: `/api/v1/instances/${id}`, headers: mutationHeaders })
  assert.equal(live.statusCode, 409)
  assert.notEqual(repository.getInstance(id), null)
  assert.equal(runtime.observers.has(id), true)

  await app.inject({
    method: "POST",
    url: `/api/v1/instances/${id}/primary-session`,
    headers: mutationHeaders,
    payload: { sessionId: "kept-session" },
  })

  runtime.inspectResults.set(id, {
    processState: "not-found",
    matched: false,
    portOwnerMatched: false,
    portOwnedByOther: false,
  })
  await app.inject({ method: "POST", url: `/api/v1/instances/${id}/recheck`, headers: mutationHeaders })
  const deleted = await app.inject({ method: "DELETE", url: `/api/v1/instances/${id}`, headers: mutationHeaders })
  assert.equal(deleted.statusCode, 204)
  assert.equal(repository.getInstance(id), null)
  assert.equal(repository.getPrimarySession(id), null)
  assert.deepEqual(runtime.sessionMetadata.get(project), [{ id: "kept-session", title: "Keep OpenCode history" }])
})

test("resume launches a new headless Instance with the same explicit primary Session and never stops or prompts the old one", async (t) => {
  const { app, project, repository, runtime } = await fixture(t)
  runtime.sessionMetadata.set(project, [{ id: "resume-root", title: "Current main title" }])
  const started = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  const oldId = started.json().id as string
  await app.inject({
    method: "POST",
    url: `/api/v1/instances/${oldId}/primary-session`,
    headers: mutationHeaders,
    payload: { sessionId: "resume-root" },
  })
  runtime.inspectResults.set(oldId, {
    processState: "unknown",
    matched: false,
    portOwnerMatched: false,
    portOwnedByOther: false,
  })
  await app.inject({ method: "POST", url: `/api/v1/instances/${oldId}/recheck`, headers: mutationHeaders })
  const createSessionCalls = runtime.createSessionCalls

  const resumed = await app.inject({ method: "POST", url: `/api/v1/instances/${oldId}/resume`, headers: mutationHeaders })
  assert.equal(resumed.statusCode, 200)
  assert.notEqual(resumed.json().id, oldId)
  assert.equal(resumed.json().kind, "headless")
  assert.equal(resumed.json().primarySession.sessionId, "resume-root")
  assert.equal(resumed.json().primarySession.title, "Current main title")
  assert.equal(repository.getInstance(oldId)?.state, "unreachable")
  assert.equal(runtime.stopCount, 0)
  assert.equal(runtime.createSessionCalls, createSessionCalls)
})

test("resume always replaces a Local TUI with a new headless Instance", async (t) => {
  const { app, project, repository, runtime } = await fixture(t)
  const port = await freePort()
  const id = "local-tui-recovery"
  const allocation = {
    id,
    kind: "local-tui" as const,
    clientInvocationId: "44444444-4444-4444-8444-444444444444",
    projectDirectory: project,
    port,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    instanceId: null,
  }
  assert.equal(repository.tryCreateAllocation(allocation), true)
  repository.createReservedInstance(id, {
    id,
    kind: "local-tui",
    clientInvocationId: allocation.clientInvocationId,
    projectName: path.basename(project),
    projectDirectory: project,
    state: "unreachable",
    endpoint: `http://127.0.0.1:${port}`,
    port,
    pid: 9123,
    creationTimeUtc: "2026-09-18T00:00:00.000Z",
    creationTimeTicks: "638937504000000000",
    executable: "C:\\tools\\opencode.exe",
    launchedAt: "2026-09-18T00:00:00.000Z",
    healthVersion: null,
    stoppedAt: null,
    error: "INSTANCE_IDENTITY_UNVERIFIED",
    stderrSummary: null,
  })
  repository.replacePrimarySession(id, {
    sessionId: "local-root",
    title: "Local primary",
    source: "manual",
    boundAt: "2026-09-18T00:00:00.000Z",
  })
  runtime.sessionMetadata.set(project, [{ id: "local-root", title: "Local primary latest" }])
  runtime.inspectResults.set(id, {
    processState: "unknown",
    matched: false,
    portOwnerMatched: false,
    portOwnedByOther: false,
  })

  const resumed = await app.inject({ method: "POST", url: `/api/v1/instances/${id}/resume`, headers: mutationHeaders })
  assert.equal(resumed.statusCode, 200)
  assert.equal(resumed.json().kind, "headless")
  assert.notEqual(resumed.json().id, id)
  assert.equal(repository.getInstance(id)?.kind, "local-tui")
})

test("resume failure after launch exposes the new Instance id and leaves it unbound", async (t) => {
  const { app, project, repository, runtime } = await fixture(t)
  runtime.sessionMetadata.set(project, [{ id: "expected-root", title: "Expected" }])
  const started = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  const oldId = started.json().id as string
  await app.inject({
    method: "POST",
    url: `/api/v1/instances/${oldId}/primary-session`,
    headers: mutationHeaders,
    payload: { sessionId: "expected-root" },
  })
  runtime.inspectResults.set(oldId, {
    processState: "unknown",
    matched: false,
    portOwnerMatched: false,
    portOwnedByOther: false,
  })
  await app.inject({ method: "POST", url: `/api/v1/instances/${oldId}/recheck`, headers: mutationHeaders })
  runtime.sessionMetadata.set(project, [{ id: "different-root", title: "Different" }])

  const resumed = await app.inject({ method: "POST", url: `/api/v1/instances/${oldId}/resume`, headers: mutationHeaders })
  assert.equal(resumed.statusCode, 409)
  assert.equal(resumed.json().error.code, "INSTANCE_RESUME_BIND_FAILED")
  assert.match(resumed.json().error.message, /新 Instance 已啟動但未接續，勿重複啟動/)
  const newId = resumed.json().error.details.newInstanceId as string
  assert.notEqual(newId, oldId)
  assert.notEqual(repository.getInstance(newId), null)
  assert.equal(repository.getPrimarySession(newId), null)
})

test("verified metadata refreshes only the primary title and a slow stale refresh cannot overwrite a newer binding", async (t) => {
  const { app, project, repository, runtime } = await fixture(t)
  runtime.sessionMetadata.set(project, [
    { id: "first-root", title: "Initial title" },
    { id: "second-root", title: "Second title" },
  ])
  const started = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  const id = started.json().id as string
  await app.inject({
    method: "POST",
    url: `/api/v1/instances/${id}/primary-session`,
    headers: mutationHeaders,
    payload: { sessionId: "first-root" },
  })
  const original = repository.getPrimarySession(id)
  runtime.summaries.set(project, {
    activity: "busy",
    busySessions: 1,
    pendingQuestions: 0,
    pendingPermissions: 0,
    error: null,
    sessions: [{ id: "first-root", title: "Latest title" }],
  })
  await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  const refreshed = repository.getPrimarySession(id)
  assert.equal(refreshed?.title, "Latest title")
  assert.equal(refreshed?.sessionId, original?.sessionId)
  assert.equal(refreshed?.source, original?.source)
  assert.equal(refreshed?.boundAt, original?.boundAt)

  runtime.summaries.set(project, {
    activity: "reported-non-busy",
    busySessions: 0,
    pendingQuestions: 0,
    pendingPermissions: 0,
    error: null,
    sessions: [{ id: "first-root", title: "Latest idle title" }],
  })
  await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.equal(repository.getPrimarySession(id)?.title, "Latest idle title")

  runtime.inspectFails = true
  await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.equal(repository.getPrimarySession(id)?.title, "Latest idle title")
  runtime.inspectFails = false

  runtime.summaries.set(project, {
    activity: "busy",
    busySessions: 1,
    pendingQuestions: 0,
    pendingPermissions: 0,
    error: null,
    sessions: [{ id: "first-root", title: "Late stale title" }],
  })
  runtime.blockSummary()
  const staleOverview = app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  await waitFor(() => runtime.summaryStarted, 500)
  const selected = await app.inject({
    method: "POST",
    url: `/api/v1/instances/${id}/primary-session`,
    headers: mutationHeaders,
    payload: { sessionId: "second-root" },
  })
  assert.equal(selected.statusCode, 200)
  runtime.releaseSummary?.()
  await staleOverview
  assert.equal(repository.getPrimarySession(id)?.sessionId, "second-root")
  assert.equal(repository.getPrimarySession(id)?.title, "Second title")
})

test("tracking hide fresh-rechecks a ready record that overview presents as unreachable", async (t) => {
  const { app, project, repository, runtime } = await fixture(t)
  const started = await app.inject({
    method: "POST",
    url: "/api/v1/instances",
    headers: mutationHeaders,
    payload: { directory: project },
  })
  const id = started.json().id as string
  runtime.inspectFails = true

  const overview = await app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  assert.equal(overview.json().instances[0].state, "unreachable")
  assert.equal(overview.json().instances[0].recovery.hideAllowed, true)
  assert.equal(repository.getInstance(id)?.state, "ready")

  const hidden = await app.inject({
    method: "POST",
    url: `/api/v1/instances/${id}/tracking`,
    headers: mutationHeaders,
    payload: { hidden: true },
  })

  assert.equal(hidden.statusCode, 200)
  assert.equal(hidden.json().state, "unreachable")
  assert.equal(hidden.json().trackingHidden, true)
  assert.equal(repository.getInstance(id)?.state, "unreachable")
})

test("same-Instance mutations serialize and an older overview cannot re-expose a deleted record", async (t) => {
  const { app, project, repository, runtime } = await fixture(t)
  const started = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
  const id = started.json().id as string

  runtime.summaryStarted = false
  runtime.blockSummary()
  const staleOverview = app.inject({ method: "GET", url: "/api/v1/overview", headers: readHeaders })
  await waitFor(() => runtime.summaryStarted, 500)

  runtime.inspectResults.set(id, {
    processState: "not-found",
    matched: false,
    portOwnerMatched: false,
    portOwnedByOther: false,
  })
  runtime.deferInspect(runtime.inspectCalls + 1)
  const recheck = app.inject({ method: "POST", url: `/api/v1/instances/${id}/recheck`, headers: mutationHeaders })
  await waitFor(() => runtime.deferredInspectStarted, 500)
  const deletion = app.inject({ method: "DELETE", url: `/api/v1/instances/${id}`, headers: mutationHeaders })

  runtime.releaseInspect?.()
  assert.equal((await recheck).json().state, "stopped")
  assert.equal((await deletion).statusCode, 204)
  runtime.releaseSummary?.()
  assert.deepEqual((await staleOverview).json().instances, [])
  assert.equal(repository.getInstance(id), null)
})

test("successful Instance mutations make the next overview independent of an older in-flight snapshot", async (t) => {
  await t.test("stop", async (t) => {
    const { app, project, runtime } = await fixture(t)
    const started = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
    const id = started.json().id as string

    const overview = await freshOverviewAfterMutation(app, runtime, async () => {
      const stopped = await app.inject({ method: "POST", url: `/api/v1/instances/${id}/stop`, headers: mutationHeaders })
      assert.equal(stopped.statusCode, 200)
      assert.equal(stopped.json().state, "stopped")
    })

    assert.equal(overview.json().instances.find((instance: { id: string }) => instance.id === id)?.state, "stopped")
  })

  await t.test("hide", async (t) => {
    const { app, project, runtime } = await fixture(t)
    const started = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
    const id = started.json().id as string

    const overview = await freshOverviewAfterMutation(app, runtime, async () => {
      runtime.inspectFails = true
      const hidden = await app.inject({
        method: "POST",
        url: `/api/v1/instances/${id}/tracking`,
        headers: mutationHeaders,
        payload: { hidden: true },
      })
      assert.equal(hidden.statusCode, 200)
      assert.equal(hidden.json().state, "unreachable")
      assert.equal(hidden.json().trackingHidden, true)
    })

    assert.deepEqual(overview.json().instances, [])
  })

  await t.test("restore", async (t) => {
    const { app, project, runtime } = await fixture(t)
    const target = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
    const id = target.json().id as string
    runtime.inspectFails = true
    const hidden = await app.inject({
      method: "POST",
      url: `/api/v1/instances/${id}/tracking`,
      headers: mutationHeaders,
      payload: { hidden: true },
    })
    assert.equal(hidden.statusCode, 200)
    runtime.inspectFails = false
    await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })

    const overview = await freshOverviewAfterMutation(app, runtime, async () => {
      const restored = await app.inject({
        method: "POST",
        url: `/api/v1/instances/${id}/tracking`,
        headers: mutationHeaders,
        payload: { hidden: false },
      })
      assert.equal(restored.statusCode, 200)
      assert.equal(restored.json().trackingHidden, false)
    }, "/api/v1/overview?includeHidden=true")

    const restored = overview.json().instances.find((instance: { id: string }) => instance.id === id)
    assert.equal(restored?.trackingHidden, false)
  })

  await t.test("resume preserves the primary binding on the new Instance", async (t) => {
    const { app, project, runtime } = await fixture(t)
    runtime.sessionMetadata.set(project, [{ id: "resume-root", title: "Resume root" }])
    const started = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
    const oldId = started.json().id as string
    await app.inject({
      method: "POST",
      url: `/api/v1/instances/${oldId}/primary-session`,
      headers: mutationHeaders,
      payload: { sessionId: "resume-root" },
    })
    runtime.inspectResults.set(oldId, {
      processState: "unknown",
      matched: false,
      portOwnerMatched: false,
      portOwnedByOther: false,
    })
    await app.inject({ method: "POST", url: `/api/v1/instances/${oldId}/recheck`, headers: mutationHeaders })
    await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
    let resumedId = ""

    const overview = await freshOverviewAfterMutation(app, runtime, async () => {
      const resumed = await app.inject({ method: "POST", url: `/api/v1/instances/${oldId}/resume`, headers: mutationHeaders })
      assert.equal(resumed.statusCode, 200)
      resumedId = resumed.json().id as string
      assert.notEqual(resumedId, oldId)
      assert.equal(resumed.json().primarySession.sessionId, "resume-root")
    })

    const resumed = overview.json().instances.find((instance: { id: string }) => instance.id === resumedId)
    assert.equal(resumed?.state, "ready")
    assert.equal(resumed?.primarySession.sessionId, "resume-root")
  })

  await t.test("New Session publishes its new primary binding", async (t) => {
    const { app, project, runtime } = await fixture(t)
    runtime.sessionMetadata.set(project, [{ id: "root", title: "Existing root" }])
    const started = await app.inject({ method: "POST", url: "/api/v1/instances", headers: mutationHeaders, payload: { directory: project } })
    const id = started.json().id as string

    const overview = await freshOverviewAfterMutation(app, runtime, async () => {
      const created = await app.inject({ method: "POST", url: `/api/v1/instances/${id}/sessions`, headers: mutationHeaders })
      assert.equal(created.statusCode, 201)
      assert.equal(created.json().sessionId, "created-1")
      runtime.summaries.set(project, {
        activity: "reported-non-busy",
        busySessions: 0,
        pendingQuestions: 0,
        pendingPermissions: 0,
        error: null,
        sessions: runtime.sessionMetadata.get(project) ?? [],
      })
    })

    const refreshed = overview.json().instances.find((instance: { id: string }) => instance.id === id)
    assert.equal(refreshed?.primarySession.sessionId, "created-1")
    assert.ok(refreshed?.sessions.some((session: { id: string }) => session.id === "created-1"))
  })
})

async function freshOverviewAfterMutation(
  app: Awaited<ReturnType<typeof fixture>>["app"],
  runtime: FakeRuntime,
  mutate: () => Promise<void>,
  overviewUrl = "/api/v1/overview",
) {
  runtime.summaryStarted = false
  runtime.blockSummary()
  const olderOverview = app.inject({ method: "GET", url: overviewUrl, headers: readHeaders })
  await waitFor(() => runtime.summaryStarted, 500)
  await mutate()

  const freshOverview = app.inject({ method: "GET", url: overviewUrl, headers: readHeaders })
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      freshOverview,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("overview after a successful mutation reused the older in-flight snapshot")), 500)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    runtime.releaseSummary?.()
    await Promise.allSettled([olderOverview, freshOverview])
  }
}

function waitFor(predicate: () => boolean, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve()
      if (Date.now() >= deadline) return reject(new Error(`Condition was not met within ${timeout} ms`))
      setTimeout(check, 10)
    }
    check()
  })
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
