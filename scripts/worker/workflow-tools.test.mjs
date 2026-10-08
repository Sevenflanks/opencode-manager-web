import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { assertCommandSlots, browserMetadata } from '../../deploy/worker/workflow-tools/install.mjs';
import { command } from './workflow-tools-smoke.mjs';

test('新 CLI 不取代既有 root command，包括 dangling symlink', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'omw-workflow-slots-'));
  try {
    assertCommandSlots(directory);
    writeFileSync(path.join(directory, 'commitlint'), 'existing command');
    assert.throws(() => assertCommandSlots(directory), /Workflow command collision/);
    rmSync(path.join(directory, 'commitlint'));
    // Windows file symlink 可能需 Developer Mode；junction 同樣驗證 lstat 不 follow target。
    symlinkSync(path.join(directory, 'missing'), path.join(directory, 'playwright-cli'), process.platform === 'win32' ? 'junction' : 'file');
    assert.throws(() => assertCommandSlots(directory), /Workflow command collision/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI 與 browser bundle 精確配對且 revision 固定', () => {
  const root = path.resolve('deploy/worker/workflow-tools');
  const metadata = browserMetadata(root);
  assert.equal(metadata.cli, '0.1.22');
  assert.equal(metadata.playwright, '1.64.0-alpha-1790635538000');
  assert.equal(metadata.chromium.revision, '1247');
  assert.equal(metadata.chromium.browserVersion, '155.0.8059.12');
});

test('command deadline／abort 在 child 永不 close 時仍有界返回 unknown outcome', { timeout: 2_000 }, async () => {
  for (const mode of ['deadline', 'abort']) {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let killed = false;
    child.kill = () => { killed = true; }; // 刻意不 emit close：模擬 plugin 繼承 stdio。
    child.unref = () => {};
    const abort = new AbortController();
    const started = Date.now();
    const pending = command('synthetic-fake-cli', [], { spawnProcess: () => child, timeout: 25, signal: abort.signal });
    child.stdout.write('public fixture progress');
    if (mode === 'abort') abort.abort();
    await assert.rejects(pending, (error) => error.unknownToolOutcome === true && error.message.includes(mode === 'abort' ? 'aborted' : 'deadline exceeded') && error.message.includes('public fixture progress'));
    assert.ok(Date.now() - started < 500, 'must not wait for inherited stdio to close');
    assert.equal(killed, true);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
  }
});
