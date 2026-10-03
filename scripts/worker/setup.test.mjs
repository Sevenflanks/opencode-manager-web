import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { promisify } from "node:util"
import { setup } from "./setup.mjs"
import { dockerOwner } from "./docker-owner.mjs"

test("setup uses fresh external secrets, validates ports, never overwrites an existing directory", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "omw-worker-setup-test-"))
  try {
    const target = path.join(parent, "config")
    const result = await setup(target, { managerPort: 45671, nativePort: 45672 })
    const token = (await readFile(result.tokenFile, "utf8")).trim()
    const password = (await readFile(result.passwordFile, "utf8")).trim()
    assert.equal(token.length, 64); assert.equal(password.length, 43); assert.notEqual(token, password)
    const env = await readFile(result.envFile, "utf8")
    assert.ok(!env.includes(token) && !env.includes(password))
    assert.match(env, /OMW_PUBLIC_ORIGIN=http:\/\/127\.0\.0\.1:45671/)
    await assert.rejects(setup(target), /EEXIST/)
    assert.equal((await readFile(result.tokenFile, "utf8")).trim(), token)
    await assert.rejects(setup(path.join(parent, "same-port"), { managerPort: 45671, nativePort: 45671 }), /必須不同/)
    await assert.rejects(setup(fileURLToPath(new URL("../../deploy/worker/no-secrets", import.meta.url))), /repo 外/)
  } finally { await rm(parent, { recursive: true, force: true }) }
})

test("Docker owner rejects a non-current-run project or image before starting commands", () => {
  assert.throws(() => dockerOwner({ context: "desktop-linux", project: "operator-project", image: "operator-image" }), /ownership binding/)
  assert.throws(() => dockerOwner({ context: "desktop-linux", project: "omw-verify-0123456789abcdef", image: "other:verification" }), /ownership binding/)
})

test("Linux build metadata patch is limited to launcher os and preserves pinned dependencies", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "omw-worker-build-test-"))
  try {
    await mkdir(path.join(parent, "packages/launcher"), { recursive: true })
    const manifest = { name: "@sevenflanks/omw", version: "0.6.1", os: ["win32"], dependencies: { example: "1.2.3" } }
    const lock = { lockfileVersion: 3, packages: { "packages/launcher": { ...manifest }, "node_modules/example": { version: "1.2.3", integrity: "unchanged" } } }
    await writeFile(path.join(parent, "packages/launcher/package.json"), JSON.stringify(manifest))
    await writeFile(path.join(parent, "package-lock.json"), JSON.stringify(lock))
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./prepare-build.mjs", import.meta.url))], { cwd: parent, timeout: 5000 })
    delete manifest.os; delete lock.packages["packages/launcher"].os
    assert.deepEqual(JSON.parse(await readFile(path.join(parent, "packages/launcher/package.json"), "utf8")), manifest)
    assert.deepEqual(JSON.parse(await readFile(path.join(parent, "package-lock.json"), "utf8")), lock)
  } finally { await rm(parent, { recursive: true, force: true }) }
})
