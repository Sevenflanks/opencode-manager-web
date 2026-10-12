import assert from "node:assert/strict"
import { readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { assertProfileModels, assertAutoPermissionsReviewer, profileModelPolicy, profileRoles } from "./verify-skills-profile.mjs"
import test from "node:test"

const repo = fileURLToPath(new URL("../../", import.meta.url))
const profile = path.join(repo, "deploy/worker/profile")
const runtime = "/home/node/.config/omw-profile"
const implementations = ["general", "general-simple", "general-complex"]
const readers = ["verifier", "explore", "scout", "reference-reader"]
const roles = ["astra", ...implementations, ...readers]
const sol = "openai/gpt-6.1-sol-fast"
const luna = "openai/gpt-6-luna-fast"
const modelPolicy = {
  astra: { model: sol, variant: "high" },
  plan: { model: sol, variant: "high" },
  build: { model: sol, variant: "high" },
  general: { model: sol, variant: "high" },
  "general-simple": { model: luna, variant: "high" },
  "general-complex": { model: sol, variant: "high" },
  verifier: { model: sol, variant: "high" },
  explore: { model: luna, variant: "medium" },
  scout: { model: luna, variant: "medium" },
  "reference-reader": { model: luna, variant: "medium" },
  title: { model: luna, variant: "medium" },
}
const office = ["officecli", "officecli-docx", "officecli-xlsx", "officecli-pptx"]
const config = JSON.parse(await readFile(path.join(profile, "opencode.json"), "utf8"))
const sourceCatalog = JSON.parse(await readFile(path.join(repo, "deploy/worker/skills-bundle/sources.json"), "utf8"))
const skills = sourceCatalog.sources.flatMap(source => Object.values(source.groups).flat())
const instructions = await readFile(path.join(profile, "AGENTS.md"), "utf8")
const routing = await readFile(path.join(profile, "references/skill-routing.md"), "utf8")

// 1.18.34 已核對的欄位子集；不是整份 upstream decoder，也不取代 native image smoke。
function keys(value, allowed, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label}: object required`)
  for (const key of Object.keys(value)) assert.ok(allowed.includes(key), `${label}: unsupported key ${key}`)
}
function validateConfig(value) {
  // HOME/.agents/skills 已由 native 掃描；禁止再加 paths 讓 profile 回到 old root 或重複掃描。
  keys(value, ["$schema", "shell", "autoupdate", "compaction", "plugin", "instructions",
    "subagent_depth", "agent", "permission", "mcp", "model", "small_model", "default_agent"], "config")
  assert.equal(value.$schema, "https://opencode.ai/config.json")
  assert.equal(value.shell, "/bin/bash")
  assert.equal(value.autoupdate, false)
  assert.deepEqual(value.compaction, { auto: false })
  assert.deepEqual(value.plugin, ["file:///opt/omw-worker/acp/acp.mjs",
    ["file:///opt/omw-worker/auto-permissions/dist/v1-server.js", {
      model: "openai/gpt-6-luna", variant: "low", sessionApprovals: true,
      timeoutMs: 30000, userMessageCount: 8, runtime: "auto", debug: false,
    }], "file:///opt/omw-worker/session-plugins/goal.mjs",
    "file:///opt/omw-worker/session-plugins/command-inject.mjs"])
  assert.deepEqual(value.instructions, [`${runtime}/AGENTS.md`])
  assert.equal(value.subagent_depth, 1)
  assert.equal(value.model, sol)
  assert.equal(value.small_model, luna)
  assert.equal(value.default_agent, "astra")
  assert.deepEqual(value.agent, { ...modelPolicy,
    plan: { ...modelPolicy.plan, permission: { task: Object.fromEntries(implementations.map(name => [name, "deny"])) } } })
  assert.deepEqual(value.permission, { bash: "ask", external_directory: "ask", doom_loop: "ask",
    "context7_*": "deny", "context7_resolve-library-id": "allow", "context7_query-docs": "allow" })
  assert.deepEqual(value.mcp, { context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true, oauth: false } })
}
function parseAgent(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/)
  assert.ok(match, "agent frontmatter and body required")
  return { data: JSON.parse(match[1]), body: match[2].trim() }
}
function validateAgent(name, { data, body }) {
  keys(data, ["description", "mode", "permission"], `${name} frontmatter`)
  assert.equal(data.mode, name === "astra" ? "primary" : "subagent")
  assert.ok(typeof data.description === "string" && data.description.length > 0)
  assert.ok(body.length > 0)
  const permission = data.permission
  // 新 primary 沿用既有 global gate，不搬宿主全 allow，也不遮蔽模型的 inline source of truth。
  if (name === "astra") {
    assert.equal(permission, undefined)
    return
  }
  if (implementations.includes(name)) {
    assert.deepEqual(permission, { task: "deny", todowrite: "deny", bash: "ask" })
    return
  }
  keys(permission, ["*", "read", "glob", "grep", "list", "skill", "webfetch", "websearch", "lsp",
    "external_directory", "context7_*", "bash", "edit", "task"], `${name} permission`)
  assert.equal(Object.keys(permission)[0], "*", "last-match rules require deny wildcard first")
  assert.equal(permission["*"], "deny")
  assert.deepEqual(permission.read, { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" })
  for (const tool of ["glob", "grep", "list", "skill", "webfetch", "websearch"]) assert.equal(permission[tool], "allow")
  if (name !== "scout") assert.equal(permission.lsp, "allow")
  assert.equal(permission.external_directory, "ask")
  assert.equal(permission["context7_*"], "ask")
  assert.equal(permission.bash, name === "verifier" ? "ask" : "deny")
  assert.equal(permission.edit, "deny")
  assert.equal(permission.task, "deny")
}
const agents = Object.fromEntries(await Promise.all((await readdir(path.join(profile, "agents"))).map(async file =>
  [file.replace(/\.md$/, ""), parseAgent(await readFile(path.join(profile, "agents", file), "utf8"))])))

// Static last-match projection for regression assertions, not an invocation of native permission code.
function matches(pattern, value) {
  return new RegExp(`^${pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(value)
}
function action(permission, tool, argument = "*") {
  let result
  for (const [pattern, rule] of Object.entries(permission)) {
    if (!matches(pattern, tool)) continue
    if (typeof rule === "string") result = rule
    else for (const [resource, decision] of Object.entries(rule)) if (matches(resource, argument)) result = decision
  }
  return result
}
function routedNames(text) {
  return text.split(/\r?\n/).filter(line => line.startsWith("| ")).slice(2)
    .flatMap(line => [...line.split("|")[2].matchAll(/`([^`]+)`/g)].map(match => match[1]))
}
function validateRouting(text, known) {
  const names = routedNames(text)
  assert.ok(names.length > 0)
  for (const name of names) assert.ok(known.has(name), `routing skill missing from catalog: ${name}`)
}

test("profile pinned config 採已授權 OpenAI model／variant，保留 ACP／paths 且省略 credentials", () => validateConfig(config))
test("拒絕未知 key、錯誤 global model、非 absolute paths、額外 MCP、headers 與 unsafe defaults", () => {
  for (const change of [
    value => { value.resource_control = { memory: 1 } },
    value => { value.model = "synthetic/model" },
    value => { delete value.model },
    value => { value.small_model = "synthetic/small" },
    value => { delete value.small_model },
    value => { value.default_agent = "general" },
    value => { delete value.default_agent },
    value => { value.instructions = ["AGENTS.md"] },
    value => { value.skills = { paths: ["skills"] } },
    value => { value.skills = { paths: [`${runtime}/skills`] } },
    value => { value.skills = { paths: ["/home/node/.agents/skills"] } },
    value => { value.mcp.context7.headers = { Authorization: "synthetic-fixture" } },
    value => { value.mcp.context7.enabled = false },
    value => { value.mcp.context7.oauth = true },
    value => { value.mcp.other = { enabled: true } },
    value => { value.permission = "allow" },
    value => { value.plugin[1] = "opencode-auto-permissions" },
    value => { value.plugin[1][1].debug = true },
    value => { value.plugin[1][1].sessionApprovals = false },
    value => { value.plugin[1][1].model = "openai/gpt-6-luna-fast" },
    value => { value.permission.external_directory = "allow" },
    value => { value.permission.bash = "allow" },
    value => { value.permission["context7_*"] = "allow" },
    value => { value.permission["context7_write-fixture"] = "allow" },
    value => { value.subagent_depth = 2 },
    value => { value.command = {} },
    value => { value.provider = { openai: { options: { apiKey: "synthetic-fixture" } } } },
    value => { value.enabled_providers = ["openai"] },
  ]) {
    const bad = structuredClone(config)
    change(bad)
    assert.throws(() => validateConfig(bad))
  }
  for (const name of implementations) {
    const bad = structuredClone(config)
    bad.agent.plan.permission.task[name] = "allow"
    assert.throws(() => validateConfig(bad), `plan must deny ${name}`)
  }
})
test("八個 Markdown roles 可解析，astra 為合法 primary、七個 subagents 不遞迴，模型只在 inline", async () => {
  assert.deepEqual((await readdir(path.join(profile, "agents"))).sort(), roles.map(name => `${name}.md`).sort())
  for (const name of roles) validateAgent(name, agents[name])
})
test("每個角色 model／variant 的遺漏、錯誤 provider、錯誤 mapping 或 reasoning 值均拒絕", () => {
  for (const name of Object.keys(modelPolicy)) {
    for (const change of [
      role => { delete role.model },
      role => { role.model = "anthropic/synthetic-fixture" },
      role => { role.model = role.model === sol ? luna : sol },
      role => { delete role.variant },
      role => { role.variant = "invalid" },
      role => { role.variant = role.variant === "high" ? "medium" : "high" },
      role => { role.reasoningEffort = "high" },
    ]) {
      const bad = structuredClone(config)
      change(bad.agent[name] ??= {})
      assert.throws(() => validateConfig(bad), `${name}: invalid model policy accepted`)
    }
  }
  for (const name of ["compaction", "summary", "non-openai-fixture"]) {
    assert.equal(config.agent[name], undefined, `${name}: 未授權宿主角色不得複製`)
    const bad = structuredClone(config)
    bad.agent[name] = { model: "anthropic/synthetic-fixture", variant: "high" }
    assert.throws(() => validateConfig(bad), `${name}: non-OpenAI role copied`)
  }
})
test("native model 檢查覆蓋 inline 與 agent 載入結果，不接受 Markdown merge 遺漏與 primary 權限放大", () => {
  assert.deepEqual(profileModelPolicy, modelPolicy)
  assert.deepEqual(profileRoles.slice().sort(), [...implementations, ...readers].sort())
  // 只測驗收函式的正負案例；此 synthetic fixture 不是 native loader 生效證據。
  const loaded = Object.entries(modelPolicy).map(([name, { model, variant }]) => {
    const [providerID, modelID] = model.split("/")
    return { name, model: { providerID, modelID }, variant,
      mode: name === "astra" ? "primary" : "subagent", hidden: name === "title",
      permission: Object.entries(config.permission).map(([permission, action]) => ({ permission, pattern: "*", action })) }
  })
  assertProfileModels(config, loaded)
  for (const name of Object.keys(modelPolicy)) {
    for (const change of [
      agent => { delete agent.model },
      agent => { agent.model.providerID = "anthropic" },
      agent => { agent.model.modelID = "wrong-model" },
      agent => { delete agent.variant },
      agent => { agent.variant = "invalid" },
    ]) {
      const bad = structuredClone(loaded)
      change(bad.find(agent => agent.name === name))
      assert.throws(() => assertProfileModels(config, bad), `${name}: invalid native model accepted`)
    }
  }
  for (const change of [
    roles => { roles.find(agent => agent.name === "astra").mode = "subagent" },
    roles => { roles.find(agent => agent.name === "astra").hidden = true },
    roles => { roles.find(agent => agent.name === "title").hidden = false },
    roles => { roles.find(agent => agent.name === "astra").permission.push({ permission: "*", pattern: "*", action: "allow" }) },
  ]) {
    const bad = structuredClone(loaded)
    change(bad)
    assert.throws(() => assertProfileModels(config, bad))
  }
})
test("astra 不隱藏、不降為 subagent、不擴大 global permissions，title 保留 builtin hidden", () => {
  validateAgent("astra", agents.astra)
  for (const change of [
    agent => { agent.data.mode = "subagent" },
    agent => { agent.data.hidden = true },
    agent => { agent.data.permission = "allow" },
    agent => { agent.data.permission = { bash: "allow" } },
  ]) {
    const bad = structuredClone(agents.astra)
    change(bad)
    assert.throws(() => validateAgent("astra", bad))
  }
  assert.equal(config.agent.title.hidden, undefined, "不覆寫 builtin title hidden")
  assert.equal(agents.title, undefined, "不新增 title prompt")
})
test("native reviewer 驗收拒絕遺漏、可見、錯誤模型或工具權限放大", () => {
  const loaded = [{ name: "auto-permissions-reviewer", model: { providerID: "openai", modelID: "gpt-6-luna" }, variant: "low",
    hidden: true, mode: "subagent", permission: [{ permission: "*", pattern: "*", action: "deny" }] }]
  assertAutoPermissionsReviewer(config, loaded)
  assert.throws(() => assertAutoPermissionsReviewer(config, []))
  for (const change of [
    agent => { agent.hidden = false },
    agent => { agent.mode = "primary" },
    agent => { agent.model.modelID = "gpt-6-luna-fast" },
    agent => { agent.variant = "high" },
    agent => { agent.permission.push({ permission: "task", pattern: "*", action: "allow" }) },
  ]) {
    const bad = structuredClone(loaded)
    change(bad[0])
    assert.throws(() => assertAutoPermissionsReviewer(config, bad))
  }
})
test("唯讀 role policy 封閉 source edits、未知 tools、遞迴；測試 shell 為 ask", () => {
  for (const tool of ["context7_resolve-library-id", "context7_query-docs"]) assert.equal(action(config.permission, tool), "allow")
  assert.equal(action(config.permission, "context7_write-fixture"), "deny")
  assert.ok(instructions.includes("**unavailable**") && instructions.includes("與原因"), "MCP 失聯需明示，不能隱藏 fallback")
  for (const name of readers) {
    const permission = agents[name].data.permission
    for (const tool of ["edit", "task", "unknown_plugin", "unrelated_mcp_write"]) assert.equal(action(permission, tool), "deny")
    assert.equal(action(permission, "bash", "arbitrary-command"), name === "verifier" ? "ask" : "deny")
    assert.equal(action(permission, "context7_query-docs"), "ask")
    assert.equal(action(permission, "read", "/repo/.env"), "ask")
    assert.equal(action(permission, "read", "/repo/.env.local"), "ask")
    assert.equal(action(permission, "read", "/repo/.env.example"), "allow")
    assert.equal(action(permission, "read", "/repo/src/app.ts"), "allow")
  }
})
test("role mutations 不能偷偷開 edit／shell／task 或在 Markdown 複製 model／未知能力", () => {
  for (const name of readers) {
    for (const change of [
      agent => { agent.data.permission.edit = "allow" },
      agent => { agent.data.permission.bash = "allow" },
      agent => { agent.data.permission.task = "allow" },
      agent => { agent.data.permission.unknown_tool = "allow" },
      agent => { agent.data.permission["*"] = "allow" },
      agent => { agent.data.permission.read = "allow" },
      agent => { agent.data.model = "synthetic/model" },
      agent => { agent.data.variant = "medium" },
      agent => { agent.data.mode = "primary" },
    ]) {
      const bad = structuredClone(agents[name])
      change(bad)
      assert.throws(() => validateAgent(name, bad))
    }
  }
})
test("來源 allowlist 62 加 Office4；routing 指向真實來源名，四個 Seven 可觸發", () => {
  assert.equal(skills.length, 62)
  const known = new Set([...skills, ...office])
  assert.equal(known.size, 66)
  for (const name of ["agent-process-lifecycle", "self-challenge", "development-test", "git-github-workflow", "linux-process-lifecycle"]) {
    assert.ok(!known.has(name))
    assert.ok(!instructions.includes(name))
  }
  validateRouting(routing, known)
  assert.throws(() => validateRouting(routing.replace("`pr-review-remake`", "`missing-fixture-skill`"), known))
  for (const name of ["finish-and-admin-merge", "push-post-pr", "start-from-matt", "to-spec-or-ticket"]) assert.ok(routedNames(routing).includes(name))
})
test("absolute instruction references 可映射到 profile，引用不是 project cwd", async () => {
  const documents = [instructions, routing]
  for (const text of documents) {
    for (const match of text.matchAll(/`(\/home\/node\/\.config\/omw-profile\/[^`]+)`/g)) {
      const relative = path.posix.relative(runtime, match[1])
      assert.ok(!relative.startsWith("..") && !path.posix.isAbsolute(relative))
      assert.ok((await stat(path.join(profile, relative))).isFile(), `profile reference missing: ${relative}`)
    }
  }
  assert.ok(instructions.includes(`${runtime}/references/skill-routing.md`))
})
