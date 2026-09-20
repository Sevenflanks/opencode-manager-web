[CmdletBinding()]
param(
  [switch]$FixtureOnly,
  [string]$VerifiedFixtureSummary,
  [string]$LifecycleScript = (Join-Path $HOME '.agents\skills\agent-process-lifecycle\scripts\Invoke-AgentProcessLifecycle.ps1')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$lifecycle = [IO.Path]::GetFullPath($LifecycleScript)
if (-not [IO.File]::Exists($lifecycle)) {
  throw "Lifecycle script not found: $lifecycle. Pass -LifecycleScript <path> or install it under `$HOME\.agents."
}
$runner = Join-Path $PSScriptRoot 'issue11-tui-runner.ps1'
$runRoot = Join-Path $PSScriptRoot ".issue11-tui-$([Guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($runRoot) | Out-Null

function Invoke-SharedReadProbe {
  Add-Type -Path (Join-Path $PSScriptRoot 'Issue11TuiNative.cs')
  $probeRoot = Join-Path $runRoot 'shared-read-probe'
  [IO.Directory]::CreateDirectory($probeRoot) | Out-Null
  $probePath = Join-Path $probeRoot 'concurrent-append.txt'
  $writer = [IO.FileStream]::new($probePath, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
  try {
    $first = [Text.Encoding]::UTF8.GetBytes('first')
    $writer.Write($first, 0, $first.Length)
    $writer.Flush($true)
    if ([Omw.Issue11Acceptance.SharedText]::ReadAllText($probePath) -ne 'first') {
      throw 'Shared reader did not observe the first append while the writer remained open.'
    }
    $second = [Text.Encoding]::UTF8.GetBytes('-second')
    $writer.Write($second, 0, $second.Length)
    $writer.Flush($true)
    if ([Omw.Issue11Acceptance.SharedText]::ReadAllText($probePath) -ne 'first-second') {
      throw 'Shared reader did not observe the second append while the writer remained open.'
    }
  } finally {
    $writer.Dispose()
  }
  return [ordered]@{
    status = 'passed'
    concurrent_append_read = $true
    writer_share = 'ReadWrite'
    reader_share = 'ReadWrite|Delete'
  }
}

function Invoke-Phase([string]$Name, [int]$ReadinessDeadlineMilliseconds) {
  $phaseRoot = Join-Path $runRoot $Name.ToLowerInvariant()
  [IO.Directory]::CreateDirectory($phaseRoot) | Out-Null
  $recordPath = Join-Path $phaseRoot 'lifecycle\run.json'
  $stdoutPath = Join-Path $phaseRoot 'lifecycle\stdout.log'
  $stderrPath = Join-Path $phaseRoot 'lifecycle\stderr.log'
  $readyPath = Join-Path $phaseRoot 'ready.json'
  $stopPath = Join-Path $phaseRoot 'stop.token'
  $resultPath = Join-Path $phaseRoot 'result.json'
  $launch = $null
  $finalize = $null
  try {
    $readiness = { param([hashtable]$Context) return [IO.File]::Exists([string]$Context.ReadyPath) }
    $launch = & $lifecycle -Action Launch -RecordPath $recordPath -Executable "$PSHOME\pwsh.exe" -ArgumentList @(
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $runner, '-Mode', $Name,
      '-RunRoot', $phaseRoot, '-ReadyPath', $readyPath, '-StopPath', $stopPath,
      '-ResultPath', $resultPath, '-RepositoryRoot', $repositoryRoot
    ) -WorkingDirectory $repositoryRoot -StdoutPath $stdoutPath -StderrPath $stderrPath -ReadinessIdentity "issue11-$($Name.ToLowerInvariant())-ready-file" -ReadinessCheck $readiness -ReadinessContext @{ ReadyPath = $readyPath } -ReadinessDeadlineMilliseconds $ReadinessDeadlineMilliseconds -RequestedDisposition Stop -DownstreamResult ([ordered]@{ status = 'pending' })
    if ($launch.lifecycle_result.status -ne 'success') { throw "$Name Launch failed: $($launch | ConvertTo-Json -Depth 12 -Compress)" }

    $graceful = { param([hashtable]$Binding) [IO.File]::WriteAllText([string]$Binding.graceful_context.StopPath, 'stop', [Text.UTF8Encoding]::new($false)); return $true }
    $finalize = & $lifecycle -Action Finalize -RecordPath $recordPath -Disposition Stop -GracefulAction $graceful -GracefulContext @{ StopPath = $stopPath } -GracefulDeadlineMilliseconds 12000 -DownstreamResult ([ordered]@{ status = 'completed' })
    if ($finalize.lifecycle_result.status -ne 'success' -or $finalize.final_disposition.status -ne 'completed' -or -not $finalize.evidence.owned_tree_empty -or -not $finalize.evidence.named_job_absent -or -not $finalize.evidence.record_cleanup_completed) {
      throw "$Name Finalize failed: $($finalize | ConvertTo-Json -Depth 12 -Compress)"
    }
    return [ordered]@{ launch = $launch; finalize = $finalize; result = ([IO.File]::ReadAllText($resultPath) | ConvertFrom-Json -AsHashtable); root = $phaseRoot }
  } finally {
    if ($launch -and $launch.lifecycle_result.status -eq 'success' -and (-not $finalize -or $finalize.final_disposition.status -ne 'completed') -and [IO.File]::Exists($recordPath)) {
      $graceful = { param([hashtable]$Binding) [IO.File]::WriteAllText([string]$Binding.graceful_context.StopPath, 'stop', [Text.UTF8Encoding]::new($false)); return $true }
      & $lifecycle -Action Finalize -RecordPath $recordPath -Disposition Stop -GracefulAction $graceful -GracefulContext @{ StopPath = $stopPath } -GracefulDeadlineMilliseconds 12000 | Out-Null
    }
  }
}

$summary = [ordered]@{ started_at_utc = [DateTimeOffset]::UtcNow.ToString('O'); repository = $repositoryRoot; run_root = $runRoot; actual_app_attempts = 0 }
try {
  if ($VerifiedFixtureSummary) {
    $fixtureSummaryPath = [IO.Path]::GetFullPath($VerifiedFixtureSummary)
    $relativeFixturePath = [IO.Path]::GetRelativePath($PSScriptRoot, $fixtureSummaryPath)
    $fixtureEvidenceRoot = [IO.DirectoryInfo]::new([IO.Path]::GetDirectoryName($fixtureSummaryPath))
    if ($relativeFixturePath.StartsWith('..') -or $fixtureEvidenceRoot.Name -notlike '.issue11-tui-*' -or [IO.Path]::GetFileName($fixtureSummaryPath) -ne 'summary.json' -or -not $fixtureEvidenceRoot.Exists -or ($fixtureEvidenceRoot.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw 'Verified fixture summary is outside a direct non-reparse acceptance runtime root.'
    }
    $verified = [IO.File]::ReadAllText($fixtureSummaryPath) | ConvertFrom-Json -AsHashtable
    $fixtureAge = [DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse([string]$verified.finished_at_utc)
    if ($fixtureAge.TotalMinutes -lt 0 -or $fixtureAge.TotalMinutes -gt 15 -or $verified.repository -ne $repositoryRoot -or $verified.status -ne 'FIXTURES_PROVEN' -or $verified.actual_app_attempts -ne 0) {
      throw 'Verified fixture summary is stale or does not match this repository and zero-app preflight.'
    }
    if ($verified.shared_read_probe.status -ne 'passed' -or $verified.fixture.result.status -ne 'passed' -or -not $verified.fixture.result.owned_job_empty -or $verified.fixture.finalize.lifecycle_result.status -ne 'success' -or -not $verified.fixture.finalize.evidence.owned_tree_empty -or -not $verified.fixture.finalize.evidence.record_cleanup_completed) {
      throw 'Verified fixture summary does not prove harmless lifecycle cleanup.'
    }
    if ($verified.pty_fixture.result.status -ne 'passed' -or -not $verified.pty_fixture.result.input_via_designated_channel -or -not $verified.pty_fixture.result.output_via_designated_channel -or -not $verified.pty_fixture.result.in_job_before_resume -or -not $verified.pty_fixture.result.owned_job_empty -or -not $verified.pty_fixture.exact_channel -or -not $verified.pty_fixture.lifecycle_stdio_clean -or $verified.pty_fixture.finalize.lifecycle_result.status -ne 'success' -or -not $verified.pty_fixture.finalize.evidence.owned_tree_empty -or -not $verified.pty_fixture.finalize.evidence.record_cleanup_completed) {
      throw 'Verified fixture summary does not prove exact PTY channels and lifecycle cleanup.'
    }
    $summary.verified_fixture = [ordered]@{ status = 'FIXTURES_PROVEN'; age_seconds = [Math]::Round($fixtureAge.TotalSeconds, 3); actual_app_attempts = 0; exact_channel = $true; owned_cleanup = $true }
  } else {
    $summary.shared_read_probe = Invoke-SharedReadProbe
    $summary.fixture = Invoke-Phase 'Fixture' 10000
    if ($summary.fixture.result.status -ne 'passed' -or -not $summary.fixture.result.owned_job_empty) { throw 'Harmless fixture did not prove runner return and cleanup.' }
    $summary.pty_fixture = Invoke-Phase 'PtyFixture' 15000
    $ptyResult = $summary.pty_fixture.result
    if ($ptyResult.status -ne 'passed' -or -not $ptyResult.input_via_designated_channel -or -not $ptyResult.output_via_designated_channel -or -not $ptyResult.in_job_before_resume -or -not $ptyResult.owned_job_empty) {
      throw 'Harmless PTY fixture did not prove exact input/output channels and owned cleanup.'
    }
    $ptyOuterStdout = [IO.File]::ReadAllText((Join-Path $summary.pty_fixture.root 'lifecycle\stdout.log'))
    $ptyOuterStderr = [IO.File]::ReadAllText((Join-Path $summary.pty_fixture.root 'lifecycle\stderr.log'))
    if ($ptyOuterStdout.Contains([string]$ptyResult.channel_token) -or $ptyOuterStderr.Contains([string]$ptyResult.channel_token)) {
      throw 'Harmless PTY fixture marker escaped the designated PTY channel into lifecycle stdio.'
    }
    $summary.pty_fixture.exact_channel = $true
    $summary.pty_fixture.lifecycle_stdio_clean = $true
  }
  if ($FixtureOnly) {
    $summary.status = 'FIXTURES_PROVEN'
    return
  }

  & npm.cmd run build -w '@omw/contracts'
  if ($LASTEXITCODE -ne 0) { throw "contracts build failed with exit $LASTEXITCODE" }
  & npm.cmd run build -w '@omw/manager'
  if ($LASTEXITCODE -ne 0) { throw "manager build failed with exit $LASTEXITCODE" }
  & npm.cmd run build -w '@sevenflanks/omw'
  if ($LASTEXITCODE -ne 0) { throw "launcher build failed with exit $LASTEXITCODE" }

  $summary.actual_app_attempts = 1
  $summary.app = Invoke-Phase 'App' 60000
  $summary.status = if ($summary.app.result.status -eq 'proven' -and $summary.app.result.cleanup.launcher_exited_after_ctrl_c -and $summary.app.result.cleanup.owned_job_empty) { 'PROVEN' } else { 'NOT_PROVEN' }
} catch {
  $summary.status = 'NOT_PROVEN'
  $summary.error = $_.Exception.Message
} finally {
  $summary.finished_at_utc = [DateTimeOffset]::UtcNow.ToString('O')
  $reportPath = Join-Path $runRoot 'summary.json'
  [IO.File]::WriteAllText($reportPath, ($summary | ConvertTo-Json -Depth 16), [Text.UTF8Encoding]::new($false))
  Write-Output ($summary | ConvertTo-Json -Depth 16)
}

if ($summary.status -ne 'PROVEN') { exit 1 }
