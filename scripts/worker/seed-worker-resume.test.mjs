import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { prepareLocalSeed, validateSeedResume, validateSeedSourceVolume } from "./verify-seed-workers.mjs"

function resumeRecord({ repo, seedFile, sourceFile }) {
  const runId = "omw-seed-0123456789abcdef", context = "local-test"
  const seedSource = sourceFile ? { file: sourceFile } : { synthetic: true }
  return { repo, seedFile, context, seedSource, allowProvider: Boolean(sourceFile),
    owner: { runId, context, repo, seedSource, exportedSeed: seedFile, realDataRetained: Boolean(sourceFile), lifecycle_result: { status: "stopped" } },
    binding: { runId, context, repo }, evidence: { runId, prompts: [] } }
}

async function fixture(verify) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode", "omw-seed-resume-test-"))
  try {
    const repo = path.join(directory, "checkout"), exported = path.join(directory, "private-export")
    await mkdir(repo); await mkdir(exported)
    await verify({ directory, repo, seedFile: path.join(exported, "owned-seed.json") })
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test("synthetic 已停止零 prompt 的 run 重用原 seed version，不重新建立檔案", { timeout: 5_000 }, async () => {
  await fixture(async ({ repo, seedFile }) => {
    await prepareLocalSeed({ repo, seedFile, resume: false })
    const before = await readFile(seedFile), identity = await stat(seedFile)
    validateSeedResume(resumeRecord({ repo, seedFile }))
    const result = await prepareLocalSeed({ repo, seedFile, resume: true })
    assert.equal(result.detail.reusedOwnedVersion, true)
    assert.deepEqual(await readFile(seedFile), before)
    const after = await stat(seedFile)
    assert.equal(after.ino, identity.ino); assert.equal(after.mtimeMs, identity.mtimeMs)
  })
})

function loginOwnerRecord() {
  const runId = "omw-seed-0123456789abcdef"
  const containers = [
    { id: "synthetic-manager", service: "manager", volumes: [{ name: `${runId}-a_manager-data`, destination: "/data" }] },
    { id: "synthetic-execution", service: "execution", volumes: [
      { name: `${runId}-a_execution-home`, destination: "/home/node" },
      { name: `${runId}-a_workspace`, destination: "/workspace" },
    ] },
  ]
  return { runId, context: "local-test", workers: [{ side: "a", project: `${runId}-a`, seedEnabled: false }],
    seedSource: { synthetic: true }, exportedSeed: null, realDataRetained: true,
    a: { containers }, retainedVolumes: [`${runId}-a_manager-data`, `${runId}-a_execution-home`, `${runId}-a_workspace`],
    final_disposition: { requested: "Preserve", status: "preserved" }, lifecycle_result: { status: "preserved" } }
}

test("prepare-login writer 形狀的 JSON roundtrip 接受已記錄 execution-home，且不修改 record", () => {
  const owner = JSON.parse(JSON.stringify(loginOwnerRecord())), before = structuredClone(owner)
  validateSeedSourceVolume({ owner, context: "local-test", sourceVolume: "omw-seed-0123456789abcdef-a_execution-home" })
  assert.deepEqual(owner, before)
})

test("source owner 的已知欄位形狀無效時 fail closed，不能將 scalar 當 volume list", () => {
  const sourceVolume = "omw-seed-0123456789abcdef-a_execution-home"
  for (const owner of [null, [], {}, { context: null }, { context: "" },
    { context: "local-test", retainedVolumes: sourceVolume },
    { context: "local-test", retainedVolumes: [null] },
    { context: "local-test", retainedVolumes: [""] },
    { context: "local-test", privateVolumes: {} },
    { context: "local-test", shutdownAudit: [] },
    { context: "local-test", shutdownAudit: { preservedVolumes: null } },
    { context: "local-test", a: [] }, { context: "local-test", b: null },
    { context: "local-test", a: { containers: {} } },
    { context: "local-test", containers: [null] },
    { context: "local-test", b: { containers: [{ volumes: sourceVolume }] } },
    { context: "local-test", containers: [{ volumes: [{ name: 7 }] }] },
    { context: "local-test", retainedVolumes: [sourceVolume], a: { containers: [{ volumes: [null] }] } },
  ]) {
    assert.throws(() => validateSeedSourceVolume({ owner, context: "local-test", sourceVolume }), /SOURCE_OWNER_RECORD_INVALID/)
  }
})

test("Stop writer 形狀的 JSON roundtrip 接受 retainedVolumes，保留 record 不變", () => {
  const record = { ...loginOwnerRecord(), final_disposition: { requested: "Stop", status: "stopped" },
    lifecycle_result: { status: "stopped" }, cleanup_attempt: "finally-scoped-compose-down-no-volume-removal", cleanup_result: "stopped" }
  const owner = JSON.parse(JSON.stringify(record)), before = structuredClone(owner)
  const sourceVolume = "omw-seed-0123456789abcdef-a_execution-home"
  validateSeedSourceVolume({ owner, context: "local-test", sourceVolume })
  validateSeedSourceVolume({ owner: { context: owner.context, retainedVolumes: owner.retainedVolumes }, context: "local-test", sourceVolume })
  assert.deepEqual(owner, before)
})

test("a 與 b 的 containers volume names 各自可核准，無需 retainedVolumes", () => {
  for (const side of ["a", "b"]) {
    const sourceVolume = `omw-seed-0123456789abcdef-${side}_execution-home`
    const owner = JSON.parse(JSON.stringify({ context: "local-test",
      [side]: { containers: [{ id: `synthetic-${side}`, service: "execution", volumes: [{ name: sourceVolume, destination: "/home/node" }] }] } }))
    const before = structuredClone(owner)
    validateSeedSourceVolume({ owner, context: "local-test", sourceVolume })
    assert.deepEqual(owner, before)
  }
})

test("來源必須 exact name；未記錄、相近 run、destination 或任意 root containers 皆不核准", () => {
  const owner = loginOwnerRecord(), sourceVolume = "omw-seed-fedcba9876543210-a_execution-home"
  owner.otherContext = { context: "other-context", containers: [{ volumes: [{ name: sourceVolume }] }] }
  owner.c = { containers: [{ volumes: [{ name: sourceVolume }] }] }
  owner.sourceVolume = sourceVolume
  owner.volumes = [{ name: sourceVolume }]
  owner.workers[0].containers = [{ volumes: [{ name: sourceVolume }] }]
  const before = structuredClone(owner)
  for (const name of [sourceVolume, "omw-seed-0123456789abcdef-b_execution-home",
    "omw-seed-0123456789abcdef-a_execution-home-extra", "OMW-SEED-0123456789ABCDEF-A_execution-home", "/home/node"]) {
    assert.throws(() => validateSeedSourceVolume({ owner, context: "local-test", sourceVolume: name }), /SOURCE_NOT_IN_APPROVED_OWNER_RECORD/)
  }
  assert.deepEqual(owner, before)
})

test("其他或相近 context 的舊 record 即使有 exact volume name 也拒絕", () => {
  const owner = loginOwnerRecord(), before = structuredClone(owner)
  for (const context of ["other-context", "LOCAL-TEST", "local-test "]) {
    assert.throws(() => validateSeedSourceVolume({ owner, context, sourceVolume: "omw-seed-0123456789abcdef-a_execution-home" }), /SOURCE_CONTEXT_MISMATCH/)
  }
  assert.deepEqual(owner, before)
})

test("legacy lab 的 shutdownAudit、privateVolumes 與頂層 containers 格式保持相容", () => {
  const sourceVolume = "legacy-execution-home"
  for (const fields of [{ shutdownAudit: { preservedVolumes: [sourceVolume] } },
    { privateVolumes: [sourceVolume] }, { containers: [{ volumes: [{ name: sourceVolume }] }] }]) {
    const owner = JSON.parse(JSON.stringify({ context: "local-test", ...fields })), before = structuredClone(owner)
    validateSeedSourceVolume({ owner, context: "local-test", sourceVolume })
    assert.throws(() => validateSeedSourceVolume({ owner, context: "local-test", sourceVolume: "legacy-other-home" }), /SOURCE_NOT_IN_APPROVED_OWNER_RECORD/)
    assert.throws(() => validateSeedSourceVolume({ owner, context: "other-context", sourceVolume }), /SOURCE_CONTEXT_MISMATCH/)
    assert.deepEqual(owner, before)
  }
})

test("file resume readonly 重用既有 full map，source 與 seed 的 bytes／identity 不變", { timeout: 5_000 }, async () => {
  await fixture(async ({ directory, repo, seedFile }) => {
    const sourceFile = path.join(directory, "approved-source.json")
    const bytes = '{ "openai": { "type": "oauth", "access": "test-access", "refresh": "test-refresh", "expires": 0 }, "other": { "type": "api", "key": "test-key" } }\n'
    await writeFile(sourceFile, bytes, { flag: "wx" })
    await prepareLocalSeed({ sourceFile, repo, seedFile, resume: false })
    const sourceBefore = await stat(sourceFile), seedBefore = await stat(seedFile)
    validateSeedResume(resumeRecord({ repo, seedFile, sourceFile }))
    const result = await prepareLocalSeed({ sourceFile, repo, seedFile, resume: true })
    assert.equal(result.detail.reusedOwnedVersion, true)
    assert.equal(await readFile(sourceFile, "utf8"), bytes)
    assert.equal(await readFile(seedFile, "utf8"), bytes)
    for (const [filename, before] of [[sourceFile, sourceBefore], [seedFile, seedBefore]]) {
      const after = await stat(filename)
      assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs)
    }
  })
})

