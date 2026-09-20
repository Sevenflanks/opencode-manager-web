import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { access, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { isolatedPorts, isolationPaths, prepareIsolatedEnvironment } from "../src/isolation.js"

const execFileAsync = promisify(execFile)

test("test isolation uses fresh owned paths without mutating or leaking the source environment", async () => {
  const root = path.join(tmpdir(), `omw-isolation-contract-${randomUUID()}`)
  const source = {
    Path: "C:\\fixture\\bin",
    SYSTEMROOT: "C:\\Windows",
    OMW_OPENCODE_EXECUTABLE: "C:\\fixture\\opencode.exe",
    OMW_DATA_DIR: "C:\\daily\\omw",
    OPENCODE_DB: "C:\\daily\\opencode.sqlite",
    OPENAI_API_KEY: "daily-secret",
    OMW_MANAGER_ORIGIN: "http://127.0.0.1:4174",
    OMW_PORT: "4174",
    OMW_INSTANCE_PORT_MIN: "4200",
    OMW_INSTANCE_PORT_MAX: "4299",
    NODE_OPTIONS: "--require=C:\\daily\\inject.js",
    NODE_EXTRA_CA_CERTS: "C:\\trusted\\enterprise-ca.pem",
  }
  const original = { ...source }
  const context = await prepareIsolatedEnvironment({ mode: "test", root, sourceEnvironment: source, ownedRoot: true })

  try {
    assert.deepEqual(source, original)
    assert.equal(context.persistent, false)
    assert.equal(context.ownedRoot, true)
    assert.equal(context.environment.PATH, source.Path)
    assert.equal(context.environment.OMW_OPENCODE_EXECUTABLE, source.OMW_OPENCODE_EXECUTABLE)
    assert.equal(context.environment.OPENAI_API_KEY, undefined)
    assert.equal(context.environment.OMW_MANAGER_ORIGIN, undefined)
    assert.equal(context.environment.NODE_OPTIONS, undefined)
    assert.equal(context.environment.NODE_EXTRA_CA_CERTS, source.NODE_EXTRA_CA_CERTS)
    assert.notEqual(context.environment.OMW_PORT, source.OMW_PORT)
    assert.notEqual(context.environment.OMW_INSTANCE_PORT_MIN, source.OMW_INSTANCE_PORT_MIN)
    assert.notEqual(context.environment.OMW_INSTANCE_PORT_MAX, source.OMW_INSTANCE_PORT_MAX)
    assert.equal(context.environment.OMW_DATA_DIR, context.paths.omwData)
    assert.equal(context.environment.OPENCODE_DB, context.paths.openCodeDatabase)
    assert.equal(context.environment.TEMP, context.paths.temporary)
    assert.equal(context.environment.TMP, context.paths.temporary)
    assert.equal(context.environment.OPENCODE_TEST_MANAGED_CONFIG_DIR, context.paths.managedConfigDirectory)
    assert.notEqual(context.environment.OMW_DATA_DIR, source.OMW_DATA_DIR)
    assert.notEqual(context.environment.OPENCODE_DB, source.OPENCODE_DB)
    assert.match(await readFile(context.paths.configFile, "utf8"), /"plugin": \[\]/)
  } finally {
    await context.dispose()
  }
  await assert.rejects(access(root))
})

test("development isolation is stable per worktree and preserves its owned data", async () => {
  const root = path.join(tmpdir(), `omw-isolation-dev-${randomUUID()}`)
  const first = await prepareIsolatedEnvironment({ mode: "development", root, sourceEnvironment: {} })
  const expectedPorts = isolatedPorts(root)
  const marker = path.join(first.paths.omwData, "persistent-marker")
  await writeFile(marker, "keep", "utf8")
  await first.dispose()
  const second = await prepareIsolatedEnvironment({ mode: "development", root, sourceEnvironment: {} })

  try {
    assert.equal(second.persistent, true)
    assert.equal(second.ownedRoot, false)
    assert.equal(await readFile(marker, "utf8"), "keep")
    assert.equal(first.environment.OMW_PORT, String(expectedPorts.manager))
    assert.equal(second.environment.OMW_PORT, first.environment.OMW_PORT)
    assert.equal(second.environment.OMW_INSTANCE_PORT_MIN, first.environment.OMW_INSTANCE_PORT_MIN)
    assert.equal(second.environment.OMW_INSTANCE_PORT_MAX, first.environment.OMW_INSTANCE_PORT_MAX)
    assert.equal(second.environment.OPENCODE_TEST_MANAGED_CONFIG_DIR, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("disposal leaves caller-owned test roots intact", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-isolation-caller-owned-"))
  const marker = path.join(root, "caller-owned.txt")

  try {
    await writeFile(marker, "keep", "utf8")
    const context = await prepareIsolatedEnvironment({ mode: "test", root, sourceEnvironment: {} })

    assert.equal(context.ownedRoot, false)
    await context.dispose()
    assert.equal(await readFile(marker, "utf8"), "keep")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("context reports the effective private custom config path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-isolation-custom-config-"))
  const configFile = path.join(root, "fixtures", "opencode.json")

  try {
    await mkdir(path.dirname(configFile), { recursive: true })
    await writeFile(configFile, "{\"plugin\":[]}\n", "utf8")
    const context = await prepareIsolatedEnvironment({ mode: "test", root, configFile, sourceEnvironment: {} })

    assert.equal(context.paths.configFile, configFile)
    assert.equal(context.environment.OPENCODE_CONFIG, configFile)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("isolation rejects existing root and mutable-directory junction aliases", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "omw-isolation-alias-"))
  const dailySubstitute = path.join(base, "daily-substitute")
  const rootAlias = path.join(base, "root-alias")
  const childRoot = path.join(base, "child-root")
  const childAlias = path.join(childRoot, "omw")
  const linkType = process.platform === "win32" ? "junction" : "dir"
  await mkdir(dailySubstitute)
  await writeFile(path.join(dailySubstitute, "daily-marker"), "unchanged", "utf8")

  try {
    await symlink(dailySubstitute, rootAlias, linkType)
    await assert.rejects(
      prepareIsolatedEnvironment({ mode: "test", root: rootAlias, sourceEnvironment: {} }),
      /symlink, junction, or canonical alias/,
    )
    await unlink(rootAlias)

    await mkdir(childRoot)
    await symlink(dailySubstitute, childAlias, linkType)
    await assert.rejects(
      prepareIsolatedEnvironment({ mode: "test", root: childRoot, sourceEnvironment: {} }),
      /symlink, junction, or canonical alias/,
    )
    assert.deepEqual(await readdir(dailySubstitute), ["daily-marker"])
    assert.equal(await readFile(path.join(dailySubstitute, "daily-marker"), "utf8"), "unchanged")
    await unlink(childAlias)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("isolation rejects hard-linked mutable config, credential, and database files", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "omw-isolation-hardlink-"))
  const cases = [
    ["config", (root: string) => isolationPaths(root).configFile],
    ["credential", (root: string) => path.join(isolationPaths(root).omwData, "credentials.dpapi")],
    ["database", (root: string) => isolationPaths(root).openCodeDatabase],
  ] as const

  try {
    for (const [name, targetFor] of cases) {
      const root = path.join(base, name)
      const source = path.join(base, `${name}-daily-substitute`)
      const target = targetFor(root)
      await writeFile(source, `${name}-unchanged`, "utf8")
      await mkdir(path.dirname(target), { recursive: true })
      await link(source, target)

      await assert.rejects(
        prepareIsolatedEnvironment({ mode: "test", root, sourceEnvironment: {} }),
        /mutable file cannot have multiple hard links/,
      )
      assert.equal(await readFile(source, "utf8"), `${name}-unchanged`)
    }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("shared config is snapshotted before child writes and never exposed as the mutable target", async () => {
  const base = path.join(tmpdir(), `omw-isolation-shared-${randomUUID()}`)
  const sharedDirectory = path.join(base, "shared")
  const sharedAlias = path.join(base, "shared-alias")
  const shared = path.join(sharedDirectory, "opencode.json")
  const sharedHardLink = path.join(sharedDirectory, "opencode-hardlink.json")
  const aliasedShared = path.join(sharedAlias, "opencode-hardlink.json")
  const root = path.join(base, "isolated")
  await mkdir(path.dirname(shared), { recursive: true })
  await writeFile(shared, "{\"plugin\":[\"explicit-fixture\"]}\n", "utf8")
  await link(shared, sharedHardLink)
  await symlink(sharedDirectory, sharedAlias, process.platform === "win32" ? "junction" : "dir")
  const before = await readFile(shared, "utf8")
  const beforeHash = createHash("sha256").update(before).digest("hex")
  const context = await prepareIsolatedEnvironment({ mode: "development", root, sourceEnvironment: {}, sharedConfigFile: aliasedShared })

  try {
    assert.equal(context.environment.OPENCODE_CONFIG, context.paths.configFile)
    assert.notEqual(context.environment.OPENCODE_CONFIG, shared)
    assert.equal(context.environment.OPENCODE_CONFIG_DIR, context.paths.configDirectory)
    assert.equal(await readFile(context.paths.configFile, "utf8"), before)

    await execFileAsync(
      process.execPath,
      ["-e", "require('node:fs').writeFileSync(process.env.OPENCODE_CONFIG, '{\\\"plugin\\\":[]}\\n')"],
      { env: context.environment },
    )
    assert.equal(await readFile(context.paths.configFile, "utf8"), "{\"plugin\":[]}\n")
    assert.equal(await readFile(shared, "utf8"), before)
    assert.equal(createHash("sha256").update(await readFile(shared)).digest("hex"), beforeHash)

    const restarted = await prepareIsolatedEnvironment({ mode: "development", root, sourceEnvironment: {}, sharedConfigFile: aliasedShared })
    assert.equal(restarted.environment.OPENCODE_CONFIG, restarted.paths.configFile)
    assert.equal(await readFile(restarted.paths.configFile, "utf8"), before)
    await assert.rejects(
      prepareIsolatedEnvironment({ mode: "test", root: path.join(base, "external-config-test"), sourceEnvironment: {}, configFile: shared }),
      /must stay inside the isolation root/,
    )
    await assert.rejects(
      prepareIsolatedEnvironment({ mode: "test", root: path.join(base, "test"), sourceEnvironment: {}, sharedConfigFile: shared }),
      /development opt-in/,
    )
  } finally {
    await unlink(sharedAlias)
    await rm(base, { recursive: true, force: true })
  }
})
