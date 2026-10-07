import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile, chmod, stat, readdir, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"

const cli = fileURLToPath(new URL("./bootstrap.mjs", import.meta.url))
const synthetic = { openai: { type: "oauth", access: "synthetic-access-not-a-secret", refresh: "synthetic-refresh-not-a-secret", expires: 0, accountId: "synthetic-account" }, other: { type: "api", key: "synthetic-api" } }
async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "omw-bootstrap-test-"))
  const home = path.join(root, "home")
  await mkdir(home, { mode: 0o700 })
  // 只繼承執行 Node 必要的非秘密 host env，不枚舉或帶入宿主 provider credentials。
  const env = {}
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "PATHEXT", "WINDIR", "TEMP", "TMP", "LANG", "TZ"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_DATA_HOME: path.join(root, "data"), OMW_WORKER_PROFILE_DIR: path.join(home, ".config", "omw-profile") })
  const auth = path.join(env.XDG_DATA_HOME, "opencode", "auth.json")
  const seed = path.join(root, "seed.json")
  await writeFile(seed, JSON.stringify(synthetic), { mode: 0o600 })
  try { await run({ root, home, env, auth, seed }) }
  finally { await rm(root, { recursive: true, force: true }) }
}
function boot(env, args = []) {
  return runNode(env, [cli, ...args])
}
function runNode(env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    const deadline = setTimeout(() => child.kill(), 10_000)
    child.stdout.on("data", chunk => { stdout += chunk })
    child.stderr.on("data", chunk => { stderr += chunk })
    child.on("error", reject)
    child.on("close", code => { clearTimeout(deadline); resolve({ code, stdout, stderr }) })
  })
}
async function success(env) {
  const result = await boot(env)
  assert.equal(result.code, 0, result.stderr)
  return JSON.parse(result.stdout)
}
test("沒有選用 seed/profile/PAT 時允許首次人工登入，不建立 auth", () => fixture(async ({ env, auth }) => {
  assert.equal((await success(env)).auth, "absent")
  await assert.rejects(stat(auth), { code: "ENOENT" })
}))
test("唯讀 seed 完整複製到 XDG auth；私有 mode、原始來源不變", () => fixture(async ({ env, seed, auth }) => {
  await chmod(seed, 0o400)
  const before = await readFile(seed)
  assert.equal((await success({ ...env, OMW_AUTH_SEED_FILE: seed })).auth, "seeded")
  assert.deepEqual(JSON.parse(await readFile(auth, "utf8")), synthetic)
  assert.deepEqual(await readFile(seed), before)
  if (process.platform !== "win32") {
    assert.equal((await stat(auth)).mode & 0o777, 0o600)
    assert.equal((await stat(path.dirname(auth))).mode & 0o777, 0o700)
  }
}))
test("HOME fallback 與 OpenCode 相同", () => fixture(async ({ env, home, seed }) => {
  delete env.XDG_DATA_HOME
  await success({ ...env, OMW_AUTH_SEED_FILE: seed })
  assert.deepEqual(JSON.parse(await readFile(path.join(home, ".local/share/opencode/auth.json"), "utf8")), synthetic)
}))
test("重啟保留最新 auth；seed 不存在／無法讀取仍成功", () => fixture(async ({ env, seed, auth, root }) => {
  await success({ ...env, OMW_AUTH_SEED_FILE: seed })
  const refreshed = { ...synthetic, openai: { ...synthetic.openai, access: "synthetic-refreshed", refresh: "synthetic-refreshed-refresh" } }
  await writeFile(auth, JSON.stringify(refreshed))
  const result = await success({ ...env, OMW_AUTH_SEED_FILE: path.join(root, "no-longer-mounted") })
  assert.equal(result.auth, "existing")
  assert.deepEqual(JSON.parse(await readFile(auth, "utf8")), refreshed)
}))
test("平行初始化只有完整 winner，無覆寫或半份檔案／暫存殘留", () => fixture(async ({ env, seed, auth, root }) => {
  const other = path.join(root, "other.json")
  const second = { openai: { ...synthetic.openai, access: "synthetic-second", refresh: "synthetic-second-refresh" } }
  await writeFile(other, JSON.stringify(second), { mode: 0o600 })
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => boot({ ...env, OMW_AUTH_SEED_FILE: index % 2 ? seed : other })))
  for (const result of results) assert.equal(result.code, 0, result.stderr)
  assert.equal(results.filter(result => JSON.parse(result.stdout).auth === "seeded").length, 1)
  const winner = await readFile(auth, "utf8")
  assert.ok([JSON.stringify(synthetic), JSON.stringify(second)].includes(winner))
  assert.deepEqual(await readdir(path.dirname(auth)), ["auth.json"])
  await success({ ...env, OMW_AUTH_SEED_FILE: seed })
  assert.equal(await readFile(auth, "utf8"), winner)
}))
test("configured invalid seed fail closed，所有錯誤不含內容或 hash", () => fixture(async ({ env, seed, auth }) => {
  const invalid = ["null", "42", '"synthetic-leak-marker"', "[]", "{synthetic-leak-marker", "{}",
    JSON.stringify({ openai: { type: "api", key: "synthetic-leak-marker" } }),
    JSON.stringify({ openai: { type: "oauth", access: "synthetic-leak-marker", expires: 1 } }),
    JSON.stringify({ openai: { ...synthetic.openai, expires: "synthetic-leak-marker" } }),
    JSON.stringify({ ...synthetic, invalid: "synthetic-leak-marker" })]
  for (const content of invalid) {
    await writeFile(seed, content)
    const result = await boot({ ...env, OMW_AUTH_SEED_FILE: seed })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /OMW_AUTH_SEED_FILE/)
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-|[a-f0-9]{64}/)
    await assert.rejects(stat(auth), { code: "ENOENT" })
  }
}))
test("seed directory 與不存在路徑提供固定安全錯誤", () => fixture(async ({ env, root }) => {
  for (const seed of [root, path.join(root, "synthetic-secret-path")]) {
    const result = await boot({ ...env, OMW_AUTH_SEED_FILE: seed })
    assert.equal(result.code, 1)
    assert.doesNotMatch(result.stderr, /synthetic-secret-path/)
    assert.match(result.stderr, /OMW_AUTH_SEED_FILE/)
  }
}))
test("明示空白或 relative 可選來源不當成 absent fallback", () => fixture(async ({ env }) => {
  for (const key of ["OMW_AUTH_SEED_FILE", "OMW_GITHUB_TOKEN_FILE", "OMW_WORKER_PROFILE_SOURCE"]) {
    for (const value of ["", "synthetic-relative"]) {
      const result = await boot({ ...env, [key]: value })
      assert.equal(result.code, 1)
      assert.ok(result.stderr.includes(key))
      assert.doesNotMatch(result.stderr, /synthetic-relative/)
    }
  }
}))
test("auth symlink 拒絕且不碰 target", { skip: process.platform === "win32" ? "Windows symlink 需要系統權限；Linux 執行此安全案例" : false }, () => fixture(async ({ env, seed, auth, root }) => {
  await mkdir(path.dirname(auth), { recursive: true, mode: 0o700 })
  const target = path.join(root, "target")
  await writeFile(target, "synthetic-preserve")
  await symlink(target, auth)
  assert.equal((await boot({ ...env, OMW_AUTH_SEED_FILE: seed })).code, 1)
  assert.equal(await readFile(target, "utf8"), "synthetic-preserve")
}))
test("不掩蓋既有 auth insecure permissions", { skip: process.platform === "win32" ? "Windows 沒有 POSIX mode enforcement" : false }, () => fixture(async ({ env, seed, auth }) => {
  await success({ ...env, OMW_AUTH_SEED_FILE: seed })
  await chmod(auth, 0o644)
  assert.equal((await boot({ ...env, OMW_AUTH_SEED_FILE: seed })).code, 1)
  assert.equal((await stat(auth)).mode & 0o777, 0o644)
}))
test("拒絕 symlink/junction auth parent；不向其他目錄寫入", () => fixture(async ({ env, seed, root, auth }) => {
  const target = path.join(root, "elsewhere")
  await mkdir(target, { mode: 0o700 })
  await mkdir(env.XDG_DATA_HOME, { mode: 0o700 })
  await symlink(target, path.dirname(auth), process.platform === "win32" ? "junction" : "dir")
  const result = await boot({ ...env, OMW_AUTH_SEED_FILE: seed })
  assert.equal(result.code, 1)
  assert.deepEqual(await readdir(target), [])
}))
test("不可寫目的地失敗且不輸出來源／內容，也不留下 auth", () => fixture(async ({ env, seed, root }) => {
  const blocked = path.join(root, "synthetic-blocked-path")
  await writeFile(blocked, "synthetic-blocked-marker")
  const result = await boot({ ...env, XDG_DATA_HOME: blocked, OMW_AUTH_SEED_FILE: seed })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /OMW_AUTH_SEED_FILE/)
  assert.doesNotMatch(result.stderr + result.stdout, /synthetic-/)
  assert.equal(await readFile(blocked, "utf8"), "synthetic-blocked-marker")
}))
test("唯讀完整 profile 複製、來源更新、刪除 owned source files、保留 runtime extras 與全域設定", () => fixture(async ({ root, env, home }) => {
  const source = path.join(root, "profile")
  await mkdir(path.join(source, "skills", "example"), { recursive: true })
  await writeFile(path.join(source, "opencode.json"), JSON.stringify({ plugin: ["/opt/acp/index.js"], compaction: { auto: false } }))
  await writeFile(path.join(source, "skills/example/SKILL.md"), "synthetic v1")
  await mkdir(path.join(home, ".config/opencode"), { recursive: true })
  const global = path.join(home, ".config/opencode/opencode.json")
  await writeFile(global, "synthetic-user-config")
  await chmod(path.join(source, "opencode.json"), 0o444)
  const runtime = env.OMW_WORKER_PROFILE_DIR
  const configured = { ...env, OMW_WORKER_PROFILE_SOURCE: source }
  const first = await success(configured)
  assert.equal(first.environment.opencodeConfig, true)
  assert.equal(await readFile(path.join(runtime, "skills/example/SKILL.md"), "utf8"), "synthetic v1")
  await writeFile(path.join(runtime, "cache.txt"), "synthetic-runtime-cache")
  await writeFile(path.join(source, "skills/example/SKILL.md"), "synthetic v2")
  await success(configured)
  assert.equal(await readFile(path.join(runtime, "skills/example/SKILL.md"), "utf8"), "synthetic v2")
  await rm(path.join(source, "skills"), { recursive: true })
  await success(configured)
  await assert.rejects(stat(path.join(runtime, "skills/example/SKILL.md")), { code: "ENOENT" })
  assert.equal(await readFile(path.join(runtime, "cache.txt"), "utf8"), "synthetic-runtime-cache")
  assert.equal(await readFile(global, "utf8"), "synthetic-user-config")
}))
test("profile v2 已由操作者完全合併時接受 incoming，重啟不再誤判衝突", () => fixture(async ({ root, env }) => {
  const source = path.join(root, "profile")
  await mkdir(source)
  await writeFile(path.join(source, "opencode.json"), "{}")
  const sourceFile = path.join(source, "AGENTS.md")
  const runtimeFile = path.join(env.OMW_WORKER_PROFILE_DIR, "AGENTS.md")
  await writeFile(sourceFile, "synthetic-v1")
  const configured = { ...env, OMW_WORKER_PROFILE_SOURCE: source }
  await success(configured)
  await writeFile(runtimeFile, "synthetic-user-change")
  await writeFile(sourceFile, "synthetic-v2")
  const conflict = await boot(configured)
  assert.equal(conflict.code, 1)
  assert.equal(await readFile(runtimeFile, "utf8"), "synthetic-user-change")
  await writeFile(runtimeFile, "synthetic-v2")
  await success(configured)
  await success(configured)
  assert.equal(await readFile(runtimeFile, "utf8"), "synthetic-v2")
}))
test("profile 新增檔案與未追蹤 runtime 自訂檔案碰撞時 fail closed，內容不覆寫或洩露", () => fixture(async ({ root, env }) => {
  const source = path.join(root, "profile")
  await mkdir(source)
  await writeFile(path.join(source, "opencode.json"), "{}")
  const configured = { ...env, OMW_WORKER_PROFILE_SOURCE: source }
  await success(configured)
  const runtimeFile = path.join(env.OMW_WORKER_PROFILE_DIR, "AGENTS.md")
  const manifestFile = path.join(env.OMW_WORKER_PROFILE_DIR, ".omw-source-manifest.json")
  const before = await readFile(manifestFile)
  await writeFile(runtimeFile, "synthetic-user-custom-marker")
  await writeFile(path.join(source, "AGENTS.md"), "synthetic-incoming-marker")
  const conflict = await boot(configured)
  assert.equal(conflict.code, 1)
  assert.match(conflict.stderr, /OMW_WORKER_PROFILE_SOURCE/)
  assert.match(conflict.stderr, /未追蹤同名檔案.*備份.*明確合併.*重試/)
  assert.doesNotMatch(conflict.stdout + conflict.stderr, /synthetic-|[a-f0-9]{64}/)
  assert.equal(await readFile(runtimeFile, "utf8"), "synthetic-user-custom-marker")
  assert.deepEqual(await readFile(manifestFile), before)
  await writeFile(runtimeFile, "synthetic-incoming-marker")
  await success(configured)
  assert.equal(await readFile(runtimeFile, "utf8"), "synthetic-incoming-marker")
}))
test("profile partial 升級重試接受已更新檔案，繼續更新仍為 prior 的檔案", () => fixture(async ({ root, env }) => {
  const source = path.join(root, "profile")
  await mkdir(source)
  const configured = { ...env, OMW_WORKER_PROFILE_SOURCE: source }
  const runtime = env.OMW_WORKER_PROFILE_DIR
  const files = { "AGENTS.md": "synthetic-v1", "opencode.json": '{"description":"synthetic-v1"}' }
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(source, name), content)
  await success(configured)
  const manifestFile = path.join(runtime, ".omw-source-manifest.json")
  const prior = await readFile(manifestFile)
  const incoming = { "AGENTS.md": "synthetic-v2", "opencode.json": '{"description":"synthetic-v2"}' }
  for (const [name, content] of Object.entries(incoming)) await writeFile(path.join(source, name), content)
  // 模擬只完成一個檔案、尚未發布新 manifest 的升級；仍只操作 scoped synthetic fixture。
  await writeFile(path.join(runtime, "AGENTS.md"), incoming["AGENTS.md"])
  assert.deepEqual(await readFile(manifestFile), prior)
  await success(configured)
  await success(configured)
  for (const [name, content] of Object.entries(incoming)) assert.equal(await readFile(path.join(runtime, name), "utf8"), content)
}))
test("profile bundle 後段 dirty collision 須先驗完，不先更新設定或移除舊 commands", () => fixture(async ({ root, env }) => {
  const source = path.join(root, "profile")
  await mkdir(path.join(source, "commands"), { recursive: true })
  await mkdir(path.join(source, "skills", "tdd"), { recursive: true })
  const config = path.join(source, "opencode.json")
  const skill = path.join(source, "skills/tdd/SKILL.md")
  await writeFile(config, '{"description":"synthetic-v1"}')
  await writeFile(skill, "synthetic simplified tdd")
  for (const name of ["task-plan", "verify", "deliver"]) await writeFile(path.join(source, `commands/${name}.md`), `synthetic ${name}`)
  const configured = { ...env, OMW_WORKER_PROFILE_SOURCE: source }
  await success(configured)
  const runtime = env.OMW_WORKER_PROFILE_DIR
  const manifest = path.join(runtime, ".omw-source-manifest.json")
  const before = await readFile(manifest)
  await writeFile(path.join(runtime, "skills/tdd/SKILL.md"), "synthetic user tdd")
  await writeFile(config, '{"description":"synthetic-v2"}')
  await writeFile(skill, "synthetic full tdd: [reference](tests.md)")
  await writeFile(path.join(source, "skills/tdd/tests.md"), "synthetic public seam reference")
  await rm(path.join(source, "commands"), { recursive: true })
  const conflict = await boot(configured)
  assert.equal(conflict.code, 1)
  assert.match(conflict.stderr, /OMW_WORKER_PROFILE_SOURCE/)
  assert.doesNotMatch(conflict.stdout + conflict.stderr, /synthetic-|[a-f0-9]{64}/)
  assert.equal(await readFile(path.join(runtime, "opencode.json"), "utf8"), '{"description":"synthetic-v1"}')
  assert.equal(await readFile(path.join(runtime, "skills/tdd/SKILL.md"), "utf8"), "synthetic user tdd")
  await assert.rejects(stat(path.join(runtime, "skills/tdd/tests.md")), { code: "ENOENT" })
  for (const name of ["task-plan", "verify", "deliver"]) assert.equal(await readFile(path.join(runtime, `commands/${name}.md`), "utf8"), `synthetic ${name}`)
  assert.deepEqual(await readFile(manifest), before)
  // 操作者明確合併為 incoming 後可重試；正式同名技能與其 reference 一起生效。
  await writeFile(path.join(runtime, "skills/tdd/SKILL.md"), "synthetic full tdd: [reference](tests.md)")
  await success(configured)
  await success(configured)
  assert.equal(await readFile(path.join(runtime, "opencode.json"), "utf8"), '{"description":"synthetic-v2"}')
  assert.equal(await readFile(path.join(runtime, "skills/tdd/tests.md"), "utf8"), "synthetic public seam reference")
  for (const name of ["task-plan", "verify", "deliver"]) await assert.rejects(stat(path.join(runtime, `commands/${name}.md`)), { code: "ENOENT" })
}))
test("新 curated profile 不預載自訂 commands", () => fixture(async ({ env }) => {
  const source = fileURLToPath(new URL("../../deploy/worker/profile/", import.meta.url))
  const commandSource = path.join(source, "commands")
  try { assert.deepEqual(await readdir(commandSource), []) }
  catch (error) { if (error.code !== "ENOENT") throw error }
  await success({ ...env, OMW_WORKER_PROFILE_SOURCE: source })
  await assert.rejects(stat(path.join(env.OMW_WORKER_PROFILE_DIR, "commands")), { code: "ENOENT" })
}))
test("commands 升級只移除 unchanged managed 檔，保留 user-modified、同名 untracked 與 native/custom", () => fixture(async ({ root, env }) => {
  const source = path.join(root, "profile")
  await mkdir(path.join(source, "commands"), { recursive: true })
  await writeFile(path.join(source, "opencode.json"), "{}")
  for (const name of ["task-plan", "verify"]) await writeFile(path.join(source, `commands/${name}.md`), `synthetic old ${name}`)
  const configured = { ...env, OMW_WORKER_PROFILE_SOURCE: source }
  await success(configured)
  const runtime = env.OMW_WORKER_PROFILE_DIR
  const preserved = {
    "verify.md": "synthetic user-modified verify",
    "deliver.md": "synthetic untracked deliver",
    "custom.md": "synthetic custom command",
    "help.md": "synthetic native-name command",
  }
  for (const [name, content] of Object.entries(preserved)) await writeFile(path.join(runtime, "commands", name), content)
  // 原生／專案 commands 不在 curated runtime 管理範圍，即使同名也不能移除。
  const project = path.join(root, "project/.opencode/commands")
  await mkdir(project, { recursive: true })
  await writeFile(path.join(project, "task-plan.md"), "synthetic project task-plan")
  await rm(path.join(source, "commands"), { recursive: true })
  await success(configured)
  await success(configured)
  await assert.rejects(stat(path.join(runtime, "commands/task-plan.md")), { code: "ENOENT" })
  for (const [name, content] of Object.entries(preserved)) assert.equal(await readFile(path.join(runtime, "commands", name), "utf8"), content)
  assert.equal(await readFile(path.join(project, "task-plan.md"), "utf8"), "synthetic project task-plan")
  const manifest = JSON.parse(await readFile(path.join(runtime, ".omw-source-manifest.json"), "utf8"))
  assert.equal(Object.keys(manifest.files).some(name => name.startsWith("commands/")), false)
}))
test("retained managed CLI 回報 user-modified 舊 command，custom 不誤報、auth 不變且重啟不重複 warn", () => fixture(async ({ root, env, seed, auth }) => {
  const source = path.join(root, "profile")
  await mkdir(path.join(source, "commands"), { recursive: true })
  await writeFile(path.join(source, "opencode.json"), "{}")
  for (const name of ["task-plan", "verify", "deliver"]) await writeFile(path.join(source, `commands/${name}.md`), `synthetic old ${name}`)
  const configured = { ...env, OMW_WORKER_PROFILE_SOURCE: source, OMW_AUTH_SEED_FILE: seed }
  await success(configured)
  const runtime = env.OMW_WORKER_PROFILE_DIR
  await writeFile(path.join(runtime, "commands/verify.md"), "synthetic user-edited-command-value")
  await writeFile(path.join(runtime, "commands/custom.md"), "synthetic custom-command-value")
  const authBefore = await readFile(auth)
  await rm(path.join(source, "commands"), { recursive: true })
  const result = await boot(configured)
  assert.equal(result.code, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.profile, "ready")
  assert.deepEqual(report.profileChanges.retainedManagedFiles, [{ path: "commands/verify.md", reason: "user-modified" }])
  assert.deepEqual(report.profileChanges.removedManagedFiles.sort(), ["commands/deliver.md", "commands/task-plan.md"])
  assert.match(result.stderr, /^\[OMW_WORKER_PROFILE_RETAINED\] /)
  const warning = JSON.parse(result.stderr.trim().slice("[OMW_WORKER_PROFILE_RETAINED] ".length))
  assert.equal(warning.count, 1)
  assert.deepEqual(warning.files, [{ path: "commands/verify.md", reason: "user-modified" }])
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-|custom\.md|[a-f0-9]{64}/)
  assert.equal((result.stdout + result.stderr).includes(root), false)
  assert.equal(await readFile(path.join(runtime, "commands/verify.md"), "utf8"), "synthetic user-edited-command-value")
  assert.equal(await readFile(path.join(runtime, "commands/custom.md"), "utf8"), "synthetic custom-command-value")
  for (const name of ["task-plan", "deliver"]) await assert.rejects(stat(path.join(runtime, `commands/${name}.md`)), { code: "ENOENT" })
  assert.deepEqual(await readFile(auth), authBefore)
  const restart = await boot(configured)
  assert.equal(restart.code, 0, restart.stderr)
  assert.deepEqual(JSON.parse(restart.stdout).profileChanges.retainedManagedFiles, [])
  assert.equal(restart.stderr, "")
}))
test("retained managed initializeWorker 返回值被 startup 忽略時仍向 stderr 回報保留原因", () => fixture(async ({ root, env }) => {
  const source = path.join(root, "profile")
  await mkdir(path.join(source, "commands"), { recursive: true })
  await writeFile(path.join(source, "opencode.json"), "{}")
  await writeFile(path.join(source, "commands/verify.md"), "synthetic old verify")
  const configured = { ...env, OMW_WORKER_PROFILE_SOURCE: source }
  await success(configured)
  const runtime = env.OMW_WORKER_PROFILE_DIR
  await writeFile(path.join(runtime, "commands/verify.md"), "synthetic user command")
  await writeFile(path.join(runtime, "commands/custom.md"), "synthetic untracked command")
  await rm(path.join(source, "commands"), { recursive: true })
  // 與 execution-server 相同：同程序 await 公開初始化入口，完全不消費返回值。
  const script = `import { initializeWorker } from ${JSON.stringify(pathToFileURL(cli).href)}; await initializeWorker(process.env)`
  const result = await runNode(configured, ["--input-type=module", "--eval", script])
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /^\[OMW_WORKER_PROFILE_RETAINED\] /)
  const warning = JSON.parse(result.stderr.trim().slice("[OMW_WORKER_PROFILE_RETAINED] ".length))
  assert.equal(warning.count, 1)
  assert.deepEqual(warning.files, [{ path: "commands/verify.md", reason: "user-modified" }])
  assert.doesNotMatch(result.stderr, /synthetic-|custom\.md|[a-f0-9]{64}/)
  assert.equal(result.stderr.includes(root), false)
  assert.equal(await readFile(path.join(runtime, "commands/verify.md"), "utf8"), "synthetic user command")
  const restart = await runNode(configured, ["--input-type=module", "--eval", script])
  assert.equal(restart.code, 0, restart.stderr)
  assert.equal(restart.stderr, "")
}))
test("retained managed 無衝突升級刪除三個 unchanged commands，回報 removal 且不 warning custom", () => fixture(async ({ root, env }) => {
  const source = path.join(root, "profile")
  await mkdir(path.join(source, "commands"), { recursive: true })
  await writeFile(path.join(source, "opencode.json"), "{}")
  for (const name of ["task-plan", "verify", "deliver"]) await writeFile(path.join(source, `commands/${name}.md`), `synthetic old ${name}`)
  const configured = { ...env, OMW_WORKER_PROFILE_SOURCE: source }
  await success(configured)
  const runtime = env.OMW_WORKER_PROFILE_DIR
  await writeFile(path.join(runtime, "commands/custom.md"), "synthetic custom command")
  await rm(path.join(source, "commands"), { recursive: true })
  const result = await boot(configured)
  assert.equal(result.code, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.profile, "ready")
  assert.deepEqual(report.profileChanges.removedManagedFiles.sort(), ["commands/deliver.md", "commands/task-plan.md", "commands/verify.md"])
  assert.deepEqual(report.profileChanges.retainedManagedFiles, [])
  assert.equal(result.stderr, "")
  for (const name of ["task-plan", "verify", "deliver"]) await assert.rejects(stat(path.join(runtime, `commands/${name}.md`)), { code: "ENOENT" })
  assert.equal(await readFile(path.join(runtime, "commands/custom.md"), "utf8"), "synthetic custom command")
}))
test("commands removal parent symlink/junction fail closed，先驗不改 profile 或外部 target", () => fixture(async ({ root, env }) => {
  const source = path.join(root, "profile")
  await mkdir(path.join(source, "commands"), { recursive: true })
  await writeFile(path.join(source, "opencode.json"), '{"description":"synthetic-v1"}')
  await writeFile(path.join(source, "commands/verify.md"), "synthetic managed verify")
  const configured = { ...env, OMW_WORKER_PROFILE_SOURCE: source }
  await success(configured)
  const runtime = env.OMW_WORKER_PROFILE_DIR
  const manifest = path.join(runtime, ".omw-source-manifest.json")
  const before = await readFile(manifest)
  const target = path.join(root, "outside")
  await mkdir(target)
  await writeFile(path.join(target, "verify.md"), "synthetic managed verify")
  await rm(path.join(runtime, "commands"), { recursive: true })
  await symlink(target, path.join(runtime, "commands"), process.platform === "win32" ? "junction" : "dir")
  await rm(path.join(source, "commands"), { recursive: true })
  await writeFile(path.join(source, "opencode.json"), '{"description":"synthetic-v2"}')
  const conflict = await boot(configured)
  assert.equal(conflict.code, 1)
  assert.match(conflict.stderr, /OMW_WORKER_PROFILE_SOURCE/)
  assert.equal(await readFile(path.join(target, "verify.md"), "utf8"), "synthetic managed verify")
  assert.equal(await readFile(path.join(runtime, "opencode.json"), "utf8"), '{"description":"synthetic-v1"}')
  assert.deepEqual(await readFile(manifest), before)
}))
test("commands removal file symlink 不跟隨 target", { skip: process.platform === "win32" ? "Windows file symlink 需要系統權限；Linux 執行此安全案例" : false }, () => fixture(async ({ root, env }) => {
  const source = path.join(root, "profile")
  await mkdir(path.join(source, "commands"), { recursive: true })
  await writeFile(path.join(source, "opencode.json"), "{}")
  await writeFile(path.join(source, "commands/deliver.md"), "synthetic managed deliver")
  const configured = { ...env, OMW_WORKER_PROFILE_SOURCE: source }
  await success(configured)
  const destination = path.join(env.OMW_WORKER_PROFILE_DIR, "commands/deliver.md")
  const target = path.join(root, "outside.md")
  await writeFile(target, "synthetic managed deliver")
  await rm(destination)
  await symlink(target, destination)
  await rm(path.join(source, "commands"), { recursive: true })
  assert.equal((await boot(configured)).code, 1)
  assert.equal(await readFile(target, "utf8"), "synthetic managed deliver")
}))
test("bundle partial publish 未換 manifest 可續行：已刪 command、已更新 skill、其餘檔案仍為 prior", () => fixture(async ({ root, env }) => {
  const source = path.join(root, "profile")
  await mkdir(path.join(source, "commands"), { recursive: true })
  await mkdir(path.join(source, "skills/tdd"), { recursive: true })
  await writeFile(path.join(source, "opencode.json"), '{"description":"synthetic-v1"}')
  await writeFile(path.join(source, "skills/tdd/SKILL.md"), "synthetic simplified tdd")
  for (const name of ["task-plan", "verify", "deliver"]) await writeFile(path.join(source, `commands/${name}.md`), `synthetic ${name}`)
  const configured = { ...env, OMW_WORKER_PROFILE_SOURCE: source }
  await success(configured)
  const runtime = env.OMW_WORKER_PROFILE_DIR
  const manifest = path.join(runtime, ".omw-source-manifest.json")
  const prior = await readFile(manifest)
  await writeFile(path.join(source, "opencode.json"), '{"description":"synthetic-v2"}')
  await writeFile(path.join(source, "skills/tdd/SKILL.md"), "synthetic full tdd: [reference](tests.md)")
  await writeFile(path.join(source, "skills/tdd/tests.md"), "synthetic reference")
  await rm(path.join(source, "commands"), { recursive: true })
  // 模擬 interruption；沿舊 manifest 接受 incoming 與已不存在的受管檔。
  await writeFile(path.join(runtime, "skills/tdd/SKILL.md"), "synthetic full tdd: [reference](tests.md)")
  await rm(path.join(runtime, "commands/task-plan.md"))
  assert.deepEqual(await readFile(manifest), prior)
  await success(configured)
  await success(configured)
  assert.equal(await readFile(path.join(runtime, "opencode.json"), "utf8"), '{"description":"synthetic-v2"}')
  assert.equal(await readFile(path.join(runtime, "skills/tdd/tests.md"), "utf8"), "synthetic reference")
  for (const name of ["task-plan", "verify", "deliver"]) await assert.rejects(stat(path.join(runtime, `commands/${name}.md`)), { code: "ENOENT" })
  const updated = JSON.parse(await readFile(manifest, "utf8"))
  assert.equal(updated.version, 1)
  assert.equal(Object.keys(updated.files).some(name => name.startsWith("commands/")), false)
}))
test("完整 skill bundle 的新增 reference 未追蹤碰撞先驗 fail closed，明確合併後更新原簡化 skill", () => fixture(async ({ root, env }) => {
  const source = path.join(root, "profile")
  await mkdir(path.join(source, "skills/tdd"), { recursive: true })
  await mkdir(path.join(source, "commands"))
  await writeFile(path.join(source, "opencode.json"), "{}")
  await writeFile(path.join(source, "skills/tdd/SKILL.md"), "synthetic simplified tdd")
  await writeFile(path.join(source, "commands/verify.md"), "synthetic managed verify")
  const configured = { ...env, OMW_WORKER_PROFILE_SOURCE: source }
  await success(configured)
  const runtime = env.OMW_WORKER_PROFILE_DIR
  const reference = path.join(runtime, "skills/tdd/tests.md")
  const manifest = path.join(runtime, ".omw-source-manifest.json")
  const before = await readFile(manifest)
  await writeFile(reference, "synthetic user reference")
  await writeFile(path.join(source, "skills/tdd/SKILL.md"), "synthetic full tdd: [reference](tests.md)")
  await writeFile(path.join(source, "skills/tdd/tests.md"), "synthetic upstream reference")
  await rm(path.join(source, "commands"), { recursive: true })
  const conflict = await boot(configured)
  assert.equal(conflict.code, 1)
  assert.match(conflict.stderr, /未追蹤同名檔案.*備份.*明確合併.*重試/)
  assert.equal(await readFile(path.join(runtime, "skills/tdd/SKILL.md"), "utf8"), "synthetic simplified tdd")
  assert.equal(await readFile(reference, "utf8"), "synthetic user reference")
  assert.equal(await readFile(path.join(runtime, "commands/verify.md"), "utf8"), "synthetic managed verify")
  assert.deepEqual(await readFile(manifest), before)
  await writeFile(reference, "synthetic upstream reference")
  await success(configured)
  await success(configured)
  assert.equal(await readFile(path.join(runtime, "skills/tdd/SKILL.md"), "utf8"), "synthetic full tdd: [reference](tests.md)")
  assert.equal(await readFile(reference, "utf8"), "synthetic upstream reference")
  await assert.rejects(stat(path.join(runtime, "commands/verify.md")), { code: "ENOENT" })
}))
test("profile source 移除後保留 modified runtime，重新引入同名檔案仍保護使用者內容", () => fixture(async ({ root, env }) => {
  const source = path.join(root, "profile")
  await mkdir(source)
  await writeFile(path.join(source, "opencode.json"), "{}")
  const sourceFile = path.join(source, "AGENTS.md")
  const runtimeFile = path.join(env.OMW_WORKER_PROFILE_DIR, "AGENTS.md")
  const manifestFile = path.join(env.OMW_WORKER_PROFILE_DIR, ".omw-source-manifest.json")
  const configured = { ...env, OMW_WORKER_PROFILE_SOURCE: source }
  await writeFile(sourceFile, "synthetic-v1")
  await success(configured)
  await writeFile(runtimeFile, "synthetic-user-custom-marker")
  await success(configured)
  assert.equal(await readFile(runtimeFile, "utf8"), "synthetic-user-custom-marker")
  await rm(sourceFile)
  await success(configured)
  assert.equal(await readFile(runtimeFile, "utf8"), "synthetic-user-custom-marker")
  const removed = await readFile(manifestFile)
  assert.equal(Object.hasOwn(JSON.parse(removed).files, "AGENTS.md"), false)
  await writeFile(sourceFile, "synthetic-reintroduced-marker")
  const conflict = await boot(configured)
  assert.equal(conflict.code, 1)
  assert.match(conflict.stderr, /未追蹤同名檔案.*備份.*明確合併.*重試/)
  assert.doesNotMatch(conflict.stdout + conflict.stderr, /synthetic-|[a-f0-9]{64}/)
  assert.equal(await readFile(runtimeFile, "utf8"), "synthetic-user-custom-marker")
  assert.deepEqual(await readFile(manifestFile), removed)
  await writeFile(runtimeFile, "synthetic-reintroduced-marker")
  await success(configured)
  await success(configured)
  assert.equal(await readFile(runtimeFile, "utf8"), "synthetic-reintroduced-marker")
}))
test("PAT 只在 subprocess memory env；process scoped gh helper 不持久化 PAT 或 identity", () => fixture(async ({ root, env, home }) => {
  const token = path.join(root, "pat")
  await writeFile(token, "synthetic-pat-do-not-persist\n", { mode: 0o400 })
  await writeFile(path.join(home, ".gitconfig"), '[user]\n\tname = Synthetic Owner\n')
  const result = await success({ ...env, OMW_GITHUB_TOKEN_FILE: token })
  assert.equal(result.environment.githubToken, true)
  assert.equal(result.environment.githubConfig, true)
  assert.equal(result.environment.gitConfig, true)
  const helper = await readFile(path.join(env.OMW_WORKER_PROFILE_DIR, "gitconfig"), "utf8")
  assert.match(helper, /gh auth git-credential/)
  assert.doesNotMatch(helper, /synthetic-pat|\[user\]|credential-store/)
  assert.equal(await readFile(path.join(home, ".gitconfig"), "utf8"), '[user]\n\tname = Synthetic Owner\n')
  assert.deepEqual(await readdir(path.join(env.OMW_WORKER_PROFILE_DIR, "gh")), [])
}))
test("PAT 無效或不存在 fail closed／不洩露；保留 existing GH_CONFIG_DIR credentials", () => fixture(async ({ root, env }) => {
  const token = path.join(root, "pat")
  for (const content of ["", "synthetic-pat\nsecond", "synthetic pat"] ) {
    await writeFile(token, content)
    const result = await boot({ ...env, OMW_GITHUB_TOKEN_FILE: token })
    assert.equal(result.code, 1)
    assert.doesNotMatch(result.stderr + result.stdout, /synthetic/)
  }
  const missing = await boot({ ...env, OMW_GITHUB_TOKEN_FILE: path.join(root, "synthetic-missing") })
  assert.equal(missing.code, 1)
  assert.doesNotMatch(missing.stderr, /synthetic/)
  const ghDirectory = path.join(root, "existing-gh")
  await mkdir(ghDirectory, { mode: 0o700 })
  await writeFile(path.join(ghDirectory, "hosts.yml"), "synthetic-existing-gh", { mode: 0o600 })
  await writeFile(token, "synthetic-valid")
  await success({ ...env, GH_CONFIG_DIR: ghDirectory, OMW_GITHUB_TOKEN_FILE: token })
  assert.equal(await readFile(path.join(ghDirectory, "hosts.yml"), "utf8"), "synthetic-existing-gh")
}))
test("operator explicit export 只複製完整 auth 到私有新 seed，不覆寫既有來源", () => fixture(async ({ root, env, seed, auth }) => {
  await success({ ...env, OMW_AUTH_SEED_FILE: seed })
  const destination = path.join(root, "export", "seed.json")
  const result = await boot(env, ["--export-auth-seed", destination])
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { exported: true })
  assert.deepEqual(await readFile(destination), await readFile(auth))
  const before = await readFile(seed)
  assert.equal((await boot(env, ["--export-auth-seed", seed])).code, 1)
  assert.deepEqual(await readFile(seed), before)
  if (process.platform !== "win32") {
    assert.equal((await stat(destination)).mode & 0o777, 0o600)
    assert.equal((await stat(path.dirname(destination))).mode & 0o777, 0o700)
  }
}))
