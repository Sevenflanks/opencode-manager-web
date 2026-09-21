import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { versionFromTag } from './verify-release.mjs';

async function githubJson(repository, apiPath, token, fetchImpl) {
  const result = await fetchImpl(`https://api.github.com/repos/${repository}${apiPath}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!result.ok) {
    throw new Error(`GitHub API ${apiPath} returned HTTP ${result.status}`);
  }
  return result.json();
}

export async function resolveGitHubRelease({ repository, tag, expectedSha, token, fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) {
    throw new Error('Expected GITHUB_REPOSITORY in owner/repository form');
  }
  if (!token) {
    throw new Error('GITHUB_TOKEN is required to verify the release');
  }
  const version = versionFromTag(tag);
  const release = await githubJson(repository, `/releases/tags/${encodeURIComponent(tag)}`, token, fetchImpl);
  if (release.draft || release.tag_name !== tag) {
    throw new Error(`GitHub Release ${tag} must already be published for the exact requested tag`);
  }

  let target = (
    await githubJson(repository, `/git/ref/tags/${encodeURIComponent(tag)}`, token, fetchImpl)
  ).object;
  while (target.type === 'tag') {
    target = (await githubJson(repository, `/git/tags/${target.sha}`, token, fetchImpl)).object;
  }
  if (target.type !== 'commit' || !target.sha) {
    throw new Error(`Git tag ${tag} does not resolve to a commit`);
  }
  if (expectedSha && target.sha.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new Error(`Git tag ${tag} points to ${target.sha}, not ${expectedSha}`);
  }

  return { tag, version, sha: target.sha };
}

export async function npmVersionPublished(packageName, version, fetchImpl = fetch) {
  if (packageName !== '@sevenflanks/omw') {
    throw new Error('Only @sevenflanks/omw may be checked for publication');
  }
  versionFromTag(`v${version}`);
  const escapedPackage = encodeURIComponent(packageName).replace('%2F', '%2f');
  const result = await fetchImpl(`https://registry.npmjs.org/${escapedPackage}/${version}`, {
    headers: { accept: 'application/json' },
  });
  if (result.status === 404) {
    return false;
  }
  if (!result.ok) {
    throw new Error(`npm registry returned HTTP ${result.status} while checking ${packageName}@${version}`);
  }
  const metadata = await result.json();
  if (metadata.version !== version) {
    throw new Error(`npm registry returned unexpected version ${metadata.version ?? '<missing>'}`);
  }
  return true;
}

async function writeOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }
  await appendFile(process.env.GITHUB_OUTPUT, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
}

async function main() {
  const [command, value, expectedSha] = process.argv.slice(2);
  if (command === 'resolve') {
    const release = await resolveGitHubRelease({
      repository: process.env.GITHUB_REPOSITORY,
      tag: value,
      expectedSha,
      token: process.env.GITHUB_TOKEN,
    });
    await writeOutputs(release);
    console.log(`Verified GitHub Release ${release.tag} at ${release.sha}`);
    return;
  }
  if (command === 'npm-status') {
    const published = await npmVersionPublished('@sevenflanks/omw', value);
    await writeOutputs({ published });
    console.log(`@sevenflanks/omw@${value} published=${published}`);
    return;
  }
  throw new Error('Usage: release-registry.mjs resolve <tag> [expected-sha] | npm-status <version>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