test("resume 只允許原 file／synthetic 來源身分，不接受相同 bytes 的另一 file", { timeout: 5_000 }, async () => {
  await fixture(async ({ directory, repo, seedFile }) => {
    const sourceFile = path.join(directory, "approved-source.json"), otherFile = path.join(directory, "other-source.json")
    for (const filename of [sourceFile, otherFile]) await writeFile(filename, '{"nonsecret":"same-bytes"}', { flag: "wx" })
    const file = resumeRecord({ repo, seedFile, sourceFile })
    assert.throws(() => validateSeedResume({ ...file, seedSource: { file: otherFile } }), /RESUME_SOURCE_MISMATCH/)
    assert.throws(() => validateSeedResume({ ...file, seedSource: { synthetic: true } }), /RESUME_SOURCE_MISMATCH/)
    const synthetic = resumeRecord({ repo, seedFile })
    assert.throws(() => validateSeedResume({ ...synthetic, seedSource: { file: sourceFile } }), /RESUME_SOURCE_MISMATCH/)
  })
})

test("resume 在 Stop、零 prompt、run identity 或 exported seed boundary 不符時拒絕", { timeout: 5_000 }, async () => {
  await fixture(async ({ repo, seedFile }) => {
    const valid = resumeRecord({ repo, seedFile })
    const cases = [
      [value => { value.owner.lifecycle_result.status = "unresolved" }, /RESUME_REQUIRES_CONFIRMED_STOP/],
      [value => { value.evidence.prompts.push({ side: "a", status: "failed" }) }, /OWNED_RUN_PROMPT_BUDGET_ALREADY_USED/],
      [value => { delete value.evidence.prompts }, /OWNED_RUN_PROMPT_BUDGET_ALREADY_USED/],
      [value => { value.binding.runId = "omw-seed-fedcba9876543210" }, /RESUME_RUN_IDENTITY_MISMATCH/],
      [value => { value.evidence.runId = "omw-seed-fedcba9876543210" }, /RESUME_RUN_IDENTITY_MISMATCH/],
      [value => { value.binding.context = "another-context" }, /RESUME_CONTEXT_MISMATCH/],
      [value => { value.binding.repo = path.dirname(repo) }, /RESUME_WORKTREE_MISMATCH/],
      [value => { value.owner.exportedSeed = path.join(repo, "foreign-seed.json") }, /RESUME_SEED_BOUNDARY_MISMATCH/],
    ]
    for (const [mutate, reason] of cases) {
      const value = structuredClone(valid)
      mutate(value)
      assert.throws(() => validateSeedResume(value), reason)
    }
  })
})

