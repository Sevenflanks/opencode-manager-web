import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, readFile, readlink, symlink, open, link, rename, unlink } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const manifestName = ".omw-source-manifest.json"
const object = value => value !== null && typeof value === "object" && !Array.isArray(value)
const text = value => typeof value === "string" && value.length > 0 && !/[\0\r\n]/.test(value)
const digest = value => createHash("sha256").update(value).digest("hex")
const inside = (parent, filename) => filename === parent || filename.startsWith(parent + path.sep)
const fail = message => { throw new Error(message) }
function absolute(value) {
  if (!value || !path.isAbsolute(value)) fail("路徑必須是 absolute path。")
  return path.resolve(value)
}
async function metadata(filename) {
  try { return await lstat(filename) }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error }
}
function owned(info) {
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) fail("目標不是目前使用者擁有。")
}
function privateMode(info, mode) {
  owned(info)
  if (process.platform !== "win32" && (info.mode & 0o777) !== mode) fail("目標權限不是私有 mode。")
}
async function noSymlinks(filename) {
  let current = path.resolve(filename)
  while (true) {
    const info = await metadata(current)
    if (info?.isSymbolicLink()) fail("不可使用 symlink。")
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}
async function privateDirectory(directory) {
  await noSymlinks(directory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory()) fail("目標不是 directory。")
  privateMode(info, 0o700)
}
async function regular(filename, limit) {
  await noSymlinks(filename)
  const info = await lstat(filename)
  if (!info.isFile() || info.size > limit) fail("來源必須是大小受限的 regular file。")
  return readFile(filename)
}
async function existingAuth(filename) {
  // 先 lstat 工作副本；存在時完全不讀舊 seed，也不讀取既有 auth 內容。
  const info = await metadata(filename)
  if (!info) return false
  if (!info.isFile()) fail("既有 auth 必須是 regular file。")
  await noSymlinks(filename)
  privateMode(info, 0o600)
  privateMode(await lstat(path.dirname(filename)), 0o700)
  return true
}
function validateAuth(content) {
  const value = JSON.parse(content.toString("utf8"))
  if (!object(value) || !object(value.openai) || value.openai.type !== "oauth") fail("需要完整 OpenAI OAuth。")
  for (const entry of Object.values(value)) {
    if (!object(entry)) fail("auth entry 無效。")
    if (entry.type === "oauth") {
      if (!text(entry.access) || !text(entry.refresh) || !Number.isSafeInteger(entry.expires) || entry.expires < 0
        || (entry.accountId !== undefined && typeof entry.accountId !== "string")
        || (entry.enterpriseUrl !== undefined && typeof entry.enterpriseUrl !== "string")) fail("OAuth 欄位無效。")
    } else if (entry.type === "api") {
      if (!text(entry.key) || (entry.metadata !== undefined && (!object(entry.metadata)
        || Object.values(entry.metadata).some(item => typeof item !== "string")))) fail("API auth 無效。")
    } else if (entry.type === "wellknown") {
      if (!text(entry.key) || !text(entry.token)) fail("Well-known auth 無效。")
    } else fail("auth type 無效。")
  }
}
async function atomicFile(filename, content, createOnly = false) {
  await privateDirectory(path.dirname(filename))
  const info = await metadata(filename)
  if (info && (!info.isFile() || info.isSymbolicLink())) fail("不可覆寫非 regular file。")
  if (info) owned(info)
  const temporary = path.join(path.dirname(filename), `.omw-bootstrap-${randomUUID()}.tmp`)
  try {
    const file = await open(temporary, "wx", 0o600)
    try { await file.writeFile(content); await file.sync() }
    finally { await file.close() }
    // rename 會覆寫併發 winner；hard-link publish 只在 destination 不存在時成功。
    if (createOnly) {
      try { await link(temporary, filename) }
      catch (error) { if (error.code === "EEXIST") return false; throw error }
    } else await rename(temporary, filename)
    return true
  } finally {
    try { await unlink(temporary) } catch (error) { if (error.code !== "ENOENT") throw error }
  }
}
function authPath(environment) {
  const home = absolute(environment.HOME)
  return path.join(environment.XDG_DATA_HOME ? absolute(environment.XDG_DATA_HOME) : path.join(home, ".local/share"), "opencode/auth.json")
}
async function seedAuth(environment) {
  if (environment.OMW_AUTH_SEED_FILE === undefined) return "absent"
  const destination = authPath(environment)
  if (await existingAuth(destination)) return "existing"
  const content = await regular(absolute(environment.OMW_AUTH_SEED_FILE), 1024 * 1024)
  validateAuth(content)
  const created = await atomicFile(destination, content, true)
  if (!created && !await existingAuth(destination)) fail("併發 auth 初始化失敗。")
  return created ? "seeded" : "existing"
}
function relativeName(name) {
  if (typeof name !== "string" || !name || path.isAbsolute(name) || name.includes("\\")
    || name.split("/").some(part => !part || part === "." || part === "..")
    || name === manifestName || name === "gitconfig" || name === "gh" || name.startsWith("gh/")
    || name.split("/").includes("auth.json")) fail("Profile 包含保留或無效檔名。")
  return name
}
function profileDirectory(environment) {
  const home = absolute(environment.HOME)
  const runtime = absolute(environment.OMW_WORKER_PROFILE_DIR ?? path.join(home, ".config/omw-profile"))
  const global = path.join(environment.XDG_CONFIG_HOME ? absolute(environment.XDG_CONFIG_HOME) : path.join(home, ".config"), "opencode")
  if (inside(runtime, global) || inside(global, runtime) || inside(runtime, authPath(environment))) fail("Profile 必須是獨立的工作目錄。")
  return runtime
}
async function copyProfile(environment) {
  if (environment.OMW_WORKER_PROFILE_SOURCE === undefined) return "absent"
  const source = absolute(environment.OMW_WORKER_PROFILE_SOURCE)
  const runtime = profileDirectory(environment)
  if (inside(source, runtime) || inside(runtime, source)) fail("Profile source/runtime 不可重疊。")
  const files = new Map()
  async function collect(directory, prefix = "") {
    await noSymlinks(directory)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = relativeName(prefix + entry.name)
      if (entry.isDirectory()) await collect(path.join(directory, entry.name), name + "/")
      else if (entry.isFile()) files.set(name, await regular(path.join(directory, entry.name), 16 * 1024 * 1024))
      else fail("Profile 只允許 regular files/directories。")
    }
  }
  await collect(source)
  if (!files.has("opencode.json")) fail("Profile 缺少 opencode.json。")
  const config = path.join(runtime, "opencode.json")
  if (environment.OPENCODE_CONFIG && absolute(environment.OPENCODE_CONFIG) !== config) fail("OPENCODE_CONFIG 必須指向 runtime opencode.json。")
  if (environment.OPENCODE_CONFIG_DIR && absolute(environment.OPENCODE_CONFIG_DIR) !== runtime) fail("OPENCODE_CONFIG_DIR 必須指向 runtime profile。")
  await privateDirectory(runtime)
  const manifestFile = path.join(runtime, manifestName)
  let prior = { version: 1, files: {} }
  if (await metadata(manifestFile)) {
    prior = JSON.parse((await regular(manifestFile, 1024 * 1024)).toString("utf8"))
    if (!object(prior) || prior.version !== 1 || !object(prior.files)) fail("Profile manifest 無效。")
    for (const [name, hash] of Object.entries(prior.files)) {
      relativeName(name)
      if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) fail("Profile manifest 無效。")
    }
  }
  const hashes = Object.create(null)
  for (const [name, content] of files) {
    const destination = path.join(runtime, name)
    hashes[name] = digest(content)
    if (await metadata(destination)) {
      const current = digest(await regular(destination, 16 * 1024 * 1024))
      // 接受操作者已合併或上次部分升級的成果，即使 manifest 還是舊版也可重試。
      if (current === hashes[name]) continue
      if (!prior.files[name]) fail("Profile 新增來源與未追蹤 runtime 檔案衝突。")
      if (prior.files[name] && current !== prior.files[name]) {
        if (hashes[name] !== prior.files[name]) fail("Profile 升級與使用者修改衝突。")
        continue
      }
    }
    await atomicFile(destination, content)
  }
  // Manifest 只管理 curated files；cache／使用者新增檔案不做 recursive cleanup。
  for (const name of Object.keys(prior.files)) if (!files.has(name)) {
    const destination = path.join(runtime, name)
    if (await metadata(destination)) {
      await noSymlinks(destination)
      const info = await lstat(destination)
      if (!info.isFile()) fail("Managed profile file 不是 regular file。")
      owned(info)
      if (digest(await regular(destination, 16 * 1024 * 1024)) === prior.files[name]) await unlink(destination)
    }
  }
  await atomicFile(manifestFile, JSON.stringify({ version: 1, files: hashes }) + "\n")
  environment.OPENCODE_CONFIG = config
  environment.OPENCODE_CONFIG_DIR = runtime
  return "ready"
}
function quoteGit(value) {
  if (/[\r\n\0]/.test(value)) fail("Git config path 無效。")
  return JSON.stringify(value.replaceAll("\\", "/"))
}
const dependencyGroups = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
function declaredDependencies(pkg) {
  if (!object(pkg)) fail("Dependency manifest 無效。")
  const result = new Set()
  for (const group of dependencyGroups) {
    if (pkg[group] === undefined) continue
    if (!object(pkg[group])) fail("Dependency manifest 無效。")
    for (const [name, version] of Object.entries(pkg[group])) {
      if (!text(version)) fail("Dependency manifest 無效。")
      result.add(name)
    }
  }
  return result
}
async function prepareDependencies(environment) {
  if (environment.OMW_WORKER_DEPENDENCIES_SOURCE === undefined) return "absent"
  if (environment.OMW_WORKER_PROFILE_SOURCE === undefined) fail("Dependencies 需要 curated profile。")
  const source = absolute(environment.OMW_WORKER_DEPENDENCIES_SOURCE)
  const modules = path.join(source, "node_modules")
  await noSymlinks(modules)
  if (!(await lstat(modules)).isDirectory()) fail("Dependencies 缺少 node_modules。")
  const packageContent = await regular(path.join(source, "package.json"), 1024 * 1024)
  const lockContent = await regular(path.join(source, "package-lock.json"), 16 * 1024 * 1024)
  const pkg = JSON.parse(packageContent)
  const lock = JSON.parse(lockContent)
  const available = declaredDependencies(lock.packages?.[""])
  const plugin = "@opencode-ai/plugin"
  if (pkg.dependencies?.[plugin] !== "1.18.34" || lock.packages?.[`node_modules/${plugin}`]?.version !== "1.18.34"
    || [...declaredDependencies(pkg)].some(name => !available.has(name))) fail("Image dependency lock 無效。")
  const home = absolute(environment.HOME)
  const global = path.join(environment.XDG_CONFIG_HOME ? absolute(environment.XDG_CONFIG_HOME) : path.join(home, ".config"), "opencode")
  for (const directory of [profileDirectory(environment), global]) {
    // 普通 global 可已存在且非 0700；不改使用者設定或權限，也不遞迴複製 npm .bin symlinks。
    await noSymlinks(directory)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const directoryInfo = await lstat(directory)
    if (!directoryInfo.isDirectory()) fail("Dependency destination 無效。")
    owned(directoryInfo)
    const packageFile = path.join(directory, "package.json")
    const lockFile = path.join(directory, "package-lock.json")
    const targetModules = path.join(directory, "node_modules")
    const currentPackage = await metadata(packageFile)
    const currentLock = await metadata(lockFile)
    const currentModules = await metadata(targetModules)
    if (currentPackage || currentLock || currentModules) {
      if (!currentPackage || !currentLock || !currentModules) fail("既有 dependencies 不完整。")
      const current = JSON.parse(await regular(packageFile, 1024 * 1024))
      const installedLock = JSON.parse(await regular(lockFile, 16 * 1024 * 1024))
      const locked = declaredDependencies(installedLock.packages?.[""])
      if (installedLock.packages?.[`node_modules/${plugin}`]?.version !== "1.18.34" || !locked.has(plugin)
        || [...declaredDependencies(current)].some(name => !locked.has(name))) fail("既有 dependencies 需離線準備。")
      if (currentModules.isSymbolicLink()) {
        if (await readlink(targetModules) !== modules) fail("Dependency link 不屬於 image。")
      } else if (!currentModules.isDirectory()) fail("Dependency destination 無效。")
      const installedPlugin = JSON.parse(await readFile(path.join(targetModules, plugin, "package.json")))
      if (installedPlugin.version !== "1.18.34") fail("既有 plugin 版本不符。")
      continue
    }
    // OpenCode 1.18.34 用 package/lock 的名稱判斷是否 reify；兩個 configdir 都要準備。
    // 只允許本函式建立指向固定 image 的 link；curated profile 的一般 copy 仍拒絕 symlink。
    // global 既有權限不必改成 private；package/lock 不含秘密。
    for (const [filename, content] of [[packageFile, packageContent], [lockFile, lockContent]]) {
      const file = await open(filename, "wx", 0o600)
      try { await file.writeFile(content); await file.sync() } finally { await file.close() }
    }
    await symlink(modules, targetModules, "dir")
  }
  return "ready"
}
async function github(environment) {
  if (environment.OMW_GITHUB_TOKEN_FILE === undefined) return "absent"
  const token = (await regular(absolute(environment.OMW_GITHUB_TOKEN_FILE), 4096)).toString("utf8").replace(/\r?\n$/, "")
  if (!token || /\s|\0/.test(token)) fail("PAT 必須是單行 token。")
  const runtime = profileDirectory(environment)
  const ghDirectory = environment.GH_CONFIG_DIR ? absolute(environment.GH_CONFIG_DIR) : path.join(runtime, "gh")
  await privateDirectory(ghDirectory)
  const gitConfig = path.join(runtime, "gitconfig")
  // 保留 owner 自行選擇的 identity config，但不讀取它或 gh 既有 credentials。
  const ownerConfig = environment.GIT_CONFIG_GLOBAL ? absolute(environment.GIT_CONFIG_GLOBAL) : path.join(absolute(environment.HOME), ".gitconfig")
  const include = ownerConfig === gitConfig ? "" : `[include]\n\tpath = ${quoteGit(ownerConfig)}\n`
  if (ownerConfig !== gitConfig) await atomicFile(gitConfig, `${include}[credential "https://github.com"]\n\thelper =\n\thelper = !gh auth git-credential\n`)
  else {
    const info = await lstat(gitConfig)
    await noSymlinks(gitConfig)
    if (!info.isFile()) fail("Git helper config 必須是 regular file。")
    privateMode(info, 0o600)
  }
  environment.GH_TOKEN = token
  environment.GH_CONFIG_DIR = ghDirectory
  environment.GIT_CONFIG_GLOBAL = gitConfig
  return "ready"
}
async function safeStep(message, operation) {
  try { return await operation() }
  catch { throw new Error(message) }
}

