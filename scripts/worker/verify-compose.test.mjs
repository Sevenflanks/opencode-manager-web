import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { registerHooks } from "node:module"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

test("Compose CLI keeps opt-in context and file selection through build failure and watchdog cleanup", async (t) => {
  const repo = fileURLToPath(new URL("../..", import.meta.url))
  const base = path.join(repo, "deploy/worker/compose.yaml")
  const overlay = path.join(repo, "deploy/worker/compose.skills-build.yaml")
  const originalArgv = process.argv, originalExitCode = process.exitCode
  const originalContext = process.env.OMW_WORKER_SKILLS_CONTEXT
  const calls = [], writes = new Map()
  let setupCalls = 0, nextPort = 45000
  const runDirectory = path.join(os.tmpdir(), "omw-compose-cli-public-fixture")
  // 在外部效果邊界替換 I/O；真 CLI、dockerOwner 與 cleanup 跑到預期 build failure，沒有 Docker／秘密／檔案產物。
  globalThis.omwComposeFixture = {
    mkdtemp: async () => runDirectory,
    readFile: async () => "public-fixture-value",
    readdir: async () => [], rm: async () => {},
    writeFile: async (filename, value) => writes.set(filename, value),
    setup: async () => { setupCalls++; return { envFile: path.join(runDirectory, "worker.env"), tokenFile: "fixture-token", passwordFile: "fixture-password" } },
    net: { createServer: () => ({ once() {}, listen(_port, _host, callback) { callback() }, address: () => ({ port: nextPort++ }), close(callback) { callback() } }) },
    execFileSync: () => "public-fixture-git",
    spawn: (command, args, options) => {
      calls.push({ command, args, options })
      const child = new EventEmitter()
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
      child.kill = () => { queueMicrotask(() => child.emit("close", 0)); return true }
      child.unref = () => {}
      if (command === process.execPath) { queueMicrotask(() => child.emit("spawn")); return child }
      assert.equal(command, "docker")
      queueMicrotask(() => {
        let output = "", code = 0
        if (args[2] === "context") output = JSON.stringify([{ Endpoints: { docker: { Host: "unix:///public-fixture.sock" } } }])
        else if (args.includes("--short") || args[2] === "version") output = "public-fixture-version"
        else if (args.includes("config")) output = JSON.stringify({ services: {
          manager: { init: true, volumes: [], environment: { OMW_EXECUTION_ORIGIN: "http://execution:4175" } },
          execution: { init: true, volumes: [], command: ["node", "apps/manager/dist/src/worker/execution-server.js"] },
        } })
        else if (args.includes("build")) { output = "expected-public-build-failure"; code = 1 }
        else assert.ok(args.includes("down") || args.includes("ls"), "unexpected runtime command")
        child.stdout.emit("data", Buffer.from(output)); child.emit("close", code)
      })
      return child
    },
  }
  const modules = {
    "./setup.mjs": "export const setup=(...a)=>globalThis.omwComposeFixture.setup(...a)",
    "node:fs/promises": "export const {mkdtemp,readFile,readdir,rm,writeFile}=globalThis.omwComposeFixture",
    "node:net": "export default globalThis.omwComposeFixture.net",
    "node:child_process": "export const spawn=(...a)=>globalThis.omwComposeFixture.spawn(...a); export const execFileSync=(...a)=>globalThis.omwComposeFixture.execFileSync(...a)",
  }
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    const runner = /\/verify-compose\.mjs(?:\?|$)/.test(context.parentURL ?? "")
    const owner = /\/docker-owner\.mjs$/.test(context.parentURL ?? "")
    if ((runner || (owner && specifier === "node:child_process")) && modules[specifier]) return { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true }
    return nextResolve(specifier, context)
  } })
  t.mock.method(console, "log", () => {})
  t.mock.method(console, "error", () => {})
  try {
    process.env.OMW_WORKER_SKILLS_CONTEXT = "must-not-inherit-host-context"
    let iteration = 0
    const artifact = path.join(os.tmpdir(), "public artifact", "worker-skills")
    for (const skillsContext of [undefined, artifact, path.relative(process.cwd(), artifact)]) {
      calls.length = 0; writes.clear()
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-compose.mjs", import.meta.url)), "--context", "desktop-linux", ...(skillsContext ? ["--skills-context", skillsContext] : [])]
      await import(`./verify-compose.mjs?fixture=${iteration++}`)
      assert.equal(process.exitCode, 1, "build failure must remain a failure")
      const binding = JSON.parse(writes.get(path.join(runDirectory, "ownership.json")))
      const files = skillsContext ? [base, overlay] : [base]
      assert.deepEqual(binding.selectedComposeFiles, files)
      const resolvedContext = skillsContext ? path.resolve(skillsContext) : undefined
      assert.equal(binding.contextpathOnly, resolvedContext)
      const composeCalls = calls.filter(call => call.args[2] === "compose" && !call.args.includes("version"))
      assert.equal(composeCalls.length, 3)
      const prefix = ["--context", "desktop-linux", "compose", "--project-name", binding.project, "--project-directory", path.dirname(base), "--env-file", binding.envFile, ...files.flatMap(file => ["-f", file])]
      for (const [index, suffix] of [[0, ["config", "--format", "json"]], [1, ["build", "manager"]], [2, ["down", "--volumes", "--remove-orphans", "--timeout", "10"]]]) {
        assert.deepEqual(composeCalls[index].args, [...prefix, ...suffix])
        assert.equal(composeCalls[index].options.env.OMW_WORKER_SKILLS_CONTEXT, resolvedContext)
        assert.equal(composeCalls[index].options.env.OMW_BROWSER_PASSWORD, undefined)
      }
      assert.equal(JSON.parse(writes.get(path.join(runDirectory, "evidence.json"))).cleanup.status, "stopped")
      // 反序列化模擬 watchdog：原 caller 不提供新增欄位時仍用單一 composeFile。
      const { dockerOwner } = await import("./docker-owner.mjs")
      await dockerOwner(JSON.parse(JSON.stringify(binding))).compose(["down"])
      assert.deepEqual(calls.at(-1).args, [...prefix, "down"])
      const { selectedComposeFiles, contextpathOnly, ...legacy } = binding
      await dockerOwner(legacy).compose(["config", "--format", "json"])
      assert.equal(calls.at(-1).args.filter(value => value === "-f").length, 1)
      assert.equal(calls.at(-1).options.env.OMW_WORKER_SKILLS_CONTEXT, undefined)
    }
    const before = setupCalls
    for (const tail of [["--skills-context"], ["--skills-context", "--browser"], ["--skills-context", ""]]) {
      process.argv = [process.execPath, "verify-compose.mjs", "--context", "desktop-linux", ...tail]
      await assert.rejects(import(`./verify-compose.mjs?fixture=${iteration++}`), /--skills-context 必須指定/)
    }
    assert.equal(setupCalls, before, "invalid CLI must fail before setup")
  } finally {
    hooks.deregister(); delete globalThis.omwComposeFixture
    process.argv = originalArgv; process.exitCode = originalExitCode
    if (originalContext === undefined) delete process.env.OMW_WORKER_SKILLS_CONTEXT
    else process.env.OMW_WORKER_SKILLS_CONTEXT = originalContext
  }
})
