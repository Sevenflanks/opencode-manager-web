import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { SeparateRequestAuthenticator, type StoredCredentials } from "../src/auth.js"
import { readInstancePortPoolConfig, readRemoteAccessConfig } from "../src/config.js"
import { DpapiCredentialStore } from "../src/credential-store.js"

const credentials: StoredCredentials = {
  manager: { username: "omw-user", password: "manager-fake-password" },
  openCode: { username: "opencode-user", password: "opencode-fake-password" },
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
})

test("DPAPI store atomically replaces and round-trips only temporary fake credentials", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-dpapi-test-"))
  const store = new DpapiCredentialStore({ dataDirectory: root })
  try {
    await store.save(credentials)
    const ciphertext = await readFile(store.filename, "utf8")
    assert.doesNotMatch(ciphertext, /manager-fake-password|opencode-fake-password|temporary-launcher-token/)
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
