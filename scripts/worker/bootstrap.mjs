import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, readFile, readlink, symlink, open, link, rename, unlink, rmdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const manifestName = ".omw-source-manifest.json"
const migrationName = ".omw-skills-migration.json"
const object = value => value !== null && typeof value === "object" && !Array.isArray(value)
const text = value => typeof value === "string" && value.length > 0 && !/[\0\r\n]/.test(value)
const digest = value => createHash("sha256").update(value).digest("hex")
const inside = (parent, filename) => filename === parent || filename.startsWith(parent + path.sep)
const fail = message => { throw new Error(message) }
function canonicalJSON(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]"
  if (object(value)) return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalJSON(value[key])).join(",") + "}"
  return JSON.stringify(value)
}
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
async function atomicFile(filename, content, createOnly = false, { directory = privateDirectory, beforePublish } = {}) {
  await directory(path.dirname(filename))
  const info = await metadata(filename)
  if (info && (!info.isFile() || info.isSymbolicLink())) fail("不可覆寫非 regular file。")
  if (info) owned(info)
  const temporary = path.join(path.dirname(filename), `.omw-bootstrap-${randomUUID()}.tmp`)
  try {
    const file = await open(temporary, "wx", 0o600)
    try { await file.writeFile(content); await file.sync() }
    finally { await file.close() }
    if (beforePublish) await beforePublish()
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
    || /[\x00-\x1f\x7f]/.test(name) || name === migrationName || name === manifestName || name === "gitconfig" || name === "gh" || name.startsWith("gh/")
    || name.split("/").includes("auth.json")) fail("Profile 包含保留或無效檔名。")
  return name
}
function profileDirectory(environment) {
  const home = absolute(environment.HOME)
  const runtime = absolute(environment.OMW_WORKER_PROFILE_DIR ?? path.join(home, ".config/omw-profile"))
  const global = path.join(environment.XDG_CONFIG_HOME ? absolute(environment.XDG_CONFIG_HOME) : path.join(home, ".config"), "opencode")
  const skills = path.join(home, ".agents/skills")
  const auth = path.dirname(authPath(environment))
  if (inside(runtime, global) || inside(global, runtime) || inside(runtime, auth) || inside(auth, runtime)
    || inside(runtime, skills) || inside(skills, runtime) || inside(runtime, home)) fail("Profile 必須是獨立的工作目錄。")
  return runtime
}
function collision(name) {
  const error = new Error("Profile collision")
  error.profileCollision = relativeName(name)
  throw error
}
function migrationRetry() {
  const error = new Error("Migration source 改變")
  error.profileRetry = true
  throw error
}
const isSkill = name => name.startsWith("skills/")
const validHash = hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)
async function tree(directory, prefix = "", requireOwner = false) {
  const files = new Map()
  await noSymlinks(directory)
  const info = await metadata(directory)
  if (!info) return files
  if (!info.isDirectory()) fail("Profile root 不是 directory。")
  if (requireOwner) owned(info)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = relativeName(prefix + entry.name)
    const filename = path.join(directory, entry.name)
    if (requireOwner) owned(await lstat(filename))
    if (entry.isDirectory()) for (const [child, bytes] of await tree(filename, name + "/", requireOwner)) files.set(child, bytes)
    else if (entry.isFile()) files.set(name, await regular(filename, 16 * 1024 * 1024))
    else fail("Profile 只允許 regular files/directories。")
  }
  return files
}
async function fileHash(filename) {
  await noSymlinks(filename)
  if (!await metadata(filename)) return null
  owned(await lstat(filename))
  return digest(await regular(filename, 16 * 1024 * 1024))
}
async function copyProfile(environment, changes) {
  if (environment.OMW_WORKER_PROFILE_SOURCE === undefined) return "absent"
  const source = absolute(environment.OMW_WORKER_PROFILE_SOURCE)
  const runtime = profileDirectory(environment)
  const home = absolute(environment.HOME)
  const skills = path.join(home, ".agents/skills")
  const globalConfig = path.join(environment.XDG_CONFIG_HOME ? absolute(environment.XDG_CONFIG_HOME) : path.join(home, ".config"), "opencode")
  const auth = path.dirname(authPath(environment))
  if (inside(source, runtime) || inside(runtime, source) || inside(source, skills) || inside(skills, source)) fail("Profile source/runtime/skills 不可重疊。")
  for (const protectedRoot of [globalConfig, auth]) {
    if (inside(skills, protectedRoot) || inside(protectedRoot, skills) || inside(source, protectedRoot) || inside(protectedRoot, source)) fail("Profile source/skills 與 global config/auth 不可重疊。")
  }
  // HOME 由既有 runtime identity 提供；不搬 source、改 XDG 或建立 mirror/link。
  await noSymlinks(runtime)
  await noSymlinks(skills)
  const files = await tree(source)
  if (!files.has("opencode.json")) fail("Profile 缺少 opencode.json。")
  const config = path.join(runtime, "opencode.json")
  if (environment.OPENCODE_CONFIG && absolute(environment.OPENCODE_CONFIG) !== config) fail("OPENCODE_CONFIG 必須指向 runtime opencode.json。")
  if (environment.OPENCODE_CONFIG_DIR && absolute(environment.OPENCODE_CONFIG_DIR) !== runtime) fail("OPENCODE_CONFIG_DIR 必須指向 runtime profile。")
  const manifestFile = path.join(runtime, manifestName)
  const receiptFile = path.join(runtime, migrationName)
  let prior = { version: 1, files: {} }
  let priorBytes = Buffer.from("")
  if (await metadata(manifestFile)) {
    priorBytes = await regular(manifestFile, 1024 * 1024)
    prior = JSON.parse(priorBytes)
    if (!object(prior) || ![1, 2].includes(prior.version) || !object(prior.files)
      || (prior.version === 2 && (prior.skillsTarget !== "home-agents" || !object(prior.userSkills)))) fail("Profile manifest 無效。")
    for (const [name, hash] of Object.entries(prior.files)) {
      relativeName(name)
      if (!validHash(hash)) fail("Profile manifest 無效。")
    }
    for (const [name, baseline] of Object.entries(prior.userSkills ?? {})) {
      relativeName(name)
      if (!isSkill(name) || name in prior.files || (baseline !== null && !validHash(baseline))) fail("Profile manifest 無效。")
    }
  }
  // v1 skills hashes 僅指 old profile；絕不可據此清除 global 同名使用者檔。
  const target = name => isSkill(name) ? path.join(skills, name.slice(7)) : path.join(runtime, name)
  const oldSkills = await tree(path.join(runtime, "skills"), "skills/", true)
  const globalFiles = await tree(skills, "skills/", true)
  const sourceHashes = Object.fromEntries([...files].map(([name, bytes]) => [name, digest(bytes)]))
  let receipt
  let receiptHash = await fileHash(receiptFile)
  if (receiptHash !== null) {
    receipt = JSON.parse(await regular(receiptFile, 1024 * 1024))
    if (!object(receipt) || receipt.version !== 1 || !validHash(receipt.prior) || !object(receipt.sources) || !object(receipt.moves)) fail("Migration receipt 無效。")
    // manifest 已發布、receipt cleanup 中斷：不把 stale receipt 用於另一輪 source 升級。
    if (prior.version === 2 && receipt.prior !== digest(priorBytes)) receipt = undefined
    else {
      if (receipt.prior !== digest(priorBytes) || canonicalJSON(receipt.sources) !== canonicalJSON(sourceHashes)) migrationRetry()
      for (const [name, move] of Object.entries(receipt.moves)) {
        relativeName(name)
        if (!isSkill(name) || !object(move) || !validHash(move.oldHash) || !validHash(move.hash)
          || typeof move.user !== "boolean" || (move.baseline !== null && !validHash(move.baseline))) fail("Migration receipt 無效。")
        const old = oldSkills.get(name)
        const current = globalFiles.get(name)
        if (old && digest(old) !== move.oldHash) collision(name)
        if (!old && (!current || digest(current) !== move.hash)) collision(name)
      }
    }
  }
  const hashes = Object.create(null)
  const userSkills = Object.create(null)
  const writes = new Map()
  const removals = new Map()
  const moves = Object.create(null)
  const names = new Set([...files.keys(), ...Object.keys(prior.files), ...Object.keys(prior.userSkills ?? {}), ...oldSkills.keys(), ...Object.keys(receipt?.moves ?? {})])
  const planWrite = async (name, content, approvedHash) => {
    const destination = target(name)
    const hash = await fileHash(destination)
    // Caller 已按 ownership／collision 核准這份 bytes（或 absent=null）。重讀只能驗證，
    // 不可把已觀察到的 user late write 重新核准為可覆寫基準；這不是 filesystem CAS。
    if (hash !== approvedHash) collision(name)
    if (approvedHash !== digest(content)) writes.set(destination, { name, content, expected: approvedHash })
  }
  // 全部 collision／移除目標先驗完，避免後段衝突讓設定指向尚未完整更新的 bundle。
  for (const name of names) {
    const content = files.get(name)
    const incoming = sourceHashes[name]
    const baseline = prior.files[name]
    const old = oldSkills.get(name)
    const resumed = receipt?.moves[name]
    if (isSkill(name) && (old || resumed)) {
      const currentBytes = globalFiles.get(name)
      const currentHash = currentBytes ? digest(currentBytes) : null
      const oldHash = old ? digest(old) : resumed.oldHash
      const user = resumed ? resumed.user : prior.version !== 1 || !baseline || oldHash !== baseline
      const sourceBaseline = resumed ? resumed.baseline : prior.version === 1 ? baseline ?? null : null
      let output = old ?? currentBytes
      if (content) {
        if (user && digest(output) !== incoming && incoming !== sourceBaseline) collision(name)
        if (!user || digest(output) === incoming) { output = content; hashes[name] = incoming }
        else userSkills[name] = sourceBaseline
      } else if (user) userSkills[name] = null
      if (content || user) {
        const outputHash = digest(output)
        if (currentHash !== null && currentHash !== outputHash && currentHash !== oldHash) collision(name)
        await planWrite(name, output, currentHash)
        moves[name] = { oldHash, hash: outputHash, user: !hashes[name], baseline: userSkills[name] ?? null }
      }
      if (old) removals.set(path.join(runtime, name), { name, hash: oldHash, migration: true })
      continue
    }
    const destination = target(name)
    const current = await fileHash(destination)
    // v1 target mapping 不授予 global ownership；只有 incoming 相同才可認作已發布。
    const managed = !isSkill(name) || prior.version === 2 ? baseline : undefined
    if (content) {
      if (current === incoming || current === null || current === managed) {
        hashes[name] = incoming
        await planWrite(name, content, current)
      } else if (managed && incoming === managed) hashes[name] = incoming
      else if (isSkill(name) && Object.hasOwn(prior.userSkills ?? {}, name) && incoming === prior.userSkills[name]) {
        userSkills[name] = prior.userSkills[name]
      } else collision(name)
    } else if (managed && current !== null) {
      if (current === managed) removals.set(destination, { name, hash: managed })
      else changes.retainedManagedFiles.push({ path: name, reason: "user-modified" })
    } else if (isSkill(name) && Object.hasOwn(prior.userSkills ?? {}, name) && current !== null) userSkills[name] = null
  }
  const nextManifest = JSON.stringify({ version: 2, skillsTarget: "home-agents", files: hashes, userSkills }) + "\n"
  const expectedManifest = await fileHash(manifestFile)
  if (expectedManifest !== (priorBytes.length ? digest(priorBytes) : null)) fail("Manifest 併發改變。")
  // 只保留 hashes 的 retry receipt：custom 已移除 old、manifest 尚未發布時仍能辨認 user ownership。
  // 先完成全部 preflight；receipt 不放 skills，也不是第二份 skills 或整批 filesystem transaction。
  if (Object.keys(moves).length) {
    const nextReceipt = { version: 1, prior: digest(priorBytes), sources: sourceHashes, moves }
    const bytes = JSON.stringify(nextReceipt) + "\n"
    if (receipt) {
      // 已移走的 old 檔會改變重建 moves 的插入順序；語意比對只忽略 object key order。
      // disk authority 仍是初讀 raw hash，不能用 canonical／重建 bytes 核准 await 期間的改動。
      if (canonicalJSON(receipt) !== canonicalJSON(nextReceipt)) fail("Migration receipt 與重建計畫分歧。")
      if (await fileHash(receiptFile) !== receiptHash) fail("Migration receipt 併發改變。")
    } else {
      if (await fileHash(receiptFile) !== receiptHash) fail("Migration receipt 併發改變。")
      if (receiptHash !== null) await unlink(receiptFile)
      if (!await atomicFile(receiptFile, bytes, true)) fail("Migration receipt 併發建立。")
      receiptHash = digest(bytes)
    }
  }
  // global user directories 可以已有一般 mode；不 chmod 使用者目錄，新建目錄仍為 0700。
  async function skillDirectory(directory) {
    await noSymlinks(directory)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await lstat(directory)
    if (!info.isDirectory()) fail("Skills destination 無效。")
    owned(info)
  }
  async function publish(destination, { name, content, expected }) {
    const check = async () => { if (await fileHash(destination) !== expected) collision(name) }
    await check()
    if (!await atomicFile(destination, content, expected === null, {
      directory: isSkill(name) ? skillDirectory : privateDirectory, beforePublish: check,
    })) collision(name)
  }
  // 每檔 atomic publish，temp bytes 完成後再核對；仍不承諾 filesystem CAS。
  // skills 搬移／清理完成前不發布新 opencode.json，失敗由 startup gate 阻止 execution。
  for (const [destination, plan] of writes) {
    if (destination !== config) await publish(destination, plan)
  }
  for (const [destination, { name, hash, migration }] of removals) {
    const current = await fileHash(destination)
    if (current === null) continue
    if (migration && moves[name] && await fileHash(target(name)) !== moves[name].hash) collision(name)
    if (current === hash) {
      await unlink(destination)
      // 搬移使用者檔不是 source-owned cleanup，不把它標成 removedManagedFiles。
      if (!migration || (prior.files[name] && !files.has(name) && !moves[name]?.user)) changes.removedManagedFiles.push(name)
    } else {
      if (migration) collision(name)
      changes.retainedManagedFiles.push({ path: name, reason: "user-modified" })
    }
  }
  // 只移除 owned 且空的 old skills directories，user late child 或 link 一律 fatal。
  async function removeEmpty(directory) {
    await noSymlinks(directory)
    const info = await metadata(directory)
    if (!info) return
    if (!info.isDirectory()) fail("Old skills root 無效。")
    owned(info)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) fail("Old skills 有併發新增檔案。")
      await removeEmpty(path.join(directory, entry.name))
    }
    await rmdir(directory)
  }
  await removeEmpty(path.join(runtime, "skills"))
  for (const [name, move] of Object.entries(moves)) {
    if (await fileHash(target(name)) !== move.hash) collision(name)
  }
  if (writes.has(config)) await publish(config, writes.get(config))
  if (await fileHash(manifestFile) !== expectedManifest) fail("Manifest 併發改變。")
  const checkManifest = async () => { if (await fileHash(manifestFile) !== expectedManifest) fail("Manifest 併發改變。") }
  if (!await atomicFile(manifestFile, nextManifest, expectedManifest === null, { beforePublish: checkManifest })) fail("Manifest 併發建立。")
  if (receiptHash !== null) {
    if (await fileHash(receiptFile) !== receiptHash) fail("Migration receipt 併發改變。")
    await unlink(receiptFile)
  }
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
  catch (error) {
    throw new Error(message + (error.profileCollision ? ` [OMW_WORKER_PROFILE_COLLISION] ${JSON.stringify({ path: error.profileCollision })}` : "")
      + (error.profileRetry ? " [OMW_WORKER_PROFILE_MIGRATION_RETRY] 遷移未完成時來源已變更；請以同一份來源完成重試後再升級。" : ""))
  }
}

