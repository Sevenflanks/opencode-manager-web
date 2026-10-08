import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { accessSync, appendFileSync, constants, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function command(executable, args, { cwd, env = process.env, input, timeout = 30_000, allowFailure = false,
  signal, spawnProcess = spawn, onOutput = () => {} } = {}) {
  return await new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawnProcess(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '', settled = false;
    const collect = (data) => { onOutput(data); output = (output + data.toString()).slice(-32_000); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.stdin.on('error', () => {});
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    };
    const abort = () => {
      if (settled) return;
      const error = new Error(`${executable} ${signal?.aborted ? 'aborted' : 'deadline exceeded'}\n${output.slice(-6000)}`);
      // CLI termination 不是 engine/plugin Stop；不等可能被 plugin child 持有的 stdio close。
      error.unknownToolOutcome = true;
      try { child.kill(); } catch {}
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
      finish(error);
    };
    const timer = setTimeout(abort, timeout);
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (!allowFailure && code !== 0) finish(new Error(`${executable} exit ${code}\n${output.slice(-6000)}`));
      else finish(null, { code, output });
    });
    child.stdin.end(input);
  });
}

async function insideImage() {
  assert.equal(process.platform, 'linux');
  assert.notEqual(process.getuid(), 0, 'browser smoke must run non-root');
  const manifest = JSON.parse(readFileSync('/opt/omw-worker/workflow-tools-versions.json', 'utf8'));
  accessSync(manifest.executableAlias, constants.X_OK);
  accessSync(process.env.HOME, constants.W_OK);
  accessSync(process.env.XDG_CACHE_HOME ?? path.join(process.env.HOME, '.cache'), constants.W_OK);
  // Public runtime seam：native login shell 的 python3，無 API/network calls。
  const python = JSON.parse((await command('/bin/bash', ['-l', '-c', 'exec python3 -c "$1"', 'omw-python-smoke', `
import json, sys, requests, yaml, urllib3, idna, chardet, certifi, charset_normalizer, six
data = yaml.safe_load('title: 工作流程\\nready: true\\n')
assert data == {'title': '工作流程', 'ready': True}
assert yaml.safe_load(yaml.safe_dump(data, allow_unicode=True)) == data
request = requests.Request('GET', 'https://fixture.invalid/', params={'title': data['title']}).prepare()
assert request.url == 'https://fixture.invalid/?title=%E5%B7%A5%E4%BD%9C%E6%B5%81%E7%A8%8B'
print(json.dumps({'version': sys.version.split()[0], 'executable': sys.executable, 'imports': {name: module.__version__ for name, module in [('requests', requests), ('yaml', yaml), ('urllib3', urllib3), ('idna', idna), ('chardet', chardet), ('certifi', certifi), ('charset_normalizer', charset_normalizer), ('six', six)]}}))
`])).output);
  assert.equal(python.executable, '/usr/bin/python3', 'login shell must resolve distro Python, not a hidden venv');
  assert.equal(python.version, manifest.python.version);
  assert.deepEqual(python.imports, manifest.python.imports);
  const pythonPackages = JSON.parse(readFileSync('/opt/omw-worker/workflow-tools/python-packages.lock.json', 'utf8')).packages;
  assert.deepEqual(manifest.python.packages, pythonPackages);
  const resolvedPackages = Object.fromEntries((await command('dpkg-query', ['-W', '-f=${Package}\t${Version}\n', ...Object.keys(pythonPackages)])).output.trim().split('\n').map((line) => line.split('\t')));
  assert.deepEqual(resolvedPackages, pythonPackages);
  const help = await command('/bin/bash', ['-l', '-c', 'exec python3 -c "$1" --help', 'omw-python-helper', "import requests, yaml, argparse; argparse.ArgumentParser(description='離線 Python helper fixture').parse_args()"]);
  assert.match(help.output, /離線 Python helper fixture/);
  const directory = mkdtempSync(path.join(tmpdir(), 'omw-workflow-smoke-'));
  const session = `omw-${randomBytes(8).toString('hex')}`;
  const cli = (args) => command('playwright-cli', [`-s=${session}`, ...args], { cwd: directory, timeout: 35_000 });
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html lang="zh-TW"><title>OMW workflow fixture</title><button onclick="document.querySelector(\'output\').textContent=\'已完成\'">執行</button><output>待執行</output></html>');
  });
  let launched = false;
  try {
    const paths = await command('/bin/bash', ['-l', '-c', 'command -v playwright-cli && command -v commitlint']);
    assert.match(paths.output, /\/usr\/local\/bin\/playwright-cli/);
    assert.match(paths.output, /\/usr\/local\/bin\/commitlint/);
    assert.match((await cli(['--version'])).output, new RegExp(manifest.cli.replaceAll('.', '\\.')));
    assert.match((await cli(['--help'])).output, /open/);
    assert.match((await command('commitlint', ['--version'])).output, new RegExp(manifest.commitlint.replaceAll('.', '\\.')));
    assert.match((await command('commitlint', ['--help'])).output, /config/);
    await command('commitlint', [], { input: 'feat(worker): 新增工作流程工具\n' });
    const invalid = await command('commitlint', [], { input: '無效提交標題\n', allowFailure: true });
    assert.notEqual(invalid.code, 0);
    assert.match(invalid.output, /type-empty|subject-empty/);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    launched = true; // 即使 open 回錯誤，仍對本次 named session 嘗試 close。
    const opened = await cli(['open', `http://127.0.0.1:${server.address().port}`, '--idle-timeout=15000']);
    assert.match(opened.output, /OMW workflow fixture/);
    const action = await cli(['run-code', "async (page) => { await page.getByRole('button', { name: '執行' }).click(); return { text: await page.locator('output').textContent(), version: page.context().browser().version(), userAgent: await page.evaluate(() => navigator.userAgent) }; }"]);
    assert.match(action.output, /已完成/);
    assert.ok(action.output.includes(manifest.chromium.browserVersion));
    assert.match(action.output, /HeadlessChrome/);
    const screenshot = path.join(directory, 'fixture.png');
    await cli(['screenshot', `--filename=${screenshot}`]);
    assert.ok(statSync(screenshot).size > 100);
    assert.deepEqual(readFileSync(screenshot).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    console.log(JSON.stringify({ downstream_result: { status: 'passed', uid: process.getuid(), manifest,
      checks: ['native-login-PATH', 'python-imports-YAML-request-prepare-offline', 'CLI-version-help', 'commitlint-valid-zhTW-invalid', 'headless-Chromium-action-screenshot'], python } }));
  } finally {
    try {
      if (launched) {
        const closed = await cli(['close']);
        assert.doesNotMatch(closed.output, /### Error/);
        console.log(JSON.stringify({ browser_cleanup: { session, status: 'closed' } }));
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

async function pythonPackageMetadata(architecture) {
  assert.equal(process.platform, 'linux');
  assert.equal(process.getuid(), 0);
  const options = architecture ? ['-o', `APT::Architecture=${architecture}`, '-o', `APT::Architectures=${architecture}`] : [];
  await command('apt-get', [...options, 'update'], { timeout: 120_000 });
  const packages = ['python3-requests', 'python3-yaml', 'python3', 'python3-minimal', 'libpython3-stdlib', 'python3.11', 'python3.11-minimal', 'libpython3.11-minimal', 'libpython3.11-stdlib', 'python3-certifi', 'python3-chardet', 'python3-charset-normalizer', 'python3-idna', 'python3-urllib3', 'python3-pkg-resources', 'python3-six', 'ca-certificates', 'openssl', 'libncursesw6', 'libnsl2', 'libtirpc3', 'libtirpc-common', 'libreadline8', 'readline-common', 'media-types', 'libyaml-0-2'];
  for (const args of [['policy', ...packages], ['show', 'python3-requests', 'python3-yaml']]) {
    console.log((await command('apt-cache', [...options, ...args])).output);
  }
  if (!architecture) console.log((await command('apt-get', ['--simulate', '--no-install-recommends', 'install', 'python3-requests', 'python3-yaml'])).output);
}

async function dockerFixture(context, metadataOnly = false, architecture) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(context ?? '')) throw new Error('Provide explicit local Docker context: --docker <context>');
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  // 與既有 dockerOwner/watchdog 的 strict current-run project/image schema 相容。
  const nonce = randomBytes(8).toString('hex'), project = `omw-verify-${nonce}`;
  const image = `${project}:verification`, label = `io.omw.workflow-smoke=${project}`;
  const evidenceBase = process.platform === 'win32' ? path.join(tmpdir(), 'opencode') : tmpdir();
  const runDirectory = mkdtempSync(path.join(evidenceBase, `${project}-tools-`));
  const ownerPath = path.join(runDirectory, 'owner.json'), logPath = path.join(runDirectory, 'commands.log');
  const composeFile = path.join(runDirectory, 'compose.yaml'), envFile = path.join(runDirectory, 'empty.env');
  const binding = { nonce, context, project, repo, label, image, envFile, composeFile,
    secretDirectory: path.join(runDirectory, 'unused-synthetic'), watchdogMilliseconds: 25 * 60_000,
    watchdogEvidence: path.join(runDirectory, 'watchdog-cleanup.json') };
  const evidence = { ...binding, startedAt: new Date().toISOString(), target: 'workflow-tools', logPath, steps: [],
    previousInterruptedRun: { downstream: 'unknown', lifecycle: 'unresolved' }, uncertainToolOutcome: false };
  const save = () => {
    writeFileSync(`${ownerPath}.tmp`, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${ownerPath}.tmp`, ownerPath);
  };
  save(); // 在 context query、watchdog 或 Docker launch 前持久化 fresh binding。
  console.log(`OWNER ${ownerPath}`);
  writeFileSync(envFile, '', { mode: 0o600 });
  writeFileSync(composeFile, `services:\n  unused:\n    image: ${image}\n`, { mode: 0o600 });
  // 明確 context，不讀 host auth/env files、Docker socket 或 workspace credential mounts。
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(DOCKER_|COMPOSE_|OMW_)/.test(key)) delete env[key];
  const workloadDeadline = Date.now() + 13 * 60_000;
  let finalizing = false;
  const docker = async (args, options = {}) => {
    const step = { operation: args.slice(0, 3).join(' '), status: 'running', startedAt: new Date().toISOString() };
    evidence.steps.push(step); save(); console.log(`BEFORE ${step.operation}`);
    appendFileSync(logPath, `\nBEFORE ${JSON.stringify(['docker', '--context', context, ...args])}\n`);
    const started = Date.now();
    const progress = setInterval(() => { step.elapsedSeconds = Math.floor((Date.now() - started) / 1000); save(); console.log(`PROGRESS ${step.operation} ${step.elapsedSeconds}s`); }, 20_000);
    try {
      const result = await command('docker', ['--context', context, ...args], { cwd: repo, env,
        timeout: finalizing ? (args[0] === 'stop' ? 20_000 : 10_000) : Math.max(1, Math.min(options.timeout ?? 30_000, workloadDeadline - Date.now())),
        allowFailure: options.allowFailure, onOutput: (chunk) => appendFileSync(logPath, chunk) });
      step.status = result.code === 0 ? 'passed' : 'failed'; step.exitCode = result.code;
      return result;
    } catch (error) {
      step.status = error.unknownToolOutcome ? 'unknown' : 'failed'; step.error = error.message;
      if (error.unknownToolOutcome) evidence.uncertainToolOutcome = true;
      throw error;
    } finally {
      clearInterval(progress); step.elapsedSeconds = Math.floor((Date.now() - started) / 1000); save();
      console.log(`AFTER ${step.operation} ${step.status} ${step.elapsedSeconds}s`);
    }
  };
  let containerId, watchdog, watchdogExited = false, downstream = { status: 'not-run' }, cleanup = 'unresolved';
  const errors = [];
  try {
    const endpoint = await docker(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']);
    assert.match(endpoint.output.trim(), /^(npipe:\/\/|unix:\/\/)/, 'only explicit local engine permitted');
    // 原 repo 官方 Docker owner/watchdog 契約；stdio ignore、獨立有限 lifetime，不新建 generic host owner。
    const { dockerOwner } = await import('./docker-owner.mjs');
    dockerOwner(binding);
    watchdog = spawn(process.execPath, [fileURLToPath(new URL('./watchdog.mjs', import.meta.url)), ownerPath], { detached: true, stdio: 'ignore', windowsHide: true });
    watchdog.once('exit', () => { watchdogExited = true; });
    await new Promise((resolve, reject) => { watchdog.once('spawn', resolve); watchdog.once('error', reject); });
    evidence.watchdog = { pid: watchdog.pid, status: 'armed', evidencePath: binding.watchdogEvidence }; save();
    watchdog.unref();
    await docker(['build', '--target', 'workflow-tools', '--label', label, '--tag', image, '--file', 'deploy/worker/Dockerfile', '.'], { timeout: 660_000 });
    const builtImage = await docker(['image', 'inspect', image, '--format', '{{.Id}}']);
    assert.match(builtImage.output.trim(), /^sha256:[a-f0-9]{64}$/);
    evidence.imageId = builtImage.output.trim(); save();
    const created = await docker(['create', '--rm', '--init', '--pull', 'never', '--name', project, '--label', label,
      '--label', `com.docker.compose.project=${project}`,
      '--user', metadataOnly ? 'root' : 'node', '--workdir', '/tmp', '--network', metadataOnly ? 'bridge' : 'none', '--shm-size', '256m', '--cpus', '2', '--memory', '1g',
      '--env', 'HOME=/home/node', '--env', 'XDG_CACHE_HOME=/home/node/.cache', image,
      'timeout', '--signal=TERM', '--kill-after=10s', '180s', 'node', '/opt/omw/scripts/worker/workflow-tools-smoke.mjs', ...(metadataOnly ? ['--python-packages', ...(architecture ? [architecture] : [])] : [])]);
    containerId = created.output.trim();
    assert.match(containerId, /^[a-f0-9]{64}$/);
    evidence.containerId = containerId; save();
    // 官方 create -> start --attach 在程序啟動前綁定 stdio，避免快速 red 與 --rm 搶走 logs。
    // container 自有 timeout 防 host 中斷留下 browser；同一 binding 保持到 finally Stop。
    const started = await docker(['start', '--attach', containerId], { timeout: 210_000, allowFailure: true });
    console.log(started.output);
    assert.equal(started.code, 0);
    downstream = { status: 'passed', target: metadataOnly ? 'snapshot-python-package-metadata' : 'workflow-tools' };
  } catch (error) {
    downstream = { status: error.unknownToolOutcome ? 'unknown' : 'failed', error: error.message };
  } finally {
    finalizing = true; evidence.downstream_result = downstream; save();
    // 僅 current-run unique label/name；不掃描、停止或 prune 其他資源。
    const owned = await docker(['container', 'ls', '--all', '--quiet', '--filter', `label=${label}`]).catch((error) => { errors.push(error.message); return null; });
    if (owned?.output.trim()) {
      const ids = owned.output.trim().split(/\s+/);
      await docker(['stop', '--time', '10', ...ids]).catch((error) => errors.push(error.message));
    }
    const inactive = await docker(['container', 'ls', '--all', '--quiet', '--filter', `label=${label}`]).catch((error) => { errors.push(error.message); return null; });
    if (inactive?.output.trim()) await docker(['container', 'rm', '--force', ...inactive.output.trim().split(/\s+/)]).catch((error) => errors.push(error.message));
    const remaining = await docker(['container', 'ls', '--all', '--quiet', '--filter', `label=${label}`]).catch((error) => { errors.push(error.message); return null; });
    const built = await docker(['image', 'ls', '--quiet', image]).catch((error) => { errors.push(error.message); return null; });
    if (built?.output.trim()) await docker(['image', 'rm', image]).catch((error) => errors.push(error.message));
    const remainingImage = await docker(['image', 'ls', '--quiet', image]).catch((error) => { errors.push(error.message); return null; });
    cleanup = !evidence.uncertainToolOutcome && remaining && !remaining.output.trim() && remainingImage && !remainingImage.output.trim() && errors.length === 0 ? 'stopped' : 'unresolved';
    if (cleanup === 'stopped' && watchdog && !watchdogExited) {
      // 僅本次 spawn handle；成功 official cleanup 後撤銷尚在 deadline sleep 的 watchdog。
      const stopped = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 3_000);
        watchdog.once('exit', () => { clearTimeout(timer); resolve(true); });
      });
      watchdog.kill();
      if (await stopped) evidence.watchdog.status = 'stopped';
      else { evidence.watchdog.status = 'unresolved'; cleanup = 'unresolved'; errors.push('Current-run watchdog Stop not confirmed'); }
    } else if (evidence.watchdog) evidence.watchdog.status = watchdogExited ? 'exited' : 'retained-for-deadline-cleanup';
    evidence.remaining = { containers: remaining?.output.trim() ?? 'query-unknown', imageTags: remainingImage?.output.trim() ?? 'query-unknown' };
    evidence.lifecycle_result = { status: cleanup, errors }; save();
    console.log(JSON.stringify({ platform: 'Windows', selected_tier: 'external-launcher',
      owner_binding: { kind: 'official-interface-current-run', context, project, containerId, label, image, imageId: evidence.imageId, ownerPath, logPath },
      final_disposition: { requested: 'Stop', status: cleanup }, lifecycle_result: { status: cleanup, errors }, downstream_result: downstream,
      ...(cleanup !== 'stopped' ? { failure_kind: evidence.uncertainToolOutcome ? 'unknown-tool-outcome' : 'cleanup-unconfirmed',
        cleanup_attempt: 'official-current-run-scoped-cleanup', cleanup_result: 'unresolved', evidence_paths: [ownerPath, logPath, binding.watchdogEvidence],
        next_owner: 'main session / existing Docker watchdog', unresolved_reason: 'Engine/plugin outcome or scoped Stop not confirmed',
        unresolved_items: [evidence.watchdog?.status ?? 'watchdog-not-armed', ...errors] } : {}),
      minimum_outcomes: { ownership_binding: 'owner handled', stdio: 'owner handled', readiness: 'owner handled', observation: 'owner handled',
        disposition: 'owner handled', cleanup_or_handoff: cleanup === 'stopped' ? 'owner handled' : 'escalated', lifecycle_callback: 'owner handled' } }));
  }
  if (downstream.status !== 'passed' || cleanup !== 'stopped') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === '--docker') await dockerFixture(process.argv[3], process.argv[4] === '--python-packages', process.argv[5]);
  else if (process.argv[2] === '--python-packages') await pythonPackageMetadata(process.argv[3]);
  else await insideImage();
}
