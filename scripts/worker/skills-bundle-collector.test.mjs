import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Linux collector date/identity/native metadata/PR/partial/real Git fixtures', () => {
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', fileURLToPath(new URL('../../deploy/worker/skills-bundle/tests/collector_test.py', import.meta.url))], { timeout: 60000, stdio: 'pipe' });
});
