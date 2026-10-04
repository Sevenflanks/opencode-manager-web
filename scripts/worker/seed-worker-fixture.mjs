// 只在離線 one-shot、已停止的私有 volume 執行；秘密及 digest 不離開 fixture。
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, writeFile, mkdir, stat, chmod } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const auth = "/home/node/.local/share/opencode/auth.json"
const state = "/home/node/.omw-seed-check"
const seed = "/run/secrets/auth_seed"
const digest = value => createHash("sha256").update(value).digest("hex")
const load = async filename => JSON.parse(await readFile(filename, "utf8"))
const put = (filename, value) => writeFile(filename, JSON.stringify(value), { mode: 0o600, flag: "wx" })
const snapshot = async () => {
  const bytes = await readFile(auth), value = JSON.parse(bytes)
  return { file: digest(bytes), access: digest(value.openai.access), refresh: digest(value.openai.refresh), expires: value.openai.expires }
}

export function classifyNativeRejection(error) {
  const text = JSON.stringify(error ?? {}).toLowerCase()
  return /refresh_token_reused|refresh token.*already.*used/.test(text) ? "REFRESH_TOKEN_REUSED"
    : /invalid_grant|refresh_token_expired|refresh token.*expired|refresh.*(?:401|403)/.test(text) ? "AUTH_REFRESH_REJECTED"
    : /model_not_found|unsupported.model|model.*not.*supported|does not exist/.test(text) ? "MODEL_REJECTED"
    : /unauthorized|invalid.api.key|401/.test(text) ? "AUTH_REJECTED"
    : /403|forbidden/.test(text) ? "PROVIDER_FORBIDDEN" : "NATIVE_REJECTION_UNCLASSIFIED"
}

