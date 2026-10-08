import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { cp, readFile, readdir, stat, mkdir, writeFile, mkdtemp, rm, rmdir } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { auditCompiled } from "./skills-bundle-audit.mjs"

export const officeSkills = ["officecli", "officecli-docx", "officecli-xlsx", "officecli-pptx"]
export const excludedSkills = ["agent-process-lifecycle", "self-challenge", "development-test", "git-github-workflow", "linux-process-lifecycle"]
export const profileRoles = ["general", "general-simple", "general-complex", "verifier", "explore", "scout"]
const digest = bytes => createHash("sha256").update(bytes).digest("hex")

export async function bundleInventory(bundle, profile) {
  const trustedAudit = await auditCompiled(bundle)
  const bytes = await readFile(path.join(bundle, "manifest.json"))
  const manifest = JSON.parse(bytes)
  assert.equal(manifest.skills.length, 62)
  const names = manifest.skills.map(skill => skill.name)
  assert.equal(new Set(names).size, 62)
  assert.ok(!names.some(name => [...officeSkills, ...excludedSkills].includes(name)))
  let compiledFiles = 0
  for (const skill of manifest.skills) for (const [file, hash] of Object.entries(skill.compiledFiles)) {
    assert.equal(digest(await readFile(path.join(profile, "skills", skill.name, file))), hash, `profile hash mismatch: ${skill.name}/${file}`)
    compiledFiles++
  }
  for (const name of officeSkills) assert.ok((await stat(path.join(profile, "skills", name, "SKILL.md"))).size > 0)
  const discovered = []
  for (const name of await readdir(path.join(profile, "skills"))) {
    if (await stat(path.join(profile, "skills", name, "SKILL.md")).catch(() => null)) discovered.push(name)
  }
  assert.deepEqual(discovered.sort(), [...names, ...officeSkills].sort())
  return { ...trustedAudit, upstream: names, office: officeSkills, profileNames: discovered, compiledFiles,
    manifestSha256: digest(bytes), sources: manifest.sources.map(({ id, commit }) => ({ id, commit })) }
}

async function assemble(bundle, profile) {
  // 不以 COPY overlay 靜默覆蓋同名技能；原創 Office 必須與完整來源名稱互斥。
  for (const name of await readdir(path.join(profile, "skills"))) {
    if (officeSkills.includes(name)) continue
    assert.deepEqual(await readdir(path.join(profile, "skills", name)), [], `source skill collision: ${name}`)
    await rmdir(path.join(profile, "skills", name))
  }
  for (const name of await readdir(path.join(bundle, "skills"))) {
    await cp(path.join(bundle, "skills", name), path.join(profile, "skills", name), { recursive: true, force: false, errorOnExist: true })
  }
  console.log(JSON.stringify(await bundleInventory(bundle, profile)))
}

// 只評估 native effective ruleset；不執行 LLM task，也不聲稱 OS sandbox。
export function permissionAction(rules, permission, pattern) {
  let action
  for (const rule of rules) {
    const glob = value => new RegExp(`^${value.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`)
    if (glob(rule.permission).test(permission) && glob(rule.pattern).test(pattern)) action = rule.action
  }
  return action
}

export function bootstrapSummary(output) {
  const count = key => {
    const match = output.match(new RegExp(`(?:#|ℹ) ${key} (\\d+)\\b`))
    assert.ok(match, `bootstrap summary missing: ${key}`)
    return Number(match[1])
  }
  const result = { tests: count("tests"), passed: count("pass"), failed: count("fail"), skipped: count("skipped") }
  assert.ok(result.tests >= 27, "有效 bootstrap checks 不得減少")
  assert.equal(result.passed, result.tests)
  assert.equal(result.failed, 0)
  assert.equal(result.skipped, 0)
  return result
}

export const context7ToolNames = ["query-docs", "resolve-library-id"]
export function context7Definitions(tools) {
  assert.deepEqual(tools.map(tool => tool.name).sort(), context7ToolNames)
  for (const tool of tools) {
    assert.ok(tool.description)
    assert.equal(tool.inputSchema.type, "object")
    assert.ok(Object.keys(tool.inputSchema.properties).length)
  }
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
}

