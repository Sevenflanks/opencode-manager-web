import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { buildExecutionApp } from "../src/worker/supervisor.js"

// 在專用 PID namespace 直接 node 執行（PID 1，或 docker-init/tini PID 1 的直接 child）。
// fixture 自行於 20 秒退出；finally 仍以本次 epoch/instanceId Stop，不能把 timeout 當 cleanup。
test("execution Stop covers an orphaned detached tool after its parent exits; stale Stop cannot touch replacement", { skip: process.platform !== "linux" || (process.pid !== 1 && process.ppid !== 1), timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omw-worker-fixture-"))
  const fixture = path.join(directory, "fixture.cjs")
  await writeFile(fixture, `const {spawn}=require('node:child_process'); const http=require('node:http'); const fs=require('node:fs');
    setTimeout(()=>process.exit(0),20000);
    process.on('SIGTERM',()=>{fs.writeFileSync('term-proof','graceful');setTimeout(()=>process.exit(0),100)});
    setTimeout(()=>http.createServer((req,res)=>{
      if(req.url==='/orphan') {
        const child=spawn(process.execPath,['-e',"const http=require('node:http');setTimeout(()=>http.createServer((q,s)=>s.end('{}')).listen(4096,'127.0.0.1'),300);setTimeout(()=>process.exit(0),15000);process.on('SIGTERM',()=>{require('node:fs').writeFileSync('term-proof','orphan-graceful');setTimeout(()=>process.exit(0),100)})"],{detached:true,stdio:'ignore'});
        child.unref();res.end('{}');setTimeout(()=>process.exit(0),50);return;
      }
      res.setHeader('Connection','x-private-response');res.setHeader('x-private-response','must-not-forward');res.setHeader('set-cookie','secret=hidden');
      res.end(JSON.stringify(req.url==='/global/health'?{healthy:true}:req.url==='/proof'?{proof:fs.existsSync('term-proof')?fs.readFileSync('term-proof','utf8'):null}:{env:process.env,headers:req.headers}));
    }).listen(4096,'127.0.0.1'),350);`)
  const token = "fixture-control-token-32-characters"
  const app = buildExecutionApp({ token, executable: process.execPath, arguments: [fixture], runtimePort: 4096,
    environment: { ...process.env, OMW_EXECUTION_TOKEN_FILE: '/fixture/control-secret', OMW_BROWSER_PASSWORD_FILE: '/fixture/browser-secret', OPENAI_API_KEY: 'must-not-seed-tools', HOME: directory } })
  const headers = { authorization: `Bearer ${token}` }
  let identity: { epoch: string; instanceId: string } | undefined
  try {
    const epoch = (await app.inject({ method: "GET", url: "/v1/execution", headers })).json().epoch
    identity = { epoch, instanceId: "fixture-one" }
    const started = await app.inject({ method: "POST", url: "/v1/start", headers, payload: { ...identity, directory } })
    assert.equal(started.statusCode, 200, started.body)
    assert.equal((await app.inject({ method: "POST", url: "/v1/inspect", headers, payload: identity })).json().portOwnerMatched, true)
    const runtimePrefix = `/runtime/${epoch}/${identity.instanceId}`
    const environment = await app.inject({ method: "GET", url: `${runtimePrefix}/env`, headers: { ...headers, connection: "x-private-request", "x-private-request": "must-not-forward" } })
    assert.equal(environment.json().env.HOME, directory)
    assert.equal(environment.json().env.OMW_EXECUTION_TOKEN_FILE, undefined)
    assert.equal(environment.json().env.OMW_BROWSER_PASSWORD_FILE, undefined)
    assert.equal(environment.json().env.OPENAI_API_KEY, undefined)
    assert.equal(environment.json().headers["x-private-request"], undefined)
    assert.equal(environment.headers["x-private-response"], undefined)
    assert.equal(environment.headers["set-cookie"], undefined)
    await app.inject({ method: "GET", url: `${runtimePrefix}/orphan`, headers })
    await delay(500)
    const orphan = (await app.inject({ method: "POST", url: "/v1/inspect", headers, payload: identity })).json()
    assert.equal(orphan.processState, "running")
    assert.equal(orphan.rootRunning, false)
    assert.equal(orphan.portOwnerMatched, false, "orphan tool listener cannot impersonate OpenCode readiness")
    assert.equal((await app.inject({ method: "GET", url: `${runtimePrefix}/global/health`, headers })).statusCode, 503)
    assert.ok(orphan.managedProcessCount >= 1)
    // 新 supervisor epoch 的 current 為空仍不代表 namespace 已空；不可啟動或 Stop 舊身分。
    const replacementSupervisor = buildExecutionApp({ token, executable: process.execPath, arguments: [fixture], runtimePort: 4096 })
    try {
      const fresh = (await replacementSupervisor.inject({ url: "/v1/execution", headers })).json()
      assert.equal(fresh.execution, null)
      assert.equal(fresh.capacity, "occupied")
      assert.equal((await replacementSupervisor.inject({ method: "POST", url: "/v1/inspect", headers, payload: identity })).json().processState, "unknown")
      assert.equal((await replacementSupervisor.inject({ method: "POST", url: "/v1/start", headers, payload: { epoch: fresh.epoch, instanceId: "must-not-start", directory } })).statusCode, 409)
      assert.equal((await replacementSupervisor.inject({ method: "POST", url: "/v1/stop", headers, payload: identity })).statusCode, 409)
    } finally { await replacementSupervisor.close() }
    assert.equal((await app.inject({ method: "POST", url: "/v1/stop", headers, payload: identity })).json().stopped, true)
    assert.equal((await app.inject({ method: "POST", url: "/v1/inspect", headers, payload: identity })).json().processState, "not-found")
    const old = identity
    identity = { epoch, instanceId: "fixture-two" }
    assert.equal((await app.inject({ method: "POST", url: "/v1/start", headers, payload: { ...identity, directory } })).statusCode, 200)
    assert.equal((await app.inject({ method: "GET", url: `/runtime/${epoch}/${identity.instanceId}/proof`, headers })).json().proof, "orphan-graceful")
    assert.equal((await app.inject({ method: "POST", url: "/v1/stop", headers, payload: old })).statusCode, 409)
    assert.equal((await app.inject({ method: "POST", url: "/v1/inspect", headers, payload: identity })).json().processState, "running")
  } finally {
    if (identity) assert.equal((await app.inject({ method: "POST", url: "/v1/stop", headers, payload: identity })).json().stopped, true)
    await app.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test("Start failure cleans an orphan before reporting failure and leaves no runnable execution", { skip: process.platform !== "linux" || (process.pid !== 1 && process.ppid !== 1), timeout: 20_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omw-worker-failed-start-"))
  const fixture = path.join(directory, "failed.cjs")
  await writeFile(fixture, `const child=require('node:child_process').spawn(process.execPath,['-e',"setTimeout(()=>process.exit(0),15000);process.on('SIGTERM',()=>{})"],{detached:true,stdio:'ignore'});child.unref();setTimeout(()=>process.exit(1),200);`)
  const token = "fixture-control-token-32-characters"
  const app = buildExecutionApp({ token, executable: process.execPath, arguments: [fixture], runtimePort: 4096 })
  const headers = { authorization: `Bearer ${token}` }
  let identity: { epoch: string; instanceId: string } | undefined
  try {
    identity = { epoch: (await app.inject({ method: "GET", url: "/v1/execution", headers })).json().epoch, instanceId: "failed-start" }
    const result = await app.inject({ method: "POST", url: "/v1/start", headers, payload: { ...identity, directory } })
    assert.equal(result.statusCode, 503)
    const inspected = (await app.inject({ method: "POST", url: "/v1/inspect", headers, payload: identity })).json()
    assert.equal(inspected.processState, "not-found")
    assert.equal(inspected.managedProcessCount, 0)
    assert.equal(inspected.portOwnerMatched, false)
  } finally {
    if (identity) assert.equal((await app.inject({ method: "POST", url: "/v1/stop", headers, payload: identity })).json().stopped, true)
    await app.close()
    await rm(directory, { recursive: true, force: true })
  }
})
