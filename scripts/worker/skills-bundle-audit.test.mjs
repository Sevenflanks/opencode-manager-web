import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepare, sha256, folderHash } from './skills-bundle.mjs';
import { auditCompiled } from './skills-bundle-audit.mjs';

test('real audit rejects self-consistent script plus manifest tampering against trusted repo lock', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'skills-audit-public-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'trusted-repo');
  const sourcesRoot = path.join(root, 'sources');
  const context = path.join(root, 'context');
  const save = async (file, text) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); };
  const encoded = (value) => JSON.stringify(value, null, 2) + '\n';
  const digest = (value) => sha256(JSON.stringify(value));
  const catalog = { catalogBasis: 'public-synthetic', excluded: [], sources: [{ id: 'fixture', repository: 'fixture/source', commit: 'a'.repeat(40), license: 'synthetic', groups: { skills: ['example'] } }] };
  await save(path.join(sourcesRoot, 'fixture/skills/example/SKILL.md'), '---\nname: example\n---\nSynthetic.\n');
  await save(path.join(sourcesRoot, 'fixture/skills/example/scripts/helper.py'), 'print("original")\n');
  const lock = await prepare({ catalog, sourcesRoot });
  const manifest = await prepare({ catalog, sourcesRoot, output: context, lock });
  manifest.patchMapSha256 = digest({});
  const trusted = { schemaVersion: 1, catalogSha256: digest(catalog), sourceLockSha256: digest(lock), patchMapSha256: digest({}), manifestSha256: sha256(encoded(manifest)) };
  await save(path.join(config, 'sources.json'), encoded(catalog));
  await save(path.join(config, 'source-lock.json'), encoded(lock));
  await save(path.join(config, 'linux-patches.json'), encoded({}));
  await save(path.join(config, 'compiled-lock.json'), encoded(trusted));
  await save(path.join(context, 'manifest.json'), encoded(manifest));
  await save(path.join(context, 'linux-patches.json'), encoded({}));
  await save(path.join(context, 'licenses/fixture/STATUS.txt'), 'synthetic\n');
  assert.equal((await auditCompiled(context, config)).skills, 1);
  // Trust metadata lives in the repository, not in the supplied build context.
  for (const [file, original] of [['sources.json', catalog], ['source-lock.json', lock], ['linux-patches.json', {}]]) {
    await save(path.join(config, file), encoded({ ...original, unreviewed: true }));
    await assert.rejects(auditCompiled(context, config), /trusted compiled/);
    await save(path.join(config, file), encoded(original));
  }
  const malicious = 'print("untrusted replacement")\n';
  await save(path.join(context, 'skills/example/scripts/helper.py'), malicious);
  manifest.skills[0].compiledFiles['scripts/helper.py'] = sha256(malicious);
  manifest.skills[0].compiledFolderSha256 = folderHash(manifest.skills[0].compiledFiles);
  await save(path.join(context, 'manifest.json'), encoded(manifest));
  await assert.rejects(auditCompiled(context, config), /trusted compiled/);
  await save(path.join(context, 'compiled-lock.json'), encoded({ ...trusted, manifestSha256: sha256(encoded(manifest)) }));
  await assert.rejects(auditCompiled(context, config), /trusted compiled/);
});
