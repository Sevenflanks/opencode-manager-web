[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('Fixture', 'PtyFixture', 'PtyHost', 'App')][string]$Mode,
  [Parameter(Mandatory)][string]$RunRoot,
  [Parameter(Mandatory)][string]$ReadyPath,
  [Parameter(Mandatory)][string]$StopPath,
  [Parameter(Mandatory)][string]$ResultPath,
  [Parameter(Mandatory)][string]$RepositoryRoot,
  [string]$PtyRequestPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'Issue11TuiNative.cs')
$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  throw 'Required Node.js executable was not found via Get-Command node.exe. Put Node.js on PATH before running the TUI acceptance.'
}
$node = [IO.Path]::GetFullPath([string]$nodeCommand.Source)
$nodeDirectory = Split-Path -Parent $node

function Write-Json([string]$Path, [object]$Value) {
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
}

if ($Mode -eq 'PtyHost') {
  $request = $null
  try {
    $request = [Omw.Issue11Acceptance.SharedText]::ReadAllText($PtyRequestPath) | ConvertFrom-Json -AsHashtable
    $hostResult = [Omw.Issue11Acceptance.PtyHost]::Run(
      [string]$request.executable,
      [string[]]@($request.arguments),
      [string]$request.working_directory
    )
    Write-Json ([string]$request.result_path) ([ordered]@{
      status = 'completed'
      exit_code = $hostResult.ExitCode
      in_job_before_resume = $hostResult.InJobBeforeResume
    })
    exit $hostResult.ExitCode
  } catch {
    if ($request -and $request.result_path) {
      Write-Json ([string]$request.result_path) ([ordered]@{ status = 'failed'; error = $_.Exception.Message })
    }
    throw
  }
}

function New-IsolatedEnvironment([string]$Root) {
  $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($name in 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT') {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($value) { $environment[$name] = $value }
  }
  $system32 = Join-Path $env:SystemRoot 'System32'
  $environment['PATH'] = @($nodeDirectory, $PSHOME, $system32) -join ';'
  foreach ($directory in 'home', 'home\AppData\Roaming', 'home\AppData\Local', 'xdg\config', 'xdg\data', 'xdg\cache', 'config\empty', 'opencode', 'omw', 'project', 'web-empty') {
    [IO.Directory]::CreateDirectory((Join-Path $Root $directory)) | Out-Null
  }
  $environment['HOME'] = Join-Path $Root 'home'
  $environment['USERPROFILE'] = $environment['HOME']
  $environment['APPDATA'] = Join-Path $Root 'home\AppData\Roaming'
  $environment['LOCALAPPDATA'] = Join-Path $Root 'home\AppData\Local'
  $environment['XDG_CONFIG_HOME'] = Join-Path $Root 'xdg\config'
  $environment['XDG_DATA_HOME'] = Join-Path $Root 'xdg\data'
  $environment['XDG_CACHE_HOME'] = Join-Path $Root 'xdg\cache'
  $environment['OPENCODE_DB'] = Join-Path $Root 'opencode\opencode.db'
  $environment['OPENCODE_CONFIG'] = Join-Path $Root 'config\opencode.json'
  $environment['OPENCODE_TUI_CONFIG'] = Join-Path $Root 'config\tui.json'
  $environment['OPENCODE_CONFIG_DIR'] = Join-Path $Root 'config\empty'
  $environment['OPENCODE_DISABLE_DEFAULT_PLUGINS'] = '1'
  $environment['OPENCODE_DISABLE_AUTOUPDATE'] = '1'
  $environment['OPENCODE_DISABLE_LSP_DOWNLOAD'] = '1'
  $environment['OPENCODE_DISABLE_MODELS_FETCH'] = '1'
  $environment['OPENCODE_DISABLE_CLAUDE_CODE'] = '1'
  $environment['OPENCODE_AUTO_SHARE'] = 'false'
  $environment['OPENCODE_ENABLE_EXA'] = '0'
  $environment['OPENCODE_ENABLE_PARALLEL'] = '0'
  $environment['HTTP_PROXY'] = 'http://127.0.0.1:9'
  $environment['HTTPS_PROXY'] = 'http://127.0.0.1:9'
  $environment['ALL_PROXY'] = 'http://127.0.0.1:9'
  $environment['NO_PROXY'] = '127.0.0.1,localhost'
  $environment['TMP'] = Join-Path $Root 'tmp'
  $environment['TEMP'] = $environment['TMP']
  [IO.Directory]::CreateDirectory($environment['TMP']) | Out-Null
  return $environment
}

