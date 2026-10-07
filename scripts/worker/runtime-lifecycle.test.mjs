import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

async function unusedPort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function bounded(work, milliseconds) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture deadline exceeded')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`manager CLI ${signal} closes health/public listeners and can reopen its owned DB (${process.platform === 'win32' ? 'Node handler delivery' : 'OS signal'})`, { timeout: 20_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'omw-manager-signal-'));
    const env = {};
    for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT', 'WINDIR', 'TEMP', 'TMP']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const port = await unusedPort(), healthPort = await unusedPort();
    Object.assign(env, { OMW_MODE: 'worker', OMW_DATA_DIR: root, OMW_WEB_ROOT: root,
      OMW_PORT: String(port), OMW_HEALTH_PORT: String(healthPort), OMW_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
      OMW_NATIVE_ORIGIN: 'http://127.0.0.1:4180', OMW_EXECUTION_ORIGIN: 'http://127.0.0.1:1',
      OMW_EXECUTION_TOKEN_FILE: path.join(root, 'control'), OMW_BROWSER_USERNAME: 'fixture', OMW_BROWSER_PASSWORD_FILE: path.join(root, 'browser') });
    await writeFile(env.OMW_EXECUTION_TOKEN_FILE, 'synthetic-control-token-32-characters');
    await writeFile(env.OMW_BROWSER_PASSWORD_FILE, 'synthetic-browser-password');
    const health = () => fetch(`http://127.0.0.1:${healthPort}/health/ready`, { signal: AbortSignal.timeout(1_000) });
    // ChildProcess binding、IPC readiness、獨立 lifetime 與 same-test finally Stop；fixture 不 spawn descendants。
    const run = async () => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/manager-lifecycle.mjs', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
      const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, receivedSignal) => resolve({ code, signal: receivedSignal })); });
      const ready = new Promise((resolve, reject) => {
        child.once('message', resolve); child.once('error', reject);
        child.once('exit', () => reject(new Error(`fixture exited before ready: ${output}`)));
      });
      try {
        await bounded(ready, 5_000);
        assert.equal((await health()).status, 200);
        assert.equal((await fetch(`${env.OMW_PUBLIC_ORIGIN}/api/v1/overview`, { signal: AbortSignal.timeout(1_000) })).status, 401);
        if (process.platform === 'win32') child.send(signal); else child.kill(signal);
        assert.deepEqual(await bounded(exit, 5_000), { code: 0, signal: null }, output);
        await assert.rejects(health());
        await assert.rejects(fetch(`${env.OMW_PUBLIC_ORIGIN}/api/v1/overview`, { signal: AbortSignal.timeout(1_000) }));
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await bounded(exit, 3_000);
      }
    };
    try { await run(); await run(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
}
