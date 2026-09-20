[CmdletBinding()]
param(
    [ValidateSet('Harness', 'Launcher', 'Observer')]
    [string]$Role = 'Harness',
    [string]$InputPath,
    [string]$OpenCodeExecutable = $env:OPENCODE_SPIKE_EXECUTABLE,
    [ValidateRange(15, 60)]
    [int]$OverallDeadlineSeconds = 45,
    [ValidateRange(1, 3)]
    [int]$RequestTimeoutSeconds = 3
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-JournalEvent {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$RoleName,
        [Parameter(Mandatory)][string]$Stage,
        [Parameter(Mandatory)][string]$Message,
        [object]$Data
    )

    $event = [ordered]@{
        timestamp_utc = [DateTime]::UtcNow.ToString('O')
        role = $RoleName
        stage = $Stage
        message = $Message
        data = $Data
    }
    [IO.File]::AppendAllText(
        $Path,
        (($event | ConvertTo-Json -Compress -Depth 8) + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
    )
}

function Get-NormalizedPath {
    param([Parameter(Mandatory)][string]$Path)

    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Test-PathEqual {
    param(
        [Parameter(Mandatory)][string]$Left,
        [Parameter(Mandatory)][string]$Right
    )

    return [string]::Equals(
        (Get-NormalizedPath -Path $Left),
        (Get-NormalizedPath -Path $Right),
        [StringComparison]::OrdinalIgnoreCase
    )
}

function Get-ProcessParentId {
    param([Parameter(Mandatory)][int]$ProcessId)

    $cimProcess = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId"
    if ($null -eq $cimProcess) {
        throw "Win32_Process did not contain PID $ProcessId."
    }
    return [int]$cimProcess.ParentProcessId
}

function Get-ExactProcessIdentity {
    param([Parameter(Mandatory)][Diagnostics.Process]$Process)

    if ($Process.HasExited) {
        throw "PID $($Process.Id) exited before its identity could be captured."
    }
    $safeHandle = $Process.SafeHandle
    if ($safeHandle.IsInvalid -or $safeHandle.IsClosed) {
        throw "PID $($Process.Id) did not provide a usable process handle."
    }
    $startTime = $Process.StartTime.ToUniversalTime()
    $imagePath = [string]$Process.MainModule.FileName
    if ([string]::IsNullOrWhiteSpace($imagePath)) {
        throw "PID $($Process.Id) did not provide an executable image path."
    }
    return [pscustomobject]@{
        pid = [int]$Process.Id
        creation_time_utc = $startTime.ToString('O')
        creation_time_utc_ticks = $startTime.Ticks
        executable = Get-NormalizedPath -Path $imagePath
        parent_pid = Get-ProcessParentId -ProcessId $Process.Id
        handle_opened = $true
    }
}

function Test-TcpListener {
    param([Parameter(Mandatory)][int]$Port)

    $tcpClient = [Net.Sockets.TcpClient]::new()
    try {
        $connectTask = $tcpClient.ConnectAsync([Net.IPAddress]::Loopback, $Port)
        if (-not $connectTask.Wait(250)) { return $false }
        return $tcpClient.Connected
    }
    catch {
        return $false
    }
    finally {
        $tcpClient.Dispose()
    }
}

function Wait-PortReleased {
    param(
        [Parameter(Mandatory)][int]$Port,
        [Parameter(Mandatory)][int]$DeadlineMilliseconds
    )

    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        if (-not (Test-TcpListener -Port $Port)) { return $true }
        Start-Sleep -Milliseconds 100
    } while ($watch.ElapsedMilliseconds -lt $DeadlineMilliseconds)
    return -not (Test-TcpListener -Port $Port)
}

function ConvertTo-QuotedProcessArgument {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)

    if ($Value.Contains('"')) {
        throw 'Process arguments containing a double quote are not supported by this spike.'
    }
    return '"' + $Value + '"'
}

