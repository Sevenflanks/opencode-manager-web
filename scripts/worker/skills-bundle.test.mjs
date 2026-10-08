import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogEntries, safePath, sha256, fileHashes, folderHash, validateSkill, validateReferences, compileSkill, prepare, resolvePatchMap } from './skills-bundle.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = () => ({ schemaVersion: 1, catalogBasis: 'synthetic-test', excluded: ['agent-process-lifecycle', 'self-challenge'], sources: [{ id: 'fixture', repository: 'fixture/source', commit: 'a'.repeat(40), license: 'synthetic', groups: { skills: ['example'] } }] });
const skill = () => ({ 'SKILL.md': Buffer.from('---\nname: example\ndescription: Synthetic fixture\n---\n\nRead [guide](references/guide.md).\n'), 'references/guide.md': Buffer.from('Guide\n'), 'scripts/helper.py': Buffer.from('raise RuntimeError("must never execute upstream")\n') });
const lockFor = (files) => ({ files: fileHashes(files), folderSha256: folderHash(fileHashes(files)) });
const temporary = async (t) => { const dir = await mkdtemp(path.join(os.tmpdir(), 'skills-bundle-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };

test('catalog requires immutable SHA and unique source identities', () => {
  const catalog = fixture();
  catalog.sources[0].commit = 'main';
  assert.throws(() => catalogEntries(catalog), /immutable/);
  catalog.sources[0].commit = 'a'.repeat(40);
  catalog.sources.push({ ...catalog.sources[0], groups: { skills: ['other'] } });
  assert.throws(() => catalogEntries(catalog), /source/);
});
test('catalog rejects duplicate and excluded skills', () => {
  for (const names of [['example', 'example'], ['agent-process-lifecycle'], ['self-challenge']]) {
    const catalog = fixture(); catalog.sources[0].groups.skills = names;
    assert.throws(() => catalogEntries(catalog), /duplicate, excluded/);
  }
});
test('paths reject traversal, NTFS streams and Windows aliases', () => {
  for (const value of ['../a', 'a/../b', '/a', 'a\\b', 'C:/a', 'a:stream', 'a//b', 'a/./b', 'CON', 'foo.', 'foo ']) assert.throws(() => safePath(value), /unsafe path/, value);
});
test('complete skill includes references and inert scripts', () => assert.doesNotThrow(() => validateSkill('example', skill())));
test('missing relative reference fails', () => {
  const files = skill(); delete files['references/guide.md'];
  assert.throws(() => validateSkill('example', files), /missing reference/);
});
test('closure validates nested documents and selected sibling skill resources', () => {
  const files = { ...skill(), 'references/guide.md': Buffer.from('Read [required](missing.md).') };
  assert.throws(() => validateReferences('example', files), /missing reference/);
  files['references/guide.md'] = Buffer.from('Read [sibling](../../other/README.md).');
  assert.throws(() => validateReferences('example', files), /missing reference/);
  assert.doesNotThrow(() => validateReferences('example', files, { example: files, other: { 'README.md': Buffer.from('included') } }));
  files['references/guide.md'] = Buffer.from('Example: `![screenshot](./generated.png)`.');
  assert.doesNotThrow(() => validateReferences('example', files));
});
test('conflicting identity, nested skills and commands fail', () => {
  assert.throws(() => validateSkill('wrong', skill()), /conflicting name/);
  for (const [file, error] of [['templates/SKILL.md', /nested SKILL/], ['commands/run.md', /commands/]]) {
    assert.throws(() => validateSkill('example', { ...skill(), [file]: Buffer.from('unsafe') }), error);
  }
});
test('body text cannot impersonate YAML skill identity', () => assert.throws(() => validateSkill('example', { 'SKILL.md': Buffer.from('name: example\n') }), /conflicting name/));
test('case aliases cannot overwrite a complete resource', () => assert.throws(() => validateSkill('example', { ...skill(), 'skill.md': Buffer.from('different') }), /case-conflicting/));
test('source changes and omitted resources fail hash verification', () => {
  const files = skill(), lock = lockFor(files);
  const changed = { ...files, 'scripts/helper.py': Buffer.from('changed') };
  assert.throws(() => compileSkill({ name: 'example' }, changed, lock), /source hash mismatch/);
  delete changed['scripts/helper.py'];
  assert.throws(() => compileSkill({ name: 'example' }, changed, lock), /source hash mismatch/);
});
test('Linux patch preserves all untouched source files and checks preimage', () => {
  const files = skill();
  const patch = { file: 'SKILL.md', beforeSha256: sha256(files['SKILL.md']), startLine: 6, deleteLines: 0, text: 'Linux adapter\n' };
  const compiled = compileSkill({ name: 'example' }, files, lockFor(files), [patch]);
  assert.match(compiled['SKILL.md'].toString(), /Linux adapter/);
  assert.deepEqual(compiled['scripts/helper.py'], files['scripts/helper.py']);
  assert.throws(() => compileSkill({ name: 'example' }, files, lockFor(files), [{ ...patch, beforeSha256: '0'.repeat(64) }]), /preimage/);
});
test('Windows CRLF checkout does not change authored adapter hash or compiled bytes', async (t) => {
  const dir = await temporary(t);
  await writeFile(path.join(dir, 'adapter.md'), 'Linux variant\r\nSecond line\r\n');
  const expected = 'Linux variant\nSecond line\n';
  const map = { example: [{ adapters: [{ path: 'adapter.md', sha256: sha256(expected) }] }] };
  const resolved = await resolvePatchMap(map, dir);
  assert.equal(resolved.example[0].text, expected);
  await writeFile(path.join(dir, 'adapter.md'), 'changed content\r\n');
  await assert.rejects(resolvePatchMap(map, dir), /adapter hash mismatch/);
});
test('bundle API copies the entire synthetic tree without executing scripts', async (t) => {
  const dir = await temporary(t), sourcesRoot = path.join(dir, 'sources');
  for (const [name, contents] of Object.entries(skill())) {
    const target = path.join(sourcesRoot, 'fixture/skills/example', name);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, contents);
  }
  const catalog = fixture();
  const lock = await prepare({ catalog, sourcesRoot });
  const output = path.join(dir, 'compiled');
  const result = await prepare({ catalog, sourcesRoot, output, lock });
  assert.equal(result.skills.length, 1);
  assert.equal(await readFile(path.join(output, 'skills/example/scripts/helper.py'), 'utf8'), skill()['scripts/helper.py'].toString());
  assert.deepEqual(await readdir(output), ['skills']);
  assert.equal(result.catalogBasis, 'synthetic-test');
  const changed = fixture(); changed.sources[0].commit = 'b'.repeat(40);
  await assert.rejects(prepare({ catalog: changed, sourcesRoot, lock }), /catalog lock mismatch/);
});
test('published catalog has exactly 62 expected roots and no command registrations', async () => {
  const catalog = JSON.parse(await readFile(path.join(root, 'deploy/worker/skills-bundle/sources.json'), 'utf8'));
  const entries = catalogEntries(catalog);
  assert.equal(entries.length, 62);
  assert.equal(new Set(entries.map((e) => e.name)).size, 62);
  assert(entries.some((e) => e.name === 'pr-review-remake'));
  assert(entries.some((e) => e.name === 'web-design-guidelines'));
  assert(!entries.some((e) => /commands|self-challenge|agent-process-lifecycle/.test(e.folder)));
});
test('CLI help works without credentials or private source', () => {
  const output = execFileSync(process.execPath, [path.join(root, 'scripts/worker/skills-bundle.mjs'), '--help'], { encoding: 'utf8', timeout: 30000 });
  assert.match(output, /No upstream scripts are executed/);
});
test('CLI rejects a checkout output before any download', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/worker/skills-bundle.mjs'), 'prepare', '--output', path.join(root, 'must-not-be-created')], { encoding: 'utf8', timeout: 30000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside all checkouts/);
});

const python = process.platform === 'win32' ? 'python' : 'python3';
const tarFixture = `import io, pathlib, sys, tarfile
kind, directory, extractor = sys.argv[1:]
directory = pathlib.Path(directory)
archive = directory / 'fixture.tar.gz'
with tarfile.open(archive, 'w:gz') as tar:
    name = {'traversal': 'root/skills/example/../../escape', 'stream': 'root/skills/example/data:stream'}.get(kind, 'root/skills/example/SKILL.md')
    info = tarfile.TarInfo(name)
    payload = b'synthetic'
    if kind in ('symlink', 'hardlink'):
        info.type = tarfile.SYMTYPE if kind == 'symlink' else tarfile.LNKTYPE
        info.linkname = '../../escape'
    elif kind == 'device': info.type = tarfile.CHRTYPE
    else: info.size = len(payload)
    tar.addfile(info, io.BytesIO(payload) if info.isfile() else None)
    if kind in ('duplicate', 'case'):
        if kind == 'case': info.name = info.name.lower()
        tar.addfile(info, io.BytesIO(payload))
sys.argv = [extractor, str(archive), str(directory / 'out'), '["skills/example"]']
import runpy
runpy.run_path(extractor, run_name='__main__')
`;
for (const kind of ['traversal', 'stream', 'symlink', 'hardlink', 'device', 'duplicate', 'case']) test(`safe archive extraction rejects ${kind}`, async (t) => {
  const dir = await temporary(t);
  const result = spawnSync(python, ['-c', tarFixture, kind, dir, path.join(root, 'deploy/worker/skills-bundle/extract.py')], { encoding: 'utf8', timeout: 30000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe archive path|unsupported archive entry|duplicate or oversized/);
});
test('safe archive extraction preserves a normal selected file', async (t) => {
  const dir = await temporary(t);
  execFileSync(python, ['-c', tarFixture, 'normal', dir, path.join(root, 'deploy/worker/skills-bundle/extract.py')], { timeout: 30000 });
  assert.equal(await readFile(path.join(dir, 'out/skills/example/SKILL.md'), 'utf8'), 'synthetic');
});
test('Linux collector reports missing repos without fabricating evidence', async (t) => {
  const dir = await temporary(t);
  const output = execFileSync(python, [path.join(root, 'deploy/worker/skills-bundle/adapters/collect-worker-git-evidence.py'), '--workspace', dir, '--repo', path.join(dir, 'missing'), '--since', '2026-10-01T00:00:00Z', '--until', '2026-10-02T00:00:00Z'], { encoding: 'utf8', timeout: 30000 });
  const result = JSON.parse(output);
  assert.equal(result.meta.partial, true);
  assert.deepEqual(result.repos, []);
  assert(result.warnings.includes('repo-unavailable-provide-repo'));
});
