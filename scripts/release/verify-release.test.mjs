import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyRelease } from './verify-release.mjs';

const packageFiles = [
  ['package.json', 'opencode-manager-web', true],
  ['apps/manager/package.json', '@omw/manager', true],
  ['apps/web/package.json', '@omw/web', true],
  ['packages/contracts/package.json', '@omw/contracts', true],
  ['packages/launcher/package.json', '@sevenflanks/omw', false],
];

async function createFixture(version = '1.2.3') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omw-release-test-'));

  for (const [relativePath, name, isPrivate] of packageFiles) {
    const contents = {
      name,
      private: isPrivate,
      version,
    };
    if (name === '@omw/manager' || name === '@omw/web') {
      contents.dependencies = { '@omw/contracts': version };
    }
    if (name === '@sevenflanks/omw') {
      contents.devDependencies = { '@omw/contracts': version };
    }

    const destination = path.join(root, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, `${JSON.stringify(contents, null, 2)}\n`);
  }

  const lockfile = {
    name: 'opencode-manager-web',
    version,
    lockfileVersion: 3,
    packages: {
      '': { name: 'opencode-manager-web', version },
      'apps/manager': {
        name: '@omw/manager',
        version,
        dependencies: { '@omw/contracts': version },
      },
      'apps/web': {
        name: '@omw/web',
        version,
        dependencies: { '@omw/contracts': version },
      },
      'packages/contracts': { name: '@omw/contracts', version },
      'packages/launcher': {
        name: '@sevenflanks/omw',
        version,
        devDependencies: { '@omw/contracts': version },
      },
    },
  };
  await writeFile(path.join(root, 'package-lock.json'), `${JSON.stringify(lockfile, null, 2)}\n`);

  return root;
}

test('accepts a synchronized root release and returns the publish identity', async (t) => {
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(await verifyRelease(root, 'v1.2.3'), {
    packageName: '@sevenflanks/omw',
    version: '1.2.3',
  });
});

test('rejects a release when a private package and lockfile dependency are stale', async (t) => {
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'apps/web/package.json'),
    `${JSON.stringify({
      name: '@omw/web',
      private: true,
      version: '1.2.2',
      dependencies: { '@omw/contracts': '1.2.2' },
    }, null, 2)}\n`,
  );

  await assert.rejects(
    verifyRelease(root, 'v1.2.3'),
    /apps\/web\/package\.json version: expected 1\.2\.3, found 1\.2\.2.*apps\/web\/package\.json @omw\/contracts: expected 1\.2\.3, found 1\.2\.2/s,
  );
});

test('rejects tags that are not immutable stable release tags', async (t) => {
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(verifyRelease(root, 'refs/heads/main'), /Expected a tag in the form vMAJOR\.MINOR\.PATCH/);
});
