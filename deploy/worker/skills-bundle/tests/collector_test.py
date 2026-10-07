import argparse
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('collector', pathlib.Path(__file__).parents[1] / 'adapters/collect-worker-git-evidence.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name).resolve()
        self.args = argparse.Namespace(workspace=str(self.root), repo=[str(self.root)], author=['me@example.test'],
            since=module.iso('2026-10-01T00:00:00Z'), until=module.iso('2026-10-02T00:00:00Z'), github=False, details=False)
        self.calls = []
        self.sessions = []
        self.rows = []
        self.fail_gh = False
        self.identity = 'me@example.test'

    def row(self, sha='a', date='2026-10-01T12:00:00Z', author='me@example.test'):
        return '\0'.join([sha * 40, date, 'Fixture User', author, 'PRIVATE SUBJECT', ''])

    def fake(self, command, cwd=None):
        self.calls.append(command)
        if command[0] == 'opencode':
            return json.dumps(self.sessions)
        if command[0] == 'gh':
            if self.fail_gh:
                raise subprocess.CalledProcessError(1, 'gh', stderr='PRIVATE TOKEN')
            if command[1] == 'api':
                return json.dumps([{'number': 17}])
            return json.dumps({'number': 17, 'state': 'MERGED', 'closingIssuesReferences': [{'number': 9}, {'number': 9}]})
        words = command[3:]
        if words[0] == 'rev-parse':
            return str(self.root)
        if words[0] == 'config':
            if self.identity is None:
                raise subprocess.CalledProcessError(1, 'git')
            return self.identity
        if words[0] == 'log':
            return '\n'.join(self.rows)
        if words[0] == 'remote':
            return 'https://github.com/fixture/project.git'
        raise AssertionError(command)

    def test_date_author_dedup_and_private_output(self):
        self.rows = [self.row(), self.row(), self.row('b', author='other@example.test'),
                     self.row('c', '2026-10-02T00:00:00Z'), self.row('d', '2026-10-01T00:00:00Z')]
        result = module.collect(self.args, self.fake)
        self.assertEqual([x['hash'] for x in result['repos'][0]['commits']], ['a' * 40, 'd' * 40])
        self.assertNotIn('PRIVATE SUBJECT', json.dumps(result))
        self.assertNotIn(str(self.root), json.dumps(result))
        self.assertIn('--all', next(x for x in self.calls if 'log' in x))

    def test_native_metadata_overlap_and_boundary(self):
        self.args.repo = None
        self.sessions = [{'directory': str(self.root), 'created': 1790812800000, 'updated': 1790985600000, 'title': 'PRIVATE TITLE'},
                         {'directory': str(self.root.parent), 'created': 1790812800000, 'updated': 1790985600000}]
        result = module.collect(self.args, self.fake)
        self.assertEqual(len(result['repos']), 1)
        self.assertIn('session-outside-worker-workspace-skipped', result['warnings'])
        self.assertNotIn('PRIVATE TITLE', json.dumps(result))
        self.assertEqual(self.calls[0], ['opencode', 'session', 'list', '--format', 'json', '--max-count', '500'])

    def test_empty_native_output_does_not_scan(self):
        self.args.repo = None
        calls = []
        def empty(command, cwd=None):
            calls.append(command)
            return ''
        result = module.collect(self.args, empty)
        self.assertEqual(result['repos'], [])
        self.assertEqual(len(calls), 1)

    def test_shared_session_directory_counts_once_per_session(self):
        self.args.repo = None
        self.sessions = [{'directory': str(self.root), 'created': 1790812800000, 'updated': 1790985600000}] * 2
        result = module.collect(self.args, self.fake)
        self.assertEqual(result['repos'][0]['sessionEvidenceCount'], 2)

    def test_no_git_commits_does_not_claim_github_auth_available(self):
        self.args.github = True
        result = module.collect(self.args, self.fake)
        self.assertNotEqual(result['meta']['ghAvailable'], 'available')

    def test_no_identity_never_uses_all_authors(self):
        self.args.author = None
        self.identity = None
        self.rows = [self.row()]
        result = module.collect(self.args, self.fake)
        self.assertEqual(result['repos'][0]['commits'], [])
        self.assertEqual(result['meta']['marker'], 'PARTIAL')
        self.assertIn('author-unavailable-provide-author', result['warnings'])

    def test_repo_config_identity(self):
        self.args.author = None
        self.rows = [self.row()]
        self.assertEqual(len(module.collect(self.args, self.fake)['repos'][0]['commits']), 1)

    def test_pr_chain_and_closing_issues(self):
        self.args.github = True
        self.rows = [self.row(), self.row('b')]
        result = module.collect(self.args, self.fake)
        prs = result['repos'][0]['prs']
        self.assertEqual(len(prs), 1)
        self.assertEqual(prs[0]['closingIssues'], [9])
        self.assertEqual(prs[0]['associatedCommit'], 'a' * 40)
        self.assertFalse(result['meta']['partial'])

    def test_missing_gh_credentials_preserves_git_and_redacts_errors(self):
        self.args.github = True
        self.rows = [self.row()]
        self.fail_gh = True
        result = module.collect(self.args, self.fake)
        self.assertEqual(len(result['repos'][0]['commits']), 1)
        self.assertEqual(result['meta']['marker'], 'PARTIAL')
        self.assertNotIn('PRIVATE TOKEN', json.dumps(result))

    def test_native_timeout_is_partial_without_retry(self):
        self.args.repo = None
        calls = []
        def timeout(command, cwd=None):
            calls.append(command)
            raise subprocess.TimeoutExpired(command, 20)
        result = module.collect(self.args, timeout)
        self.assertEqual(len(calls), 1)
        self.assertIn('native-session-metadata-unavailable-provide-repo', result['warnings'])

    def test_malformed_git_date_is_partial(self):
        self.rows = [self.row(date='invalid')]
        result = module.collect(self.args, self.fake)
        self.assertIn('git-evidence-unavailable', result['warnings'])

    def test_explicit_repo_bypasses_discovery(self):
        module.collect(self.args, self.fake)
        self.assertFalse(any(command[0] == 'opencode' for command in self.calls))

    def test_session_bound_is_visible(self):
        self.args.repo = None
        self.sessions = [{'directory': str(self.root), 'created': 1790812800000, 'updated': 1790985600000}] * 500
        result = module.collect(self.args, self.fake)
        self.assertIn('session-limit-reached', result['warnings'])

    def test_real_temporary_git_branches(self):
        # Isolated synthetic object database, never user repository commits or data.
        env = {**os.environ, 'GIT_AUTHOR_NAME': 'Fixture', 'GIT_AUTHOR_EMAIL': 'me@example.test',
               'GIT_COMMITTER_NAME': 'Fixture', 'GIT_COMMITTER_EMAIL': 'me@example.test',
               'GIT_AUTHOR_DATE': '2026-10-01T12:00:00Z', 'GIT_COMMITTER_DATE': '2026-10-03T12:00:00Z',
               'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull}
        def git(*words, content=None):
            return subprocess.run(['git', '-C', str(self.root), *words], input=content,
                capture_output=True, text=True, check=True, timeout=20, env=env).stdout.strip()
        git('init', '--quiet')
        tree = git('mktree', content='')
        oid = git('commit-tree', tree, content='synthetic fixture\n')
        git('update-ref', 'refs/heads/one', oid)
        git('update-ref', 'refs/heads/two', oid)
        result = module.collect(self.args)
        self.assertEqual([x['hash'] for x in result['repos'][0]['commits']], [oid])


if __name__ == '__main__':
    unittest.main()