function Start-PowerShellRole {
    param(
        [Parameter(Mandatory)][string]$ScriptPath,
        [Parameter(Mandatory)][string]$RoleName,
        [Parameter(Mandatory)][string]$RoleInputPath,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [Parameter(Mandatory)][string]$StdoutPath,
        [Parameter(Mandatory)][string]$StderrPath
    )

    $pwshPath = [string][Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    $arguments = @(
        '-NoLogo', '-NoProfile', '-NonInteractive',
        '-File', (ConvertTo-QuotedProcessArgument -Value $ScriptPath),
        '-Role', $RoleName,
        '-InputPath', (ConvertTo-QuotedProcessArgument -Value $RoleInputPath)
    ) -join ' '
    return Start-Process -FilePath $pwshPath -ArgumentList $arguments -WorkingDirectory $WorkingDirectory `
        -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath -WindowStyle Hidden -PassThru
}

function Set-IsolatedChildEnvironment {
    param([Parameter(Mandatory)]$Config)

    $credentialNamePatterns = @(
        '*_API_KEY', '*_TOKEN', '*_SECRET', '*_PASSWORD', '*_CREDENTIAL*', '*AUTH*',
        'AWS_*', 'AZURE_*', 'GOOGLE_*', 'GITHUB_*', 'GITLAB_*', 'ANTHROPIC_*',
        'OPENAI_*', 'GEMINI_*', 'COHERE_*', 'MISTRAL_*', 'GROQ_*', 'CEREBRAS_*',
        'XAI_*', 'VERTEXAI_*', 'OCI_*'
    )
    $namesToRemove = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($name in [Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Process).Keys) {
        foreach ($pattern in $credentialNamePatterns) {
            if ([string]$name -like $pattern) {
                $namesToRemove.Add([string]$name) | Out-Null
                break
            }
        }
    }
    foreach ($name in @(
        'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION', 'OPENCODE_SERVER_PASSWORD',
        'OPENCODE_SERVER_USERNAME'
    )) {
        $namesToRemove.Add($name) | Out-Null
    }
    foreach ($name in $namesToRemove) {
        [Environment]::SetEnvironmentVariable($name, $null, [EnvironmentVariableTarget]::Process)
    }

    $environment = [ordered]@{
        HOME = $Config.home_directory
        USERPROFILE = $Config.home_directory
        OPENCODE_TEST_HOME = $Config.home_directory
        XDG_CONFIG_HOME = $Config.xdg_config_directory
        XDG_DATA_HOME = $Config.xdg_data_directory
        XDG_CACHE_HOME = $Config.xdg_cache_directory
        XDG_STATE_HOME = $Config.xdg_state_directory
        OPENCODE_DB = $Config.database_path
        OPENCODE_CONFIG = $Config.config_path
        OPENCODE_CONFIG_DIR = $Config.config_directory
        OPENCODE_DISABLE_PROJECT_CONFIG = '1'
        OPENCODE_PURE = '1'
        OPENCODE_DISABLE_DEFAULT_PLUGINS = '1'
        OPENCODE_DISABLE_EXTERNAL_SKILLS = '1'
        OPENCODE_DISABLE_CLAUDE_CODE = '1'
        OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = '1'
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = '1'
        OPENCODE_DISABLE_MODELS_FETCH = '1'
        OPENCODE_DISABLE_AUTOUPDATE = '1'
        OPENCODE_DISABLE_LSP_DOWNLOAD = '1'
        OPENCODE_DISABLE_PRUNE = '1'
        OPENCODE_AUTO_SHARE = 'false'
    }
    foreach ($entry in $environment.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, [EnvironmentVariableTarget]::Process)
    }
    return $namesToRemove.Count
}

function Invoke-LauncherRole {
    param([Parameter(Mandatory)][string]$ConfigurationPath)

    $config = Get-Content -LiteralPath $ConfigurationPath -Raw | ConvertFrom-Json
    $child = $null
    $pipe = $null
    $reader = $null
    $writer = $null
    $ownershipTransferred = $false
    $exitCode = 1
    try {
        Write-JournalEvent -Path $config.journal_path -RoleName 'launcher' -Stage 'start' `
            -Message 'Launcher started; no OpenCode child exists yet.' -Data @{ launcher_pid = $PID }
        $removedCredentialNameCount = Set-IsolatedChildEnvironment -Config $config

        $childRecord = [ordered]@{
            process = $null
            started = $false
            ownership = 'launcher'
        }
        Write-JournalEvent -Path $config.journal_path -RoleName 'launcher' -Stage 'child/registered' `
            -Message 'Cleanup record registered before Process.Start metadata access.' -Data $null
        $child = Start-Process -FilePath $config.open_code_executable `
            -ArgumentList @('serve', '--hostname', '127.0.0.1', '--port', [string]$config.port, '--pure', '--log-level', 'INFO') `
            -WorkingDirectory $config.project_directory -RedirectStandardOutput $config.child_stdout_path `
            -RedirectStandardError $config.child_stderr_path -WindowStyle Hidden -PassThru
        $childRecord.process = $child
        $childRecord.started = $true
        Write-JournalEvent -Path $config.journal_path -RoleName 'launcher' -Stage 'child/started' `
            -Message 'Process.Start succeeded; launcher retains the cleanup handle until handoff ACK.' `
            -Data @{ pid = [int]$child.Id }

        $identity = Get-ExactProcessIdentity -Process $child
        if ($identity.parent_pid -ne $PID) {
            throw "OpenCode parent PID $($identity.parent_pid) did not equal launcher PID $PID."
        }
        $handshake = [ordered]@{
            kind = 'opencode-parent-exit-child'
            token = $config.handoff_token
            launcher_pid = $PID
            child = $identity
            endpoint = $config.endpoint
            project_directory = Get-NormalizedPath -Path $config.project_directory
            removed_credential_variable_name_count = $removedCredentialNameCount
            standard_streams = [ordered]@{
                stdout = $config.child_stdout_path
                stderr = $config.child_stderr_path
                inherited_launcher_pipes = $false
            }
        }
        Write-JournalEvent -Path $config.journal_path -RoleName 'launcher' -Stage 'handoff/connect' `
            -Message 'Connecting to the external safety owner before launcher exit.' -Data @{ pid = $identity.pid }

        $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $config.pipe_name, [IO.Pipes.PipeDirection]::InOut)
        try {
            $pipe.Connect([int]$config.handshake_deadline_milliseconds)
            $writer = [IO.StreamWriter]::new($pipe, [Text.UTF8Encoding]::new($false), 1024, $true)
            $reader = [IO.StreamReader]::new($pipe, [Text.UTF8Encoding]::new($false), $false, 1024, $true)
            try {
                $writer.WriteLine(($handshake | ConvertTo-Json -Compress -Depth 8))
                $writer.Flush()
                $ackTask = $reader.ReadLineAsync()
                if (-not $ackTask.Wait([int]$config.handshake_deadline_milliseconds)) {
                    throw 'Safety-owner handoff ACK timed out.'
                }
                $ackLine = $ackTask.GetAwaiter().GetResult()
                if ([string]::IsNullOrWhiteSpace($ackLine)) {
                    throw 'Safety-owner handoff ACK was empty.'
                }
                $ack = $ackLine | ConvertFrom-Json
                if ($ack.accepted -ne $true -or $ack.token -ne $config.handoff_token) {
                    throw 'Safety-owner handoff ACK was invalid.'
                }
                $ownershipTransferred = $true
                $childRecord.ownership = 'safety-owner'
                Write-JournalEvent -Path $config.journal_path -RoleName 'launcher' -Stage 'handoff/accepted' `
                    -Message 'Safety owner confirmed a retained exact child handle; launcher may exit normally.' `
                    -Data @{ pid = $identity.pid }
                $exitCode = 0
            }
            finally {
                if ($null -ne $reader) { $reader.Dispose() }
                if ($null -ne $writer) { $writer.Dispose() }
            }
        }
        finally {
            if ($null -ne $pipe) { $pipe.Dispose() }
        }
    }
    catch {
        try {
            Write-JournalEvent -Path $config.journal_path -RoleName 'launcher' -Stage 'failed' `
                -Message $_.Exception.Message -Data @{ ownership_transferred = $ownershipTransferred }
        }
        catch { }
    }
    finally {
        if ($null -ne $child -and -not $ownershipTransferred) {
            try {
                if (-not $child.HasExited) {
                    $child.Kill($true)
                    if (-not $child.WaitForExit(5000)) {
                        throw 'Launcher-owned OpenCode child did not exit within 5000 ms.'
                    }
                }
                Write-JournalEvent -Path $config.journal_path -RoleName 'launcher' -Stage 'cleanup/complete' `
                    -Message 'Pre-handoff failure cleanup completed through the retained child handle.' `
                    -Data @{ pid = [int]$child.Id; exited = $child.HasExited; exit_code = $child.ExitCode }
            }
            catch {
                try {
                    Write-JournalEvent -Path $config.journal_path -RoleName 'launcher' -Stage 'cleanup/failed' `
                        -Message $_.Exception.Message -Data $null
                }
                catch { }
                $exitCode = 1
            }
        }
        if ($null -ne $child) { $child.Dispose() }
    }
    return $exitCode
}

function New-LoopbackHttpClient {
    param([Parameter(Mandatory)][int]$TimeoutSeconds)

    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseProxy = $false
    $client = [Net.Http.HttpClient]::new($handler, $true)
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
    return $client
}

function Invoke-ObserverGet {
    param(
        [Parameter(Mandatory)][Net.Http.HttpClient]$Client,
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][int]$TimeoutSeconds
    )

    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $Uri)
    $cts = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSeconds))
    try {
        $response = $Client.SendAsync($request, $cts.Token).GetAwaiter().GetResult()
        try {
            return [pscustomobject]@{
                status_code = [int]$response.StatusCode
                content_type = [string]$response.Content.Headers.ContentType
                body = $response.Content.ReadAsStringAsync($cts.Token).GetAwaiter().GetResult()
            }
        }
        finally {
            $response.Dispose()
        }
    }
    finally {
        $cts.Dispose()
        $request.Dispose()
    }
}

function Invoke-ObserverRole {
    param([Parameter(Mandatory)][string]$ConfigurationPath)

    $config = Get-Content -LiteralPath $ConfigurationPath -Raw | ConvertFrom-Json
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $observedProcess = $null
    $client = $null
    $result = [ordered]@{
        status = 'failed'
        observer_pid = $PID
        process_identity = $null
        probes = [ordered]@{}
        error = $null
    }
    try {
        Write-JournalEvent -Path $config.journal_path -RoleName 'observer' -Stage 'start' `
            -Message 'Fresh observer process started after launcher exit.' -Data @{ observer_pid = $PID }
        $observedProcess = [Diagnostics.Process]::GetProcessById([int]$config.expected_child.pid)
        $identity = Get-ExactProcessIdentity -Process $observedProcess
        if ($identity.pid -ne [int]$config.expected_child.pid) { throw 'Observed child PID did not match.' }
        if ($identity.creation_time_utc_ticks -ne [long]$config.expected_child.creation_time_utc_ticks) {
            throw 'Observed child creation time did not match exactly.'
        }
        if (-not (Test-PathEqual -Left $identity.executable -Right $config.expected_child.executable)) {
            throw 'Observed child executable image did not match.'
        }
        if ($identity.parent_pid -ne [int]$config.expected_child.parent_pid) {
            throw 'Observed child parent PID did not match the exited launcher PID.'
        }
        $result.process_identity = $identity
        Write-JournalEvent -Path $config.journal_path -RoleName 'observer' -Stage 'identity/matched' `
            -Message 'PID, creation time, executable image, and recorded parent PID matched.' -Data $identity

        $client = New-LoopbackHttpClient -TimeoutSeconds ([int]$config.request_timeout_seconds)
        $health = $null
        $lastHealthError = $null
        do {
            try {
                $response = Invoke-ObserverGet -Client $client -Uri "$($config.endpoint)/global/health" `
                    -TimeoutSeconds ([int]$config.request_timeout_seconds)
                if ($response.status_code -eq 200 -and $response.content_type -like 'application/json*') {
                    $healthObject = $response.body | ConvertFrom-Json
                    if ($healthObject.healthy -eq $true -and -not [string]::IsNullOrWhiteSpace([string]$healthObject.version)) {
                        $health = [ordered]@{
                            status_code = $response.status_code
                            content_type = $response.content_type
                            healthy = $true
                            version = [string]$healthObject.version
                            elapsed_milliseconds = $watch.ElapsedMilliseconds
                        }
                    }
                }
            }
            catch {
                $lastHealthError = $_.Exception.Message
            }
            if ($null -eq $health) { Start-Sleep -Milliseconds 200 }
        } while ($null -eq $health -and $watch.Elapsed.TotalSeconds -lt [int]$config.observer_deadline_seconds)
        if ($null -eq $health) {
            throw "OpenCode health was not ready before the observer deadline. Last error: $lastHealthError"
        }

        $pathResponse = Invoke-ObserverGet -Client $client -Uri "$($config.endpoint)/path" `
            -TimeoutSeconds ([int]$config.request_timeout_seconds)
        if ($pathResponse.status_code -ne 200 -or $pathResponse.content_type -notlike 'application/json*') {
            throw 'GET /path did not return JSON HTTP 200.'
        }
        $pathObject = $pathResponse.body | ConvertFrom-Json
        $directoryProperty = $pathObject.PSObject.Properties['directory']
        if ($null -eq $directoryProperty -or [string]::IsNullOrWhiteSpace([string]$directoryProperty.Value)) {
            throw 'GET /path did not return path.directory.'
        }
        $pathDirectory = [string]$directoryProperty.Value
        if (-not (Test-PathEqual -Left $pathDirectory -Right $config.project_directory)) {
            throw 'GET /path.directory did not exactly identify the isolated project directory.'
        }
        $result.probes = [ordered]@{
            health = $health
            path = [ordered]@{
                status_code = $pathResponse.status_code
                content_type = $pathResponse.content_type
                directory = $pathDirectory
                exact_project_match = $true
            }
        }
        $result.status = 'passed'
        Write-JournalEvent -Path $config.journal_path -RoleName 'observer' -Stage 'complete' `
            -Message 'Identity, endpoint health, and exact project-directory probes passed.' -Data $result.probes
    }
    catch {
        $result.error = $_.Exception.Message
        try {
            Write-JournalEvent -Path $config.journal_path -RoleName 'observer' -Stage 'failed' `
                -Message $_.Exception.Message -Data $null
        }
        catch { }
    }
    finally {
        $result['elapsed_milliseconds'] = $watch.ElapsedMilliseconds
        [IO.File]::WriteAllText(
            $config.result_path,
            ($result | ConvertTo-Json -Depth 10),
            [Text.UTF8Encoding]::new($false)
        )
        if ($null -ne $client) { $client.Dispose() }
        if ($null -ne $observedProcess) { $observedProcess.Dispose() }
    }
    if ($result.status -eq 'passed') { return 0 }
    return 1
}

function New-FreeLoopbackPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { return [int]$listener.LocalEndpoint.Port }
    finally { $listener.Stop() }
}

function Get-RemainingMilliseconds {
    param(
        [Parameter(Mandatory)][Diagnostics.Stopwatch]$Stopwatch,
        [Parameter(Mandatory)][int]$DeadlineSeconds,
        [int]$ReserveMilliseconds = 0
    )

    return [Math]::Max(0, ($DeadlineSeconds * 1000) - [int]$Stopwatch.ElapsedMilliseconds - $ReserveMilliseconds)
}

function Wait-TaskBounded {
    param(
        [Parameter(Mandatory)][Threading.Tasks.Task]$Task,
        [Parameter(Mandatory)][int]$TimeoutMilliseconds,
        [Parameter(Mandatory)][string]$Description
    )

    if ($TimeoutMilliseconds -le 0 -or -not $Task.Wait($TimeoutMilliseconds)) {
        throw "$Description timed out after $TimeoutMilliseconds ms."
    }
    return $Task.GetAwaiter().GetResult()
}

function Wait-ProcessBounded {
    param(
        [Parameter(Mandatory)][Diagnostics.Process]$Process,
        [Parameter(Mandatory)][int]$TimeoutMilliseconds,
        [Parameter(Mandatory)][string]$Description
    )

    if ($TimeoutMilliseconds -le 0 -or -not $Process.WaitForExit($TimeoutMilliseconds)) {
        throw "$Description timed out after $TimeoutMilliseconds ms."
    }
}

function Stop-RetainedProcess {
    param(
        [Diagnostics.Process]$Process,
        [Parameter(Mandatory)][int]$TimeoutMilliseconds,
        [switch]$IncludeDescendants
    )

    if ($null -eq $Process) {
        return [pscustomobject]@{ attempted = $false; exited = $null; exit_code = $null; error = $null }
    }
    $stop = [ordered]@{ attempted = $false; exited = $false; exit_code = $null; error = $null }
    try {
        if (-not $Process.HasExited) {
            $stop.attempted = $true
            if ($IncludeDescendants) { $Process.Kill($true) } else { $Process.Kill() }
            if ($TimeoutMilliseconds -le 0 -or -not $Process.WaitForExit($TimeoutMilliseconds)) {
                throw "PID $($Process.Id) did not exit within the cleanup deadline."
            }
        }
        $stop.exited = $Process.HasExited
        if ($Process.HasExited) { $stop.exit_code = $Process.ExitCode }
    }
    catch {
        $stop.error = $_.Exception.Message
        try { $stop.exited = $Process.HasExited } catch { }
    }
    return [pscustomobject]$stop
}

function Invoke-HarnessRole {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $runId = [Guid]::NewGuid().ToString('N')
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $scratchParent = Join-Path $repoRoot '.scratch'
    $sandbox = Join-Path $scratchParent "opencode-parent-exit-$runId"
    $projectDirectory = Join-Path $sandbox 'project'
    $configDirectory = Join-Path $sandbox 'config'
    $logDirectory = Join-Path $sandbox 'logs'
    $dataDirectory = Join-Path $sandbox 'data'
    $journalDirectory = Join-Path $sandbox 'journal'
    $harnessJournal = Join-Path $journalDirectory 'harness.jsonl'
    $launcherJournal = Join-Path $journalDirectory 'launcher.jsonl'
    $observerJournal = Join-Path $journalDirectory 'observer.jsonl'
    $resultPath = Join-Path $sandbox 'result.json'
    $launcherInputPath = Join-Path $sandbox 'launcher-input.json'
    $observerInputPath = Join-Path $sandbox 'observer-input.json'
    $observerResultPath = Join-Path $sandbox 'observer-result.json'
    $launcher = $null
    $observer = $null
    $ownedChild = $null
    $ownedChildHandle = $null
    $handoffAccepted = $false
    $port = $null
    $pipe = $null
    $reader = $null
    $writer = $null
    $handshake = $null
    $cleanupErrors = [Collections.Generic.List[string]]::new()
    $result = [ordered]@{
        status = 'running'
        run_id = $runId
        sandbox = $sandbox
        expectation = [ordered]@{
            scenario = 'normal-launcher-exit'
            expected_outcome = 'success'
            expected_failure = $false
        }
        outcome = [ordered]@{ classification = 'running'; error = $null }
        launcher = [ordered]@{}
        child = $null
        observer = [ordered]@{}
        probes = [ordered]@{}
        limits = [ordered]@{
            overall_deadline_seconds = $OverallDeadlineSeconds
            operation_cleanup_reserve_seconds = 10
            request_timeout_seconds = $RequestTimeoutSeconds
            request_timeout_at_most_three_seconds = $RequestTimeoutSeconds -le 3
            launcher_handoff_deadline_milliseconds = 10000
            process_exit_wait_milliseconds = 5000
            log_transport = 'direct sandbox files; no OpenCode stdout/stderr pipe owned by launcher'
        }
        isolation = [ordered]@{}
        cleanup = [ordered]@{}
        journal = [ordered]@{
            harness = $harnessJournal
            launcher = $launcherJournal
            observer = $observerJournal
        }
        limitations = @(
            'This proves only a native headless process survived one normal short-lived launcher exit.',
            'The observer is a fresh process, but this is not OMW restart or production recovery.',
            'Launcher crash, service hosting, auth, LLM, TUI, mobile, Tailnet, proxy, SSE, and WebSocket behavior were not tested.'
        )
    }

    try {
        if (-not (Test-Path -LiteralPath $repoRoot -PathType Container)) {
            throw "Repository root is unavailable: $repoRoot"
        }
        if (-not (Test-Path -LiteralPath $OpenCodeExecutable -PathType Leaf)) {
            throw 'Pass -OpenCodeExecutable or set OPENCODE_SPIKE_EXECUTABLE to an existing opencode.exe.'
        }
        if (Test-Path -LiteralPath (Join-Path $env:ProgramData 'opencode') -PathType Container) {
            throw 'Isolation cannot be guaranteed because the Windows managed OpenCode config directory exists.'
        }
        foreach ($directory in @(
            $scratchParent, $sandbox, $projectDirectory, $configDirectory, $logDirectory,
            $dataDirectory, $journalDirectory, (Join-Path $sandbox 'home'),
            (Join-Path $sandbox 'xdg-config'), (Join-Path $sandbox 'xdg-data'),
            (Join-Path $sandbox 'xdg-cache'), (Join-Path $sandbox 'xdg-state')
        )) {
            if (-not (Test-Path -LiteralPath $directory)) {
                [IO.Directory]::CreateDirectory($directory) | Out-Null
            }
        }
        Write-JournalEvent -Path $harnessJournal -RoleName 'harness' -Stage 'setup/start' `
            -Message 'Sandbox and journal exist before any child process launch.' -Data @{ run_id = $runId }
        [IO.File]::WriteAllText(
            (Join-Path $configDirectory 'opencode.json'),
            "{`n  `"plugin`": []`n}`n",
            [Text.UTF8Encoding]::new($false)
        )

        $port = New-FreeLoopbackPort
        $endpoint = "http://127.0.0.1:$port"
        $pipeName = "omw-parent-exit-$runId"
        $handoffToken = [Guid]::NewGuid().ToString('N')
        $launcherConfig = [ordered]@{
            open_code_executable = Get-NormalizedPath -Path $OpenCodeExecutable
            port = $port
            endpoint = $endpoint
            project_directory = $projectDirectory
            config_directory = $configDirectory
            config_path = Join-Path $configDirectory 'opencode.json'
            database_path = Join-Path $dataDirectory 'opencode.db'
            home_directory = Join-Path $sandbox 'home'
            xdg_config_directory = Join-Path $sandbox 'xdg-config'
            xdg_data_directory = Join-Path $sandbox 'xdg-data'
            xdg_cache_directory = Join-Path $sandbox 'xdg-cache'
            xdg_state_directory = Join-Path $sandbox 'xdg-state'
            child_stdout_path = Join-Path $logDirectory 'opencode.stdout.log'
            child_stderr_path = Join-Path $logDirectory 'opencode.stderr.log'
            journal_path = $launcherJournal
            pipe_name = $pipeName
            handoff_token = $handoffToken
            handshake_deadline_milliseconds = 10000
        }
        [IO.File]::WriteAllText(
            $launcherInputPath,
            ($launcherConfig | ConvertTo-Json -Depth 8),
            [Text.UTF8Encoding]::new($false)
        )
        $result.isolation = [ordered]@{
            sandbox_project = $projectDirectory
            isolated_database = $launcherConfig.database_path
            isolated_home = $launcherConfig.home_directory
            isolated_xdg_roots = $true
            pure_mode = $true
            project_config_disabled = $true
            default_plugins_disabled = $true
            external_skills_disabled = $true
            model_fetch_disabled = $true
            autoupdate_disabled = $true
            parent_environment_modified = $false
            path_modified = $false
            credential_variable_values_read_or_printed = $false
        }

        $pipe = [IO.Pipes.NamedPipeServerStream]::new(
            $pipeName,
            [IO.Pipes.PipeDirection]::InOut,
            1,
            [IO.Pipes.PipeTransmissionMode]::Byte,
            [IO.Pipes.PipeOptions]::Asynchronous
        )
        Write-JournalEvent -Path $harnessJournal -RoleName 'harness' -Stage 'launcher/start' `
            -Message 'Starting short-lived launcher with a pre-created handoff pipe.' -Data @{ port = $port }
        $launcher = Start-PowerShellRole -ScriptPath $PSCommandPath -RoleName 'Launcher' `
            -RoleInputPath $launcherInputPath -WorkingDirectory $sandbox `
            -StdoutPath (Join-Path $logDirectory 'launcher.stdout.log') `
            -StderrPath (Join-Path $logDirectory 'launcher.stderr.log')
        $result.launcher.pid = [int]$launcher.Id

        $connectTask = $pipe.WaitForConnectionAsync()
        $remaining = Get-RemainingMilliseconds -Stopwatch $watch -DeadlineSeconds $OverallDeadlineSeconds -ReserveMilliseconds 10000
        Wait-TaskBounded -Task $connectTask -TimeoutMilliseconds ([Math]::Min(10000, $remaining)) `
            -Description 'Launcher handoff connection' | Out-Null
        $reader = [IO.StreamReader]::new($pipe, [Text.UTF8Encoding]::new($false), $false, 1024, $true)
        $writer = [IO.StreamWriter]::new($pipe, [Text.UTF8Encoding]::new($false), 1024, $true)
        try {
            $readTask = $reader.ReadLineAsync()
            $remaining = Get-RemainingMilliseconds -Stopwatch $watch -DeadlineSeconds $OverallDeadlineSeconds -ReserveMilliseconds 10000
            $handshakeLine = Wait-TaskBounded -Task $readTask -TimeoutMilliseconds ([Math]::Min(10000, $remaining)) `
                -Description 'Launcher handoff record'
            if ([string]::IsNullOrWhiteSpace($handshakeLine)) { throw 'Launcher handoff record was empty.' }
            $handshake = $handshakeLine | ConvertFrom-Json
            if ($handshake.kind -ne 'opencode-parent-exit-child' -or $handshake.token -ne $handoffToken) {
                throw 'Launcher handoff record type or token did not match.'
            }
            if ([int]$handshake.launcher_pid -ne [int]$launcher.Id) {
                throw 'Launcher handoff PID did not match the retained launcher process.'
            }
            if ([int]$handshake.child.parent_pid -ne [int]$launcher.Id) {
                throw 'Child parent PID did not match the retained launcher process.'
            }
            if ($handshake.endpoint -ne $endpoint) { throw 'Child endpoint did not match the fixed loopback endpoint.' }
            if (-not (Test-PathEqual -Left $handshake.project_directory -Right $projectDirectory)) {
                throw 'Child project directory did not match the isolated project.'
            }

            $candidate = [Diagnostics.Process]::GetProcessById([int]$handshake.child.pid)
            try {
                $candidateIdentity = Get-ExactProcessIdentity -Process $candidate
                if ($candidateIdentity.creation_time_utc_ticks -ne [long]$handshake.child.creation_time_utc_ticks) {
                    throw 'Safety owner observed a different child creation time.'
                }
                if (-not (Test-PathEqual -Left $candidateIdentity.executable -Right $handshake.child.executable)) {
                    throw 'Safety owner observed a different child executable image.'
                }
                if ($candidateIdentity.parent_pid -ne [int]$launcher.Id) {
                    throw 'Safety owner observed a different child parent PID.'
                }
                $ownedChild = $candidate
                $candidate = $null
                $ownedChildHandle = $ownedChild.SafeHandle
                if ($ownedChildHandle.IsInvalid -or $ownedChildHandle.IsClosed) {
                    throw 'Safety owner could not retain a usable child process handle.'
                }
            }
            finally {
                if ($null -ne $candidate) { $candidate.Dispose() }
            }

            $writer.WriteLine(([ordered]@{ accepted = $true; token = $handoffToken } | ConvertTo-Json -Compress))
            $writer.Flush()
            $handoffAccepted = $true
            $result.child = [ordered]@{
                pid = $candidateIdentity.pid
                creation_time_utc = $candidateIdentity.creation_time_utc
                creation_time_utc_ticks = $candidateIdentity.creation_time_utc_ticks
                executable = $candidateIdentity.executable
                parent_pid = $candidateIdentity.parent_pid
                handle_opened = $candidateIdentity.handle_opened
                endpoint = $endpoint
                project_directory = $projectDirectory
                removed_credential_variable_name_count = [int]$handshake.removed_credential_variable_name_count
                standard_streams = $handshake.standard_streams
            }
            Write-JournalEvent -Path $harnessJournal -RoleName 'harness' -Stage 'handoff/accepted' `
                -Message 'Exact child identity and retained handle were secured before ACK.' -Data $result.child
        }
        finally {
            if ($null -ne $reader) { $reader.Dispose() }
            if ($null -ne $writer) { $writer.Dispose() }
        }

        $remaining = Get-RemainingMilliseconds -Stopwatch $watch -DeadlineSeconds $OverallDeadlineSeconds -ReserveMilliseconds 10000
        Wait-ProcessBounded -Process $launcher -TimeoutMilliseconds ([Math]::Min(5000, $remaining)) `
            -Description 'Normal launcher exit'
        $result.launcher.exit_code = $launcher.ExitCode
        $result.launcher.normal_exit = $launcher.ExitCode -eq 0
        if ($launcher.ExitCode -ne 0) { throw "Launcher exited with code $($launcher.ExitCode)." }
        Write-JournalEvent -Path $harnessJournal -RoleName 'harness' -Stage 'launcher/exited' `
            -Message 'Launcher exited normally after transferring cleanup ownership.' `
            -Data @{ pid = [int]$launcher.Id; exit_code = $launcher.ExitCode }

        $remainingSeconds = [Math]::Floor((Get-RemainingMilliseconds -Stopwatch $watch `
            -DeadlineSeconds $OverallDeadlineSeconds -ReserveMilliseconds 10000) / 1000)
        if ($remainingSeconds -lt 1) { throw 'No operation budget remained for the fresh observer.' }
        $observerConfig = [ordered]@{
            expected_child = $result.child
            endpoint = $endpoint
            project_directory = $projectDirectory
            request_timeout_seconds = $RequestTimeoutSeconds
            observer_deadline_seconds = [Math]::Min(15, [int]$remainingSeconds)
            journal_path = $observerJournal
            result_path = $observerResultPath
        }
        [IO.File]::WriteAllText(
            $observerInputPath,
            ($observerConfig | ConvertTo-Json -Depth 8),
            [Text.UTF8Encoding]::new($false)
        )
        Write-JournalEvent -Path $harnessJournal -RoleName 'harness' -Stage 'observer/start' `
            -Message 'Starting a fresh .NET observer only after the launcher has exited.' -Data $null
        $observer = Start-PowerShellRole -ScriptPath $PSCommandPath -RoleName 'Observer' `
            -RoleInputPath $observerInputPath -WorkingDirectory $sandbox `
            -StdoutPath (Join-Path $logDirectory 'observer.stdout.log') `
            -StderrPath (Join-Path $logDirectory 'observer.stderr.log')
        $result.observer.pid = [int]$observer.Id
        $remaining = Get-RemainingMilliseconds -Stopwatch $watch -DeadlineSeconds $OverallDeadlineSeconds -ReserveMilliseconds 10000
        Wait-ProcessBounded -Process $observer -TimeoutMilliseconds $remaining -Description 'Fresh observer exit'
        $result.observer.exit_code = $observer.ExitCode
        if (-not (Test-Path -LiteralPath $observerResultPath -PathType Leaf)) {
            throw 'Fresh observer did not write its bounded result file.'
        }
        $observerResult = Get-Content -LiteralPath $observerResultPath -Raw | ConvertFrom-Json
        $result.observer.status = $observerResult.status
        $result.observer.elapsed_milliseconds = $observerResult.elapsed_milliseconds
        $result.observer.process_identity = $observerResult.process_identity
        $result.probes = $observerResult.probes
        if ($observer.ExitCode -ne 0 -or $observerResult.status -ne 'passed') {
            throw "Fresh observer failed: $($observerResult.error)"
        }

        $result.status = 'passed'
        $result.outcome.classification = 'observed_success'
    }
    catch {
        $result.status = 'failed'
        $result.outcome.classification = 'unexpected_failure'
        $result.outcome.error = $_.Exception.Message
        try {
            if (Test-Path -LiteralPath $journalDirectory -PathType Container) {
                Write-JournalEvent -Path $harnessJournal -RoleName 'harness' -Stage 'failed' `
                    -Message $_.Exception.Message -Data @{ handoff_accepted = $handoffAccepted }
            }
        }
        catch { }
    }
    finally {
        if ($null -ne $pipe) { $pipe.Dispose() }

        $cleanupRemaining = Get-RemainingMilliseconds -Stopwatch $watch -DeadlineSeconds $OverallDeadlineSeconds
        $observerStop = Stop-RetainedProcess -Process $observer `
            -TimeoutMilliseconds ([Math]::Min(3000, $cleanupRemaining)) -IncludeDescendants

        if ($null -ne $launcher -and -not $launcher.HasExited) {
            if (-not $handoffAccepted) {
                try {
                    $briefWait = [Math]::Min(2000, (Get-RemainingMilliseconds -Stopwatch $watch -DeadlineSeconds $OverallDeadlineSeconds))
                    if ($briefWait -gt 0) { $launcher.WaitForExit($briefWait) | Out-Null }
                }
                catch { }
            }
        }
        $cleanupRemaining = Get-RemainingMilliseconds -Stopwatch $watch -DeadlineSeconds $OverallDeadlineSeconds
        $launcherStop = Stop-RetainedProcess -Process $launcher `
            -TimeoutMilliseconds ([Math]::Min(3000, $cleanupRemaining)) `
            -IncludeDescendants:(-not $handoffAccepted)

        $cleanupRemaining = Get-RemainingMilliseconds -Stopwatch $watch -DeadlineSeconds $OverallDeadlineSeconds
        $childStop = Stop-RetainedProcess -Process $(if ($handoffAccepted) { $ownedChild } else { $null }) `
            -TimeoutMilliseconds ([Math]::Min(5000, $cleanupRemaining)) -IncludeDescendants
        if ($null -ne $childStop.error) { $cleanupErrors.Add([string]$childStop.error) }
        if ($null -ne $launcherStop.error) { $cleanupErrors.Add([string]$launcherStop.error) }
        if ($null -ne $observerStop.error) { $cleanupErrors.Add([string]$observerStop.error) }

        $portReleased = $null
        if ($null -ne $port) {
            $cleanupRemaining = Get-RemainingMilliseconds -Stopwatch $watch -DeadlineSeconds $OverallDeadlineSeconds
            $portReleased = Wait-PortReleased -Port $port -DeadlineMilliseconds ([Math]::Min(5000, $cleanupRemaining))
            if (-not $portReleased) { $cleanupErrors.Add("Loopback port $port remained reachable after cleanup.") }
        }
        $result.cleanup = [ordered]@{
            ownership_handoff_accepted = $handoffAccepted
            child_cleanup_authority = if ($handoffAccepted) { 'retained exact Process object and SafeHandle' } else { 'launcher retained handle before handoff' }
            metadata_lookup_used_as_cleanup_authority = $false
            observer = $observerStop
            launcher = $launcherStop
            child = $childStop
            port = $port
            port_released = $portReleased
            errors = @($cleanupErrors)
            sandbox_retained_for_evidence = $true
        }
        if ($cleanupErrors.Count -gt 0 -and $result.status -eq 'passed') {
            $result.status = 'failed'
            $result.outcome.classification = 'unexpected_cleanup_failure'
            $result.outcome.error = $cleanupErrors -join '; '
        }
        $result['elapsed_milliseconds'] = $watch.ElapsedMilliseconds

        if (Test-Path -LiteralPath $sandbox -PathType Container) {
            try {
                Write-JournalEvent -Path $harnessJournal -RoleName 'harness' -Stage 'cleanup/complete' `
                    -Message 'Finite retained-handle cleanup and external port check completed.' -Data $result.cleanup
            }
            catch { }
            [IO.File]::WriteAllText(
                $resultPath,
                ($result | ConvertTo-Json -Depth 14),
                [Text.UTF8Encoding]::new($false)
            )
        }
        if ($null -ne $observer) { $observer.Dispose() }
        if ($null -ne $launcher) { $launcher.Dispose() }
        if ($null -ne $ownedChild) { $ownedChild.Dispose() }
    }

    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 14))
    if ($result.status -eq 'passed') { return 0 }
    return 1
}

if ($Role -ne 'Harness' -and [string]::IsNullOrWhiteSpace($InputPath)) {
    throw "Role $Role requires -InputPath."
}

switch ($Role) {
    'Launcher' { exit (Invoke-LauncherRole -ConfigurationPath $InputPath) }
    'Observer' { exit (Invoke-ObserverRole -ConfigurationPath $InputPath) }
    default { exit (Invoke-HarnessRole) }
}
