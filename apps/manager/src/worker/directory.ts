import path from "node:path"
import type { DirectoryPort } from "../directory.js"
import { ManagerError } from "../errors.js"

export async function resolveStartDirectory(input: string, directories: DirectoryPort, workspaceRoot: string): Promise<string> {
  const directory = await directories.resolve(input)
  const root = await directories.resolve(workspaceRoot)
  // Worker 只限制開 Instance；browse／Shortcut 仍可指向外部。兩端須先 realpath，
  // 不可用字串 startsWith：它會放過 /workspace-sibling 與指向外部的 symlink。
  const relative = path.relative(root, directory)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ManagerError("WORKER_DIRECTORY_OUTSIDE_WORKSPACE", "Worker 只能在 /workspace 或其子目錄啟動 Instance。", 400)
  }
  return directory
}
