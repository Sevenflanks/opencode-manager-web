export async function resolveReleasePullRequest({
  rawPullRequest,
  repository,
  baseBranch,
  getPull,
}) {
  const repositoryMatch = /^([^/]+)\/([^/]+)$/.exec(repository ?? "");
  if (!repositoryMatch) {
    throw new Error("Expected repository in owner/repository form");
  }

  const actionPullRequest = JSON.parse(rawPullRequest ?? "null");
  if (
    !Number.isInteger(actionPullRequest?.number) ||
    actionPullRequest.number <= 0
  ) {
    throw new Error("Release Please did not return a valid PR number");
  }

  const [, owner, repo] = repositoryMatch;
  const { data } = await getPull({
    owner,
    repo,
    pull_number: actionPullRequest.number,
  });
  const expectedRepository = repository.toLowerCase();
  if (
    data.number !== actionPullRequest.number ||
    data.base?.ref !== baseBranch ||
    data.base?.repo?.full_name?.toLowerCase() !== expectedRepository ||
    data.head?.repo?.full_name?.toLowerCase() !== expectedRepository
  ) {
    throw new Error(
      `Release PR must target ${repository}:${baseBranch} from the same repository`,
    );
  }
  if (!/^[0-9a-f]{40}$/i.test(data.head?.sha ?? "")) {
    throw new Error("Release PR API response did not contain a commit SHA");
  }

  return { number: data.number, sha: data.head.sha };
}
