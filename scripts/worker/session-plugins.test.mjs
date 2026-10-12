import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"
import { assertSessionPlugins, assertAutoPermissionsReviewer } from "./verify-skills-profile.mjs"
import { initializeWorker } from "./bootstrap.mjs"

const root = fileURLToPath(new URL("../../deploy/worker/session-plugins/", import.meta.url))
const dist = path.join(root, "dist")
const goalTools = ["clear_goal", "create_goal", "get_goal", "get_goal_history", "list_all_goals", "replace_goal",
  "set_goal", "stop_goal", "update_goal", "update_goal_objective", "update_goal_plan", "update_goal_status"]

// 對真 bundle／upstream hooks 測試；只把 native SDK 的外部 IO 換成 memory-only boundary。
async function fixture(run) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "omw-session-plugins-"))
  const home = path.join(scratch, "home")
  const project = path.join(scratch, "project")
  const variables = {
    HOME: home, USERPROFILE: home, XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"), XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"), OPENCODE_CONFIG_DIR: path.join(home, ".config/omw-profile"),
    OPENCODE_GOAL_STATE_PATH: undefined, OPENCODE_COMMAND_INJECT_CONFIG: undefined,
  }
  const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]))
  const timers = new Set()
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout
  const hooks = []
  const prompts = [], logs = []
  let children = []
  try {
    await mkdir(home, { recursive: true }); await mkdir(project)
    for (const [key, value] of Object.entries(variables)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    assert.equal(os.homedir(), home, "fixture must not scan host HOME")
    globalThis.setTimeout = (callback, milliseconds, ...args) => {
      const timer = originalSet(() => { timers.delete(timer); callback(...args) }, milliseconds)
      timers.add(timer)
      return timer
    }
    globalThis.clearTimeout = timer => { timers.delete(timer); originalClear(timer) }
    const client = {
      global: { health: async () => ({ data: { healthy: true, version: "1.18.34" } }) },
      session: {
        messages: async input => { assert.ok(input.path.id); assert.deepEqual(input.query, { limit: 20 }); return { data: [] } },
        children: async input => { assert.ok(input.path.id); return { data: children } },
        status: async () => ({ data: Object.fromEntries(children.map(child => [child.id, { type: "busy" }])) }),
        promptAsync: async input => { prompts.push(structuredClone(input)); return { data: undefined } },
      },
      app: { log: async input => { logs.push(input.body) }, agents: async () => ({ data: [] }), skills: async () => ({ data: [] }) },
    }
    const context = { client, directory: project, worktree: project,
      project: { id: "fixture-project", worktree: project, vcs: "git", time: { created: 1, updated: 1 } },
      serverUrl: new URL("http://127.0.0.1:1"),
      experimental_workspace: { register: () => assert.fail("unexpected workspace registration") },
      $: () => assert.fail("plugin must not execute shell commands"),
    }
    const load = async entry => {
      // Relocation away from all node_modules proves the artifact has no missing npm runtime import.
      const location = path.join(scratch, `${entry}.mjs`)
      await cp(path.join(dist, `${entry}.mjs`), location)
      const module = await import(pathToFileURL(location).href)
      assert.deepEqual(Object.keys(module), ["default"])
      assert.equal(typeof module.default, "function")
      const loaded = await module.default(context)
      hooks.push(loaded)
      return loaded
    }
    const loadAutoPermissions = async options => {
      const module = await import(new URL("../../deploy/worker/auto-permissions/dist/dist/v1-server.js", import.meta.url))
      const loaded = await module.default.server(context, options)
      hooks.push(loaded)
      return loaded
    }
    const toolContext = (sessionID, agent = "astra") => ({ sessionID, agent, messageID: "fixture-message",
      callID: "fixture-call", directory: project, worktree: project, abort: new AbortController().signal,
      metadata: () => {}, ask: () => assert.fail("unexpected permission IO") })
    await run({ load, loadAutoPermissions, project, home, prompts, logs, timers, toolContext,
      setChildren: value => { children = value }, stateFile: path.join(home, ".local/share/opencode-goal-plugin/goals.json") })
  } finally {
    try {
      for (const hook of hooks) await hook.dispose?.()
      assert.equal(timers.size, 0, "upstream dispose must clear every owned continuation timer")
    } finally {
      for (const timer of timers) originalClear(timer)
      globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(scratch, { recursive: true, force: true })
    }
  }
}
const call = async (hooks, tool, args, context) => JSON.parse(await hooks.tool[tool].execute(args, context))
const idle = (hooks, sessionID) => hooks.event({ event: { type: "session.idle", properties: { sessionID } } })

