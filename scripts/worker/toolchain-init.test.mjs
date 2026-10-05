import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Worker image pins Debian tini and its per-architecture checksum without a global ENTRYPOINT', async () => {
  const base = new URL('../../deploy/worker/', import.meta.url);
  const lock = JSON.parse(await readFile(new URL('toolchain.lock.json', base), 'utf8'));
  // 20260930T000000Z 的 signed Packages 是 source 0.19.0-1、binary rebuild +b3；不可把 source version 當 install pin。
  assert.ok(lock.debian.packages.includes('tini=0.19.0-1+b3'));
  assert.equal(lock.debian.tini.version, '0.19.0-1+b3');
  assert.equal(lock.debian.tini.executable, '/usr/bin/tini');
  assert.equal(lock.debian.tini.amd64.sha256, '7d1947665fa40e55f218fefad773dc6de66458d0b39eaa292cdcadfc7c996632');
  assert.equal(lock.debian.tini.arm64.sha256, '335dee1e36c0bf61f11c9fe9740012966a3183bd50405b73ed19477293c28f7f');
  const installer = await readFile(new URL('toolchain-install.mjs', base), 'utf8');
  assert.match(installer, /tini checksum mismatch/);
  assert.match(installer, /dpkg-query/);
  const dockerfile = await readFile(new URL('Dockerfile', base), 'utf8');
  assert.doesNotMatch(dockerfile, /^ENTRYPOINT\s/m);
  assert.match(dockerfile, /node .*toolchain-install\.mjs/);
});
