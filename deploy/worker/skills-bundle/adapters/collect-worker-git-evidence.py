"""Bounded Worker-native daily metadata collector. JSON output is private evidence."""
import argparse
import datetime as dt
import json
import pathlib
import re
import subprocess


def iso(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed
    except ValueError:
        raise argparse.ArgumentTypeError('ISO8601 timestamp with timezone required') from None


def run(command, cwd=None):
    # No shell, retries, config mutation, credential reads or source execution.
    return subprocess.run(command, cwd=cwd, check=True, capture_output=True,
                          text=True, encoding='utf-8', timeout=20).stdout


def collect(args, invoke=run):
    report = {'meta': {'from': args.since.isoformat(), 'to': args.until.isoformat(),
                      'sourceMode': 'explicit-repos' if args.repo else 'worker-native-sessions',
                      'authorScope': 'explicit' if args.author else 'repo-identity',
                      'ghAvailable': 'unknown' if args.github else 'not-requested', 'privateEvidence': True},
              'warnings': [], 'errors': [], 'repos': []}

    def partial(code):
        if code not in report['warnings']:
            report['warnings'].append(code)

    candidates = list(args.repo or [])
    session_counts = {}
    workspace = pathlib.Path(args.workspace).resolve()
    if not candidates:
        try:
            raw = invoke(['opencode', 'session', 'list', '--format', 'json', '--max-count', '500'], str(workspace))
            sessions = json.loads(raw) if raw.strip() else []
            if not isinstance(sessions, list):
                raise ValueError()
            if len(sessions) >= 500:
                partial('session-limit-reached')
            for session in sessions[:500]:
                if not isinstance(session, dict):
                    raise ValueError()
                updated = session.get('updated')
                created = session.get('created')
                if not isinstance(updated, (int, float)) or not isinstance(created, (int, float)):
                    raise ValueError()
                # A long-lived session may overlap the range without an update inside it.
                if updated < args.since.timestamp() * 1000 or created >= args.until.timestamp() * 1000:
                    continue
                directory = session.get('directory')
                if not isinstance(directory, str):
                    raise ValueError()
                candidate = pathlib.Path(directory).resolve()
                if not candidate.is_relative_to(workspace):
                    partial('session-outside-worker-workspace-skipped')
                    continue
                key = str(candidate)
                candidates.append(key)
                session_counts[key] = session_counts.get(key, 0) + 1
        except (subprocess.SubprocessError, OSError, ValueError, TypeError):
            partial('native-session-metadata-unavailable-provide-repo')
    candidates = list(dict.fromkeys(candidates))
    roots = {}
    for value in candidates[:100]:
        try:
            candidate = pathlib.Path(value).resolve(strict=True)
            if not candidate.is_relative_to(workspace):
                partial('repo-outside-worker-workspace-skipped')
                continue
            root = pathlib.Path(invoke(['git', '-C', str(candidate), 'rev-parse', '--show-toplevel']).strip()).resolve(strict=True)
            if not root.is_relative_to(workspace):
                partial('repo-outside-worker-workspace-skipped')
                continue
            roots[str(root)] = roots.get(str(root), 0) + session_counts.get(str(candidate), 0)
        except (subprocess.SubprocessError, OSError, ValueError):
            partial('repo-unavailable-provide-repo')
    if len(candidates) > 100:
        partial('repo-limit-reached')
    for index, (root, evidence_count) in enumerate(roots.items(), 1):
        repo = {'id': 'repo-' + str(index), 'sessionEvidenceCount': evidence_count,
                'commits': [], 'prs': [], 'warnings': []}
        report['repos'].append(repo)

        def warn(code):
            repo['warnings'].append(code)
            partial(code)

        def git(*words):
            return invoke(['git', '-C', root, *words])

        authors = [x.casefold() for x in (args.author or [])]
        if not authors:
            # Prefer email over display name; fail closed instead of attributing all authors.
            for key in ['user.email', 'user.name']:
                try:
                    value = git('config', '--get', key).strip()
                    if value:
                        authors = [value.casefold()]
                        break
                except (subprocess.SubprocessError, OSError):
                    pass
        if not authors:
            warn('author-unavailable-provide-author')
            continue
        try:
            # Enumerate author-date evidence across every branch; Git --since uses committer
            # time, so filter author timestamps ourselves, with a visible bounded limit.
            output = git('log', '--no-show-signature', '--exclude=refs/stash', '--all',
                         '--max-count=10001', '--format=%H%x00%aI%x00%an%x00%ae%x00%s%x00')
            records = output.split('\0')
            seen = set()
            if len(records) // 5 > 10000:
                warn('commit-limit-reached')
            for offset in range(0, min(len(records) - 1, 50000), 5):
                sha, date, name, email, subject = records[offset:offset + 5]
                sha = sha.strip()
                if not re.fullmatch(r'[a-f0-9]{40,64}', sha):
                    raise ValueError()
                stamp = iso(date)
                if not args.since <= stamp < args.until or sha in seen:
                    continue
                if not any(token in (email.casefold(), name.casefold()) for token in authors):
                    continue
                if subject.lower().startswith(('wip on ', 'index on ', 'untracked files on ')):
                    continue
                seen.add(sha)
                item = {'hash': sha, 'date': date}
                # Titles and paths are opt-in private output, never publication commands.
                if args.details:
                    item['subject'] = subject
                repo['commits'].append(item)
        except (subprocess.SubprocessError, OSError, ValueError, argparse.ArgumentTypeError):
            warn('git-evidence-unavailable')
            continue
        if args.details:
            repo['path'] = root
        if not args.github:
            continue
        try:
            remote = git('remote', 'get-url', 'origin').strip()
            match = re.fullmatch(r'(?:https://github\.com/|git@github\.com:)([\w.-]+/[\w.-]+?)(?:\.git)?', remote)
            if not match:
                warn('github-repository-unavailable')
                continue
            repository = match[1]
            if len(repo['commits']) > 40:
                warn('github-commit-limit-reached')
            numbers = set()
            for commit in repo['commits'][:40]:
                # Exact commit association, not unrelated PR updated-date heuristics.
                prs = json.loads(invoke(['gh', 'api', '--hostname', 'github.com',
                                         f'repos/{repository}/commits/{commit["hash"]}/pulls?per_page=100']))
                if not isinstance(prs, list):
                    raise ValueError()
                if report['meta']['ghAvailable'] != 'partial-or-unavailable':
                    report['meta']['ghAvailable'] = 'available'
                if len(prs) >= 100:
                    warn('github-pr-limit-reached')
                for pr in prs[:100]:
                    if not isinstance(pr, dict):
                        raise ValueError()
                    number = pr.get('number')
                    if not isinstance(number, int) or number <= 0:
                        raise ValueError()
                    if number in numbers:
                        continue
                    if len(numbers) >= 40:
                        warn('github-pr-limit-reached')
                        break
                    numbers.add(number)
                    details = json.loads(invoke(['gh', 'pr', 'view', str(number), '--repo', repository,
                                                 '--json', 'number,state,closingIssuesReferences']))
                    if not isinstance(details, dict) or details.get('number') != number or not isinstance(details.get('closingIssuesReferences'), list):
                        raise ValueError()
                    issues = details['closingIssuesReferences']
                    if any(not isinstance(item, dict) or not isinstance(item.get('number'), int) for item in issues):
                        raise ValueError()
                    repo['prs'].append({'number': number, 'state': details.get('state'),
                                        'associatedCommit': commit['hash'],
                                        'closingIssues': sorted({item['number'] for item in issues
                                                                 if isinstance(item.get('number'), int)})})
        except (subprocess.SubprocessError, OSError, ValueError, TypeError, KeyError):
            report['meta']['ghAvailable'] = 'partial-or-unavailable'
            warn('github-supplement-unavailable')
    report['meta']['partial'] = bool(report['warnings'] or report['errors'])
    report['meta']['marker'] = 'PARTIAL' if report['meta']['partial'] else 'COMPLETE_WITHIN_REQUESTED_SCOPE'
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', required=True, help='Worker-owned workspace boundary; no host scan')
    parser.add_argument('--repo', action='append', help='explicit override; bypass native session discovery')
    parser.add_argument('--author', action='append', help='exact Git author email or name')
    parser.add_argument('--since', type=iso, required=True)
    parser.add_argument('--until', type=iso, required=True)
    parser.add_argument('--github', action='store_true', help='read-only supplement using existing runtime gh auth')
    parser.add_argument('--details', action='store_true', help='include private local subjects/paths; never publish automatically')
    args = parser.parse_args()
    if args.until <= args.since:
        parser.error('until must be later than since')
    print(json.dumps(collect(args), ensure_ascii=False))


if __name__ == '__main__':
    main()
