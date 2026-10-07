import assert from "node:assert/strict"
import { readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const repo = fileURLToPath(new URL("../../", import.meta.url))
const profile = path.join(repo, "deploy/worker/profile")
const runtime = "/home/node/.config/omw-profile"
const implementations = ["general", "general-simple", "general-complex"]
const readers = ["verifier", "explore", "scout"]
const roles = [...implementations, ...readers]
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
  keys(value, ["$schema", "shell", "autoupdate", "compaction", "plugin", "instructions", "skills",
    "subagent_depth", "agent", "permission", "mcp"], "config")
  assert.equal(value.$schema, "https://opencode.ai/config.json")
  assert.equal(value.shell, "/bin/bash")
  assert.equal(value.autoupdate, false)
  assert.deepEqual(value.compaction, { auto: false })
  assert.deepEqual(value.plugin, ["file:///opt/omw-worker/acp/acp.mjs"])
  assert.deepEqual(value.instructions, [`${runtime}/AGENTS.md`])
  assert.deepEqual(value.skills, { paths: [`${runtime}/skills`] })
  assert.equal(value.subagent_depth, 1)
  assert.deepEqual(value.agent, { plan: { permission: { task: Object.fromEntries(implementations.map(name => [name, "deny"])) } } })
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
  assert.equal(data.mode, "subagent")
  assert.ok(typeof data.description === "string" && data.description.length > 0)
  assert.ok(body.length > 0)
  const permission = data.permission
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
const agents = Object.fromEntries(await Promise.all(roles.map(async name =>
  [name, parseAgent(await readFile(path.join(profile, "agents", `${name}.md`), "utf8"))])))

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

test("profile pinned config 使用支援子集，保留 ACP／paths 且省略 host model 與 credentials", () => validateConfig(config))
test("拒絕未知 key、日常 model、非 absolute paths、額外 MCP、headers 與 unsafe defaults", () => {
  for (const change of [
    value => { value.resource_control = { memory: 1 } },
    value => { value.model = "synthetic/model" },
    value => { value.small_model = "synthetic/small" },
    value => { value.default_agent = "general" },
    value => { value.instructions = ["AGENTS.md"] },
    value => { value.skills.paths = ["skills"] },
    value => { value.mcp.context7.headers = { Authorization: "synthetic-fixture" } },
    value => { value.mcp.context7.enabled = false },
    value => { value.mcp.context7.oauth = true },
    value => { value.mcp.other = { enabled: true } },
    value => { value.permission = "allow" },
    value => { value.permission.external_directory = "allow" },
    value => { value.permission.bash = "allow" },
    value => { value.permission["context7_*"] = "allow" },
    value => { value.permission["context7_write-fixture"] = "allow" },
    value => { value.subagent_depth = 2 },
    value => { value.agent.plan.permission.task["general-simple"] = "allow" },
    value => { value.command = {} },
  ]) {
    const bad = structuredClone(config)
    change(bad)
    assert.throws(() => validateConfig(bad))
  }
})
test("六個 native Markdown role 可解析，不指定 model，均不遞迴", async () => {
  assert.deepEqual((await readdir(path.join(profile, "agents"))).sort(), roles.map(name => `${name}.md`).sort())
  for (const name of roles) validateAgent(name, agents[name])
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
test("role mutations 不能偷偷開 edit／shell／task 或添加 model／未知能力", () => {
  for (const change of [
    agent => { agent.data.permission.edit = "allow" },
    agent => { agent.data.permission.bash = "allow" },
    agent => { agent.data.permission.task = "allow" },
    agent => { agent.data.permission.unknown_tool = "allow" },
    agent => { agent.data.permission["*"] = "allow" },
    agent => { agent.data.permission.read = "allow" },
    agent => { agent.data.model = "synthetic/model" },
    agent => { agent.data.mode = "primary" },
  ]) {
    const bad = structuredClone(agents.explore)
    change(bad)
    assert.throws(() => validateAgent("explore", bad))
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
