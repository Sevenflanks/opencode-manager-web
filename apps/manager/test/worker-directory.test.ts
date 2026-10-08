import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildExecutionApp } from "../src/worker/supervisor.js"
import { localDirectories, type DirectoryPort } from "../src/directory.js"
import { WorkerRuntime } from "../src/worker/runtime.js"
import { ManagerService } from "../src/service.js"
import { ManagerRepository } from "../src/repository.js"
import { buildApp } from "../src/app.js"
import { SeparateRequestAuthenticator } from "../src/auth.js"

test("execution directory HTTP resolves actual symlinks and classifies inaccessible paths behind control auth", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-execution-fs-"))
  const target = path.join(root, "home", "node", "project")
  await mkdir(target, { recursive: true })
  await mkdir(path.join(root, "workspace"))
  await symlink(target, path.join(root, "workspace", "link"), "junction")
  await mkdir(path.join(root, "workspace", "child"))
  await symlink(path.join(root, "workspace"), path.join(root, "workspace-root"), "junction")
  await writeFile(path.join(root, "file"), "not a directory")
  const token = "fixture-control-token-32-characters"
  const app = buildExecutionApp({ token, executable: process.execPath, runtimePort: 4096 }, localDirectories, path.join(root, "workspace-root"))
  const headers = { authorization: `Bearer ${token}` }
  const query = (operation: string, directory: string) => `/v1/directories/${operation}?directory=${encodeURIComponent(directory)}`
  try {
    const url = query("resolve", path.join(root, "workspace", "link"))
    assert.equal((await app.inject({ url })).statusCode, 401)
    assert.equal((await app.inject({ url, headers: { ...headers, origin: "http://evil.test" } })).statusCode, 403)
    const resolved = await app.inject({ url, headers })
    assert.equal(resolved.statusCode, 200, resolved.body)
    assert.deepEqual(resolved.json(), { directory: target })
    const listing = (await app.inject({ url: query("browse", path.join(root, "workspace")), headers })).json()
    assert.deepEqual(listing.children, [{ name: "child", path: path.join(root, "workspace", "child") }, { name: "link", path: target }])
    for (const input of [path.join(root, "workspace-root"), path.join(root, "workspace", "child")]) {
      const allowed = await app.inject({ url: query("resolve-start", input), headers })
      assert.equal(allowed.statusCode, 200, allowed.body)
      assert.equal(allowed.json().directory, await localDirectories.resolve(input), "workspace root itself is canonicalized")
    }
    const rejected = await app.inject({ url: query("resolve-start", path.join(root, "workspace", "link")), headers })
    assert.equal(rejected.statusCode, 400)
    assert.equal(rejected.json().error.code, "WORKER_DIRECTORY_OUTSIDE_WORKSPACE")
    for (const [name, reason] of [["missing", "NOT_FOUND"], ["file", "NOT_DIRECTORY"]]) {
      const response = await app.inject({ url: query("resolve", path.join(root, name!)), headers })
      assert.equal(response.statusCode, 400)
      assert.equal(response.json().error.code, "DIRECTORY_NOT_ACCESSIBLE")
      assert.equal(response.json().error.details.reason, reason)
    }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }) }
})