async function run() {
  const [action, argument, sourcePath] = process.argv.slice(2)
  if (action === "inventory") {
    const manifest = await load("/opt/omw-worker/toolchain-versions.json")
    console.log(JSON.stringify({ nodeActual: process.versions.node, runtimePinned: manifest.runtime,
      toolsPinned: Object.fromEntries(Object.entries(manifest.tools).map(([name, tool]) => [name, tool.version])) }))
    return
  }
  if (action === "message-audit") {
    assert.match(argument, /^ses_[a-zA-Z0-9]+$/)
    const { DatabaseSync } = await import("node:sqlite")
    const db = new DatabaseSync("/home/node/.local/share/opencode/opencode.db", { readOnly: true })
    try {
      const messages = db.prepare("SELECT data FROM message WHERE session_id = ?").all(argument).map(row => JSON.parse(row.data))
      const rejection = messages.find(m => m.role === "assistant" && m.error)?.error
      const text = JSON.stringify(rejection ?? {}).toLowerCase()
      const status = rejection?.data?.statusCode ?? rejection?.statusCode
      console.log(JSON.stringify({ assistantErrorPresent: Boolean(rejection), reason: classifyNativeRejection(rejection),
        httpStatus: [400, 401, 403, 404, 429, 500, 502, 503].includes(status) ? status : null,
        authRejectedText: /unauthorized|invalid.api.key|incorrect.api.key/.test(text),
        mentionsRefreshFailure: /refresh/.test(text), modelRejectedText: /model_not_found|unsupported.model|model.*not.*supported/.test(text) }))
    } finally { db.close() }
    return
  }
  if (action === "export") {
    assert.ok(sourcePath.startsWith("/source/") && !sourcePath.includes(".."))
    const bytes = await readFile(sourcePath)
    const { exportAuthSeed } = await import("/opt/omw/scripts/worker/bootstrap.mjs")
    // Windows bind mount 不提供 Unix 0700 語意；官方 export 在私有 Linux tmp 執行，
    // 再 wx 複製至本輪已套用 Windows 私有 ACL 的 host artifact boundary。
    await mkdir("/tmp/omw-seed-export", { mode: 0o700 })
    const temporary = `/tmp/omw-seed-export/${argument}`
    const privateHome = "/tmp/omw-seed-export/home"
    await mkdir(`${privateHome}/.local/share/opencode`, { recursive: true, mode: 0o700 })
    await writeFile(`${privateHome}/.local/share/opencode/auth.json`, bytes, { flag: "wx", mode: 0o600 })
    await exportAuthSeed(temporary, { HOME: privateHome })
    assert.ok((await readFile(temporary)).equals(bytes))
    await writeFile(`/export/${argument}`, bytes, { flag: "wx", mode: 0o600 })
    await put("/export/.source-baseline.json", { file: digest(bytes) })
    const sourceInfo = await stat(sourcePath), sourceParent = await stat(path.dirname(sourcePath))
    console.log(JSON.stringify({ exported: true, fullMapIdentical: true, exportedUsingPrivateSnapshot: true,
      originalAuthMode600: (sourceInfo.mode & 0o777) === 0o600,
      originalParentMode700: (sourceParent.mode & 0o777) === 0o700 }))
    return
  }
  if (action === "source-audit") {
    const baseline = await load("/export/.source-baseline.json")
    console.log(JSON.stringify({ sourceUnchanged: digest(await readFile(sourcePath)) === baseline.file,
      exportedSeedUnchanged: digest(await readFile(`/export/${argument}`)) === baseline.file }))
    return
  }
  if (action === "prepare-login") {
    const { initializeWorker } = await import("/opt/omw/scripts/worker/bootstrap.mjs")
    await initializeWorker()
    await mkdir("/workspace/seed-check", { mode: 0o700 })
    await put("/workspace/seed-check/opencode.json", { snapshot: false, share: "disabled",
      permission: { "*": "deny" }, tools: { "*": false }, agent: { title: { disable: true }, summary: { disable: true } }, compaction: { auto: false } })
    console.log(JSON.stringify({ emptyLoginWorkspacePrepared: true, authInitiated: false }))
    return
  }
  if (action === "prepare") {
    assert.ok(["a", "b"].includes(argument))
    const { initializeWorker } = await import("/opt/omw/scripts/worker/bootstrap.mjs")
    const result = await initializeWorker()
    assert.equal(result.auth, "seeded")
    await mkdir(state, { mode: 0o700 })
    const initial = await readFile(auth), seedBytes = await readFile(seed)
    assert.ok(initial.equals(seedBytes))
    const value = JSON.parse(initial)
    // 只對本輪私有副本人工過期；不修改 seed，不自行實作 OAuth refresh。
    value.openai.expires = 0
    await writeFile(auth, JSON.stringify(value), { mode: 0o600 })
    await chmod(auth, 0o600)
    await put(`${state}/before.json`, { ...await snapshot(), seed: digest(seedBytes) })
    await mkdir("/workspace/seed-check", { mode: 0o700 })
    await writeFile(`/workspace/seed-check/marker-${argument}.txt`, `WORKER_${argument.toUpperCase()}_MARKER`, { flag: "wx" })
    await put("/workspace/seed-check/opencode.json", { snapshot: false, share: "disabled",
      permission: { "*": "deny" }, tools: { "*": false }, agent: { title: { disable: true }, summary: { disable: true } },
      compaction: { auto: false } })
    console.log(JSON.stringify({ initializedFromFullSeed: true, artificialExpiry: true, privateOnly: true }))
    return
  }
  if (action === "audit") {
    assert.ok(["after-prompt", "after-restart"].includes(argument))
    const before = await load(`${state}/before.json`), after = await snapshot()
    const info = await stat(auth), parent = await stat(path.dirname(auth)), seedInfo = await stat(seed)
    const evidence = { authMode600: (info.mode & 0o777) === 0o600, parentMode700: (parent.mode & 0o777) === 0o700,
      ownerUid1000: info.uid === 1000 && parent.uid === 1000,
      separateSeedInode: info.dev !== seedInfo.dev || info.ino !== seedInfo.ino,
      seedUnchanged: digest(await readFile(seed)) === before.seed,
      changed: { access: after.access !== before.access, refresh: after.refresh !== before.refresh, expires: after.expires !== before.expires } }
    if (argument === "after-prompt") await put(`${state}/updated.json`, after)
    else {
      evidence.privateAuthPreserved = after.file === (await load(`${state}/updated.json`)).file
      evidence.refreshObservedBeforeRestart = evidence.changed.access && evidence.changed.refresh && evidence.changed.expires
    }
    console.log(JSON.stringify(evidence))
    return
  }
  throw new Error("INVALID_FIXTURE_ACTION")
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run().catch(() => { console.error("PRIVATE_FIXTURE_FAILED"); process.exitCode = 1 })
