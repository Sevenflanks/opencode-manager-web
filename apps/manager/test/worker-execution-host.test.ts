import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import test from "node:test"
import { buildExecutionApp } from "../src/worker/supervisor.js"
import { workerExecutionHost } from "../src/worker/config.js"

for (const value of [undefined, "127.0.0.1", "0.0.0.0"]) {
  test(`execution control binds allowed OMW_EXECUTION_HOST=${value ?? "unset (Compose default)"} and retains token auth`, { timeout: 10_000 }, async () => {
    const app = buildExecutionApp({ token: "fixture-control-token-32-characters", executable: process.execPath, runtimePort: 4096 })
    const lifetime = setTimeout(() => { app.server.closeAllConnections(); void app.close() }, 8_000)
    try {
      await app.listen({ host: workerExecutionHost(value), port: 0 })
      const address = app.server.address()
      assert.ok(address && typeof address !== "string")
      assert.equal(address.address, value ?? "0.0.0.0")
      const origin = `http://127.0.0.1:${address.port}`
      const request = (headers: Record<string, string> = {}) => fetch(`${origin}/v1/execution`, { headers, signal: AbortSignal.timeout(1_000) })
      assert.equal((await request()).status, 401)
      assert.equal((await request({ authorization: "Bearer fixture-control-token-32-characters" })).status, 200)
      assert.equal((await request({ authorization: "Bearer fixture-control-token-32-characters", origin: "http://evil.test" })).status, 403)
    } finally {
      clearTimeout(lifetime)
      app.server.closeAllConnections()
      await app.close()
    }
  })
}

test("execution CLI rejects invalid OMW_EXECUTION_HOST before bootstrap or listeners", { timeout: 15_000 }, async () => {
  const entry = new URL("../src/worker/execution-server.js", import.meta.url).href
  for (const value of ["", "localhost", "http://127.0.0.1", "127.0.0.2", "::1", " 127.0.0.1", "0.0.0.0:4175"]) {
    const env: NodeJS.ProcessEnv = { OMW_EXECUTION_HOST: value }
    for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "PATHEXT", "WINDIR", "TEMP", "TMP"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    // 同一次 ChildProcess binding，獨立 3s lifetime；無 secrets/provider 或 descendants。
    const child = spawn(process.execPath, ["--input-type=module", "-e", `setTimeout(()=>process.exit(99),3000);await import(${JSON.stringify(entry)});`], { env, stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr.on("data", chunk => { stderr += chunk })
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => resolve({ code, signal }))
    })
    const deadline = setTimeout(() => child.kill("SIGKILL"), 4_000)
    try {
      assert.deepEqual(await exit, { code: 1, signal: null }, value)
      assert.match(stderr, /OMW_EXECUTION_HOST 必須是 127\.0\.0\.1 或 0\.0\.0\.0/, value)
    } finally {
      clearTimeout(deadline)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await exit
    }
  }
})