test("synthetic／file resume 缺少 seed 或 bytes 不符時 fail closed；new run 保持 exclusive create", { timeout: 5_000 }, async () => {
  for (const mode of ["synthetic", "file"]) await fixture(async ({ directory, repo, seedFile }) => {
    const sourceFile = mode === "file" ? path.join(directory, "source.json") : undefined
    const sourceBytes = '{"nonsecret":"approved-original"}\n'
    if (sourceFile) await writeFile(sourceFile, sourceBytes, { flag: "wx" })
    const input = { sourceFile, repo, seedFile }
    await assert.rejects(prepareLocalSeed({ ...input, resume: true }), { code: "ENOENT" })
    await assert.rejects(stat(seedFile), { code: "ENOENT" })
    const existing = "nonsecret-mismatched-owned-seed"
    await writeFile(seedFile, existing, { flag: "wx" })
    const before = await stat(seedFile)
    await assert.rejects(prepareLocalSeed({ ...input, resume: true }), /OWNED_SEED_MISMATCH/)
    await assert.rejects(prepareLocalSeed({ ...input, resume: false }), { code: "EEXIST" })
    assert.equal(await readFile(seedFile, "utf8"), existing)
    const after = await stat(seedFile)
    assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs)
    if (sourceFile) assert.equal(await readFile(sourceFile, "utf8"), sourceBytes)
  })
})
