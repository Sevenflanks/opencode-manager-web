import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import net, { type Socket } from "node:net"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { buildExecutionApp } from "../src/worker/supervisor.js"

async function bounded<T>(work: Promise<T>, milliseconds = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("native upgrade fixture deadline exceeded")), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

// 真 TCP request 一次寫入 headers + head；不以 inject 或替代 upgrade handler 模擬 transport。
function upgradeClient(port: number, headers: Record<string, string>, pathname = "/socket?view=1", head = "") {
  const socket = net.connect({ host: "127.0.0.1", port })
  let received = "", ended = false
  const waiters = new Set<() => void>()
  const notify = () => { for (const waiter of waiters) waiter() }
  socket.on("data", (data) => { received += data.toString(); notify() })
  socket.on("error", () => {})
  const closed = new Promise<void>((resolve) => socket.once("close", () => { ended = true; notify(); resolve() }))
  socket.once("connect", () => socket.write(`GET ${pathname} HTTP/1.1\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n${head}`))
  return {
    socket, closed,
    async until(predicate: (text: string) => boolean) {
      let check!: () => void
      try {
        await bounded(new Promise<void>((resolve, reject) => {
          check = () => {
            if (predicate(received)) resolve()
            else if (ended) reject(new Error("native upgrade peer closed before expected bytes"))
          }
          waiters.add(check); check()
        }))
        return received
      } finally { waiters.delete(check) }
    },
    text: () => received,
  }
}

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