/** 同程序 startup hook；不可把它改成常駐 wrapper，否則會破壞 execution PID ownership。 */
export async function initializeWorker(environment = process.env) {
  const profileChanges = { removedManagedFiles: [], retainedManagedFiles: [] }
  const auth = await safeStep("OMW_AUTH_SEED_FILE 初始化失敗：檢查完整 OAuth JSON、來源可讀及私有目的地權限；execution 不啟動。", () => seedAuth(environment))
  const profile = await safeStep("OMW_WORKER_PROFILE_SOURCE 初始化失敗：檢查 curated source、獨立可寫 profile 與 runtime config 路徑；若來源升級與 runtime 修改分歧，或來源新增檔案與未追蹤同名檔案衝突，請先備份並明確合併為與來源相同的內容後重試；execution 不啟動。", () => copyProfile(environment, profileChanges))
  // Startup caller 可忽略返回值；共同初始化入口仍須讓操作人看到保留原因，只輸出已驗證的受管 relative paths。
  if (profileChanges.retainedManagedFiles.length) console.warn("[OMW_WORKER_PROFILE_RETAINED] " + JSON.stringify({ count: profileChanges.retainedManagedFiles.length, files: profileChanges.retainedManagedFiles }))
  const dependencies = await safeStep("OMW_WORKER_DEPENDENCIES_SOURCE 初始化失敗：檢查固定 image dependencies 與既有 configdir 的完整離線依賴；execution 不啟動。", () => prepareDependencies(environment))
  const githubStatus = await safeStep("OMW_GITHUB_TOKEN_FILE 初始化失敗：檢查 readonly PAT file 與私有 Git/gh 工作目錄；execution 不啟動。", () => github(environment))
  return { auth, profile, profileChanges, dependencies, github: githubStatus, environment: {
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
