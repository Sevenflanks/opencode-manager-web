import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const commandNames = ['playwright-cli', 'commitlint'];

// dangling symlink 也代表既有命令；拒絕覆蓋，而不是只檢查可執行的 target。
export function assertCommandSlots(directory, names = commandNames) {
  for (const name of names) {
    const destination = path.join(directory, name);
    if (lstatSync(destination, { throwIfNoEntry: false })) throw new Error(`Workflow command collision: ${destination}`);
  }
}

export function browserMetadata(root) {
  const json = (file) => JSON.parse(readFileSync(path.join(root, 'node_modules', file), 'utf8'));
  const cli = json('@playwright/cli/package.json');
  const playwright = json('playwright/package.json');
  const core = json('playwright-core/package.json');
  if (cli.dependencies.playwright !== playwright.version || cli.dependencies['playwright-core'] !== core.version || core.version !== playwright.version) {
    throw new Error('Playwright CLI/browser bundle version mismatch');
  }
  const chromium = json('playwright-core/browsers.json').browsers.find((entry) => entry.name === 'chromium');
  return { cli: cli.version, playwright: core.version, chromium };
}

function run(command, args, timeout = 300_000, capture = false) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, stdio: capture ? 'pipe' : 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${command} failed (${result.error?.code ?? result.status})`);
  return result.stdout?.trim();
}

function pythonLock(root, snapshot) {
  const lock = JSON.parse(readFileSync(path.join(root, 'python-packages.lock.json'), 'utf8'));
  if (lock.debianSnapshot !== snapshot) throw new Error('Python package lock snapshot mismatch');
  if (!lock.architectures.includes(run('dpkg', ['--print-architecture'], 30_000, true))) throw new Error('Unsupported Python package lock architecture');
  return lock;
}

function pythonMetadata(root, snapshot) {
  const lock = pythonLock(root, snapshot);
  const packages = Object.fromEntries(run('dpkg-query', ['-W', '-f=${Package}\t${Version}\n', ...Object.keys(lock.packages)], 30_000, true)
    .split('\n').map((line) => line.split('\t')));
  for (const [name, version] of Object.entries(lock.packages)) {
    if (packages[name] !== version) throw new Error(`Python package lock mismatch: ${name}`);
  }
  const metadata = JSON.parse(run('python3', ['-c', `
