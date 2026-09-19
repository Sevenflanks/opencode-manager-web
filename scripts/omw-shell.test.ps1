$ErrorActionPreference = 'Stop'

function ConvertTo-SingleQuotedLiteral([string]$value) {
  return "'$($value.Replace("'", "''"))'"
}

function Invoke-IsolatedPowerShell(
  [string]$name,
  [string]$content,
  [hashtable]$environment,
  [string]$workingDirectory
) {
  $casePath = Join-Path $script:scratchRoot "$name.ps1"
  [IO.File]::WriteAllText($casePath, $content, [Text.UTF8Encoding]::new($false))

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $script:pwshPath
  $startInfo.WorkingDirectory = $workingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  [void]$startInfo.ArgumentList.Add('-NoLogo')
  [void]$startInfo.ArgumentList.Add('-NoProfile')
  [void]$startInfo.ArgumentList.Add('-File')
  [void]$startInfo.ArgumentList.Add($casePath)
  foreach ($entry in $environment.GetEnumerator()) {
    $startInfo.Environment[$entry.Key] = [string]$entry.Value
  }

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    throw "Failed to start isolated PowerShell case '$name'."
  }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(10000)) {
    $process.Kill($true)
    throw "Isolated PowerShell case '$name' exceeded 10000ms."
  }
  $process.WaitForExit()

  return [pscustomobject]@{
    ExitCode = $process.ExitCode
    Stdout = $stdoutTask.GetAwaiter().GetResult()
    Stderr = $stderrTask.GetAwaiter().GetResult()
  }
}

function Assert-ChildPassed([string]$name, [pscustomobject]$result) {
  if ($result.ExitCode -ne 0) {
    throw "Case '$name' failed with exit code $($result.ExitCode).`nSTDOUT:`n$($result.Stdout)`nSTDERR:`n$($result.Stderr)"
  }
}

$tempParent = [IO.Path]::GetTempPath()
if (-not (Test-Path -LiteralPath $tempParent -PathType Container)) {
  throw "Temporary parent does not exist: '$tempParent'."
}

$pwsh = Get-Command pwsh -CommandType Application -ErrorAction Stop | Select-Object -First 1
$node = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
$script:pwshPath = $pwsh.Path
$script:scratchRoot = Join-Path $tempParent "omw-shell-test-$([guid]::NewGuid().ToString('N'))"
$repoRoot = Join-Path $script:scratchRoot 'repo with spaces'
$helperDirectory = Join-Path $repoRoot 'scripts'
$launcherDirectory = Join-Path $repoRoot 'packages\launcher\dist\src'
$invocationDirectory = Join-Path $script:scratchRoot 'caller cwd 雪 & [fixture]'
$emptyBin = Join-Path $script:scratchRoot 'empty-bin'
$missingRepoRoot = Join-Path $script:scratchRoot 'missing-entry-repo'
$missingHelperDirectory = Join-Path $missingRepoRoot 'scripts'

try {
  foreach ($directory in @(
    $helperDirectory,
    $launcherDirectory,
    $invocationDirectory,
    $emptyBin,
    $missingHelperDirectory
  )) {
    [void][IO.Directory]::CreateDirectory($directory)
  }

  $helperPath = Join-Path $helperDirectory 'omw-shell.ps1'
  $launcherPath = Join-Path $launcherDirectory 'cli.js'
  $missingHelperPath = Join-Path $missingHelperDirectory 'omw-shell.ps1'
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'omw-shell.ps1') -Destination $helperPath
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'omw-shell.ps1') -Destination $missingHelperPath
  [IO.File]::WriteAllText($launcherPath, @'
const fs = require("node:fs");
fs.writeFileSync(
  process.env.OMW_FAKE_CAPTURE,
  JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }),
  "utf8",
);
process.exit(17);
'@, [Text.UTF8Encoding]::new($false))

  $capturePath = Join-Path $script:scratchRoot 'capture.json'
  $expectedArguments = @(
    'value with spaces',
    '雪-ユニコード',
    '-s',
    'ses with spaces',
    '--help',
    'literal & | ; $() [] {} !'
  )
  $argumentLiterals = ($expectedArguments | ForEach-Object {
    "  $(ConvertTo-SingleQuotedLiteral $_)"
  }) -join ",`n"
  $helperLiteral = ConvertTo-SingleQuotedLiteral $helperPath
  $happyCase = @"