function Get-EphemeralPort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  try { $listener.Start(); return ([Net.IPEndPoint]$listener.LocalEndpoint).Port } finally { $listener.Stop() }
}

function New-HttpClient {
  $handler = [Net.Http.SocketsHttpHandler]::new()
  $handler.UseProxy = $false
  $handler.ConnectTimeout = [TimeSpan]::FromSeconds(1)
  $client = [Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(2)
  return $client
}

function Wait-Http([Net.Http.HttpClient]$Client, [string]$Url, [int]$DeadlineMilliseconds, [string]$LauncherToken = '') {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($watch.ElapsedMilliseconds -lt $DeadlineMilliseconds) {
    try {
      $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $Url)
      if ($LauncherToken) { $request.Headers.Add('x-omw-launcher-token', $LauncherToken) }
      $response = $Client.Send($request)
      if ($response.IsSuccessStatusCode) { return $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() }
    } catch { }
    Start-Sleep -Milliseconds 100
  }
  throw "HTTP readiness exceeded ${DeadlineMilliseconds}ms: $Url"
}

function Invoke-JsonRequest([Net.Http.HttpClient]$Client, [string]$Method, [string]$Url, [object]$Body = $null) {
  $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($Method), $Url)
  if ($null -ne $Body) { $request.Content = [Net.Http.StringContent]::new(($Body | ConvertTo-Json -Compress), [Text.Encoding]::UTF8, 'application/json') }
  $response = $Client.Send($request)
  $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
  if (-not $response.IsSuccessStatusCode) { throw "$Method $Url failed with HTTP $([int]$response.StatusCode): $text" }
  return $text | ConvertFrom-Json -AsHashtable
}

function Wait-Stop([string]$Path, [int]$DeadlineMilliseconds) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($watch.ElapsedMilliseconds -lt $DeadlineMilliseconds) {
    if ([IO.File]::Exists($Path)) { return }
    Start-Sleep -Milliseconds 25
  }
  throw "Runner watchdog exceeded ${DeadlineMilliseconds}ms waiting for Stop."
}

