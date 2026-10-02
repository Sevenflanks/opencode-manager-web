import assert from "node:assert/strict"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { createProofArtifacts } from "./proof-artifacts.js"

test("proof artifacts default to platform temp or the explicit root", async () => {
  const artifacts = await createProofArtifacts("omw-proof-parent-test-")
  try {
    assert.equal(path.resolve(path.dirname(artifacts)), path.resolve(process.env.OMW_PROOF_ROOT ?? tmpdir()))
    assert.equal((await stat(artifacts)).isDirectory(), true)
  } finally { await rm(artifacts, { recursive: true, force: true }) }
})

test("proof artifacts create a missing optional parent and allocate separate run directories", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "omw-proof-parent-test-"))
  try {
    const parent = path.join(sandbox, "new-parent", "nested")
    const first = await createProofArtifacts("run-", parent)
    const second = await createProofArtifacts("run-", parent)
    assert.notEqual(first, second)
    assert.equal(path.dirname(first), parent)
    assert.equal((await stat(first)).isDirectory(), true)
    assert.equal((await stat(second)).isDirectory(), true)
  } finally { await rm(sandbox, { recursive: true, force: true }) }
})