`$ErrorActionPreference = 'Stop'
function Get-EnvironmentSnapshot {
  `$snapshot = @{}
  foreach (`$item in Get-ChildItem Env:) { `$snapshot[`$item.Name] = `$item.Value }
  return `$snapshot
}
`$beforeEnvironment = Get-EnvironmentSnapshot
`$existing = 'caller-existing-sentinel'
`$omwLauncherPath = 'caller-omw-launcher-sentinel'
. $helperLiteral
`$firstSource = (Get-Command omw -CommandType Function -ErrorAction Stop).ScriptBlock.File
. $helperLiteral
`$secondSource = (Get-Command omw -CommandType Function -ErrorAction Stop).ScriptBlock.File
if (`$firstSource -cne $helperLiteral -or `$secondSource -cne $helperLiteral) { throw 'Helper ownership source was not retained.' }
if (`$existing -cne 'caller-existing-sentinel' -or `$omwLauncherPath -cne 'caller-omw-launcher-sentinel') { throw 'Caller variables were changed.' }
`$forwarded = @(
$argumentLiterals
)
omw @forwarded
`$observedExitCode = `$LASTEXITCODE
'caller-marker-after-omw'
if (`$observedExitCode -ne 17) { throw "Expected LASTEXITCODE 17, got '`$observedExitCode'." }
`$afterEnvironment = Get-EnvironmentSnapshot
if (`$beforeEnvironment.Count -ne `$afterEnvironment.Count) { throw 'Environment count changed.' }
foreach (`$key in `$beforeEnvironment.Keys) {
  if (-not `$afterEnvironment.ContainsKey(`$key) -or `$afterEnvironment[`$key] -cne `$beforeEnvironment[`$key]) {
    throw "Environment changed at '`$key'."
  }
}
if ((Get-Location).Path -cne $(ConvertTo-SingleQuotedLiteral $invocationDirectory)) { throw 'Caller cwd changed.' }
Remove-Item Function:\omw
if (Get-Command omw -ErrorAction SilentlyContinue) { throw 'Helper function was not removed.' }
exit 0
"@
  $controlledEnvironment = @{
    PATH = Split-Path -Parent $node.Path
    OMW_FAKE_CAPTURE = $capturePath
  }
  $happy = Invoke-IsolatedPowerShell 'happy-path' $happyCase $controlledEnvironment $invocationDirectory
  Assert-ChildPassed 'happy-path' $happy
  if ($happy.Stdout -notmatch 'caller-marker-after-omw') {
    throw 'Caller did not continue after the fake launcher exited 17.'
  }
  $capture = Get-Content -LiteralPath $capturePath -Raw | ConvertFrom-Json
  if ($capture.cwd -cne $invocationDirectory) {
    throw "Fake launcher cwd mismatch: '$($capture.cwd)'."
  }
  if (@($capture.argv).Count -ne $expectedArguments.Count) {
    throw 'Fake launcher argv count mismatch.'
  }
  for ($index = 0; $index -lt $expectedArguments.Count; $index++) {
    if ($capture.argv[$index] -cne $expectedArguments[$index]) {
      throw "Fake launcher argv $index mismatch."
    }
  }

  $aliasCase = @"
`$ErrorActionPreference = 'Stop'
Set-Alias omw Get-Date
`$before = (Get-Alias omw).Definition
try { . $helperLiteral; throw 'Expected alias conflict.' } catch {
  if (`$_.Exception.Message -notmatch 'existing Alias binding') { throw }
}
`$after = Get-Command omw -ErrorAction Stop
if (`$after.CommandType -ne 'Alias' -or `$after.Definition -cne `$before) { throw 'Existing alias changed.' }
exit 0
"@
  $alias = Invoke-IsolatedPowerShell 'existing-alias' $aliasCase $controlledEnvironment $invocationDirectory
  Assert-ChildPassed 'existing-alias' $alias

  $functionCase = @"
`$ErrorActionPreference = 'Stop'
function omw { 'user-function-sentinel' }
`$before = (Get-Command omw -CommandType Function).ScriptBlock.ToString()
try { . $helperLiteral; throw 'Expected function conflict.' } catch {
  if (`$_.Exception.Message -notmatch 'existing Function binding') { throw }
}
`$after = Get-Command omw -CommandType Function -ErrorAction Stop
if (`$after.ScriptBlock.ToString() -cne `$before -or (& omw) -cne 'user-function-sentinel') { throw 'Existing function changed.' }
exit 0
"@
  $function = Invoke-IsolatedPowerShell 'existing-function' $functionCase $controlledEnvironment $invocationDirectory
  Assert-ChildPassed 'existing-function' $function

  $missingHelperLiteral = ConvertTo-SingleQuotedLiteral $missingHelperPath
  $missingEntryCase = @"
`$ErrorActionPreference = 'Stop'
try { . $missingHelperLiteral; throw 'Expected missing compiled entry failure.' } catch {
  if (`$_.Exception.Message -notmatch 'compiled launcher not found') { throw }
}
if (Get-Command omw -ErrorAction SilentlyContinue) { throw 'Missing entry polluted the omw binding.' }
exit 0
"@
  $missingEntry = Invoke-IsolatedPowerShell 'missing-entry' $missingEntryCase $controlledEnvironment $invocationDirectory
  Assert-ChildPassed 'missing-entry' $missingEntry

  $missingNodeCase = @"
`$ErrorActionPreference = 'Stop'
try { . $helperLiteral; throw 'Expected missing node failure.' } catch {
  if (`$_.Exception.Message -notmatch 'node executable was not found') { throw }
}
if (Get-Command omw -ErrorAction SilentlyContinue) { throw 'Missing node polluted the omw binding.' }
exit 0
"@
  $missingNode = Invoke-IsolatedPowerShell 'missing-node' $missingNodeCase @{ PATH = $emptyBin } $invocationDirectory
  Assert-ChildPassed 'missing-node' $missingNode

  'omw-shell isolated fake tests passed'
}
finally {
  if (Test-Path -LiteralPath $script:scratchRoot) {
    Remove-Item -LiteralPath $script:scratchRoot -Recurse -Force
  }
}