import json, sys, requests, yaml, urllib3, idna, chardet, certifi, charset_normalizer, six
print(json.dumps({'version': sys.version.split()[0], 'executable': sys.executable, 'imports': {name: module.__version__ for name, module in [('requests', requests), ('yaml', yaml), ('urllib3', urllib3), ('idna', idna), ('chardet', chardet), ('certifi', certifi), ('charset_normalizer', charset_normalizer), ('six', six)]}}))
`], 30_000, true));
  return { ...metadata, packages };
}

async function install() {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Workflow install requires image-build Linux root');
  const root = path.dirname(new URL(import.meta.url).pathname);
  const lock = JSON.parse(readFileSync('/opt/omw-worker/toolchain.lock.json', 'utf8'));
  assertCommandSlots('/usr/local/bin');
  const metadata = browserMetadata(root);
  if (process.argv.includes('--system-deps')) {
    // 共用既有 signed Debian snapshot；不可用 runtime apt/npx 補安裝 floating libs/browser。
    rmSync('/etc/apt/sources.list.d/debian.sources', { force: true });
    writeFileSync('/etc/apt/sources.list', [
      `deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${lock.debian.snapshot}/ bookworm main`,
      `deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${lock.debian.snapshot}/ bookworm-updates main`,
      `deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${lock.debian.snapshot}/ bookworm-security main`,
      '',
    ].join('\n'));
    writeFileSync('/etc/apt/apt.conf.d/80omw-workflow', 'Acquire::Retries "2";\nAcquire::http::Timeout "30";\n');
    run(process.execPath, [path.join(root, 'node_modules/playwright-core/cli.js'), 'install-deps', 'chromium'], 300_000);
    // Helpers 的 import 必須在 build 即可用；pin 所有 resolver 新增的必要套件，不提供 runtime pip fallback。
    const python = pythonLock(root, lock.debian.snapshot);
    run('apt-get', ['install', '--yes', '--no-install-recommends', ...Object.entries(python.packages).map(([name, version]) => `${name}=${version}`)], 300_000);
    pythonMetadata(root, lock.debian.snapshot);
    rmSync('/var/lib/apt/lists', { recursive: true, force: true });
    rmSync('/etc/apt/apt.conf.d/80omw-workflow');
    return;
  }
  run(process.execPath, [path.join(root, 'node_modules/playwright-core/cli.js'), 'install', '--no-shell', 'chromium'], 540_000);
  const { chromium } = await import(pathToFileURL(path.join(root, 'node_modules/playwright/index.mjs')));
  const executable = chromium.executablePath();
  accessSync(executable, constants.X_OK);
  // 穩定 executable path，不假設 Linux amd64/arm64 的 archive 子目錄同名。
  symlinkSync(executable, '/opt/omw-worker/chromium');
  const wrappers = {
    // bundled chromium channel 採官方 Linux no-sandbox 預設，隔離邊界是 non-root Worker container。
    // 不為 browser 增加 Docker capabilities、privileged 或 host IPC。
    'playwright-cli': `#!/bin/sh\nexport NO_UPDATE_NOTIFIER=1\nexport PLAYWRIGHT_MCP_BROWSER="\${PLAYWRIGHT_MCP_BROWSER:-chromium}"\nexport PLAYWRIGHT_MCP_EXECUTABLE_PATH="\${PLAYWRIGHT_MCP_EXECUTABLE_PATH:-/opt/omw-worker/chromium}"\nexport PLAYWRIGHT_MCP_HEADLESS="\${PLAYWRIGHT_MCP_HEADLESS:-true}"\nexec /usr/local/bin/node ${root}/node_modules/@playwright/cli/playwright-cli.js "$@"\n`,
    commitlint: `#!/bin/sh\nexec /usr/local/bin/node ${root}/node_modules/@commitlint/cli/cli.js --config ${root}/commitlint.config.cjs "$@"\n`,
  };
  for (const [name, contents] of Object.entries(wrappers)) {
    const destination = `/usr/local/bin/${name}`;
    writeFileSync(destination, contents, { flag: 'wx', mode: 0o755 });
  }
  const versions = {
    ...metadata,
    commitlint: JSON.parse(readFileSync(path.join(root, 'node_modules/@commitlint/cli/package.json'), 'utf8')).version,
    conventional: JSON.parse(readFileSync(path.join(root, 'node_modules/@commitlint/config-conventional/package.json'), 'utf8')).version,
    executable, executableAlias: '/opt/omw-worker/chromium', debianSnapshot: lock.debian.snapshot,
    python: pythonMetadata(root, lock.debian.snapshot),
  };
  writeFileSync('/opt/omw-worker/workflow-tools-versions.json', `${JSON.stringify(versions, null, 2)}\n`);
  writeFileSync('/opt/omw-worker/workflow-tools-debian.tsv', `${run('dpkg-query', ['-W', '-f=${binary:Package}\t${Version}\t${Architecture}\n'], 30_000, true)}\n`);
  // Bundle唯讀；HOME/XDG profiles/cache 由既有 Worker user 擁有，不把共享 browser cache 設成可寫。
  run('chmod', ['-R', 'a-w', root, process.env.PLAYWRIGHT_BROWSERS_PATH]);
  for (const file of ['/opt/omw-worker/workflow-tools-versions.json', '/opt/omw-worker/workflow-tools-debian.tsv']) chmodSync(file, 0o444);
  run('install', ['-d', '-o', 'node', '-g', 'node', '/home/node/.cache']);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await install();