test("完整 artifact inventory hashes 與 relocatable default-only entries，無外部 npm runtime deps", { timeout: 30000 }, async () => {
  const artifact = JSON.parse(await readFile(path.join(dist, "artifact.json"), "utf8"))
  for (const [file, hash] of Object.entries(artifact.files)) {
    assert.equal(createHash("sha256").update(await readFile(path.join(dist, file))).digest("hex"), hash, file)
  }
  assert.ok(artifact.files["sources/node_modules/@prevalentware/opencode-goal-plugin/LICENSE"])
  assert.ok(artifact.files["sources/node_modules/opencode-command-inject/src/plugin.ts"])
  await fixture(async ({ load }) => { await load("goal"); await load("command-inject") })
})

test("相同 Session ID 在兩個 fresh Worker HOME 不共享 Goal state／history", { timeout: 8000 }, async () => {
  let firstPath
  await fixture(async ({ load, toolContext, stateFile }) => {
    const hooks = await load("goal"), ctx = toolContext("fixture-identical-session")
    await call(hooks, "create_goal", { objective: "第一個 Worker 私有目標" }, ctx)
    assert.equal((await call(hooks, "get_goal", {}, ctx)).goal.objective, "第一個 Worker 私有目標")
    firstPath = stateFile
  })
  await fixture(async ({ load, toolContext, stateFile }) => {
    const hooks = await load("goal"), ctx = toolContext("fixture-identical-session")
    assert.notEqual(stateFile, firstPath)
    assert.equal((await call(hooks, "get_goal", {}, ctx)).goal, null)
    assert.deepEqual((await call(hooks, "get_goal_history", {}, ctx)).previous_goals, [])
  })
})

test("普通訊息不建立 goal；明確 create／pause／clear 持久化，未 active idle 不續行", { timeout: 8000 }, async () => {
  await fixture(async ({ load, toolContext, stateFile, prompts }) => {
    const hooks = await load("goal"), ctx = toolContext("fixture-explicit")
    assert.deepEqual(Object.keys(hooks.tool).sort(), goalTools)
    await hooks["chat.message"]({ sessionID: ctx.sessionID, agent: "astra" }, { message: { sessionID: ctx.sessionID, agent: "astra" }, parts: [{ type: "text", text: "請分析目前程式" }] })
    await idle(hooks, ctx.sessionID)
    assert.equal((await call(hooks, "get_goal", {}, ctx)).goal, null)
    assert.equal(prompts.length, 0)
    const system = { system: ["Fixture base instructions"] }
    await hooks["experimental.chat.system.transform"]({ sessionID: ctx.sessionID }, system)
    assert.match(system.system[0], /Fixture base instructions/)
    assert.match(system.system[0], /[Ee]xplicit/)
    assert.match(system.system[0], /get_goal/)
    assert.match(hooks.tool.create_goal.description, /explicitly requested/)
    assert.equal((await call(hooks, "create_goal", { objective: "明確測試目標" }, ctx)).goal.status, "active")
    assert.equal((await call(hooks, "update_goal_status", { status: "paused" }, ctx)).goal.status, "paused")
    await idle(hooks, ctx.sessionID)
    assert.equal(prompts.length, 0)
    assert.match(await readFile(stateFile, "utf8"), /明確測試目標/)
    assert.equal((await call(hooks, "clear_goal", {}, ctx)).cleared, true)
    assert.equal((await call(hooks, "get_goal", {}, ctx)).goal, null)
    assert.equal((await call(hooks, "get_goal_history", {}, ctx)).previous_goals.length, 1)
    await idle(hooks, ctx.sessionID)
    assert.equal(prompts.length, 0)
  })
})

