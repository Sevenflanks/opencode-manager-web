import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

export async function createProofArtifacts(prefix: string, parent = process.env.OMW_PROOF_ROOT ?? tmpdir()): Promise<string> {
  await mkdir(parent, { recursive: true })
  return await mkdtemp(path.join(parent, prefix))
}
