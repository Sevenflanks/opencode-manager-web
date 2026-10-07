import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"

// Opt-in 專用 Docker namespace；Node PID 1 同程序 import 真正 CLI，不 mock bootstrap/supervisor。
test("execution CLI completes bootstrap and both listeners before announcing readiness", {
  skip: !process.env.OMW_EXECUTION_STARTUP_DOCKER_IMAGE, timeout: 40_000,
}, async () => {
  const root = fileURLToPath(new URL("../../../..", import.meta.url)).replace(/\\/g, "/").replace(/\/$/, "")
  const owner = randomUUID()
  const docker = (args: string[]) => spawnSync("docker", args, { encoding: "utf8", timeout: 10_000 })
  const fixture = `
    import assert from 'node:assert/strict';
    import {mkdtemp,writeFile,rm} from 'node:fs/promises';
    const lifetime=setTimeout(()=>process.exit(99),15000);
    const directory=await mkdtemp('/tmp/omw-execution-startup-');
    try {
      await writeFile(directory+'/control','synthetic-control-token-32-characters');
      await writeFile(directory+'/browser','synthetic-browser-password');
      Object.assign(process.env,{HOME:directory,OMW_EXECUTION_HOST:'127.0.0.1',OMW_EXECUTION_PORT:'4175',OMW_NATIVE_PORT:'4180',OMW_RUNTIME_PORT:'4096',OMW_HEALTH_PORT:'4177',OMW_NATIVE_ORIGIN:'http://127.0.0.1:4180',OMW_BROWSER_USERNAME:'fixture',OMW_EXECUTION_TOKEN_FILE:directory+'/control',OMW_BROWSER_PASSWORD_FILE:directory+'/browser'});
      await import('/opt/omw/apps/manager/dist/src/worker/execution-server.js');
      const request=(url,headers={})=>fetch(url,{headers,signal:AbortSignal.timeout(1000)});
      for(const route of ['live','ready']) {
        const response=await request('http://127.0.0.1:4177/health/'+route);
        assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:'ok'});
      }
      assert.equal((await request('http://127.0.0.1:4175/v1/execution')).status,401);
      const control=await request('http://127.0.0.1:4175/v1/execution',{authorization:'Bearer synthetic-control-token-32-characters'});
      assert.equal(control.status,200);assert.equal((await control.json()).execution,null);
      assert.equal((await request('http://127.0.0.1:4180/')).status,401);
      console.log('EXECUTION_STARTUP_HTTP_CONFIRMED');
    } catch(error) { console.error(error);process.exitCode=1; }
    finally {await rm(directory,{recursive:true,force:true});}
    if(process.exitCode) {clearTimeout(lifetime);process.exit(1);}
    process.emit('SIGTERM');
  `
  let id: string | undefined
  try {
    const created = docker(["create", "--rm", "--name", `omw-execution-startup-${owner}`, "--label", `io.omw.fixture.owner=${owner}`,
      "--network", "none", "--entrypoint", "node",
      ...["apps/manager/dist", "scripts/worker", "node_modules"].flatMap(relative => ["--mount", `type=bind,source=${root}/${relative},target=/opt/omw/${relative},readonly`]),
      process.env.OMW_EXECUTION_STARTUP_DOCKER_IMAGE!, "--input-type=module", "-e", fixture])
    assert.equal(created.status, 0, created.stderr || created.error?.message)
    id = created.stdout.trim()
    assert.match(id, /^[a-f0-9]{64}$/)
    // fresh Docker ID 擁有整個 namespace；attached CLI 的 ChildProcess 另有 bounded lifetime。
    const child = spawn("docker", ["start", "--attach", id], { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    child.stdout.on("data", chunk => { stdout += chunk })
    child.stderr.on("data", chunk => { stderr += chunk })
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("close", resolve)
    })
    const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000)
    try {
      assert.equal(await exit, 0, stderr)
      assert.match(stdout, /EXECUTION_STARTUP_HTTP_CONFIRMED/, stdout)
    } finally {
      clearTimeout(deadline)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await exit
    }
  } finally {
    if (id) {
      const removed = docker(["rm", "--force", id])
      assert.ok(removed.status === 0 || /No such (container|object)/i.test(removed.stderr), `current-run Docker cleanup unresolved: ${removed.stderr}`)
    }
  }
})
