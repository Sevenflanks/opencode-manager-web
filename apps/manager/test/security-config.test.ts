import assert from "node:assert/strict"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import test from "node:test"
import { SeparateRequestAuthenticator, type StoredCredentials } from "../src/auth.js"
import { readInstancePortPoolConfig, readRemoteAccessConfig } from "../src/config.js"
import { DpapiCredentialStore } from "../src/credential-store.js"

const credentials: StoredCredentials = {
  manager: { username: "omw-user", password: "manager-fake-password" },
  launcherToken: "temporary-launcher-token-with-enough-entropy-shape",
}

test("remote config accepts only explicit fixed same-port mappings", () => {
  const config = readRemoteAccessConfig({
    OMW_REMOTE_ACCESS: "1",
    OMW_EXPECTED_LOOPBACK_ORIGIN: "http://127.0.0.1:4174",
    OMW_TAILNET_DNS_HOST: "device.example.ts.net",
    OMW_MANAGER_PUBLIC_HTTPS_PORT: "8443",
    OMW_INSTANCE_PUBLIC_PORT_MIN: "42000",
    OMW_INSTANCE_PUBLIC_PORT_MAX: "42009",
    OMW_REMOTE_MAPPING_READY: "1",
  }, 4174)
  assert.ok(config)
  assert.equal(config.publicManagerOrigin, "https://device.example.ts.net:8443")
  assert.equal(config.instanceOrigin(42004), "https://device.example.ts.net:42004")
  assert.throws(() => config.instanceOrigin(43000), /fixed mapping range/)
})

test("remote config fails closed for an unconfirmed mapping or wrong loopback entry", () => {
  const base = {
    OMW_REMOTE_ACCESS: "1",
    OMW_EXPECTED_LOOPBACK_ORIGIN: "http://127.0.0.1:4174",
    OMW_TAILNET_DNS_HOST: "device.example.ts.net",
    OMW_MANAGER_PUBLIC_HTTPS_PORT: "8443",
    OMW_INSTANCE_PUBLIC_PORT_MIN: "42000",
    OMW_INSTANCE_PUBLIC_PORT_MAX: "42009",
  }
  assert.throws(() => readRemoteAccessConfig(base, 4174), /MAPPING_READY/)
  assert.throws(() => readRemoteAccessConfig({ ...base, OMW_REMOTE_MAPPING_READY: "1", OMW_EXPECTED_LOOPBACK_ORIGIN: "http://localhost:4174" }, 4174), /127\.0\.0\.1/)
  assert.throws(() => readRemoteAccessConfig({ ...base, OMW_REMOTE_MAPPING_READY: "1", OMW_TAILNET_DNS_HOST: "https://device.example.ts.net" }, 4174), /tailnet DNS host/)
})

test("instance pool is fixed, paired, bounded, and identical to remote public ports", () => {
  assert.deepEqual(readInstancePortPoolConfig({}, null), { min: 42_000, max: 42_099 })
  assert.deepEqual(readInstancePortPoolConfig({
    OMW_INSTANCE_PORT_MIN: "43000",
    OMW_INSTANCE_PORT_MAX: "43009",
  }, null), { min: 43_000, max: 43_009 })
  assert.throws(() => readInstancePortPoolConfig({ OMW_INSTANCE_PORT_MIN: "43000" }, null), /一起設定/)
  assert.throws(() => readInstancePortPoolConfig({
    OMW_INSTANCE_PORT_MIN: "43000",
    OMW_INSTANCE_PORT_MAX: "43128",
  }, null), /128/)

  const remote = readRemoteAccessConfig({
    OMW_REMOTE_ACCESS: "1",
    OMW_EXPECTED_LOOPBACK_ORIGIN: "http://127.0.0.1:4174",
    OMW_TAILNET_DNS_HOST: "device.example.ts.net",
    OMW_MANAGER_PUBLIC_HTTPS_PORT: "8443",
    OMW_INSTANCE_PUBLIC_PORT_MIN: "44000",
    OMW_INSTANCE_PUBLIC_PORT_MAX: "44009",
    OMW_REMOTE_MAPPING_READY: "1",
  }, 4174)
  assert.deepEqual(readInstancePortPoolConfig({}, remote), { min: 44_000, max: 44_009 })
})

