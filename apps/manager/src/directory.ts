import { readdir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import type { DirectoryListing } from "@omw/contracts"
import { ManagerError } from "./errors.js"

export interface DirectoryPort {
  resolve(input: string): Promise<string>
  browse(input: string): Promise<DirectoryListing>
}

export async function canonicalDirectory(input: string): Promise<string> {
  if (typeof input !== "string" || !input.trim()) throw new ManagerError("DIRECTORY_REQUIRED", "請提供目錄路徑。", 400)
  try {
    const canonical = await realpath(path.resolve(input.trim()))
    if (!(await stat(canonical)).isDirectory()) throw Object.assign(new Error("路徑不是目錄"), { code: "ENOTDIR" })
    await readdir(canonical)
    return path.normalize(canonical)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const reason = code === "ENOENT" ? "NOT_FOUND" : code === "ENOTDIR" ? "NOT_DIRECTORY" : "NOT_ACCESSIBLE"
    throw new ManagerError("DIRECTORY_NOT_ACCESSIBLE", `目錄不存在、不是目錄或無法存取：${error instanceof Error ? error.message : String(error)}`, 400, { reason })
  }
}

export const localDirectories: DirectoryPort = {
  resolve: canonicalDirectory,
  async browse(input) {
    const current = await canonicalDirectory(input)
    const parentCandidate = path.dirname(current)
    const children = []
    const errors: DirectoryListing["errors"] = []
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const candidate = path.join(current, entry.name)
      try { children.push({ name: entry.name, path: await canonicalDirectory(candidate) }) }
      catch (error) { errors.push({ path: candidate, message: error instanceof Error ? error.message : String(error) }) }
    }
    children.sort((a, b) => a.name.localeCompare(b.name, "zh-TW"))
    return { current, parent: parentCandidate === current ? null : parentCandidate, children, errors }
  },
}
