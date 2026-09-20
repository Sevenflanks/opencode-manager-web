import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildApp } from "../../apps/manager/dist/src/app.js"
import { SeparateRequestAuthenticator } from "../../apps/manager/dist/src/auth.js"
import { CredentialController } from "../../apps/manager/dist/src/credential-controller.js"
import { DpapiCredentialStore } from "../../apps/manager/dist/src/credential-store.js"

const publicOrigin = "https://device.example.ts.net:8443"
const authority = new URL(publicOrigin).host
const dpapiTimeoutMs = 3_000
const operationTimeoutMs = 3_000
const initial = {
  manager: { username: "acceptance-initial", password: "acceptance-initial-password-2026" },
  launcherToken: "acceptance-launcher-token-2026-with-bounded-fixture-data",
}
const rotated = {
  manager: { username: "acceptance-rotated", password: "acceptance-rotated-password-2026" },
  launcherToken: initial.launcherToken,
}

function basic(credentials) {
  return `Basic ${Buffer.from(`${credentials.manager.username}:${credentials.manager.password}`).toString("base64")}`
}

function browserHeaders(credentials) {
  return { host: authority, authorization: basic(credentials) }
}

function mutationHeaders(credentials) {
  return {
    ...browserHeaders(credentials),
    origin: publicOrigin,
    "x-omw-csrf": "1",
  }
}

function withDeadline(promise, label, timeoutMs = operationTimeoutMs) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

function acceptanceService() {
  let shutdownCalls = 0
  return {
    service: {
      overview: async () => ({ shortcuts: [], instances: [] }),
      shutdown: async () => { shutdownCalls++ },
    },
    shutdownCalls: () => shutdownCalls,
  }
}

function createAcceptanceApp(credentials, store, options = {}) {
  const authenticator = new SeparateRequestAuthenticator(credentials)
  const serviceState = acceptanceService()
  const app = buildApp({
    service: serviceState.service,
    authority: { hostname: "127.0.0.1", port: 4174 },
    publicOrigin,
    allowedOrigins: new Set([publicOrigin]),
    authenticator,
    launcherAuthenticator: authenticator,
    credentialController: new CredentialController(store, authenticator, credentials),
    ...(options.shutdownManager ? { shutdownManager: options.shutdownManager } : {}),
  })
  return { app, serviceState }
}

async function inject(app, options, label) {
  return await withDeadline(app.inject(options), label)
}

async function closeApp(app) {
  await withDeadline(app.close(), "Fastify app.close")
}

