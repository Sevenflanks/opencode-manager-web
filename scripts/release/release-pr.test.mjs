import assert from "node:assert/strict";
import test from "node:test";

import { resolveReleasePullRequest } from "./release-pr.mjs";

test("resolves the Release PR head from GitHub when the action output has no SHA", async () => {
  const calls = [];
  const result = await resolveReleasePullRequest({
    rawPullRequest: JSON.stringify({ number: 24, baseBranchName: "main" }),
    repository: "Sevenflanks/opencode-manager-web",
    baseBranch: "main",
    getPull: async (request) => {
      calls.push(request);
      return {
        data: {
          number: 24,
          base: {
            ref: "main",
            repo: { full_name: "Sevenflanks/opencode-manager-web" },
          },
          head: {
            sha: "1234567890abcdef1234567890abcdef12345678",
            repo: { full_name: "Sevenflanks/opencode-manager-web" },
          },
        },
      };
    },
  });

  assert.deepEqual(calls, [
    { owner: "Sevenflanks", repo: "opencode-manager-web", pull_number: 24 },
  ]);
  assert.deepEqual(result, {
    number: 24,
    sha: "1234567890abcdef1234567890abcdef12345678",
  });
});

test("rejects a Release PR whose API base or head repository is not the expected main branch", async () => {
  await assert.rejects(
    resolveReleasePullRequest({
      rawPullRequest: JSON.stringify({ number: 24 }),
      repository: "Sevenflanks/opencode-manager-web",
      baseBranch: "main",
      getPull: async () => ({
        data: {
          number: 24,
          base: {
            ref: "release",
            repo: { full_name: "Sevenflanks/opencode-manager-web" },
          },
          head: {
            sha: "1234567890abcdef1234567890abcdef12345678",
            repo: { full_name: "attacker/fork" },
          },
        },
      }),
    }),
    /must target Sevenflanks\/opencode-manager-web:main from the same repository/,
  );
});
