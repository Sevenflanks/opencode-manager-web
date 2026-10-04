import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { prepareLocalSeed, validateSeedResume } from "./verify-seed-workers.mjs"

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
