[CmdletBinding()]
param(
    [string]$OpenCodeExecutable = $env:OPENCODE_SPIKE_EXECUTABLE,
    [ValidateRange(30, 60)][int]$OverallDeadlineSeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$watch = [Diagnostics.Stopwatch]::StartNew()
$runId = [Guid]::NewGuid().ToString('N')
$repoRoot = Split-Path -Parent $PSScriptRoot
$sandbox = Join-Path $repoRoot ".scratch\opencode-tui-$runId"
$project = Join-Path $sandbox 'project'
$config = Join-Path $sandbox 'config'
$journal = Join-Path $sandbox 'journal.jsonl'
$outputPath = Join-Path $sandbox 'conpty-output.bin'
$resultPath = Join-Path $sandbox 'result.json'
$pty = $null
$client = $null
$port = $null
$naturalExit = $false
$forcedStop = $false
$cleanupErrors = [Collections.Generic.List[string]]::new()
$errors = [Collections.Generic.List[string]]::new()
$result = [ordered]@{
    status = 'running'; run_id = $runId; sandbox = $sandbox
    process = $null; isolation = [ordered]@{}; probes = [ordered]@{}
    resize = [ordered]@{}; render_observation = [ordered]@{}; exit = [ordered]@{ strategy='Ctrl+C byte once, then once more after a 2500 ms wait'; natural=$false; forced=$false; classification='not-started'; wait_limit_milliseconds=5000; exit_code=$null }; cleanup = [ordered]@{}
    errors = @(); limitations = @(
        'This is a bounded native ConPTY and loopback API probe, not complete TTY keyboard or ANSI validation.',
        'Mobile interaction, browser JavaScript execution, authentication, Tailnet, plugins, skills, and LLM prompts are not tested.',
        'ResizePseudoConsole API success and subsequent output bytes do not visually prove correct redraw.',
        'A non-Git project/current worktree of / is not treated as a failure.'
    )
}

function Write-Journal {
    param([string]$Stage, [string]$Message, [object]$Data)
    $event = [ordered]@{ timestamp_utc = [DateTime]::UtcNow.ToString('O'); stage = $Stage; message = $Message; data = $Data }
    [IO.File]::AppendAllText($journal, (($event | ConvertTo-Json -Compress -Depth 8) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
}

function Assert-Budget {
    if ($watch.Elapsed.TotalSeconds -ge $OverallDeadlineSeconds) { throw "Overall deadline of $OverallDeadlineSeconds seconds was exceeded." }
}

function New-FreePort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { [int]$listener.LocalEndpoint.Port } finally { $listener.Stop() }
}

function Test-Port {
    param([int]$Value)
    $tcp = [Net.Sockets.TcpClient]::new()
    try { $task = $tcp.ConnectAsync([Net.IPAddress]::Loopback, $Value); $task.Wait(200) -and $tcp.Connected } catch { $false } finally { $tcp.Dispose() }
}

function Invoke-Http {
    param([Net.Http.HttpMethod]$Method, [string]$Uri, [string]$Body)
    Assert-Budget
    $request = [Net.Http.HttpRequestMessage]::new($Method, $Uri)
    $cts = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(3))
    try {
        if ($PSBoundParameters.ContainsKey('Body')) { $request.Content = [Net.Http.StringContent]::new($Body, [Text.Encoding]::UTF8, 'application/json') }
        $response = $client.SendAsync($request, $cts.Token).GetAwaiter().GetResult()
        try {
            [pscustomobject]@{
                status = [int]$response.StatusCode
                content_type = [string]$response.Content.Headers.ContentType
                body = $response.Content.ReadAsStringAsync($cts.Token).GetAwaiter().GetResult()
            }
        } finally { $response.Dispose() }
    } finally { $cts.Dispose(); $request.Dispose() }
}

function Wait-Health {
    param([string]$BaseUri, [int]$Milliseconds = 15000)
    $readyWatch = [Diagnostics.Stopwatch]::StartNew(); $lastError = $null
    do {
        try {
            $response = Invoke-Http -Method ([Net.Http.HttpMethod]::Get) -Uri "$BaseUri/global/health"
            if ($response.status -eq 200) {
                $health = $response.body | ConvertFrom-Json
                if ($health.healthy -eq $true) { return [ordered]@{ status_code = 200; healthy = $true; version = [string]$health.version; elapsed_milliseconds = $readyWatch.ElapsedMilliseconds } }
            }
        } catch { $lastError = $_.Exception.Message }
        Start-Sleep -Milliseconds 200
    } while ($readyWatch.ElapsedMilliseconds -lt $Milliseconds)
    throw "OpenCode health was not ready within $Milliseconds ms. Last error: $lastError"
}

function New-IsolatedEnvironment {
    param([string]$SandboxHome, [string]$Database, [string]$ConfigPath)
    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    # Nested OpenCode launches must not inherit the hosting agent's process/context hints.
    # Explicit test settings are reapplied below; stripping names does not inspect their values.
    $patterns = @('OPENCODE*','OTUI*','*API_KEY*','*TOKEN*','*SECRET*','*PASSWORD*','*CREDENTIAL*','*PRIVATE_KEY*','*AUTH*','*PROXY*','SSH_*','GPG_*','AWS_*','AZURE_*','GOOGLE_*','GITHUB_*','GITLAB_*','ANTHROPIC_*','OPENAI_*','GEMINI_*','COHERE_*','MISTRAL_*','GROQ_*','CEREBRAS_*','XAI_*','VERTEXAI_*','OCI_*')
    $explicit = @('OPENCODE_CONFIG_CONTENT','OPENCODE_PERMISSION','OPENCODE_SERVER_PASSWORD','OPENCODE_SERVER_USERNAME')
    $removed = 0
    foreach ($entry in [Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Process).GetEnumerator()) {
        $name = [string]$entry.Key
        if (($explicit -contains $name) -or @($patterns | Where-Object { $name -like $_ }).Count -gt 0) { $removed++; continue }
        $environment[$name] = [string]$entry.Value
    }
    $values = [ordered]@{
        HOME=$SandboxHome; USERPROFILE=$SandboxHome; OPENCODE_TEST_HOME=$SandboxHome; CLAUDE_CONFIG_DIR=(Join-Path $sandbox 'claude')
        XDG_CONFIG_HOME=(Join-Path $sandbox 'xdg-config'); XDG_DATA_HOME=(Join-Path $sandbox 'xdg-data')
        XDG_CACHE_HOME=(Join-Path $sandbox 'xdg-cache'); XDG_STATE_HOME=(Join-Path $sandbox 'xdg-state')
        OPENCODE_DB=$Database; OPENCODE_CONFIG=$ConfigPath; OPENCODE_CONFIG_DIR=$config
        OPENCODE_DISABLE_PROJECT_CONFIG='1'; OPENCODE_PURE='1'; OPENCODE_DISABLE_DEFAULT_PLUGINS='1'
        OPENCODE_DISABLE_EXTERNAL_SKILLS='1'; OPENCODE_DISABLE_CLAUDE_CODE='1'; OPENCODE_DISABLE_CLAUDE_CODE_PROMPT='1'
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS='1'; OPENCODE_DISABLE_MODELS_FETCH='1'; OPENCODE_DISABLE_AUTOUPDATE='1'
        OPENCODE_DISABLE_LSP_DOWNLOAD='1'; OPENCODE_DISABLE_PRUNE='1'; OPENCODE_AUTO_SHARE='false'
    }
    foreach ($item in $values.GetEnumerator()) { $environment[$item.Key] = [string]$item.Value }
    [pscustomobject]@{ Values = $environment; RemovedCredentialNameCount = $removed }
}

function Read-OutputSnapshot {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    $stream = $null
    $memory = $null
    try {
        $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite, 65536, [IO.FileOptions]::SequentialScan)
        $memory = [IO.MemoryStream]::new(8 * 1024 * 1024)
        $buffer = [byte[]]::new(65536)
        while ($memory.Length -lt 8 * 1024 * 1024) {
            $toRead = [Math]::Min($buffer.Length, (8 * 1024 * 1024) - [int]$memory.Length)
            $read = $stream.Read($buffer, 0, $toRead)
            if ($read -le 0) { break }
            $memory.Write($buffer, 0, $read)
        }
        return [Text.Encoding]::UTF8.GetString($memory.ToArray())
    } catch [IO.FileNotFoundException] {
        return ''
    } catch [IO.IOException] {
        return ''
    } finally {
        if ($null -ne $memory) { $memory.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Get-NonControlText {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $clean = [regex]::Replace($Text, '\x1b\][^\x07]*(?:\x07|\x1b\\)', '')
    $clean = [regex]::Replace($clean, '\x1b\[[0-?]*[ -/]*[@-~]', '')
    $clean = [regex]::Replace($clean, '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]', '')
    return ($clean -replace '\s+', '')
}

function Wait-ForOutputCandidate {
    param([string]$Path, [int]$Milliseconds = 10000)
    $waitWatch = [Diagnostics.Stopwatch]::StartNew()
    $waitLimit = [Math]::Min($Milliseconds, [Math]::Max(0, ($OverallDeadlineSeconds * 1000) - $watch.ElapsedMilliseconds))
    $candidate = ''
    do {
        $candidate = Get-NonControlText (Read-OutputSnapshot -Path $Path)
        if ($candidate.Length -gt 40) { break }
        $remaining = $waitLimit - $waitWatch.ElapsedMilliseconds
        if ($remaining -le 0) { break }
        Start-Sleep -Milliseconds ([Math]::Min(200, $remaining))
    } while ($true)
    $found = $candidate.Length -gt 40
    $recordedCandidate = if ($candidate.Length -gt 512) { $candidate.Substring(0, 512) } else { $candidate }
    [ordered]@{
        wait_milliseconds = $waitWatch.ElapsedMilliseconds
        candidate_noncontrol_text = $recordedCandidate
        candidate_noncontrol_text_length = $candidate.Length
        candidatefound = $found
        timeout = -not $found
    }
}

try {
    if (-not (Test-Path -LiteralPath $OpenCodeExecutable -PathType Leaf)) { throw 'Pass -OpenCodeExecutable or set OPENCODE_SPIKE_EXECUTABLE to an existing opencode.exe.' }
    if (Test-Path -LiteralPath (Join-Path $env:ProgramData 'opencode') -PathType Container) { throw 'Isolation cannot be guaranteed because the Windows managed OpenCode config directory exists.' }
    foreach ($directory in @($sandbox,$project,$config,(Join-Path $sandbox 'home'),(Join-Path $sandbox 'claude'),(Join-Path $sandbox 'data'),(Join-Path $sandbox 'xdg-config'),(Join-Path $sandbox 'xdg-data'),(Join-Path $sandbox 'xdg-cache'),(Join-Path $sandbox 'xdg-state'))) {
        [IO.Directory]::CreateDirectory($directory) | Out-Null
    }
    [IO.File]::WriteAllText((Join-Path $config 'opencode.json'), "{`n  `"plugin`": []`n}`n", [Text.UTF8Encoding]::new($false))
    Write-Journal 'setup' 'Sandbox and cleanup plan exist before launch.' @{ run_id = $runId }
    Add-Type -Path (Join-Path $PSScriptRoot 'ConPtySpike.cs')
    $port = New-FreePort
    $baseUri = "http://127.0.0.1:$port"
    $childEnvironment = New-IsolatedEnvironment -SandboxHome (Join-Path $sandbox 'home') -Database (Join-Path $sandbox 'data\opencode.db') -ConfigPath (Join-Path $config 'opencode.json')
    $result.isolation = [ordered]@{ project=$project; home=(Join-Path $sandbox 'home'); database=(Join-Path $sandbox 'data\opencode.db'); explicit_child_environment=$true; parent_environment_modified=$false; path_modified=$false; credential_values_logged=$false; removed_credential_variable_name_count=$childEnvironment.RemovedCredentialNameCount }

    Write-Journal 'launch/registered' 'C# launch owns failure cleanup; returned object will be registered before metadata access.' @{ port = $port }
    $pty = [Omw.ConPtySpike.OwnedProcess]::Start($OpenCodeExecutable, @('--hostname','127.0.0.1','--port',[string]$port,'--pure'), $project, $childEnvironment.Values, 120, 35, $outputPath)
    # Registration precedes PID and creation-time access so metadata failure cannot bypass cleanup.
    $owned = $pty
    $result.process = [ordered]@{ pid=$owned.ProcessId; creation_time_utc=$owned.CreationTimeUtc.ToString('O'); executable=$OpenCodeExecutable; port=$port; initial_size='120x35' }
    Write-Journal 'launch/started' 'Native ConPTY child started with retained process handle.' $result.process

    $handler = [Net.Http.HttpClientHandler]::new(); $handler.UseProxy = $false; $handler.AllowAutoRedirect = $false
    $client = [Net.Http.HttpClient]::new($handler, $true); $client.Timeout = [TimeSpan]::FromSeconds(3); $client.MaxResponseContentBufferSize = 1048576
    $health = Wait-Health -BaseUri $baseUri
    $encodedDirectory = [Uri]::EscapeDataString($project)
    $pathResponse = Invoke-Http -Method ([Net.Http.HttpMethod]::Get) -Uri "$baseUri/path"
    $pathObject = $pathResponse.body | ConvertFrom-Json
    if ($pathResponse.status -ne 200 -or -not [string]::Equals([string]$pathObject.directory, $project, [StringComparison]::OrdinalIgnoreCase)) { throw 'GET /path.directory did not exactly match the sandbox project.' }
    $root = Invoke-Http -Method ([Net.Http.HttpMethod]::Get) -Uri "$baseUri/"
    if ($root.status -ne 200 -or $root.content_type -notlike 'text/html*' -or $root.body -notmatch '(?i)<html') { throw 'GET / did not return HTML HTTP 200.' }
    $sessionsResponse = Invoke-Http -Method ([Net.Http.HttpMethod]::Get) -Uri "$baseUri/session?directory=$encodedDirectory"
    $sessions = ConvertFrom-Json -InputObject $sessionsResponse.body -NoEnumerate
    if ($sessionsResponse.status -ne 200 -or $sessions.Count -ne 0) { throw 'Initial isolated GET /session was not an empty HTTP 200 list.' }
    $title = "OMW TUI spike $runId"
    $createdResponse = Invoke-Http -Method ([Net.Http.HttpMethod]::Post) -Uri "$baseUri/session?directory=$encodedDirectory" -Body (@{ title=$title } | ConvertTo-Json -Compress)
    $created = $createdResponse.body | ConvertFrom-Json
    if ($createdResponse.status -ne 200 -or [string]::IsNullOrWhiteSpace([string]$created.id)) { throw 'POST /session did not create an empty titled session.' }
    $sameResponse = Invoke-Http -Method ([Net.Http.HttpMethod]::Get) -Uri "$baseUri/session/$($created.id)?directory=$encodedDirectory"
    $same = $sameResponse.body | ConvertFrom-Json
    if ($sameResponse.status -ne 200 -or [string]$same.id -ne [string]$created.id) { throw 'GET of the created session did not return the same id.' }
    $result.probes = [ordered]@{ health=$health; path=[ordered]@{status_code=200; directory=[string]$pathObject.directory; exact_sandbox_match=$true}; root=[ordered]@{status_code=200; content_type=$root.content_type}; session=[ordered]@{initial_count=0; created_id=[string]$created.id; title=$title; same_session_read=$true; prompt_sent=$false}; tui_select_session=[ordered]@{status='skipped'; reason='Optional endpoint contract was not required or assumed.'} }
    $result.render_observation = Wait-ForOutputCandidate -Path $outputPath -Milliseconds 10000
    Write-Journal 'render-observation' 'Bounded PTY output candidate observation completed; this is not visual TUI QA.' $result.render_observation
    if ($result.render_observation.timeout) {
        $result.limitations += 'Bounded render observation timed out; recognizable TUI rendering was not verified.'
    } else {
        $result.limitations += 'Recognizable output text is only a candidate observation and does not verify TUI rendering.'
    }

    $owned.Resize(100, 30)
    Start-Sleep -Milliseconds 300
    $afterResize = Invoke-Http -Method ([Net.Http.HttpMethod]::Get) -Uri "$baseUri/global/health"
    $afterHealth = $afterResize.body | ConvertFrom-Json
    if ($afterResize.status -ne 200 -or $afterHealth.healthy -ne $true -or $owned.OutputBytes -le 0) { throw 'Resize follow-up did not retain HTTP health and non-empty PTY output.' }
    # Cumulative output may contain only terminal control bytes; it is not proof of rendering.
    $result.resize = [ordered]@{ from='120x35'; to='100x30'; api_success=$true; health_after_resize=$true; cumulative_pty_output_bytes_after_resize=$owned.OutputBytes; visual_redraw_tested=$false; recognizable_tui_render_verified=$false }

    $owned.SendCtrlC(); $naturalExit = $owned.WaitForExit(2500)
    if (-not $naturalExit) {
        try { $owned.SendCtrlC() } catch { if (-not $owned.HasExited) { throw } }
        $naturalExit = $owned.WaitForExit(2500)
    }
    $result.exit = [ordered]@{ strategy='Ctrl+C byte once, then once more after a 2500 ms wait'; natural=$naturalExit; forced=$false; classification=if($naturalExit){'natural-exit'}else{'natural-exit-timeout'}; wait_limit_milliseconds=5000; exit_code=if($naturalExit){$owned.ExitCode}else{$null} }
    if (-not $naturalExit) { throw 'OpenCode did not exit naturally within 5000 ms after the bounded Ctrl+C strategy.' }
    $result.status = 'passed'
} catch {
    $errors.Add($_.Exception.Message); $result.status = 'failed'
    try { if (Test-Path -LiteralPath $sandbox) { Write-Journal 'failed' $_.Exception.Message $null } } catch { }
} finally {
    if ($null -ne $client) { $client.Dispose() }
    $processExited = $null; $consoleClosed = $null; $outputDrained = $null; $exitCode = $null
    if ($null -ne $pty) {
        try {
            if (-not $pty.HasExited) { $forcedStop = $pty.Terminate(1); $processExited = $pty.WaitForExit(3000) } else { $processExited = $true }
            if (-not $processExited) { throw 'Retained process handle did not report exit during cleanup.' }
            $exitCode = $pty.ExitCode
            $pty.CloseInput()
            $consoleClosed = $pty.ClosePseudoConsoleBounded(2000)
            $outputDrained = $pty.WaitForOutputDrain(2000)
            if (-not $consoleClosed) { throw 'ClosePseudoConsole did not complete within its bounded background-thread join.' }
            if (-not $outputDrained) { throw 'PTY output did not drain through pseudo-console close within the bounded join.' }
            if ($null -ne $pty.OutputError) { throw "PTY output drain failed: $($pty.OutputError)" }
        } catch { $cleanupErrors.Add($_.Exception.Message) }
        finally { $pty.Dispose() }
    }
    $portReleased = $null
    if ($null -ne $port) {
        $releaseWatch = [Diagnostics.Stopwatch]::StartNew()
        do { if (-not (Test-Port $port)) { $portReleased = $true; break }; Start-Sleep -Milliseconds 100 } while ($releaseWatch.ElapsedMilliseconds -lt 5000)
        if ($null -eq $portReleased) { $portReleased = -not (Test-Port $port) }
        if (-not $portReleased) { $cleanupErrors.Add("Loopback port $port remained reachable after cleanup.") }
    }
    if ($forcedStop) { $result.exit['natural'] = $false; $result.exit['forced'] = $true; $result.exit['classification'] = 'forced-cleanup-not-pass' }
    elseif ($naturalExit) { $result.exit['classification'] = 'natural-exit' }
    $result.exit['exit_code'] = $exitCode
    $result.cleanup = [ordered]@{ process_exited=$processExited; forced_stop=$forcedStop; pseudo_console_close_completed=$consoleClosed; output_drained_through_close=$outputDrained; output_path=$outputPath; output_bytes=if($null -ne $pty){$pty.OutputBytes}else{0}; output_persisted_bytes=if($null -ne $pty){$pty.OutputPersistedBytes}else{0}; output_truncated=if($null -ne $pty){$pty.OutputTruncated}else{$false}; port=$port; port_released=$portReleased; errors=@($cleanupErrors) }
    if ($cleanupErrors.Count -gt 0) { foreach ($item in $cleanupErrors) { $errors.Add($item) }; $result.status = 'failed' }
    $result.errors = @($errors); $result['elapsed_milliseconds'] = $watch.ElapsedMilliseconds
    if (-not (Test-Path -LiteralPath $sandbox)) { [IO.Directory]::CreateDirectory($sandbox) | Out-Null }
    try { Write-Journal 'cleanup' 'Bounded retained-handle cleanup completed.' $result.cleanup } catch { }
    [IO.File]::WriteAllText($resultPath, ($result | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
}

$result | ConvertTo-Json -Depth 12
if ($result.status -ne 'passed') { exit 1 }
