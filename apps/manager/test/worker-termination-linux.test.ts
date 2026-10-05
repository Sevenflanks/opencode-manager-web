import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { buildExecutionApp, requireNamespaceOwner } from "../src/worker/supervisor.js"
import { startHealthServer } from "../src/worker/health.js"

// 僅能由專用 PID namespace 的 Node PID 1 或 tini 直接 child 執行；不可在一般 Linux host 掃程序。
for (const phase of ["ready", "starting"] as const) {
  test(`execution shutdown drains ${phase} Start and cleans detached TERM-ignoring tools`, { timeout: 20_000 }, async (context) => {
    try { await requireNamespaceOwner() } catch { context.skip("requires a dedicated Linux PID namespace owner"); return }
    const directory = await mkdtemp(path.join(os.tmpdir(), "omw-worker-drain-"))
    const fixture = path.join(directory, "runtime.cjs")
    const rootTerm = path.join(directory, "root-term"), toolStarted = path.join(directory, "tool-started"), toolTerm = path.join(directory, "tool-term")
    // root 與 detached 工具各自有 lifetime；工具接收 TERM 留證但不退出，要求 existing namespace owner 升級 KILL。
    await writeFile(fixture, `const fs=require('node:fs'), http=require('node:http'), {spawn}=require('node:child_process');
      const tool=spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('node:fs');process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(toolTerm)},'term'));setTimeout(()=>process.exit(0),12000);fs.writeFileSync(${JSON.stringify(toolStarted)},'started');`)}],{detached:true,stdio:'ignore'});tool.unref();
      const authorization='Basic '+Buffer.from('opencode:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
      const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.headers.authorization!==authorization){res.writeHead(401).end('{}');return}res.end(JSON.stringify({healthy:${phase === "ready"}}))}).listen(4096,'127.0.0.1');
      process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(rootTerm)},'term');server.close();process.exit(0)});setTimeout(()=>process.exit(0),12000);`)
    const token = "fixture-control-token-32-characters"
    const app = buildExecutionApp({ token, executable: process.execPath, arguments: [fixture], runtimePort: 4096 })
    const health = await startHealthServer(0)
    const lifetime = setTimeout(() => { app.server.closeAllConnections(); void health?.close() }, 15_000)
    let start: Promise<Response> | undefined
    try {
      const origin = await app.listen({ host: "127.0.0.1", port: 0 })
      health!.ready()
      const control = (pathname: string, body?: unknown) => fetch(`${origin}${pathname}`, {
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
      })
      const { epoch } = await (await control("/v1/execution")).json() as { epoch: string }
      start = control("/v1/start", { epoch, instanceId: "owned-drain-fixture", directory })
      const deadline = Date.now() + 4_000
      while (true) {
        if (await readFile(toolStarted, "utf8").catch(() => "") === "started") break
        assert.ok(Date.now() < deadline, "the same accepted Start must create its bounded tool before shutdown")
        await delay(20)
      }
      if (phase === "ready") assert.equal((await start).status, 200)
      health!.drain()
      app.beginDrain()
      assert.equal((await fetch(`http://127.0.0.1:${health!.port}/health/ready`, { signal: AbortSignal.timeout(1_000) })).status, 503)
      assert.equal((await control("/v1/start", { epoch, instanceId: "must-not-respawn", directory })).status, 503)
      assert.deepEqual(await app.shutdownExecution(), { stopped: true, reason: null })
      if (phase === "starting") assert.equal((await start).status, 503)
      assert.equal(await readFile(rootTerm, "utf8"), "term", "root receives graceful TERM before exit")
      assert.equal(await readFile(toolTerm, "utf8"), "term", "detached tool receives TERM before forced namespace cleanup")
      await assert.rejects(fetch("http://127.0.0.1:4096/global/health", { signal: AbortSignal.timeout(1_000) }))
      assert.deepEqual(await app.shutdownExecution(), { stopped: true, reason: null }, "one final owner, no competing namespace cleanup")
    } finally {
      clearTimeout(lifetime)
      app.beginDrain()
      try { assert.equal((await app.shutdownExecution()).stopped, true) }
      finally {
        await start?.catch(() => undefined)
        app.server.closeAllConnections()
        try { await app.close() } finally { await health?.close(); await rm(directory, { recursive: true, force: true }) }
      }
    }
  })
}
