import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync, symlinkSync, accessSync, constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 僅於 image build 執行；來源鎖定，不把下載／全域設定搬到 Worker startup。
if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Image build requires Linux root');
const lock = JSON.parse(readFileSync(new URL('./toolchain.lock.json', import.meta.url), 'utf8'));
const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
if (!arch) throw new Error(`Unsupported Worker architecture: ${process.arch}`);
const root = lock.runtime.installRoot;
const run = (command, args, timeout = 180_000, capture = false, cwd) => {
  const result = spawnSync(command, args, { timeout, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', cwd });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  return result.stdout?.trim();
};

// Frozen snapshot 只忽略過期時間；保留 Debian archive keyring 簽章與 package hash 驗證。
rmSync('/etc/apt/sources.list.d/debian.sources', { force: true });
writeFileSync('/etc/apt/sources.list', [
  `deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${lock.debian.snapshot}/ bookworm main`,
  `deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${lock.debian.snapshot}/ bookworm-updates main`,
  `deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${lock.debian.snapshot}/ bookworm-security main`,
  '',
].join('\n'));
run('apt-get', ['-o', 'Acquire::Retries=2', '-o', 'Acquire::http::Timeout=30', 'update'], 240_000);
const initTemporary = mkdtempSync(join(tmpdir(), 'omw-init-'));
try {
  const tini = lock.debian.tini;
  if (!lock.debian.packages.includes(`tini=${tini.version}`)) throw new Error('tini package version mismatch');
  // 仍由 frozen、signed apt index 選取套件；另驗固定 bytes，避免 init 被浮動版本取代。
  run('apt-get', ['-o', 'Acquire::Retries=2', '-o', 'Acquire::http::Timeout=30', 'download', `tini=${tini.version}`], 120_000, false, initTemporary);
  const archive = join(initTemporary, `tini_${tini.version}_${arch}.deb`);
  const expected = tini[arch].sha256;
  if (!/^[a-f0-9]{64}$/.test(expected) || createHash('sha256').update(readFileSync(archive)).digest('hex') !== expected) throw new Error('tini checksum mismatch');
  run('apt-get', ['-o', 'Acquire::Retries=2', '-o', 'Acquire::http::Timeout=30', 'install', '-y', '--no-install-recommends',
    ...lock.debian.packages.filter((entry) => !entry.startsWith('tini=')), archive], 300_000);
} finally {
  rmSync(initTemporary, { recursive: true, force: true });
}
if (run('dpkg-query', ['-W', '-f=${Version}', 'tini'], 30_000, true) !== lock.debian.tini.version) throw new Error('Installed tini version mismatch');
if (!run('dpkg-query', ['-L', 'tini'], 30_000, true).split('\n').includes(lock.debian.tini.executable)) throw new Error('Installed tini path mismatch');
accessSync(lock.debian.tini.executable, constants.X_OK);
run(lock.debian.tini.executable, ['--version'], 30_000);
mkdirSync(root, { recursive: true });
const packages = run('dpkg-query', ['-W', '-f=${binary:Package}\t${Version}\t${Architecture}\n'], 30_000, true);
writeFileSync('/opt/omw-worker/toolchain-debian.tsv', `${packages}\n`);
rmSync('/var/lib/apt/lists', { recursive: true, force: true });

const temporary = mkdtempSync(join(tmpdir(), 'omw-toolchain-'));
try {
  for (const [name, tool] of Object.entries(lock.tools)) {
    const asset = tool[arch] ?? tool;
    const algorithm = asset.sha512 ? 'sha512' : 'sha256';
    const expected = asset[algorithm];
    if (!new RegExp(`^[a-f0-9]{${algorithm === 'sha512' ? 128 : 64}}$`).test(expected)) throw new Error(`Invalid ${name} checksum`);
    const archive = join(temporary, name);
    run('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '20', '--max-time', '180', '--output', archive, asset.url], 190_000);
    const actual = createHash(algorithm).update(readFileSync(archive)).digest('hex');
    if (actual !== expected) throw new Error(`${name} checksum mismatch`);
    const destination = join(root, name);
    mkdirSync(destination);
    if (name === 'officecli') {
      run('install', ['-m', '0555', archive, join(destination, 'officecli')]);
      symlinkSync(join(destination, 'officecli'), '/usr/local/bin/officecli');
    } else {
      run('tar', ['-xzf', archive, '--strip-components=1', '--no-same-owner', '-C', destination]);
    }
    rmSync(archive);
  }
  // Runtime node 不可更新 image 工具，只有 HOME/cache/workspace 是工作副本。
  run('chmod', ['-R', 'a-w', root]);
  const npm = run('npm', ['--version'], 30_000, true);
  if (process.versions.node !== lock.runtime.node || npm !== lock.runtime.npm) throw new Error('Base Node/npm version mismatch');
  writeFileSync(lock.runtime.manifest, `${JSON.stringify({ ...lock, architecture: arch, resolved: { node: process.versions.node, npm }, debianVersions: '/opt/omw-worker/toolchain-debian.tsv' }, null, 2)}\n`);
  chmodSync(lock.runtime.manifest, 0o444);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
