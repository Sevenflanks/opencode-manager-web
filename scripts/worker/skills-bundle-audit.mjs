// Maintainer-only, read-only audit of an explicitly supplied private source artifact.
// Emits metadata, never file bodies, URLs or credential examples.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogEntries, filesIn, fileHashes, sha256, folderHash, validateSkill, validateReferences, licenseStatusFiles, verifyCompiledLock, resolvePatchMap } from './skills-bundle.mjs';
const config = fileURLToPath(new URL('../../deploy/worker/skills-bundle/', import.meta.url));
export async function auditCompiled(artifact, configDirectory = config) {
  const config = configDirectory;
  const catalog = JSON.parse(await readFile(path.join(config, 'sources.json'), 'utf8'));
  const manifestBytes = await readFile(path.join(artifact, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  const lock = JSON.parse(await readFile(path.join(config, 'source-lock.json'), 'utf8'));
  const patches = JSON.parse(await readFile(path.join(artifact, 'linux-patches.json'), 'utf8'));
  const expectedPatches = JSON.parse(await readFile(path.join(config, 'linux-patches.json'), 'utf8'));
  const trusted = JSON.parse(await readFile(path.join(config, 'compiled-lock.json'), 'utf8'));
  verifyCompiledLock(trusted, catalog, lock, expectedPatches, manifestBytes);
  await resolvePatchMap(expectedPatches, config);
  if (manifest.catalogSha256 !== sha256(JSON.stringify(catalog)) || manifest.patchMapSha256 !== sha256(JSON.stringify(patches)) || JSON.stringify(patches) !== JSON.stringify(expectedPatches) || JSON.stringify(manifest.sources) !== JSON.stringify(lock.sources)) throw new Error('compiled provenance mismatch');
  const expected = {}, compiledSkills = {};
  if (manifest.skills.length !== lock.skills.length) throw new Error('compiled registry mismatch');
  for (const skill of manifest.skills) {
    const original = lock.skills.find((item) => item.name === skill.name);
    if (!original || compiledSkills[skill.name] || skill.folderSha256 !== original.folderSha256 || JSON.stringify(skill.files) !== JSON.stringify(original.files)) throw new Error('compiled source-lock mismatch');
    const files = await filesIn(path.join(artifact, 'skills', skill.name));
    validateSkill(skill.name, files);
    if (JSON.stringify(fileHashes(files)) !== JSON.stringify(skill.compiledFiles) || folderHash(fileHashes(files)) !== skill.compiledFolderSha256) throw new Error('compiled file hash mismatch');
    compiledSkills[skill.name] = files;
    for (const [file, hash] of Object.entries(skill.compiledFiles)) expected[`skills/${skill.name}/${file}`] = hash;
  }
  for (const [name, files] of Object.entries(compiledSkills)) validateReferences(name, files, compiledSkills);
  for (const source of manifest.sources) {
    for (const [file, hash] of Object.entries(source.licenseFiles)) expected[`licenses/${source.id}/${file}`] = hash;
    for (const [file, text] of Object.entries(licenseStatusFiles(source))) expected[`licenses/${source.id}/${file}`] = sha256(text);
  }
  expected['manifest.json'] = sha256(manifestBytes);
  expected['linux-patches.json'] = sha256(await readFile(path.join(artifact, 'linux-patches.json')));
  const actual = fileHashes(await filesIn(artifact));
  if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(expected).sort())) throw new Error('unexpected or changed context files');
  return { context: artifact, skills: manifest.skills.length, sourceFiles: manifest.skills.reduce((n, skill) => n + Object.keys(skill.files).length, 0), compiledFiles: manifest.skills.reduce((n, skill) => n + Object.keys(skill.compiledFiles).length, 0), totalContextFiles: Object.keys(actual).length, manifestSha256: sha256(manifestBytes), catalogSha256: manifest.catalogSha256, patchMapSha256: manifest.patchMapSha256, references: 'resolved', commands: 0, excludedSkills: 0 };
}
async function main() {
const catalog = JSON.parse(await readFile(path.join(config, 'sources.json'), 'utf8'));
const artifact = process.argv[2];
if (!artifact) throw new Error('explicit source artifact required');
if (process.argv.includes('--compiled')) {
  console.log(JSON.stringify(await auditCompiled(artifact)));
  return;
}
const selected = {};
for (const entry of catalogEntries(catalog)) selected[entry.name] = await filesIn(process.argv.includes('--compiled-risks') ? path.join(artifact, 'skills', entry.name) : path.join(artifact, 'sources', entry.source, entry.folder));
for (const entry of catalogEntries(catalog)) {
  const files = selected[entry.name];
  let validation = 'ok';
  try { validateSkill(entry.name, files); } catch (e) { validation = e.message; }
  const risks = [], dependencies = new Set(), imports = new Set();
  for (const [name, bytes] of Object.entries(files)) {
    if (name.startsWith('evals/') || name.startsWith('tests/')) continue;
    if (!/\.(md|py|js|mjs|sh|json|yaml|yml|toml|ps1)$/.test(name)) continue;
    bytes.toString('utf8').split('\n').forEach((line, index) => {
      if (/skill/i.test(line)) for (const match of line.matchAll(/\b[a-z]+(?:-[a-z]+)+\b/g)) dependencies.add(match[0]);
      if (name.endsWith('.py')) for (const match of line.matchAll(/^(?:from|import) ([a-zA-Z0-9_]+)/g)) imports.add(match[1]);
      const flags = [
        ['windows', /[A-Z]:[\\/]|PowerShell|pwsh|\.ps1\b|mvn\.cmd/],
        ['excluded-skill', /agent-process-lifecycle|self-challenge/],
        ['external-manager', /OMO_INTERNAL|Heartbeat|session-memory|workflow-handoff/],
        ['host-memory', /\bdeja_|durable_memory|recall_context/],
        ['external-service', /https?:\/\//],
      ].filter(([, pattern]) => pattern.test(line)).map(([flag]) => flag);
      if (flags.length) risks.push({ file: name, line: index + 1, flags });
    });
  }
  if (process.argv.includes('--references')) {
    validateReferences(entry.name, files, selected);
  } else console.log(JSON.stringify({ name: entry.name, files: Object.keys(files).length, validation, ...(process.argv.includes('--dependencies') ? { candidates: [...dependencies].sort(), pythonImports: [...imports].sort() } : { risks }) }));
}
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