test("public Manager browse/shortcuts/start use execution filesystem namespace, never Manager paths", async () => {
  const disk = await mkdtemp(path.join(tmpdir(), "omw-separate-fs-"))
  const mount = `/execution-${path.basename(disk)}`
  const project = `${mount}/home/node/project`
  await mkdir(path.join(disk, "home/node/project"), { recursive: true })
  await mkdir(path.join(disk, "workspace"))
  await symlink(path.join(disk, "home/node/project"), path.join(disk, "workspace/link"), "junction")
  await writeFile(path.join(disk, "file"), "regular file")
  // Execution fixture 有自己的 mount namespace，實際 realpath/stat/readdir 與 symlink 都在 disk 上運作。
  // Manager 的同名絕對路徑不存在；移除 DirectoryPort 路由必定失敗，而非兩邊共用同一 directory mock。
  const physical = (input: string) => {
    assert.ok(input.startsWith(`${mount}/`))
    return path.join(disk, input.slice(mount.length))
  }
  const logical = (input: string) => `${mount}/${path.relative(disk, input).split(path.sep).join("/")}`.replace(/\/$/, "")
  const directories: DirectoryPort = {
    async resolve(input) { return logical(await localDirectories.resolve(physical(input))) },
    async browse(input) {
      const listing = await localDirectories.browse(physical(input))
      return { current: logical(listing.current), parent: listing.parent ? logical(listing.parent) : null,
        children: listing.children.map((child) => ({ ...child, path: logical(child.path) })),
        errors: listing.errors.map((error) => ({ ...error, path: logical(error.path) })) }
    },
  }
  const token = "fixture-control-token-32-characters"
  const execution = buildExecutionApp({ token, executable: process.execPath, runtimePort: 4096 }, directories, `${mount}/workspace`)
  const repository = new ManagerRepository(":memory:")
  const launches: string[] = []
  let activeDirectory: string | null = null
  const runtime = new WorkerRuntime({ controlOrigin: "http://execution:4175", token, nativeOrigin: "http://localhost:4180", fetch: async (url, init) => {
    const request = new URL(String(url))
    if (request.pathname.startsWith("/v1/directories/")) {
      const response = await execution.inject({ url: request.pathname + request.search, headers: Object.fromEntries(new Headers(init?.headers)) })
      return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } })
    }
    if (request.pathname === "/v1/execution") return Response.json({ epoch: "fixture-epoch", capacity: "available" })
    if (request.pathname === "/v1/start") {
      const body = JSON.parse(String(init?.body)); launches.push(body.directory)
      activeDirectory = body.directory
      return Response.json({ pid: 12, instanceId: body.instanceId, directory: body.directory, executable: "/bin/opencode", creationTimeUtc: new Date().toISOString(), creationTimeTicks: "fixture-epoch", endpoint: "http://localhost:4096" })
    }
    if (request.pathname === "/v1/inspect") return Response.json({ processState: activeDirectory ? "running" : "not-found", running: !!activeDirectory, matched: !!activeDirectory, portOwnerMatched: !!activeDirectory, portOwnedByOther: false, portAvailable: !activeDirectory })
    if (request.pathname === "/v1/stop") { activeDirectory = null; return Response.json({ stopped: true, reason: null }) }
    if (request.pathname.endsWith("/global/health")) return Response.json({ healthy: true, version: "fixture" })
    if (request.pathname.endsWith("/path")) return Response.json({ directory: activeDirectory })
    if (request.pathname.endsWith("/session")) return Response.json([{ id: "ses_primary", title: "Existing", directory: activeDirectory, time: { created: 1, updated: 2 } }])
    if (request.pathname.endsWith("/session/status")) return Response.json({})
    if (request.pathname.endsWith("/event")) return new Response(null, { status: 503 })
    assert.notEqual(init?.method, "POST", "directory work must not create session/prompt")
    return Response.json([])
  } })
  const service = new ManagerService(repository, runtime, { min: 4096, max: 4096 })
  const app = buildApp({ service, authority: { hostname: "127.0.0.1", port: 4174 }, allowedOrigins: new Set(["http://127.0.0.1:4174"]),
    worker: { nativeOrigin: "http://localhost:4180" }, authenticator: new SeparateRequestAuthenticator({ manager: { username: "fixture", password: "fixture-only-password" }, launcherToken: "unused" }) })
  const headers = { host: "127.0.0.1:4174", authorization: `Basic ${Buffer.from("fixture:fixture-only-password").toString("base64")}`, origin: "http://127.0.0.1:4174", "x-omw-csrf": "1" }
  try {
    await assert.rejects(localDirectories.resolve(project), { code: "DIRECTORY_NOT_ACCESSIBLE" })
    const browse = await app.inject({ url: `/api/v1/directories?path=${encodeURIComponent(`${mount}/workspace`)}`, headers })
    assert.equal(browse.statusCode, 200, browse.body)
    assert.deepEqual(browse.json().children, [{ name: "link", path: project }])
    const shortcut = await app.inject({ method: "POST", url: "/api/v1/shortcuts", headers, payload: { name: "Exec", directory: `${mount}/workspace/link` } })
    assert.equal(shortcut.statusCode, 201, shortcut.body)
    assert.equal(shortcut.json().directory, project)
    const updated = await app.inject({ method: "PATCH", url: `/api/v1/shortcuts/${shortcut.json().id}`, headers, payload: { name: "Home", directory: project } })
    assert.equal(updated.statusCode, 200, updated.body)
    assert.equal(updated.json().directory, project)
    for (const [name, reason] of [["missing", "NOT_FOUND"], ["file", "NOT_DIRECTORY"]]) {
      const response = await app.inject({ method: "POST", url: "/api/v1/instances", headers, payload: { directory: `${mount}/${name}` } })
      assert.equal(response.statusCode, 400, response.body)
      assert.equal(response.json().error.code, "DIRECTORY_NOT_ACCESSIBLE")
      assert.equal(response.json().error.details.reason, reason)
    }
    const started = await app.inject({ method: "POST", url: "/api/v1/instances", headers, payload: { directory: `${mount}/workspace/link` } })
    assert.equal(started.statusCode, 400, started.body)
    assert.equal(started.json().error.code, "WORKER_DIRECTORY_OUTSIDE_WORKSPACE")
    assert.deepEqual(launches, [])
    assert.deepEqual(repository.allocationScopes(), [], "Start rejects before allocation")
    await mkdir(path.join(disk, "workspace", "nested", "project"), { recursive: true })
    await mkdir(path.join(disk, "workspace-sibling"))
    await symlink(path.join(disk, "workspace", "nested", "project"), path.join(disk, "workspace", "inside-link"), "junction")
    for (const directory of [project, `${mount}/workspace-sibling`, `${mount}/workspace/../home/node/project`, `${mount}/workspace/link`]) {
      const response = await app.inject({ method: "POST", url: "/api/v1/instances", headers, payload: { directory } })
      assert.equal(response.statusCode, 400, response.body)
      assert.equal(response.json().error.code, "WORKER_DIRECTORY_OUTSIDE_WORKSPACE")
      await assert.rejects(runtime.launch(directory, 4096, "bypass", "fixture-epoch"), { code: "WORKER_DIRECTORY_OUTSIDE_WORKSPACE" })
    }
    assert.deepEqual(launches, [], "RuntimePort.launch cannot bypass the Start preflight")
    assert.deepEqual(repository.allocationScopes(), [])
    for (const [input, canonical] of [[`${mount}/workspace`, `${mount}/workspace`],
      [`${mount}/workspace/nested/project`, `${mount}/workspace/nested/project`],
      [`${mount}/workspace/inside-link`, `${mount}/workspace/nested/project`]]) {
      const allowed = await service.start(input!, false)
      assert.equal(allowed.projectDirectory, canonical)
      await service.selectPrimarySession(allowed.id, "ses_primary")
      await service.stop(allowed.id)
      const original = repository.getInstance(allowed.id)!
      original.projectDirectory = project
      repository.saveInstance(original)
      const before = repository.allocationScopes()
      const count: number = launches.length
      for (const state of ["stopped", "unreachable"] as const) {
        repository.saveInstance({ ...original, state })
        const resumed = await app.inject({ method: "POST", url: `/api/v1/instances/${allowed.id}/resume`, headers })
        assert.equal(resumed.statusCode, 400, resumed.body)
        assert.equal(resumed.json().error.code, "WORKER_DIRECTORY_OUTSIDE_WORKSPACE")
        assert.equal(launches.length, count, "Resume cannot launch historical outside paths")
        assert.deepEqual(repository.allocationScopes(), before)
      }
    }
    assert.deepEqual(launches, [`${mount}/workspace`, `${mount}/workspace/nested/project`, `${mount}/workspace/nested/project`])
  } finally { await app.close(); await service.shutdown(); repository.close(); await execution.close(); await rm(disk, { recursive: true, force: true }) }
})