export async function anonymousContext7Definitions() {
  const deadline = AbortSignal.timeout(20_000)
  let session
  const call = async (method, params, id) => {
    const response = await fetch("https://mcp.context7.com/mcp", { method: "POST", signal: deadline,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session, "mcp-protocol-version": "2025-03-26" } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, ...(id ? { id } : {}) }) })
    assert.ok(response.ok, `Context7 anonymous ${method}: HTTP ${response.status}`)
    session ??= response.headers.get("mcp-session-id")
    if (!id) { await response.body?.cancel(); return }
    const text = await response.text()
    const data = text.split("\n").find(line => line.startsWith("data:"))
    const result = JSON.parse(data ? data.slice(5) : text)
    assert.ok(!result.error, `Context7 ${method}: ${JSON.stringify(result.error)}`)
    return result.result
  }
  try {
    const initialized = await call("initialize", { protocolVersion: "2025-03-26", capabilities: {},
      clientInfo: { name: "omw-public-profile-verification", version: "1" } }, 1)
    await call("notifications/initialized", {})
    const listed = await call("tools/list", {}, 2)
    return { source: "direct-anonymous-MCP; separate from native HTTP connection", protocolVersion: initialized.protocolVersion,
      tools: context7Definitions(listed.tools), modelCalls: 0, toolCalls: 0 }
  } finally {
    if (session) {
      const closed = await fetch("https://mcp.context7.com/mcp", { method: "DELETE", signal: AbortSignal.timeout(3000),
        headers: { "mcp-session-id": session, "mcp-protocol-version": "2025-03-26" } })
      await closed.body?.cancel()
      assert.ok(closed.ok || [404, 405].includes(closed.status), `Context7 direct session close: HTTP ${closed.status}`)
    }
  }
}

function command(executable, args, { cwd, env = process.env, timeout = 20_000, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
    let output = "", expired = false
    const collect = bytes => { output = (output + bytes).slice(-32_000) }
    child.stdout.on("data", collect); child.stderr.on("data", collect)
    const timer = setTimeout(() => { expired = true; child.kill("SIGKILL") }, timeout)
    child.once("error", error => { clearTimeout(timer); reject(error) })
    child.once("close", code => {
      clearTimeout(timer)
      if (expired || (code !== 0 && !allowFailure)) reject(new Error(`${executable} ${expired ? "deadline exceeded" : `exit ${code}`}\n${output.slice(-4000)}`))
      else resolve({ code, output })
    })
  })
}

async function helpers(profile, scratch) {
  const root = path.join(profile, "skills")
  const checks = []
  for (const file of ["jenkins/scripts/jenkins.py", "kibana/scripts/kibana.py", "erp/scripts/erp.py", "llms-docs/scripts/fetch-llms.py",
    "pr-review/scripts/stage.py", "go-for-it-remake/scripts/config.py", "get-pr-ready-remake/scripts/config.py", "daily-work-log/scripts/collect-worker-git-evidence.py"]) {
    const result = await command("python3", ["-B", path.join(root, file), "--help"], { cwd: scratch })
    assert.ok(result.output.length > 0)
    checks.push({ file, exit: result.code, mode: "help-only" })
  }
  const config = path.join(root, "go-for-it-remake/scripts/config.py")
  const configRoot = path.join(scratch, "fixture-config")
  await command("python3", ["-B", config, "--config-root", configRoot, "save", "--selector", "implement"], { cwd: scratch })
  const result = await command("python3", ["-B", config, "--config-root", configRoot, "read"], { cwd: scratch })
  assert.match(result.output, /implement/)
  // Node 24 原生 type stripping 僅驗證 bundled plugin startup／空訊息 callback，沒有安裝全域 hook。
  for (const file of ["git-commit-co-author/scripts/opencode-plugin.ts", "release-workflow/references/opencode-plugin.ts"]) {
    const plugin = await import(`file://${path.join(root, file)}`)
    await plugin.default()["experimental.chat.messages.transform"]({}, { messages: [] })
    checks.push({ file, mode: "native-node-plugin-startup-empty-callback" })
  }
  const dependencies = []
  const metadata = JSON.parse(await readFile("/opt/omw-worker/workflow-tools-versions.json", "utf8"))
  for (const name of ["requests", "yaml"]) {
    const probe = await command("python3", ["-B", "-c", `import ${name}; print(${name}.__version__)`], { cwd: scratch })
    assert.equal(probe.output.trim(), name === "requests" ? "2.28.1" : "6.0")
    dependencies.push({ module: name, available: probe.code === 0, detail: probe.output.trim() })
  }
  return { checks, configRoundTrip: true, dependencies, installedPythonMetadata: metadata.python, runtimeInstall: false, externalServices: "not-exercised" }
}

