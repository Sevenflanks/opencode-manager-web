import { randomBytes } from "node:crypto"
import process from "node:process"
import path from "node:path"
import { DpapiCredentialStore } from "./credential-store.js"

const dataDirectory = path.resolve(process.env.OMW_DATA_DIR ?? path.join(process.cwd(), ".omw"))
const store = new DpapiCredentialStore({
  dataDirectory,
  ...(process.env.OMW_POWERSHELL_EXECUTABLE ? { powershell: process.env.OMW_POWERSHELL_EXECUTABLE } : {}),
})

if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
  throw new Error("Credential setup 必須在本機互動式 TTY 執行，避免 secret 經 command argv 或 redirected log 傳入。")
}

const managerUsername = await promptVisible("OMW Basic auth username [omw]: ") || "omw"
const managerPassword = await confirmedPassword("OMW Basic auth password (至少 16 字元): ")
const openCodeUsername = await promptVisible("OpenCode Basic auth username [opencode]: ") || "opencode"
const openCodePassword = await confirmedPassword("OpenCode Basic auth password (至少 16 字元): ")

await store.save({
  manager: { username: managerUsername, password: managerPassword },
  openCode: { username: openCodeUsername, password: openCodePassword },
  launcherToken: randomBytes(32).toString("base64url"),
})
process.stdout.write(`Credential store 已更新：${store.filename}\n密碼與 launcher token 未顯示；請停止並重新啟動 OMW 與既有 OpenCode instances。\n`)

async function confirmedPassword(prompt: string): Promise<string> {
  const value = await promptHidden(prompt)
  if (value.length < 16) throw new Error("Password 至少需要 16 字元。")
  const confirmation = await promptHidden("再次輸入 password: ")
  if (value !== confirmation) throw new Error("兩次輸入的 password 不一致。")
  return value
}

function promptVisible(prompt: string): Promise<string> {
  process.stdout.write(prompt)
  return readLine(false)
}

function promptHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt)
  return readLine(true)
}

function readLine(masked: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = ""
    process.stdin.setRawMode!(true)
    process.stdin.resume()
    process.stdin.setEncoding("utf8")
    const finish = (error?: Error) => {
      process.stdin.off("data", onData)
      process.stdin.setRawMode!(false)
      process.stdin.pause()
      process.stdout.write("\n")
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") return finish(new Error("Credential setup 已取消。"))
        if (character === "\r" || character === "\n") return finish()
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1)
          if (!masked) process.stdout.write("\b \b")
          continue
        }
        if (character >= " ") {
          value += character
          if (!masked) process.stdout.write(character)
        }
      }
    }
    process.stdin.on("data", onData)
  })
}
