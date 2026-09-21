import assert from 'node:assert/strict';
import test from 'node:test';

import { npmVersionPublished, resolveGitHubRelease } from './release-registry.mjs';

function response(status, body) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('resolves a published GitHub Release tag to its immutable commit', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/releases/tags/v1.2.3')) {
      return response(200, { tag_name: 'v1.2.3', draft: false });
    }
    return response(200, { object: { type: 'commit', sha: 'abc123' } });
  };

  assert.deepEqual(
    await resolveGitHubRelease({
      repository: 'Sevenflanks/opencode-manager-web',
      tag: 'v1.2.3',
      expectedSha: 'abc123',
      token: 'test-token',
      fetchImpl,
    }),
    { tag: 'v1.2.3', version: '1.2.3', sha: 'abc123' },
  );
  assert.equal(calls.length, 2);
});

test('dereferences an annotated tag before checkout', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/releases/tags/v2.0.0')) {
      return response(200, { tag_name: 'v2.0.0', draft: false });
    }
    if (url.endsWith('/git/ref/tags/v2.0.0')) {
      return response(200, { object: { type: 'tag', sha: 'tag-object' } });
    }
    return response(200, { object: { type: 'commit', sha: 'release-commit' } });
  };

  assert.equal(
    (await resolveGitHubRelease({ repository: 'owner/repo', tag: 'v2.0.0', token: 'token', fetchImpl })).sha,
    'release-commit',
  );
});

test('rejects a draft release or a tag that differs from the action SHA', async () => {
  const draftFetch = async () => response(200, { tag_name: 'v1.0.0', draft: true });
  await assert.rejects(
    resolveGitHubRelease({ repository: 'owner/repo', tag: 'v1.0.0', token: 'token', fetchImpl: draftFetch }),
    /must already be published/,
  );

  const mismatchFetch = async (url) =>
    url.includes('/releases/')
      ? response(200, { tag_name: 'v1.0.0', draft: false })
      : response(200, { object: { type: 'commit', sha: 'different' } });
  await assert.rejects(
    resolveGitHubRelease({
      repository: 'owner/repo',
      tag: 'v1.0.0',
      expectedSha: 'expected',
      token: 'token',
      fetchImpl: mismatchFetch,
    }),
    /points to different, not expected/,
  );
});

test('distinguishes an existing npm version from a missing version and registry failure', async () => {
  assert.equal(
    await npmVersionPublished('@sevenflanks/omw', '1.2.3', async () => response(200, { version: '1.2.3' })),
    true,
  );
  assert.equal(
    await npmVersionPublished('@sevenflanks/omw', '1.2.4', async () => response(404, { error: 'Not found' })),
    false,
  );
  await assert.rejects(
    npmVersionPublished('@sevenflanks/omw', '1.2.5', async () => response(503, { error: 'Unavailable' })),
    /npm registry returned HTTP 503/,
  );
});