test("Plan create 預設 paused，拒絕 resume；Build active idle 只送 mock prompt 並保留 agent／objective", { timeout: 8000 }, async () => {
  await fixture(async ({ load, toolContext, prompts, logs }) => {
    const hooks = await load("goal"), plan = toolContext("fixture-plan", "plan")
    assert.equal((await call(hooks, "create_goal", { objective: "只規劃的目標" }, plan)).goal.status, "paused")
    await assert.rejects(hooks.tool.update_goal_status.execute({ status: "active" }, plan), /[Pp]lan/)
    await idle(hooks, plan.sessionID)
    assert.equal(prompts.length, 0)
    const active = toolContext("fixture-active", "astra")
    await call(hooks, "create_goal", { objective: "可觀察的續行目標" }, active)
    await idle(hooks, active.sessionID)
    assert.equal(prompts.length, 1)
    assert.deepEqual(prompts[0].path, { id: active.sessionID })
    assert.equal(prompts[0].body.agent, "astra")
    assert.equal(prompts[0].body.parts[0].type, "text")
    assert.match(prompts[0].body.parts[0].text, /可觀察的續行目標/)
    assert.equal(logs.length, 0)
    await call(hooks, "update_goal_status", { status: "paused" }, active)
    await idle(hooks, active.sessionID)
    assert.equal(prompts.length, 1)
  })
})

test("active child defers idle；dispose 清除真 upstream timer 並停止後續 prompt", { timeout: 8000 }, async () => {
  await fixture(async ({ load, toolContext, setChildren, prompts, timers }) => {
    const hooks = await load("goal"), ctx = toolContext("fixture-parent")
    await call(hooks, "create_goal", { objective: "等待 child reconciliation" }, ctx)
    setChildren([{ id: "fixture-child", parentID: ctx.sessionID, directory: ctx.directory,
      projectID: "fixture-project", version: "1.18.34", title: "fixture", time: { created: 1, updated: 1 } }])
    await idle(hooks, ctx.sessionID)
    assert.equal(prompts.length, 0)
    assert.equal(timers.size, 1, "real Task deferral must schedule a bounded recheck")
    await hooks.dispose()
    assert.equal(timers.size, 0)
    setChildren([])
    await idle(hooks, ctx.sessionID)
    assert.equal(prompts.length, 0)
  })
})