test("launcher token and browser Basic auth are separate audiences", () => {
  const authenticator = new SeparateRequestAuthenticator(credentials)
  const browserHeader = `Basic ${Buffer.from(`${credentials.manager.username}:${credentials.manager.password}`).toString("base64")}`
  assert.equal(authenticator.authorize({ authorization: browserHeader }, "browser"), true)
  assert.equal(authenticator.authorize({ "x-omw-launcher-token": credentials.launcherToken }, "browser"), false)
  assert.equal(authenticator.authorize({ authorization: browserHeader }, "launcher"), false)
  assert.equal(authenticator.authorize({ "x-omw-launcher-token": credentials.launcherToken }, "launcher"), true)
  assert.equal(authenticator.authorize({ "x-omw-launcher-token": "wrong-launcher-token" }, "launcher"), false)
})

test("DPAPI store atomically replaces and round-trips only temporary fake credentials", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-dpapi-test-"))
  const store = new DpapiCredentialStore({ dataDirectory: root })
  try {
    await store.save(credentials)
    const ciphertext = await readFile(store.filename, "utf8")
    assert.doesNotMatch(ciphertext, /manager-fake-password|temporary-launcher-token/)
    assert.deepEqual(await store.load(), credentials)
    const rotated = {
      ...credentials,
      manager: { ...credentials.manager, password: "rotated-manager-fake-password" },
    }
    await store.save(rotated)
    assert.deepEqual(await store.load(), rotated)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("DPAPI store accepts a legacy OpenCode field without rotating the ciphertext", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-dpapi-legacy-test-"))
  const legacy = {
    ...credentials,
    openCode: { username: "legacy-opencode", password: "legacy-opencode-password" },
  }
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  Object.assign(child, { stdin, stdout, stderr, kill: () => true })
  const store = new DpapiCredentialStore({
    dataDirectory: root,
    powershell: "fixture-pwsh",
    spawnDpapi: () => {
      queueMicrotask(() => {
        stdout.end(JSON.stringify(legacy))
        child.emit("close", 0, null)
      })
      return child
    },
  })
  try {
    await writeFile(store.filename, "legacy-ciphertext", "utf8")
    assert.deepEqual(await store.load(), credentials)
    assert.equal(await readFile(store.filename, "utf8"), "legacy-ciphertext")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("DPAPI store rejects a helper that never closes within a bounded deadline", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-dpapi-deadline-test-"))
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let kills = 0
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    kill: () => { kills++; return true },
  })
  const store = new DpapiCredentialStore({
    dataDirectory: root,
    powershell: "fixture-pwsh",
    dpapiTimeoutMs: 30,
    spawnDpapi: () => child,
  })
  try {
    await writeFile(store.filename, "fixture-ciphertext", "utf8")
    stderr.write("fixture-password-must-not-appear")
    const startedAt = Date.now()
    const error = await store.load().catch((cause: unknown) => cause)
    assert.ok(error instanceof Error)
    assert.match(error.message, /DPAPI helper.*deadline/)
    assert.doesNotMatch(error.message, /fixture-password/)
    const elapsedMs = Date.now() - startedAt
    assert.ok(elapsedMs >= 20, "a never-closing helper should settle through the deadline")
    assert.ok(elapsedMs < 500, "helper deadline should reject promptly")
    assert.equal(kills, 1)
    assert.equal(child.listenerCount("error"), 0)
    assert.equal(child.listenerCount("close"), 0)
    assert.equal(stdout.listenerCount("data"), 0)
    assert.equal(stderr.listenerCount("data"), 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