/** 同程序 startup hook；不可把它改成常駐 wrapper，否則會破壞 execution PID ownership。 */
export async function initializeWorker(environment = process.env) {
  const auth = await safeStep("OMW_AUTH_SEED_FILE 初始化失敗：檢查完整 OAuth JSON、來源可讀及私有目的地權限；execution 不啟動。", () => seedAuth(environment))
  const profile = await safeStep("OMW_WORKER_PROFILE_SOURCE 初始化失敗：檢查 curated source、獨立可寫 profile 與 runtime config 路徑；若來源升級與 runtime 修改分歧，或來源新增檔案與未追蹤同名檔案衝突，請先備份並明確合併為與來源相同的內容後重試；execution 不啟動。", () => copyProfile(environment))
  const dependencies = await safeStep("OMW_WORKER_DEPENDENCIES_SOURCE 初始化失敗：檢查固定 image dependencies 與既有 configdir 的完整離線依賴；execution 不啟動。", () => prepareDependencies(environment))
  const githubStatus = await safeStep("OMW_GITHUB_TOKEN_FILE 初始化失敗：檢查 readonly PAT file 與私有 Git/gh 工作目錄；execution 不啟動。", () => github(environment))
  return { auth, profile, dependencies, github: githubStatus, environment: {
    opencodeConfig: Boolean(environment.OPENCODE_CONFIG && environment.OPENCODE_CONFIG_DIR),
    githubToken: Boolean(environment.GH_TOKEN), githubConfig: Boolean(environment.GH_CONFIG_DIR), gitConfig: Boolean(environment.GIT_CONFIG_GLOBAL),
  } }
}

/** 只有操作者明確 CLI export 才讀取目前 auth；從不提供 HTTP 入口。 */
export async function exportAuthSeed(destination, environment = process.env) {
  return safeStep("Auth seed export 失敗：檢查私有來源與不存在的外部目的檔；不覆寫既有 seed。", async () => {
    const source = authPath(environment)
    if (!await existingAuth(source)) fail("Auth 不存在。")
    const content = await regular(source, 1024 * 1024)
    validateAuth(content)
    if (!await atomicFile(absolute(destination), content, true)) fail("Seed 已存在。")
    return { exported: true }
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let result
    if (process.argv.length === 2) result = await initializeWorker()
    else if (process.argv.length === 4 && process.argv[2] === "--export-auth-seed") result = await exportAuthSeed(process.argv[3])
    else fail("Usage: node scripts/worker/bootstrap.mjs [--export-auth-seed ABSOLUTE_FILE]")
    console.log(JSON.stringify(result))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