test("command hooks 讀取 package scripts／Makefile／skills 並注入參數；collision 保留既有 command", { timeout: 8000 }, async () => {
  await fixture(async ({ load, project }) => {
    await writeFile(path.join(project, "package.json"), JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { check: "never-run", preserved: "never-run" } }))
    await writeFile(path.join(project, "Makefile"), "build: ## Fixture build\n\t@echo never-run\n")
    await mkdir(path.join(project, ".opencode/skills/review"), { recursive: true })
    await writeFile(path.join(project, ".opencode/skills/review/SKILL.md"), "---\nname: review\ndescription: Fixture review\n---\nInspect the public fixture.\n")
    const hooks = await load("command-inject")
    const existing = { description: "Existing owner", template: "Existing template $ARGUMENTS" }
    const config = { command: { "pnpm:preserved": existing, acp: { template: "ACP owned" } } }
    await hooks.config(config)
    assert.deepEqual(config.command["pnpm:preserved"], existing)
    assert.equal(config.command.acp.template, "ACP owned")
    assert.equal(config.command["pnpm:check"].template, "Use shell to execute `pnpm run check -- $ARGUMENTS`")
    assert.equal(config.command["make:build"].description, "Fixture build")
    for (const [command, expected] of [
      ["pnpm:check", "Use shell to execute `pnpm run check -- public-argument`"],
      ["make:build", "Use shell to execute `make build public-argument`"],
      ["skill:review", "<skill-instruction>\nInspect the public fixture.\n</skill-instruction>\n\n<user-request>\npublic-argument\n</user-request>"],
    ]) {
      const output = { parts: [{ type: "text", text: "Native part retained" }] }
      await hooks["command.execute.before"]({ command, sessionID: "fixture-command", arguments: "public-argument" }, output)
      assert.equal(output.parts[0].text, expected)
      assert.equal(output.parts[1].text, "Native part retained")
    }
    const output = { parts: [{ type: "text", text: "Existing rendered command" }] }
    await hooks["command.execute.before"]({ command: "pnpm:preserved", sessionID: "fixture-command", arguments: "ignored" }, output)
    assert.deepEqual(output.parts, [{ type: "text", text: "Existing rendered command" }])
    await assert.rejects(stat(path.join(project, "commands")), { code: "ENOENT" })
  })
})

test("Goal 與 Command Inject config 共存且保留既有 command；native helper 拒絕漏載 tool／command", { timeout: 8000 }, async () => {
  await fixture(async ({ load, project }) => {
    await writeFile(path.join(project, "package.json"), JSON.stringify({ scripts: { check: "never-run" } }))
    const goal = await load("goal"), inject = await load("command-inject")
    const config = { plugin: ["file:///opt/omw-worker/session-plugins/goal.mjs", "file:///opt/omw-worker/session-plugins/command-inject.mjs"],
      command: { acp: { template: "Keep ACP" } }, permission: { bash: "ask" }, agent: { fixture: { permission: { task: "deny" } } } }
    await goal.config(config); await inject.config(config)
    assert.equal(config.command.acp.template, "Keep ACP")
    assert.equal(config.command["npm:check"].template, "Use shell to execute `npm run check -- $ARGUMENTS`")
    assert.deepEqual(config.permission, { bash: "ask" })
    assert.deepEqual(config.agent.fixture.permission, { task: "deny" })
    const commands = Object.keys(config.command).map(name => ({ name }))
    assertSessionPlugins(config, Object.keys(goal.tool), commands)
    for (const name of goalTools) assert.throws(() => assertSessionPlugins(config, goalTools.filter(id => id !== name), commands))
    assert.throws(() => assertSessionPlugins(config, goalTools, commands.filter(command => command.name !== "goal")))
    assert.throws(() => assertSessionPlugins({ ...config, plugin: [] }, goalTools, commands))
  })
})