test("native gateway TCP upgrade enforces current listener and browser guards, relays heads and bytes, and bounds handshake cleanup", { skip: process.platform !== "linux" || (process.pid !== 1 && process.ppid !== 1), timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "omw-worker-upgrade-"))
  const fixture = path.join(directory, "upgrade.cjs")
  // Proof 只輸出 boolean／counter／synthetic bytes，不保存或輸出內部 credential。
  // /replace 保留 root，但讓不同 PID 接手 listener，實測 listenerMatches 而非 mock guard。
  await writeFile(fixture, `const http=require('node:http'),fs=require('node:fs'),{spawn}=require('node:child_process');
    const replacement=process.argv.includes('--replacement');
    const proof={replacement,connections:0,upgrades:0,live:0,closed:0,ends:0,authReplaced:false,filtered:false,path:null,received:''};
    const save=()=>{fs.writeFileSync('proof-next.json',JSON.stringify(proof));fs.renameSync('proof-next.json','proof.json')};
    const peers=new Set();
    const server=http.createServer((req,res)=>{
      if(req.url==='/replace') {res.end('{}');server.close(()=>{const child=spawn(process.execPath,[__filename,'--replacement'],{detached:true,stdio:'ignore'});child.unref()});server.closeAllConnections();return}
      res.end(JSON.stringify({healthy:true}));
    });
    server.on('connection',()=>{proof.connections++;save()});
    server.on('upgrade',(req,socket,head)=>{
      socket.on('error',()=>{});peers.add(socket);proof.upgrades++;proof.live++;proof.path=req.url;
      const internal='Basic '+Buffer.from(process.env.OPENCODE_SERVER_USERNAME+':'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
      proof.authReplaced=req.headers.authorization===internal;
      proof.filtered=['cookie','origin','forwarded','x-forwarded-for','x-forwarded-host','x-forwarded-proto','proxy-authorization','x-client-hop'].every(k=>req.headers[k]===undefined)
        &&req.headers.host==='127.0.0.1:4096'&&req.headers['x-visible']==='public';
      socket.once('close',()=>{peers.delete(socket);proof.live--;proof.closed++;save()});save();
      socket.once('end',()=>{proof.ends++;save();socket.end()});
      if(req.url==='/stall') return;
      socket.write('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade, x-upstream-hop\\r\\nUpgrade: websocket\\r\\nSet-Cookie: internal='+process.env.OPENCODE_SERVER_PASSWORD+'\\r\\nAuthorization: '+internal+'\\r\\nx-upstream-hop: private\\r\\nx-visible: public\\r\\n\\r\\nupstream-head');
      const receive=data=>{proof.received+=data.toString();save();if(proof.received.endsWith('close-peer'))socket.end('peer-final');else socket.write(data)};
      if(head.length)receive(head);socket.on('data',receive);
    });
    server.listen(4096,'127.0.0.1',save);
    setTimeout(()=>{for(const peer of peers)peer.destroy();server.close();process.exit(0)},20000);
    process.on('SIGTERM',()=>{for(const peer of peers)peer.destroy();server.close();process.exit(0)});`)
  const token = "fixture-control-token-32-characters"
  const nativeOrigin = "http://native.fixture.test"
  const options = { token, executable: process.execPath, arguments: [fixture], runtimePort: 4096,
    nativeOrigin, browserUsername: "fixture-browser", browserPassword: "synthetic-browser-only" }
  const app = buildExecutionApp(options)
  const empty = buildExecutionApp(options)
  const control = { authorization: `Bearer ${token}` }
  const browser = `Basic ${Buffer.from(`${options.browserUsername}:${options.browserPassword}`).toString("base64")}`
  const headers = { host: new URL(nativeOrigin).host, origin: nativeOrigin, authorization: browser,
    connection: "Upgrade, authorization, x-client-hop", upgrade: "websocket", "x-client-hop": "private",
    cookie: `control=${token}`, forwarded: "host=untrusted.invalid", "x-forwarded-for": "192.0.2.1",
    "x-forwarded-host": "untrusted.invalid", "x-forwarded-proto": "https", "proxy-authorization": `Bearer ${token}`, "x-visible": "public" }
  const sockets = new Set<Socket>()
  const gateways = [app.nativeGateway, empty.nativeGateway]
  for (const gateway of gateways) gateway.server.on("connection", (socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket))
  })
  // 獨立有限 lifetime；finally 另以 public Stop exact identity 清理 spawned namespace。
  const lifetime = setTimeout(() => { for (const socket of sockets) socket.destroy() }, 25_000)
  let identity: { epoch: string; instanceId: string } | undefined
  const connect = (port: number, requestHeaders: Record<string, string> = headers, pathname?: string, head?: string) => {
    const client = upgradeClient(port, requestHeaders, pathname, head)
    sockets.add(client.socket); client.socket.once("close", () => sockets.delete(client.socket))
    return client
  }
  type Proof = { replacement: boolean; connections: number; upgrades: number; live: number; closed: number; ends: number;
    authReplaced: boolean; filtered: boolean; path: string; received: string }
  const proof = async () => JSON.parse(await readFile(path.join(directory, "proof.json"), "utf8")) as Proof
  const waitProof = async (predicate: (value: Proof) => boolean) => {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const value = await proof()
      if (predicate(value)) return value
      await delay(10)
    }
    throw new Error("runtime proof did not reach expected observable state")
  }
  const rejectUpgrade = async (port: number, requestHeaders: Record<string, string>, status: number) => {
    const before = await proof()
    const client = connect(port, requestHeaders)
    await bounded(client.closed)
    assert.match(client.text(), new RegExp(`^HTTP/1.1 ${status}\\b`))
    const after = await proof()
    assert.equal(after.connections, before.connections, "rejected upgrade must not connect to runtime")
    assert.equal(after.upgrades, before.upgrades)
  }
  try {
    for (const gateway of gateways) await gateway.listen({ host: "127.0.0.1", port: 0 })
    const port = (gateway: typeof app.nativeGateway) => {
      const address = gateway.server.address()
      assert.ok(address && typeof address !== "string")
      return address.port
    }
    const gatewayPort = port(app.nativeGateway)
    identity = { epoch: (await app.inject({ url: "/v1/execution", headers: control })).json().epoch, instanceId: "upgrade-fixture" }
    assert.equal((await app.inject({ method: "POST", url: "/v1/start", headers: control, payload: { ...identity, directory } })).statusCode, 200)
    assert.equal((await app.inject({ method: "POST", url: "/v1/inspect", headers: control, payload: identity })).json().portOwnerMatched, true)
    await rejectUpgrade(port(empty.nativeGateway), headers, 403)
    const { authorization: _authorization, ...withoutBasic } = headers
    const { origin: _origin, ...withoutOrigin } = headers
    for (const requestHeaders of [withoutBasic, { ...headers, authorization: "Basic invalid" }, { ...headers, authorization: control.authorization },
      { ...headers, host: "wrong.fixture.test" }, withoutOrigin, { ...headers, origin: "http://wrong.fixture.test" },
      { ...headers, "sec-fetch-site": "cross-site" }]) await rejectUpgrade(gatewayPort, requestHeaders, 403)

    // 觀察真正 server upgrade event 的 head；handler 仍完全由 buildExecutionApp 提供。
    const gatewayHead = new Promise<Buffer>((resolve) => app.nativeGateway.server.once("upgrade", (_request, _socket, head) => resolve(head)))
    const client = connect(gatewayPort, headers, "/socket?view=1", "client-head")
    assert.equal((await bounded(gatewayHead)).toString(), "client-head")
    const handshake = await client.until((text) => text.includes("\r\n\r\nupstream-headclient-head"))
    assert.match(handshake, /^HTTP\/1.1 101 Switching Protocols\r\n/)
    const responseHeaders = handshake.split("\r\n\r\n")[0]!.toLowerCase()
    assert.ok(responseHeaders.split("\r\n").includes("connection: upgrade") && responseHeaders.split("\r\n").includes("upgrade: websocket"))
    assert.ok(responseHeaders.includes("x-visible: public"))
    for (const name of ["set-cookie:", "authorization:", "x-upstream-hop:"]) assert.equal(responseHeaders.includes(name), false)
    assert.ok(!handshake.includes(token) && !handshake.includes(browser) && !handshake.includes(options.browserPassword))
    client.socket.write("client-data")
    await client.until((text) => text.endsWith("client-headclient-data"))
    const relayed = await waitProof((value) => value.received === "client-headclient-data")
    assert.equal(relayed.authReplaced, true, "runtime must receive its own credential, never browser Basic")
    assert.equal(relayed.filtered, true)
    assert.equal(relayed.path, "/socket?view=1")
    client.socket.write("close-peer")
    await bounded(client.closed)
    assert.ok(client.text().endsWith("peer-final"), "upstream bytes are delivered before peer close")
    await waitProof((value) => value.live === 0 && value.closed === 1)

    const downstream = connect(gatewayPort)
    await downstream.until((text) => text.includes("\r\n\r\nupstream-head"))
    downstream.socket.destroy()
    await bounded(downstream.closed)
    await waitProof((value) => value.live === 0 && value.closed === 2 && value.ends === 2)

    const stalled = connect(gatewayPort, headers, "/stall")
    await waitProof((value) => value.live === 1 && value.path === "/stall")
    const started = Date.now()
    await bounded(stalled.closed, 7_000)
    assert.ok(Date.now() - started >= 4_000, "fixture must exercise handshake deadline, not immediate failure")
    assert.equal(stalled.text(), "", "no synthetic 101 is emitted for a stalled upstream handshake")
    await waitProof((value) => value.live === 0 && value.closed === 3)

    assert.equal((await app.inject({ url: `/runtime/${identity.epoch}/${identity.instanceId}/replace`, headers: control })).statusCode, 200)
    await waitProof((value) => value.replacement)
    const stale = (await app.inject({ method: "POST", url: "/v1/inspect", headers: control, payload: identity })).json()
    assert.equal(stale.rootRunning, true)
    assert.equal(stale.portOwnerMatched, false)
    await rejectUpgrade(gatewayPort, headers, 503)
  } finally {
    clearTimeout(lifetime)
    for (const socket of sockets) socket.destroy()
    try {
      if (identity) {
        assert.equal((await app.inject({ method: "POST", url: "/v1/stop", headers: control, payload: identity })).json().stopped, true)
        assert.equal((await app.inject({ method: "POST", url: "/v1/inspect", headers: control, payload: identity })).json().managedProcessCount, 0)
      }
    } finally {
      await bounded(Promise.all([app.close(), empty.close()]))
      await rm(directory, { recursive: true, force: true })
    }
  }
})