function New-Token([int]$Bytes = 32) {
  $buffer = [byte[]]::new($Bytes)
  [Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return [Convert]::ToBase64String($buffer).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function Start-PtyTarget(
  [object]$Job,
  [Collections.Generic.IDictionary[string,string]]$Environment,
  [string]$Root,
  [string]$Executable,
  [string[]]$Arguments,
  [string]$WorkingDirectory,
  [string]$ScreenPath
) {
  $requestPath = Join-Path $Root 'pty-request.json'
  $hostResultPath = Join-Path $Root 'pty-host-result.json'
  Write-Json $requestPath ([ordered]@{
    executable = $Executable
    arguments = $Arguments
    working_directory = $WorkingDirectory
    result_path = $hostResultPath
  })
  $hostArguments = @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File', $PSCommandPath,
    '-Mode', 'PtyHost', '-RunRoot', $Root, '-ReadyPath', $ReadyPath,
    '-StopPath', $StopPath, '-ResultPath', $ResultPath,
    '-RepositoryRoot', $RepositoryRoot, '-PtyRequestPath', $requestPath
  )
  return [pscustomobject]@{
    Child = $Job.StartConPty("$PSHOME\pwsh.exe", $hostArguments, $WorkingDirectory, $Environment, 120, 36, $ScreenPath)
    HostResultPath = $hostResultPath
  }
}

$job = $null
$fixture = $null
$seeder = $null
$manager = $null
$tui = $null
$result = [ordered]@{ mode = $Mode; status = 'failed'; started_at_utc = [DateTimeOffset]::UtcNow.ToString('O') }
try {
  [IO.Directory]::CreateDirectory($RunRoot) | Out-Null
  $job = [Omw.Issue11Acceptance.OwnedJob]::new()
  $environment = New-IsolatedEnvironment $RunRoot
  if ($Mode -eq 'Fixture') {
    $fixture = $job.StartRedirected("$PSHOME\pwsh.exe", @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30'), $RunRoot, $environment, (Join-Path $RunRoot 'fixture.stdout.log'), (Join-Path $RunRoot 'fixture.stderr.log'))
    if ($job.ActiveProcesses -lt 1) { throw 'Fixture Job did not retain its assigned child.' }
    Write-Json $ReadyPath ([ordered]@{ mode = 'Fixture'; assigned_before_resume = $true; active_processes = $job.ActiveProcesses; child_pid = $fixture.ProcessId })
    Wait-Stop $StopPath 15000
    $job.Terminate(0)
    if (-not $job.WaitEmpty(5000)) { throw 'Fixture Job did not empty after termination.' }
    $result.status = 'passed'; $result.assigned_before_resume = $true; $result.owned_job_empty = $true
    Write-Json $ResultPath $result
    exit 0
  }

  if ($Mode -eq 'PtyFixture') {
    $token = [Guid]::NewGuid().ToString('N')
    $fixtureScript = Join-Path $RunRoot 'pty-channel-probe.cjs'
    [IO.File]::WriteAllText($fixtureScript, @'
const { spawnSync } = require("node:child_process")
const token = process.argv[3]
if (process.argv[2] === "leaf") {
  process.stdout.write(`PTY_READY:${token}\r\n`)
  process.stdin.setEncoding("utf8")
  const timer = setTimeout(() => process.exit(91), 5000)
  process.stdin.once("data", chunk => {
    clearTimeout(timer)
    const input = chunk.replace(/[\r\n]+/g, "")
    process.stdout.write(`PTY_REPLY:${token}:${input}\r\n`, () => process.exit(0))
  })
} else {
  const child = spawnSync(process.execPath, [__filename, "leaf", token], { stdio: "inherit", timeout: 10000 })
  process.exit(child.status === null ? 92 : child.status)
}
'@, [Text.UTF8Encoding]::new($false))
    $screenPath = Join-Path $RunRoot 'pty-channel-screen.ansi'
    $started = Start-PtyTarget $job $environment $RunRoot $node @($fixtureScript, 'parent', $token) $RunRoot $screenPath
    $tui = $started.Child
    $readyMarker = "PTY_READY:$token"
    $inputMarker = "PTY_INPUT:$token"
    $replyMarker = "PTY_REPLY:$token`:$inputMarker"
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $readySeen = $false
    while ($watch.ElapsedMilliseconds -lt 5000 -and -not $tui.HasExited) {
      Start-Sleep -Milliseconds 50
      $raw = if ([IO.File]::Exists($screenPath)) { [Omw.Issue11Acceptance.SharedText]::ReadAllText($screenPath) } else { '' }
      if ($raw.Contains($readyMarker)) { $readySeen = $true; break }
    }
    if (-not $readySeen) { throw 'PTY channel probe did not emit its readiness marker on the designated output channel.' }
    $tui.WriteInput("$inputMarker`r")
    if (-not $tui.WaitForExit(8000)) { throw 'PTY channel probe did not exit after designated-channel input.' }
    $tui.CloseInput()
    $tui.ClosePseudoConsoleBounded(2000) | Out-Null
    if (-not $tui.WaitForOutputDrain(2000)) { throw 'PTY channel probe output did not drain.' }
    if ($tui.OutputError) { throw "PTY channel probe output failed: $($tui.OutputError)" }
    $raw = [Omw.Issue11Acceptance.SharedText]::ReadAllText($screenPath)
    if (-not $raw.Contains($inputMarker) -or ([Regex]::Matches($raw, [Regex]::Escape($replyMarker)).Count -ne 1)) {
      throw 'PTY channel probe did not prove exact input echo and one output reply on the designated channel.'
    }
    $hostResult = [Omw.Issue11Acceptance.SharedText]::ReadAllText($started.HostResultPath) | ConvertFrom-Json -AsHashtable
    if ($hostResult.status -ne 'completed' -or -not $hostResult.in_job_before_resume -or $hostResult.exit_code -ne 0) {
      throw 'PTY channel host did not prove suspended current-Job membership and clean completion.'
    }
    if (-not $job.WaitEmpty(5000)) { throw 'PTY channel probe descendants remained in the owned Job.' }
    $result.status = 'passed'
    $result.channel_token = $token
    $result.input_via_designated_channel = $true
    $result.output_via_designated_channel = $true
    $result.in_job_before_resume = $true
    Write-Json $ResultPath $result
    Write-Json $ReadyPath ([ordered]@{ mode = 'PtyFixture'; status = 'passed' })
    Wait-Stop $StopPath 15000
    $result.owned_job_empty = $job.WaitEmpty(1000)
    Write-Json $ResultPath $result
    exit 0
  }

  $opencode = $env:OMW_OPENCODE_EXECUTABLE
  if ([string]::IsNullOrWhiteSpace($opencode)) {
    throw 'OMW_OPENCODE_EXECUTABLE must be set to the OpenCode executable path before running the App acceptance.'
  }
  $opencodeCommand = Get-Command $opencode -CommandType Application -ErrorAction SilentlyContinue
  if ($opencodeCommand) { $opencode = [string]$opencodeCommand.Source }
  $opencode = [IO.Path]::GetFullPath($opencode)
  $managerEntry = Join-Path $RepositoryRoot 'apps\manager\dist\src\server.js'
  $launcherEntry = Join-Path $RepositoryRoot 'packages\launcher\dist\src\manager-cli.js'
  foreach ($path in $node, $opencode, $managerEntry, $launcherEntry) { if (-not [IO.File]::Exists($path)) { throw "Required executable/build output is absent: $path" } }

  $project = Join-Path $RunRoot 'project'
  [IO.File]::WriteAllText((Join-Path $project 'README.md'), "# Isolated Issue 11 acceptance project`n")
  [IO.File]::WriteAllText($environment['OPENCODE_CONFIG'], '{"plugin":[],"mcp":{}}', [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($environment['OPENCODE_TUI_CONFIG'], '{}', [Text.UTF8Encoding]::new($false))

  $password = New-Token 24
  $launcherToken = New-Token 32
  $plain = [Text.Encoding]::UTF8.GetBytes((@{ manager = @{ username = 'issue11-acceptance'; password = $password }; launcherToken = $launcherToken } | ConvertTo-Json -Compress))
  try {
    $cipher = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    try { [IO.File]::WriteAllText((Join-Path $RunRoot 'omw\credentials.dpapi'), [Convert]::ToBase64String($cipher), [Text.UTF8Encoding]::new($false)) } finally { [Array]::Clear($cipher, 0, $cipher.Length) }
  } finally { [Array]::Clear($plain, 0, $plain.Length) }

  $client = New-HttpClient
  try {
    $seedPort = Get-EphemeralPort
    $seeder = $job.StartRedirected($opencode, @('serve', '--hostname', '127.0.0.1', '--port', [string]$seedPort), $project, $environment, (Join-Path $RunRoot 'seeder.stdout.log'), (Join-Path $RunRoot 'seeder.stderr.log'))
    Wait-Http $client "http://127.0.0.1:$seedPort/global/health" 15000 | Out-Null
    $suffix = [Guid]::NewGuid().ToString('N').Substring(0, 10)
    $targetTitle = "ISSUE11-TARGET-$suffix"
    $decoyTitle = "ISSUE11-DECOY-$suffix"
    $target = Invoke-JsonRequest $client 'POST' "http://127.0.0.1:$seedPort/session" @{ title = $targetTitle }
    Start-Sleep -Milliseconds 100
    $decoy = Invoke-JsonRequest $client 'POST' "http://127.0.0.1:$seedPort/session" @{ title = $decoyTitle }
    $seeder.Terminate(0)
    if (-not $seeder.WaitForExit(5000)) { throw 'Seeder did not stop within 5000ms.' }
    if (-not $job.WaitEmpty(5000)) { throw 'Seeder descendants remained in the owned Job.' }

    $managerPort = Get-EphemeralPort
    $instancePort = Get-EphemeralPort
    $environment['OMW_DATA_DIR'] = Join-Path $RunRoot 'omw'
    $environment['OMW_PORT'] = [string]$managerPort
    $environment['OMW_INSTANCE_PORT_MIN'] = [string]$instancePort
    $environment['OMW_INSTANCE_PORT_MAX'] = [string]$instancePort
    $environment['OMW_LAUNCHER_INTEGRATION'] = '1'
    $environment['OMW_WEB_ROOT'] = Join-Path $RunRoot 'web-empty'
    $environment['OMW_OPENCODE_EXECUTABLE'] = $opencode
    $environment['OMW_POWERSHELL_EXECUTABLE'] = "$PSHOME\pwsh.exe"
    $environment['OMW_MANAGER_ORIGIN'] = "http://127.0.0.1:$managerPort"
    $environment['OMW_REQUIRED'] = '1'

    $manager = $job.StartRedirected($node, @($managerEntry), $RepositoryRoot, $environment, (Join-Path $RunRoot 'manager.stdout.log'), (Join-Path $RunRoot 'manager.stderr.log'))
    Wait-Http $client "http://127.0.0.1:$managerPort/api/v1/launcher/identity" 15000 $launcherToken | Out-Null

    $screenPath = Join-Path $RunRoot 'tui-screen.ansi'
    $started = Start-PtyTarget $job $environment $RunRoot $node @($launcherEntry, 'opencode', '-s', [string]$target.id) $project $screenPath
    $tui = $started.Child
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $proof = $null
    while ($watch.ElapsedMilliseconds -lt 30000 -and -not $tui.HasExited) {
      Start-Sleep -Milliseconds 200
      $raw = if ([IO.File]::Exists($screenPath)) { [Omw.Issue11Acceptance.SharedText]::ReadAllText($screenPath) } else { '' }
      $plainScreen = [Regex]::Replace($raw, "`e\][^`a]*(?:`a|`e\\)", '')
      $plainScreen = [Regex]::Replace($plainScreen, "`e\[[0-9;?]*[ -/]*[@-~]", '')
      $ansiControls = [Regex]::Matches($raw, "`e\[[0-9;?]*[ -/]*[@-~]").Count
      try {
        $overview = Invoke-JsonRequest $client 'GET' "http://127.0.0.1:$managerPort/api/v1/overview"
        $instance = @($overview.instances | Where-Object { $_.kind -eq 'local-tui' -and [IO.Path]::GetFullPath([string]$_.projectDirectory) -eq [IO.Path]::GetFullPath($project) }) | Select-Object -First 1
        if ($ansiControls -ge 10 -and $plainScreen.Contains($targetTitle) -and -not $plainScreen.Contains($decoyTitle) -and $instance -and $instance.state -eq 'ready') {
          $proof = [ordered]@{
            true_tui_render = $true; ansi_control_count = $ansiControls; target_title_visible = $true; decoy_title_visible = $false
            target_session_id = $target.id; target_title = $targetTitle; decoy_session_id = $decoy.id; decoy_title = $decoyTitle
            manager_instance_id = $instance.id; manager_kind = $instance.kind; manager_state = $instance.state
            pty_host_pid = $tui.ProcessId; manager_pid = $manager.ProcessId
          }
          [IO.File]::WriteAllText((Join-Path $RunRoot 'tui-screen.txt'), $plainScreen, [Text.UTF8Encoding]::new($false))
          Write-Json (Join-Path $RunRoot 'manager-overview.json') $overview
          break
        }
      } catch { }
    }
    if (-not $proof) {
      $exit = if ($tui.HasExited) { $tui.ExitCode } else { $null }
      throw "NOT_PROVEN: no bounded PTY screen target/not-decoy + Manager local-tui ready proof (PTY host exit=$exit)."
    }
    $result.status = 'proven'; $result.proof = $proof
    Write-Json $ResultPath $result
    Write-Json $ReadyPath ([ordered]@{ mode = 'App'; status = 'proven'; result_path = $ResultPath })
    Wait-Stop $StopPath 15000
    $ctrlCStarted = [DateTimeOffset]::UtcNow
    $tui.SendCtrlC()
    $ctrlCExited = $tui.WaitForExit(3000)
    $job.Terminate(0)
    $empty = $job.WaitEmpty(5000)
    if (-not $empty) { throw 'Owned app Job did not empty after bounded cleanup.' }
    $tui.CloseInput()
    $tui.ClosePseudoConsoleBounded(2000) | Out-Null
    $tui.WaitForOutputDrain(2000) | Out-Null
    $result.cleanup = [ordered]@{ ctrl_c_started_at_utc = $ctrlCStarted.ToString('O'); ctrl_c_deadline_ms = 3000; launcher_exited_after_ctrl_c = $ctrlCExited; terminate_job_invoked = $true; owned_job_empty = $empty; conpty_output_error = $tui.OutputError }
    if (-not $ctrlCExited) { $result.status = 'failed' }
    Write-Json $ResultPath $result
    if (-not $ctrlCExited) { throw 'NOT_PROVEN: PTY launcher did not exit within 3000ms after Ctrl-C.' }
  } finally { if ($client) { $client.Dispose() } }
}
catch {
  $result.error = $_.Exception.Message
  $result.stack = $_.ScriptStackTrace
  try { if ($job) { $job.Terminate(124); $result.cleanup_job_empty = $job.WaitEmpty(5000) } } catch { $result.cleanup_error = $_.Exception.Message }
  Write-Json $ResultPath $result
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
finally {
  if ($tui) { $tui.Dispose() }
  if ($manager) { $manager.Dispose() }
  if ($seeder) { $seeder.Dispose() }
  if ($fixture) { $fixture.Dispose() }
  if ($job) { $job.Dispose() }
}