test("bootstrap global skills 可被 Command Inject 1.3.1 讀取，v1 user migration 與重啟不需 skills.paths 或 mirror", { timeout: 8000 }, async () => {
  await fixture(async ({ load, project, home }) => {
    const source = path.join(project, "source")
    const runtime = path.join(home, ".config/omw-profile")
    const original = "---\nname: fixture-global\ndescription: Global discovery fixture\n---\nInspect the curated fixture.\n"
    const modified = "---\nname: fixture-global\ndescription: Global discovery fixture\n---\nInspect the owner customization.\n"
    await mkdir(path.join(source, "skills/fixture-global"), { recursive: true, mode: 0o700 })
    await mkdir(path.join(runtime, "skills/fixture-global"), { recursive: true, mode: 0o700 })
    await writeFile(path.join(source, "opencode.json"), "{}")
    await writeFile(path.join(source, "skills/fixture-global/SKILL.md"), original)
    await writeFile(path.join(runtime, "opencode.json"), "{}")
    await writeFile(path.join(runtime, "skills/fixture-global/SKILL.md"), modified)
    await writeFile(path.join(runtime, ".omw-source-manifest.json"), JSON.stringify({ version: 1,
      files: { "opencode.json": createHash("sha256").update("{}").digest("hex"),
        "skills/fixture-global/SKILL.md": createHash("sha256").update(original).digest("hex") } }))
    const environment = { HOME: home, OMW_WORKER_PROFILE_SOURCE: source, OMW_WORKER_PROFILE_DIR: runtime }
    await initializeWorker(environment)
    await initializeWorker(environment)
    await assert.rejects(stat(path.join(runtime, "skills")), { code: "ENOENT" })
    const hooks = await load("command-inject")
    const config = { command: {} }
    await hooks.config(config)
    assert.ok(config.command["skill:fixture-global"], "standard HOME discovery must expose migrated user skill")
    const output = { parts: [] }
    await hooks["command.execute.before"]({ command: "skill:fixture-global", sessionID: "fixture-global-command", arguments: "public-argument" }, output)
    assert.equal(output.parts[0].text, "<skill-instruction>\nInspect the owner customization.\n</skill-instruction>\n\n<user-request>\npublic-argument\n</user-request>")
    assert.equal(output.parts.length, 1)
    await assert.rejects(stat(path.join(runtime, "commands")), { code: "ENOENT" })
    await assert.rejects(stat(path.join(home, ".agents/skills/.omw-source-manifest.json")), { code: "ENOENT" })
  })
})

test("Auto Permissions→Goal→Command Inject 真 config hooks 共存，reviewer 與七角色 task deny 均保留", { timeout: 8000 }, async () => {
  await fixture(async ({ load, loadAutoPermissions, project, prompts }) => {
    await writeFile(path.join(project, "package.json"), JSON.stringify({ scripts: { check: "never-run" } }))
    const config = JSON.parse(await readFile(new URL("../../deploy/worker/profile/opencode.json", import.meta.url), "utf8"))
    const roles = ["general", "general-simple", "general-complex", "verifier", "explore", "scout", "reference-reader"]
    for (const name of roles) {
      const markdown = await readFile(new URL(`../../deploy/worker/profile/agents/${name}.md`, import.meta.url), "utf8")
      const frontmatter = JSON.parse(markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1])
      // Fixture 投影現行 JSON-subset frontmatter；native decode 仍由下一輪驗證。
      config.agent[name] = { ...config.agent[name], ...frontmatter }
    }
    const beforeAgent = structuredClone(config.agent), beforePermission = structuredClone(config.permission)
    const auto = await loadAutoPermissions(config.plugin[1][1])
    const goal = await load("goal"), inject = await load("command-inject")
    await auto.config(config); await goal.config(config); await inject.config(config)
    assert.deepEqual(config.permission, beforePermission)
    for (const [name, role] of Object.entries(beforeAgent)) assert.deepEqual(config.agent[name], role)
    for (const name of roles) assert.equal(config.agent[name].permission.task, "deny", name)
    const reviewer = config.agent["auto-permissions-reviewer"]
    assert.equal(reviewer.hidden, true)
    assert.deepEqual(reviewer.tools, { "*": false })
    assert.deepEqual(reviewer.permission, { "*": "deny" })
    // Config hook 產生 model string／permission object；native /agent 會解碼成另一種形狀。
    // 只在 fixture boundary 做這個投影，不把 config hooks 冒稱 native loader。
    const [providerID, modelID] = reviewer.model.split("/")
    assertAutoPermissionsReviewer(config, [{ name: "auto-permissions-reviewer", ...reviewer,
      model: { providerID, modelID }, permission: Object.entries(reviewer.permission).map(([permission, action]) =>
        ({ permission, pattern: "*", action })) }])
    assert.ok(config.command.goal)
    assert.ok(config.command["npm:check"])
    assert.equal(prompts.length, 0, "config registration must not send a model prompt")
  })
})
