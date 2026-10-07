import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const config = path.join(root, 'deploy/worker/skills-bundle');
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const json = async (name) => JSON.parse(await readFile(name, 'utf8'));
// Only repo-authored text adapters use canonical LF: Windows Git checkouts may use CRLF.
// Upstream source/license bytes are never normalized before hashing or copying.
const adapterBytes = (bytes) => Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'));
export function licenseStatusFiles(source) {
  return { 'STATUS.txt': source.license + '\n', ...(source.license.startsWith('unknown;') ? { 'NOTICE.txt': `Source revision: ${source.commit}\nLicense status: ${source.license}\nNo license grant was found in the selected upstream tree; this notice does not invent one.\n` } : {}) };
}
const metadataHash = (value) => sha256(JSON.stringify(value));
const manifestBytes = (value) => JSON.stringify(value, null, 2) + '\n';
// Call only after deriving the manifest from verified source bytes and exact patches.
// This repo-owned digest pins every expected compiled-file hash without publishing source.
export function compiledLockFor(catalog, sourceLock, patches, manifest) {
  return { schemaVersion: 1, catalogSha256: metadataHash(catalog), sourceLockSha256: metadataHash(sourceLock), patchMapSha256: metadataHash(patches), manifestSha256: sha256(manifestBytes(manifest)) };
}
export function verifyCompiledLock(trusted, catalog, sourceLock, patches, bytes) {
  if (trusted.schemaVersion !== 1 || trusted.catalogSha256 !== metadataHash(catalog) || trusted.sourceLockSha256 !== metadataHash(sourceLock) || trusted.patchMapSha256 !== metadataHash(patches) || trusted.manifestSha256 !== sha256(bytes)) throw new Error('trusted compiled lock mismatch; explicit regeneration required');
}
export function safePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':') || /[\x00-\x1f]/.test(value) || value.startsWith('/') || value.split('/').some((p) => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) throw new Error('unsafe path');
  return value;
}
export function catalogEntries(catalog) {
  const entries = [], seen = new Set(), sources = new Set();
  for (const source of catalog.sources) {
    if (!/^[a-z][a-z0-9-]*$/.test(source.id) || sources.has(source.id)) throw new Error('invalid or duplicate source identity');
    sources.add(source.id);
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(source.repository) || !/^[a-f0-9]{40}$/.test(source.commit)) throw new Error('repository and immutable commit required');
    for (const [folder, names] of Object.entries(source.groups)) for (const name of names) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || seen.has(name) || catalog.excluded.includes(name)) throw new Error('duplicate, excluded or invalid skill');
      safePath(folder);
      seen.add(name);
      entries.push({ name, source: source.id, folder: `${folder}/${name}` });
    }
  }
  return entries;
}
export async function filesIn(directory, prefix = '') {
  const files = Object.create(null);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = safePath(prefix + entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('symlinks forbidden');
    if (entry.isDirectory()) Object.assign(files, await filesIn(absolute, name + '/'));
    else if (entry.isFile()) files[name] = await readFile(absolute);
    else throw new Error('non-file entry forbidden');
  }
  return files;
}
export function fileHashes(files) {
  return Object.fromEntries(Object.keys(files).sort().map((name) => [safePath(name), sha256(files[name])]));
}
export function folderHash(hashes) {
  return sha256(Object.keys(hashes).sort().map((name) => `${name}\0${hashes[name]}\n`).join(''));
}
export function validateSkill(name, files) {
  for (const filename of Object.keys(files)) safePath(filename);
  if (new Set(Object.keys(files).map((name) => name.toLowerCase())).size !== Object.keys(files).length) throw new Error('case-conflicting files');
  const text = files['SKILL.md']?.toString('utf8');
  if (!text) throw new Error(`missing SKILL.md: ${name}`);
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const declared = frontmatter?.match(/^name:\s*["']?([^\r\n"']+)/m)?.[1]?.trim();
  if (declared !== name) throw new Error(`conflicting name: ${name}`);
  // Templates may contain another SKILL.md; never expose those as discoverable skills.
  if (Object.keys(files).some((file) => file !== 'SKILL.md' && path.posix.basename(file) === 'SKILL.md')) throw new Error(`nested SKILL.md requires explicit resource mapping: ${name}`);
  if (Object.keys(files).some((file) => file.toLowerCase().split('/').includes('commands'))) throw new Error(`commands not permitted: ${name}`);
  const prose = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
  for (const match of prose.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
    const reference = match[1].split('#')[0];
    if (!reference || /^[a-z]+:|^#|^\//i.test(reference)) continue;
    if (reference.includes('<') || reference.includes('{') || reference === 'link') continue;
    const normalized = path.posix.normalize(reference);
    safePath(normalized);
    if (!files[normalized] && !Object.keys(files).some((file) => file.startsWith(normalized + '/'))) throw new Error(`missing reference: ${name}/${normalized}`);
  }
}
export function validateReferences(name, files, skills = { [name]: files }) {
  for (const [filename, bytes] of Object.entries(files)) {
    if (!filename.endsWith('.md') || /^(tests|evals)\//.test(filename)) continue;
    // Fenced and inline examples describe user-created files, not bundled resources.
    const prose = bytes.toString('utf8').replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '').replace(/(`+)[^\n]*?\1/g, '');
    for (const match of prose.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
      const reference = match[1].split('#')[0];
      if (!reference || /^[a-z]+:|^\//i.test(reference) || /[<{]/.test(reference)) continue;
      const resolved = path.posix.normalize(path.posix.join(name, path.posix.dirname(filename), reference)).replace(/\/$/, '');
      safePath(resolved);
      const [targetSkill, ...parts] = resolved.split('/');
      const target = parts.join('/');
      const resources = skills[targetSkill];
      if (!resources || (target && !Object.hasOwn(resources, target) && !Object.keys(resources).some((file) => file.startsWith(target + '/')))) throw new Error(`missing reference: ${name}/${filename} -> ${resolved}`);
    }
  }
}
export function compileSkill(entry, files, lock, patches = []) {
  validateSkill(entry.name, files);
  const hashes = fileHashes(files);
  if (JSON.stringify(hashes) !== JSON.stringify(lock.files) || folderHash(hashes) !== lock.folderSha256) throw new Error(`source hash mismatch: ${entry.name}`);
  const compiled = { ...files };
  for (const patch of patches) {
    safePath(patch.file);
    if (patch.add === true) {
      if (Object.hasOwn(compiled, patch.file)) throw new Error('patch addition already exists');
      compiled[patch.file] = Buffer.from(patch.text);
      continue;
    }
    if (!compiled[patch.file] || sha256(compiled[patch.file]) !== patch.beforeSha256) throw new Error(`patch preimage mismatch: ${entry.name}`);
    const lines = compiled[patch.file].toString('utf8').split('\n');
    if (!Number.isInteger(patch.startLine) || !Number.isInteger(patch.deleteLines) || patch.startLine < 1 || patch.deleteLines < 0 || patch.startLine - 1 + patch.deleteLines > lines.length) throw new Error('invalid patch range');
    lines.splice(patch.startLine - 1, patch.deleteLines, ...patch.text.split('\n'));
    compiled[patch.file] = Buffer.from(lines.join('\n'));
  }
  validateSkill(entry.name, compiled);
  return compiled;
}
async function privateDirectory(output) {
  const parent = await realpath(path.dirname(output));
  // Never put private artifacts inside any checkout, including another worktree.
  for (let current = parent; ; current = path.dirname(current)) {
    try {
      const git = await lstat(path.join(current, '.git'));
      if (git.isDirectory()) await lstat(path.join(current, '.git', 'HEAD'));
      throw new Error('output must be outside all checkouts');
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // The approved OS temp area may sit below a home-directory dotfiles repo.
    if (current === await realpath(os.tmpdir()) || path.dirname(current) === current) break;
  }
  await mkdir(output, { mode: 0o700 }); // exclusive: existing directories are never reused
  if (process.platform === 'win32') {
    const identity = execFileSync('whoami.exe', [], { encoding: 'utf8', timeout: 10000 }).trim();
    execFileSync('icacls.exe', [output, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`], { stdio: 'pipe', timeout: 10000 });
  }
}
async function saveFiles(directory, files) {
  for (const [relative, content] of Object.entries(files)) {
    safePath(relative);
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { flag: 'wx', mode: 0o600 });
  }
}
async function download(catalog, output) {
  for (const source of catalog.sources) {
    const archive = path.join(output, `${source.id}.tar.gz`);
    let payload;
    try {
      // Use gh's authorized credential store, never inherited token variables or URL credentials.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_DEBUG)$/i.test(key)));
      payload = execFileSync('gh', ['api', '--hostname', 'github.com', `repos/${source.repository}/tarball/${source.commit}`], { env, maxBuffer: 256 * 1024 * 1024, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { throw new Error(`official API source download failed: ${source.id}; check authorized gh authentication`); }
    await writeFile(archive, payload, { flag: 'wx', mode: 0o600 });
    const target = path.join(output, 'sources', source.id);
    await mkdir(target, { recursive: true, mode: 0o700 });
    const folders = catalogEntries({ ...catalog, sources: [source] }).map((entry) => entry.folder);
    try {
      execFileSync(process.platform === 'win32' ? 'python' : 'python3', [path.join(config, 'extract.py'), archive, target, JSON.stringify(folders)], { timeout: 60000, stdio: 'pipe' });
    } catch { throw new Error(`safe extraction failed: ${source.id}`); }
  }
}
export async function prepare({ catalog, sourcesRoot, output, lock, patchMap = {} }) {
  const entries = catalogEntries(catalog);
  if (Object.keys(patchMap).some((name) => !entries.some((entry) => entry.name === name))) throw new Error('patch refers to unselected skill');
  if (lock && (lock.catalogSha256 !== sha256(JSON.stringify(catalog)) || lock.skills.length !== entries.length)) throw new Error('catalog lock mismatch');
  const records = [], compiledSkills = {};
  for (const entry of entries) {
    const files = await filesIn(path.join(sourcesRoot, entry.source, entry.folder));
    validateSkill(entry.name, files);
    const record = { ...entry, folderSha256: folderHash(fileHashes(files)), files: fileHashes(files) };
    const expected = lock?.skills.find((skill) => skill.name === entry.name);
    if (lock && !expected) throw new Error('missing locked skill');
    const compiled = expected ? compileSkill(entry, files, expected, patchMap[entry.name] ?? []) : files;
    compiledSkills[entry.name] = compiled;
    records.push({ ...record, compiledFolderSha256: folderHash(fileHashes(compiled)), compiledFiles: fileHashes(compiled) });
  }
  const sources = [];
  for (const { groups, ...source } of catalog.sources) {
    const licenses = await licenseFiles(path.join(sourcesRoot, source.id));
    const licenseHashes = fileHashes(licenses);
    if (lock && JSON.stringify(licenseHashes) !== JSON.stringify(lock.sources.find((item) => item.id === source.id)?.licenseFiles)) throw new Error(`license hash mismatch: ${source.id}`);
    sources.push({ ...source, licenseFiles: licenseHashes });
  }
  for (const [name, files] of Object.entries(compiledSkills)) validateReferences(name, files, compiledSkills);
  if (output) for (const [name, files] of Object.entries(compiledSkills)) await saveFiles(path.join(output, 'skills', name), files);
  return { schemaVersion: 1, catalogSha256: sha256(JSON.stringify(catalog)), catalogBasis: catalog.catalogBasis, sources, skills: records };
}
async function licenseFiles(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && /^(licen[cs]e|copying|notice)/i.test(entry.name)) result[entry.name] = await readFile(path.join(directory, entry.name));
  }
  return result;
}
async function generatePatchMap(result, sourcesRoot) {
  const adapter = async (name) => ({ path: `adapters/${name}`, sha256: sha256(adapterBytes(await readFile(path.join(config, 'adapters', name)))) });
  const common = await adapter('worker-runtime.md');
  const map = {};
  for (const skill of result.skills) {
    const text = await readFile(path.join(sourcesRoot, skill.source, skill.folder, 'SKILL.md'), 'utf8');
    const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
    if (!match) throw new Error(`frontmatter required: ${skill.name}`);
    const adapters = [common];
    if (['gh-body-file', 'daily-work-log'].includes(skill.name)) adapters.push(await adapter(`${skill.name}-linux.md`));
    map[skill.name] = [{ file: 'SKILL.md', beforeSha256: skill.files['SKILL.md'], startLine: match[0].split('\n').length, deleteLines: 0, adapters }];
    if (skill.name === 'daily-work-log') map[skill.name].push({ file: 'scripts/collect-worker-git-evidence.py', add: true, adapters: [await adapter('collect-worker-git-evidence.py')] });
  }
  return map;
}
export async function resolvePatchMap(map, directory = config) {
  const result = {};
  for (const [name, patches] of Object.entries(map)) {
    result[name] = [];
    for (const patch of patches) {
      const texts = [];
      for (const adapter of patch.adapters) {
        safePath(adapter.path);
        const bytes = adapterBytes(await readFile(path.join(directory, adapter.path)));
        if (sha256(bytes) !== adapter.sha256) throw new Error('adapter hash mismatch');
        texts.push(bytes.toString('utf8'));
      }
      result[name].push({ ...patch, text: texts.join('\n') });
    }
  }
  return result;
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || !command) {
    console.log('Usage: node scripts/worker/skills-bundle.mjs <lock|prepare> --output <NEW-PRIVATE-DIRECTORY> [--sources <EXISTING-PRIVATE-SOURCES>]\nlock: download pinned sources and explicitly regenerate source, patch and compiled locks.\nlock-compiled --sources <EXISTING-PRIVATE-SOURCES>: explicitly derive compiled lock from SHA-verified origins and committed patches.\nprepare: verify committed locks and compile worker-skills Docker context; never update locks.\nNo upstream scripts are executed. No source is copied into Git.');
    return;
  }
  const catalog = await json(path.join(config, 'sources.json'));
  catalogEntries(catalog);
  if (command === 'lock-compiled') {
    if (args.length !== 2 || args[0] !== '--sources') throw new Error('invalid arguments; use --help');
    const sourceLock = await json(path.join(config, 'source-lock.json'));
    const patches = await json(path.join(config, 'linux-patches.json'));
    const derived = await prepare({ catalog, sourcesRoot: path.resolve(args[1]), lock: sourceLock, patchMap: await resolvePatchMap(patches) });
    derived.patchMapSha256 = metadataHash(patches);
    const compiledLock = compiledLockFor(catalog, sourceLock, patches, derived);
    await writeFile(path.join(config, 'compiled-lock.json'), manifestBytes(compiledLock));
    console.log(JSON.stringify({ skills: derived.skills.length, ...compiledLock }));
    return;
  }
  if (!['lock', 'prepare'].includes(command) || args[0] !== '--output' || !(args.length === 2 || (command === 'prepare' && args.length === 4 && args[2] === '--sources'))) throw new Error('invalid arguments; use --help');
  const output = path.resolve(args[1]);
  await privateDirectory(output);
  if (args.length === 2) await download(catalog, output);
  const sourcesRoot = args.length === 4 ? await realpath(args[3]) : path.join(output, 'sources');
  const lock = command === 'prepare' ? await json(path.join(config, 'source-lock.json')) : undefined;
  const patchMap = command === 'prepare' ? await json(path.join(config, 'linux-patches.json')) : {};
  const context = command === 'prepare' ? path.join(output, 'worker-skills') : undefined;
  const result = await prepare({ catalog, sourcesRoot, output: context, lock, patchMap: await resolvePatchMap(patchMap) });
  if (command === 'lock') {
    await writeFile(path.join(config, 'source-lock.json'), JSON.stringify(result, null, 2) + '\n');
    const patches = await generatePatchMap(result, sourcesRoot);
    await writeFile(path.join(config, 'linux-patches.json'), manifestBytes(patches));
    const derived = await prepare({ catalog, sourcesRoot, lock: result, patchMap: await resolvePatchMap(patches) });
    derived.patchMapSha256 = metadataHash(patches);
    await writeFile(path.join(config, 'compiled-lock.json'), manifestBytes(compiledLockFor(catalog, result, patches, derived)));
  }
  if (context) {
    result.patchMapSha256 = sha256(JSON.stringify(patchMap));
    verifyCompiledLock(await json(path.join(config, 'compiled-lock.json')), catalog, lock, patchMap, manifestBytes(result));
    await saveFiles(context, { 'manifest.json': JSON.stringify(result, null, 2) + '\n', 'linux-patches.json': JSON.stringify(patchMap, null, 2) + '\n' });
    for (const source of catalog.sources) {
      const licenses = await licenseFiles(path.join(sourcesRoot, source.id));
      await saveFiles(path.join(context, 'licenses', source.id), { ...licenses, ...licenseStatusFiles(source) });
    }
  }
  console.log(JSON.stringify({ output, context, skills: result.skills.length, files: result.skills.reduce((n, s) => n + Object.keys(s.files).length, 0) }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
