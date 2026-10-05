import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile, chmod, stat, readdir, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
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
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["ignore", "pipe", "pipe"] })
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