async function run() {
  assert.equal(process.platform, "win32", "real DPAPI acceptance requires Windows")
  const root = await mkdtemp(path.join(tmpdir(), "omw-issue11-credential-api-"))
  const apps = new Set()
  const checks = []
  try {
    const dataDirectory = path.join(root, "credential-data")
    const store = new DpapiCredentialStore({ dataDirectory, dpapiTimeoutMs })
    await store.save(initial)
    checks.push("initial credentials saved through Windows current-user DPAPI")

    const first = createAcceptanceApp(initial, store)
    apps.add(first.app)
    const oldBefore = await inject(first.app, {
      method: "GET",
      url: "/api/v1/overview",
      headers: browserHeaders(initial),
    }, "initial auth probe")
    assert.equal(oldBefore.statusCode, 200)

    const launcherBefore = await inject(first.app, {
      method: "GET",
      url: "/api/v1/launcher/identity",
      headers: { host: "127.0.0.1:4174", "x-omw-launcher-token": initial.launcherToken },
    }, "initial launcher token probe")
    assert.equal(launcherBefore.statusCode, 200)

    const update = await inject(first.app, {
      method: "PATCH",
      url: "/api/v1/settings/credentials",
      headers: mutationHeaders(initial),
      payload: {
        currentPassword: initial.manager.password,
        username: rotated.manager.username,
        password: rotated.manager.password,
      },
    }, "credential rotation")
    assert.equal(update.statusCode, 204)

    const oldAfter = await inject(first.app, {
      method: "GET",
      url: "/api/v1/overview",
      headers: browserHeaders(initial),
    }, "old auth rejection after rotation")
    assert.equal(oldAfter.statusCode, 401)
    const newAfter = await inject(first.app, {
      method: "GET",
      url: "/api/v1/overview",
      headers: browserHeaders(rotated),
    }, "new auth acceptance after rotation")
    assert.equal(newAfter.statusCode, 200)
    const launcherAfter = await inject(first.app, {
      method: "GET",
      url: "/api/v1/launcher/identity",
      headers: { host: "127.0.0.1:4174", "x-omw-launcher-token": initial.launcherToken },
    }, "launcher token probe after rotation")
    assert.equal(launcherAfter.statusCode, 200)
    checks.push("rotation persisted before immediate old/new auth switch; launcher token remained valid")

    const ciphertext = await readFile(store.filename, "utf8")
    for (const plaintext of [
      initial.manager.password,
      rotated.manager.password,
      initial.launcherToken,
    ]) assert.equal(ciphertext.includes(plaintext), false, "DPAPI file contains fixture plaintext")
    checks.push("DPAPI file contains none of the fixture password/token plaintext")

    await closeApp(first.app)
    apps.delete(first.app)

    const restartedCredentials = await store.load()
    assert.deepEqual(restartedCredentials, rotated)
    const restarted = createAcceptanceApp(restartedCredentials, store)
    apps.add(restarted.app)
    const restartedNew = await inject(restarted.app, {
      method: "GET",
      url: "/api/v1/overview",
      headers: browserHeaders(rotated),
    }, "restarted new auth probe")
    assert.equal(restartedNew.statusCode, 200)
    const restartedOld = await inject(restarted.app, {
      method: "GET",
      url: "/api/v1/overview",
      headers: browserHeaders(initial),
    }, "restarted old auth rejection")
    assert.equal(restartedOld.statusCode, 401)
    const restartedLauncher = await inject(restarted.app, {
      method: "GET",
      url: "/api/v1/launcher/identity",
      headers: { host: "127.0.0.1:4174", "x-omw-launcher-token": initial.launcherToken },
    }, "restarted launcher token probe")
    assert.equal(restartedLauncher.statusCode, 200)
    assert.equal(restartedCredentials.launcherToken, initial.launcherToken)
    checks.push("fresh store load retained rotated browser auth and the original launcher token")

    const blockedDataDirectory = path.join(root, "blocked-data-directory")
    await writeFile(blockedDataDirectory, "fixture file blocks directory creation", "utf8")
    const failingStore = new DpapiCredentialStore({ dataDirectory: blockedDataDirectory, dpapiTimeoutMs })
    const failure = createAcceptanceApp(restartedCredentials, failingStore)
    apps.add(failure.app)
    const rejectedUpdate = await inject(failure.app, {
      method: "PATCH",
      url: "/api/v1/settings/credentials",
      headers: mutationHeaders(rotated),
      payload: {
        currentPassword: rotated.manager.password,
        username: "acceptance-rejected",
        password: "acceptance-rejected-password-2026",
      },
    }, "real DPAPI save failure")
    assert.equal(rejectedUpdate.statusCode, 500)
    const oldRetained = await inject(failure.app, {
      method: "GET",
      url: "/api/v1/overview",
      headers: browserHeaders(rotated),
    }, "retained auth after save failure")
    assert.equal(oldRetained.statusCode, 200)
    const rejectedAuth = await inject(failure.app, {
      method: "GET",
      url: "/api/v1/overview",
      headers: browserHeaders({
        manager: { username: "acceptance-rejected", password: "acceptance-rejected-password-2026" },
        launcherToken: initial.launcherToken,
      }),
    }, "rejected auth after save failure")
    assert.equal(rejectedAuth.statusCode, 401)
    assert.deepEqual(await store.load(), rotated)
    checks.push("real DPAPI Protect followed by isolated filesystem save failure kept old in-memory and persisted auth")
    await closeApp(failure.app)
    apps.delete(failure.app)

    let shutdownApiCalls = 0
    let shutdownClose
    const shutdownState = acceptanceService()
    const shutdownAuthenticator = new SeparateRequestAuthenticator(restartedCredentials)
    let shutdownApp
    shutdownApp = buildApp({
      service: shutdownState.service,
      authority: { hostname: "127.0.0.1", port: 4174 },
      publicOrigin,
      allowedOrigins: new Set([publicOrigin]),
      authenticator: shutdownAuthenticator,
      shutdownManager: () => {
        shutdownApiCalls++
        shutdownClose = shutdownApp.close()
      },
    })
    apps.add(shutdownApp)
    const shutdown = await inject(shutdownApp, {
      method: "POST",
      url: "/api/v1/manager/shutdown",
      headers: mutationHeaders(rotated),
      payload: {},
    }, "shutdown API")
    assert.equal(shutdown.statusCode, 202)
    assert.deepEqual(shutdown.json(), { stopping: true })
    await withDeadline(new Promise((resolve) => setImmediate(resolve)), "shutdown scheduling")
    assert.equal(shutdownApiCalls, 1)
    assert.ok(shutdownClose)
    await withDeadline(shutdownClose, "shutdown app close")
    assert.equal(shutdownState.shutdownCalls(), 1)
    apps.delete(shutdownApp)
    checks.push("shutdown API returned 202, scheduled once, and closed only the in-process Manager app")

    await closeApp(restarted.app)
    apps.delete(restarted.app)
    return {
      status: "passed",
      platform: process.platform,
      networkListenUsed: false,
      detachedProcessUsed: false,
      managerOrTuiStarted: false,
      dpapiTimeoutMs,
      operationTimeoutMs,
      checks,
    }
  } finally {
    const cleanupErrors = []
    for (const app of apps) {
      try {
        await closeApp(app)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    try {
      await rm(root, { recursive: true, force: true })
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "acceptance cleanup failed")
  }
}

run().then(
  (result) => console.log(JSON.stringify(result, null, 2)),
  (error) => {
    console.error(error instanceof Error ? error.stack : error)
    process.exitCode = 1
  },
)