async function browser(outputDirectory) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omw-skills-cli-"))
  const session = `omw-${randomBytes(8).toString("hex")}`
  const cli = args => command("playwright-cli", [`-s=${session}`, ...args], { cwd: directory, timeout: 30_000 })
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8")
    response.end('<!doctype html><html lang="zh-TW"><title>OMW owned fixture</title><button onclick="document.querySelector(\'output\').textContent=\'已完成\'">執行</button><output>待執行</output></html>')
  })
  let launched = false, detail
  try {
    assert.match((await cli(["--help"])).output, /run-code/)
    assert.match((await cli(["--version"])).output, /0\.1\.22/)
    assert.match((await cli(["open", "--help"])).output, /idle-timeout/)
    assert.match((await cli(["screenshot", "--help"])).output, /filename/)
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
    launched = true
    const opened = await cli(["open", `http://127.0.0.1:${server.address().port}`, "--idle-timeout=15000"])
    assert.doesNotMatch(opened.output, /### Error/)
    const action = await cli(["run-code", "async (page) => { await page.getByRole('button', {name:'執行'}).click(); const text = await page.locator('output').textContent(); if (text !== '已完成') throw new Error('fixture button failed'); return {text, version:page.context().browser().version(), userAgent:await page.evaluate(()=>navigator.userAgent)}; }"])
    assert.doesNotMatch(action.output, /### Error/)
    assert.match(action.output, /已完成/); assert.match(action.output, /HeadlessChrome/)
    const versions = JSON.parse(await readFile("/opt/omw-worker/workflow-tools-versions.json", "utf8"))
    assert.ok(action.output.includes(versions.chromium.browserVersion))
    const screenshot = path.join(outputDirectory, "fixture.png")
    assert.doesNotMatch((await cli(["screenshot", `--filename=${screenshot}`])).output, /### Error/)
    const png = await readFile(screenshot)
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    detail = { session, cli: versions.cli, chromium: versions.chromium, screenshot: "fixture.png", screenshotSha256: digest(png), action: "button-and-output-assertion", network: "owned-loopback-only" }
  } finally {
    try { if (launched) assert.doesNotMatch((await cli(["close"])).output, /### Error/) }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }) }
  }
  return { ...detail, sessionClosed: true, daemonOwner: "current-run-Docker-container" }
}

async function inside(outputDirectory) {
  assert.equal(process.getuid(), 1000)
  const scratch = await mkdtemp("/tmp/omw-skills-helper-")
  const ttl = setTimeout(() => process.exit(124), 150_000)
  try {
    await mkdir(outputDirectory, { recursive: true })
    const inventory = await bundleInventory("/opt/omw-worker/skills-bundle", "/opt/omw/deploy/worker/profile")
    const helperResults = await helpers("/opt/omw/deploy/worker/profile", scratch)
    const browserResults = await browser(outputDirectory)
    const result = { inventory, helpers: helperResults, browser: browserResults, limits: { modelCalls: 0, credentials: "none", fixture: "synthetic-local", allSkillsEndToEnd: false } }
    await writeFile(path.join(outputDirectory, "skills-tools.json"), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result))
  } finally { clearTimeout(ttl); await rm(scratch, { recursive: true, force: true }) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--assemble") await assemble(process.argv[3], process.argv[4])
  else if (process.argv[2] === "--inside") await inside(process.argv[3] ?? "/tmp/omw-skills-evidence")
  else throw new Error("使用 verify-profile.mjs --context <local-context> --skills-context <private-worker-skills>；image 模式 --inside <owned-output>。")
}
