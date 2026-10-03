import { randomBytes } from "node:crypto"
import { mkdir, open, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export async function setup(directory, { username = "worker", managerPort = 4174, nativePort = 4180, image = "omw-worker:1.18.34" } = {}) {
  if (!directory || !path.isAbsolute(directory)) throw new Error("請提供 repo 外的 absolute 設定目錄。")
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username)) throw new Error("username 必須是 1..64 個英數、_ 或 -。")
  for (const port of [managerPort, nativePort]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port 必須為 1..65535。")
  if (managerPort === nativePort) throw new Error("Manager 與 native ports 必須不同。")
  if (!/^[a-z0-9][a-z0-9.:/_-]*$/.test(image)) throw new Error("image 必須是有效的 lowercase Docker reference。")
  if (/[\r\n']/.test(directory)) throw new Error("設定目錄不能含 newline 或 single quote。")
  const repo = await realpath(fileURLToPath(new URL("../..", import.meta.url)))
  const inside = (target) => { const relative = path.relative(repo, target); return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) }
  if (inside(path.resolve(directory))) throw new Error("秘密初始化目錄必須在 repo 外。")
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 })
  const parent = await realpath(path.dirname(directory))
  const target = path.join(parent, path.basename(directory))
  if (inside(target)) throw new Error("秘密初始化目錄必須在 repo 外。")
  // mkdir exclusive：拒絕覆寫既有秘密、seed 或 symlink。Linux operator 應以與 image node UID 相同的 UID 執行。
  await mkdir(target, { mode: 0o700 })
  try {
    const tokenFile = path.join(target, "execution-token")
    const passwordFile = path.join(target, "browser-password")
    async function write(filename, content) {
      const handle = await open(filename, "wx", 0o600)
      try { await handle.writeFile(content, "utf8") } finally { await handle.close() }
    }
    await write(tokenFile, `${randomBytes(48).toString("base64url")}\n`)
    await write(passwordFile, `${randomBytes(32).toString("base64url")}\n`)
    const quote = (value) => `'${value.replaceAll("\\", "/")}'`
    const envFile = path.join(target, "worker.env")
    await write(envFile, [
      `OMW_WORKER_IMAGE=${image}`, `OMW_BROWSER_USERNAME=${username}`,
      `OMW_EXECUTION_TOKEN_SOURCE=${quote(tokenFile)}`, `OMW_BROWSER_PASSWORD_SOURCE=${quote(passwordFile)}`,
      `OMW_MANAGER_HOST_PORT=${managerPort}`, `OMW_NATIVE_HOST_PORT=${nativePort}`,
      `OMW_PUBLIC_ORIGIN=http://127.0.0.1:${managerPort}`, `OMW_NATIVE_ORIGIN=http://127.0.0.1:${nativePort}`, "",
    ].join("\n"))
    return { envFile, tokenFile, passwordFile }
  } catch (error) {
    await rm(target, { recursive: true, force: true })
    throw error
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await setup(process.argv[2])
    console.log(`設定已建立：${result.envFile}\nBrowser username：worker\nBrowser password 請只在自己的終端讀取：${result.passwordFile}\nSecret 未輸出。`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
