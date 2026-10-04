import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 在獨立、network-none、non-root one-shot container 驗證，不向 live execution 注入程序。
assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 1000);
const manifest = JSON.parse(readFileSync('/opt/omw-worker/toolchain-versions.json', 'utf8'));
assert.equal(process.versions.node, manifest.runtime.node);
assert.equal(process.env.OFFICECLI_SKIP_UPDATE, '1');
assert.equal(process.env.OFFICECLI_NO_AUTO_INSTALL, '1');
assert.equal(process.env.OFFICECLI_NO_AUTO_RESIDENT, '1');
const results = {};
const run = (command, args, pattern) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (pattern) assert.match(output, pattern, command);
  results[`${command} ${args.join(' ')}`] = output;
  return output;
};
const versionPattern = (version) => new RegExp(`\\b${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
run('npm', ['--version'], versionPattern(manifest.runtime.npm));
run('npx', ['--version'], versionPattern(manifest.runtime.npm));
run('opencode', ['--version'], versionPattern(manifest.runtime.opencode));
run('java', ['--version'], versionPattern(manifest.tools.java.version));
run('javac', ['--version'], /javac 25\./);
run('mvn', ['--offline', '--version'], versionPattern(manifest.tools.maven.version));
run('python3', ['-c', 'import sys; assert sys.version_info.major == 3; print(6 * 7)'], /^42$/);
run('gh', ['--version'], versionPattern(manifest.tools.gh.version));
run('git', ['--version'], /git version/);
run('curl', ['--version'], /curl /);
run('ssh', ['-V'], /OpenSSH/);
run('rg', ['--version'], /ripgrep/);
run('jq', ['--version'], /jq-/);
run('tar', ['--version'], /tar /);
run('unzip', ['-v'], /UnZip/);
run('officecli', ['--version'], versionPattern(manifest.tools.officecli.version));
run('officecli', ['--help'], /Usage:/);
accessSync('/etc/ssl/certs/ca-certificates.crt', constants.R_OK);
for (const path of [manifest.runtime.installRoot, '/usr/local/bin/officecli', '/opt/omw/deploy/worker/toolchain.lock.json']) {
  assert.throws(() => accessSync(path, constants.W_OK), { code: 'EACCES' });
}
mkdirSync(process.env.XDG_CACHE_HOME, { recursive: true });
accessSync(process.env.HOME, constants.W_OK);
accessSync(process.env.XDG_CACHE_HOME, constants.W_OK);
const directory = mkdtempSync(join(tmpdir(), 'omw-toolchain-smoke-'));
try {
  writeFileSync(join(directory, 'Smoke.java'), 'public class Smoke { public static void main(String[] args) { if (Runtime.version().feature() != 25) throw new AssertionError(); System.out.println("java25-ok"); } }\n');
  run('javac', ['--release', '25', '-d', directory, join(directory, 'Smoke.java')]);
  run('java', ['-cp', directory, 'Smoke'], /^java25-ok$/);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ uid: process.getuid(), architecture: manifest.architecture, results }, null, 2));
