// 驗證專用 transport：只在 manager container 執行，不讓外來程序進 live execution namespace。
import { readFile } from "node:fs/promises"

const token = (await readFile(process.env.OMW_EXECUTION_TOKEN_FILE, "utf8")).trimEnd()
const pathname = process.argv[2] ?? "/v1/execution"
const body = process.argv[3] && process.argv[3] !== "null" ? JSON.parse(process.argv[3]) : undefined
const mode = process.argv[4]
const response = await fetch(`http://execution:4175${pathname}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { ...(mode !== "unauthenticated" ? { authorization: `Bearer ${token}` } : {}),
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
    ...(mode === "browser-origin" ? { origin: "http://127.0.0.1:4174" } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  signal: AbortSignal.timeout(8000), redirect: "error",
})
console.log(JSON.stringify({ status: response.status, body: await response.json() }))
