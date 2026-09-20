[CmdletBinding()]
param(
    [string]$OpenCodeExecutable = $env:OPENCODE_SPIKE_EXECUTABLE,
    [ValidateRange(30, 180)]
    [int]$OverallDeadlineSeconds = 75,
    [switch]$InjectFailureAfterSecondStart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$runWatch = [Diagnostics.Stopwatch]::StartNew()
$runId = [Guid]::NewGuid().ToString('N')
$repoRoot = Split-Path -Parent $PSScriptRoot
$scratchParent = Join-Path $repoRoot '.scratch'
$sandbox = Join-Path $scratchParent "opencode-runtime-spike-$runId"
$projectDirectory = Join-Path $sandbox 'project'
$configDirectory = Join-Path $sandbox 'config'
$logDirectory = Join-Path $sandbox 'logs'
$progressPath = Join-Path $sandbox 'progress.jsonl'
$processes = [Collections.Generic.List[object]]::new()
$cleanupErrors = [Collections.Generic.List[string]]::new()
$progressErrors = [Collections.Generic.List[string]]::new()
$progressEvents = [Collections.Generic.List[object]]::new()
$currentStage = 'preflight'
$earliestChildIdentity = $null
$createdSessionId = $null
$sessionDeleted = $false
$testError = $null
$client = $null

$result = [ordered]@{
    status = 'running'
    run_id = $runId
    sandbox = $sandbox
    executable = $OpenCodeExecutable
    overall_deadline_seconds = $OverallDeadlineSeconds
    failure_injection = if ($InjectFailureAfterSecondStart) { 'after-second-start' } else { $null }
    isolation = [ordered]@{}
    instances = @()
    probes = [ordered]@{}
    session_visibility = [ordered]@{}
    cleanup = [ordered]@{}
    limitations = @(
        'No TTY or ConPTY test was performed.'
    )
}

function Write-ProgressEvent {
    param(
        [Parameter(Mandatory)][string]$Stage,
        [Parameter(Mandatory)][string]$Message,
        [object]$ChildIdentity
    )

    $script:currentStage = $Stage
    if ($null -eq $script:earliestChildIdentity -and $null -ne $ChildIdentity) {
        $script:earliestChildIdentity = $ChildIdentity
    }
    $event = [ordered]@{
        timestamp_utc = [DateTime]::UtcNow.ToString('O')
        stage = $Stage
        message = $Message
        child_identity = $ChildIdentity
    }
    $progressEvents.Add([pscustomobject]$event)
    try {
        if (Test-Path -LiteralPath $sandbox -PathType Container) {
            [IO.File]::AppendAllText(
                $progressPath,
                (($event | ConvertTo-Json -Compress -Depth 8) + [Environment]::NewLine)
            )
        }
    }
    catch {
        $progressErrors.Add($_.Exception.Message)
    }
}

function Assert-RunBudget {
    if ($runWatch.Elapsed.TotalSeconds -ge $OverallDeadlineSeconds) {
        throw "Overall harness deadline of $OverallDeadlineSeconds seconds was exceeded."
    }
}

function New-FreeLoopbackPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try {
        return [int]$listener.LocalEndpoint.Port
    }
    finally {
        $listener.Stop()
    }
}

function New-LoopbackHttpClient {
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseProxy = $false
    $client = [Net.Http.HttpClient]::new($handler, $true)
    $client.Timeout = [TimeSpan]::FromSeconds(4)
    return $client
}

function Invoke-BoundedHttp {
    param(
        [Parameter(Mandatory)]
        [Net.Http.HttpClient]$Client,
        [Parameter(Mandatory)]
        [Net.Http.HttpMethod]$Method,
        [Parameter(Mandatory)]
        [string]$Uri,
        [string]$JsonBody
    )

    Assert-RunBudget
    $request = [Net.Http.HttpRequestMessage]::new($Method, $Uri)
    $cts = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(4))
    try {
        if ($PSBoundParameters.ContainsKey('JsonBody')) {
            $request.Content = [Net.Http.StringContent]::new($JsonBody, [Text.Encoding]::UTF8, 'application/json')
        }
        $response = $Client.SendAsync($request, $cts.Token).GetAwaiter().GetResult()
        try {
            $body = $response.Content.ReadAsStringAsync($cts.Token).GetAwaiter().GetResult()
            return [pscustomobject]@{
                StatusCode = [int]$response.StatusCode
                ContentType = [string]$response.Content.Headers.ContentType
                Body = $body
                Location = if ($response.Headers.Location) { [string]$response.Headers.Location } else { $null }
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

function Test-TcpListener {
    param([Parameter(Mandatory)][int]$Port)

    $client = [Net.Sockets.TcpClient]::new()
    try {
        $task = $client.ConnectAsync([Net.IPAddress]::Loopback, $Port)
        if (-not $task.Wait(250)) {
            return $false
        }
        return $client.Connected
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

function Wait-PortReleased {
    param(
        [Parameter(Mandatory)][int]$Port,
        [int]$DeadlineMilliseconds = 5000
    )

    $watch = [Diagnostics.Stopwatch]::StartNew()
    do {
        if (-not (Test-TcpListener -Port $Port)) {
            return $true
        }
        Start-Sleep -Milliseconds 100
    } while ($watch.ElapsedMilliseconds -lt $DeadlineMilliseconds)
    return $false
}

function Set-IsolatedEnvironment {
    param([Parameter(Mandatory)][Diagnostics.ProcessStartInfo]$StartInfo)

    $credentialNamePatterns = @(
        '*_API_KEY', '*_TOKEN', '*_SECRET', '*_PASSWORD', '*_CREDENTIAL*', '*AUTH*',
        'AWS_*', 'AZURE_*', 'GOOGLE_*', 'GITHUB_*', 'GITLAB_*', 'ANTHROPIC_*',
        'OPENAI_*', 'GEMINI_*', 'COHERE_*', 'MISTRAL_*', 'GROQ_*', 'CEREBRAS_*',
        'XAI_*', 'VERTEXAI_*', 'OCI_*'
    )

    $removedCount = 0
    foreach ($name in @($StartInfo.Environment.Keys)) {
        if ($credentialNamePatterns | Where-Object { $name -like $_ }) {
            if ($StartInfo.Environment.Remove([string]$name)) {
                $removedCount++
            }
        }
    }

    foreach ($name in @(
        'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION', 'OPENCODE_SERVER_PASSWORD',
        'OPENCODE_SERVER_USERNAME'
    )) {
        if ($StartInfo.Environment.Remove($name)) {
            $removedCount++
        }
    }

    $homeDirectory = Join-Path $sandbox 'home'
    $StartInfo.Environment['HOME'] = $homeDirectory
    $StartInfo.Environment['USERPROFILE'] = $homeDirectory
    $StartInfo.Environment['OPENCODE_TEST_HOME'] = $homeDirectory
    $StartInfo.Environment['XDG_CONFIG_HOME'] = Join-Path $sandbox 'xdg-config'
    $StartInfo.Environment['XDG_DATA_HOME'] = Join-Path $sandbox 'xdg-data'
    $StartInfo.Environment['XDG_CACHE_HOME'] = Join-Path $sandbox 'xdg-cache'
    $StartInfo.Environment['XDG_STATE_HOME'] = Join-Path $sandbox 'xdg-state'
    $StartInfo.Environment['OPENCODE_DB'] = Join-Path $sandbox 'data\opencode.db'
    $StartInfo.Environment['OPENCODE_CONFIG'] = Join-Path $configDirectory 'opencode.json'
    $StartInfo.Environment['OPENCODE_CONFIG_DIR'] = $configDirectory
    $StartInfo.Environment['OPENCODE_DISABLE_PROJECT_CONFIG'] = '1'
    $StartInfo.Environment['OPENCODE_PURE'] = '1'
    $StartInfo.Environment['OPENCODE_DISABLE_DEFAULT_PLUGINS'] = '1'
    $StartInfo.Environment['OPENCODE_DISABLE_EXTERNAL_SKILLS'] = '1'
    $StartInfo.Environment['OPENCODE_DISABLE_CLAUDE_CODE'] = '1'
    $StartInfo.Environment['OPENCODE_DISABLE_CLAUDE_CODE_PROMPT'] = '1'
    $StartInfo.Environment['OPENCODE_DISABLE_CLAUDE_CODE_SKILLS'] = '1'
    $StartInfo.Environment['OPENCODE_DISABLE_MODELS_FETCH'] = '1'
    $StartInfo.Environment['OPENCODE_DISABLE_AUTOUPDATE'] = '1'
    $StartInfo.Environment['OPENCODE_DISABLE_LSP_DOWNLOAD'] = '1'
    $StartInfo.Environment['OPENCODE_DISABLE_PRUNE'] = '1'
    $StartInfo.Environment['OPENCODE_AUTO_SHARE'] = 'false'
    return $removedCount
}

function Wait-OpenCodeHealth {
    param(
        [Parameter(Mandatory)][string]$BaseUri,
        [int]$DeadlineMilliseconds = 15000
    )

    $client = New-LoopbackHttpClient
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $lastError = $null
    try {
        do {
            Assert-RunBudget
            try {
                $response = Invoke-BoundedHttp -Client $client -Method ([Net.Http.HttpMethod]::Get) -Uri "$BaseUri/global/health"
                if ($response.StatusCode -eq 200 -and $response.ContentType -like 'application/json*') {
                    $health = $response.Body | ConvertFrom-Json -ErrorAction Stop
                    if ($health.healthy -eq $true -and -not [string]::IsNullOrWhiteSpace([string]$health.version)) {
                        return [pscustomobject]@{
                            healthy = $true
                            version = [string]$health.version
                            elapsed_milliseconds = $watch.ElapsedMilliseconds
                        }
                    }
                }
            }
            catch {
                $lastError = $_.Exception.Message
            }
            Start-Sleep -Milliseconds 200
        } while ($watch.ElapsedMilliseconds -lt $DeadlineMilliseconds)
    }
    finally {
        $client.Dispose()
    }

    throw "OpenCode health did not become ready within $DeadlineMilliseconds ms. Last error: $lastError"
}

function Get-BestEffortProcessIdentity {
    param(
        [Parameter(Mandatory)][Diagnostics.Process]$Process,
        [Parameter(Mandatory)][string]$LaunchImagePath
    )

    $childPid = $null
    $startTime = $null
    $imagePath = $null
    try { $childPid = [int]$Process.Id } catch { }
    try { $startTime = $Process.StartTime.ToUniversalTime().ToString('O') } catch { }
    try { $imagePath = [string]$Process.MainModule.FileName } catch { }
    $imagePathSource = 'process'
    if ([string]::IsNullOrWhiteSpace($imagePath)) {
        $imagePath = $LaunchImagePath
        $imagePathSource = 'launch_path'
    }
    if ($null -eq $childPid -and $null -eq $startTime -and [string]::IsNullOrWhiteSpace($imagePath)) {
        return $null
    }
    return [pscustomobject]@{
        pid = $childPid
        start_time_utc = $startTime
        image_path = $imagePath
        image_path_source = $imagePathSource
    }
}

function Get-IdentityValue {
    param(
        [object]$Identity,
        [Parameter(Mandatory)][string]$Name
    )

    if ($null -eq $Identity) { return $null }
    $property = $Identity.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Start-OwnedInstance {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][int]$Port
    )

    Assert-RunBudget
    Write-ProgressEvent -Stage "$Name/start-prepared" -Message 'Process entry registered before Process.Start.'
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $OpenCodeExecutable
    $startInfo.WorkingDirectory = $projectDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in @('serve', '--hostname', '127.0.0.1', '--port', [string]$Port, '--pure', '--log-level', 'INFO')) {
        $startInfo.ArgumentList.Add($argument)
    }
    $removedCredentialVariableCount = Set-IsolatedEnvironment -StartInfo $startInfo

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $instance = [pscustomobject]@{
        Name = $Name
        Port = $Port
        BaseUri = "http://127.0.0.1:$Port"
        Process = $process
        ProcessHandle = $null
        Started = $false
        Identity = $null
        StdoutTask = $null
        StderrTask = $null
        RemovedCredentialVariableCount = $removedCredentialVariableCount
        Readiness = $null
        Stopped = $false
        StopResult = $null
        LogCapture = $null
    }
    $processes.Add($instance)

    try {
        if (-not $process.Start()) {
            throw "$Name failed to start."
        }
    }
    catch {
        Write-ProgressEvent -Stage "$Name/start-failed" -Message $_.Exception.Message
        throw
    }
    $instance.Started = $true
    try {
        $instance.ProcessHandle = $process.SafeHandle
    }
    catch {
        $instance.ProcessHandle = $null
    }
    $startedPid = $null
    try { $startedPid = [int]$process.Id } catch { }
    Write-ProgressEvent -Stage "$Name/started" -Message 'Process.Start succeeded; retained process entry is cleanup-owned.' -ChildIdentity ([pscustomobject]@{
        pid = $startedPid
        image_path = $OpenCodeExecutable
        source = 'Process.Start retained object'
    })
    if ($InjectFailureAfterSecondStart -and $Name -eq 'instance-2') {
        throw 'Injected failure after instance-2 Process.Start succeeded, before metadata and readiness.'
    }

    $instance.StdoutTask = $process.StandardOutput.ReadToEndAsync()
    $instance.StderrTask = $process.StandardError.ReadToEndAsync()
    $instance.Identity = Get-BestEffortProcessIdentity -Process $process -LaunchImagePath $OpenCodeExecutable
    Write-ProgressEvent -Stage "$Name/metadata-captured" -Message 'Best-effort child metadata captured.' -ChildIdentity $instance.Identity

    Write-ProgressEvent -Stage "$Name/readiness" -Message 'Waiting for /global/health.' -ChildIdentity $instance.Identity
    $health = Wait-OpenCodeHealth -BaseUri $instance.BaseUri
    $instance.Readiness = $health
    Write-ProgressEvent -Stage "$Name/ready" -Message 'OpenCode health is ready.' -ChildIdentity $instance.Identity
    return [pscustomobject]@{
        Instance = $instance
        Health = $health
    }
}

function Stop-OwnedInstance {
    param([Parameter(Mandatory)]$Instance)

    if ($Instance.Stopped) {
        return $Instance.StopResult
    }

    if (-not $Instance.Started) {
        $Instance.Stopped = $true
        $Instance.StopResult = [pscustomobject]@{
            owner_binding_established = $false
            owner_binding = $null
            identity_matched = $null
            tree_kill_requested = $false
            exited = $null
            exit_code = $null
            port_released = $true
        }
        return $Instance.StopResult
    }

    $process = $Instance.Process
    # Cleanup uses the retained process, not a fresh lookup matched against metadata.
    $identityMatched = $null
    $treeKillRequested = $false
    if (-not $process.HasExited) {
        try {
            # Process.Start retained the object and handle; metadata is diagnostic only.
            $process.Kill($true)
            $treeKillRequested = $true
        }
        catch {
            if (-not $process.HasExited) { throw }
        }
        if (-not $process.WaitForExit(5000)) {
            throw "$($Instance.Name) did not exit within the 5000 ms stop deadline."
        }
    }
    else {
        $identityMatched = $null
    }

    $portReleased = Wait-PortReleased -Port $Instance.Port -DeadlineMilliseconds 5000
    if (-not $portReleased) {
        throw "$($Instance.Name) port $($Instance.Port) remained reachable after owned process exit."
    }

    $Instance.Stopped = $true
    $Instance.StopResult = [pscustomobject]@{
        owner_binding_established = $true
        owner_binding = [ordered]@{
            authority = 'Process.Start retained object and SafeHandle'
            metadata_required_for_cleanup = $false
        }
        handle_retained = $null -ne $Instance.ProcessHandle
        identity_matched = $identityMatched
        tree_kill_requested = $treeKillRequested
        exited = $process.HasExited
        exit_code = if ($process.HasExited) { $process.ExitCode } else { $null }
        port_released = $portReleased
    }
    return $Instance.StopResult
}

function Get-BoundedTaskResult {
    param(
        [Threading.Tasks.Task]$Task,
        [Parameter(Mandatory)][int]$TimeoutMilliseconds
    )

    $capture = [ordered]@{
        status = 'not-started'
        completed = $false
        timed_out = $false
        partial = $null
        text_available = $false
        text = $null
        error = $null
    }
    if ($null -eq $Task) {
        $capture.error = 'ReadToEndAsync was not started.'
        return [pscustomobject]$capture
    }
    try {
        if (-not $Task.Wait($TimeoutMilliseconds)) {
            $capture.status = 'timeout'
            $capture.timed_out = $true
            return [pscustomobject]$capture
        }
        if ($Task.IsCanceled) {
            $capture.status = 'canceled'
            $capture.error = 'ReadToEndAsync was canceled.'
            return [pscustomobject]$capture
        }
        if ($Task.IsFaulted) {
            $capture.status = 'faulted'
            $capture.error = $Task.Exception.GetBaseException().Message
            return [pscustomobject]$capture
        }
        $capture.status = 'complete'
        $capture.completed = $true
        # GetResult is reached only after the finite Wait succeeded.
        $capture.text = $Task.GetAwaiter().GetResult()
        $capture.text_available = $true
        $capture.partial = $false
    }
    catch {
        $capture.status = 'faulted'
        $capture.error = $_.Exception.Message
    }
    return [pscustomobject]$capture
}

function Save-InstanceLogs {
    param(
        [Parameter(Mandatory)]$Instance,
        [int]$TimeoutMilliseconds = 5000
    )

    $stdout = Get-BoundedTaskResult -Task $Instance.StdoutTask -TimeoutMilliseconds $TimeoutMilliseconds
    $stderr = Get-BoundedTaskResult -Task $Instance.StderrTask -TimeoutMilliseconds $TimeoutMilliseconds
    $stdoutPath = Join-Path $logDirectory "$($Instance.Name).stdout.log"
    $stderrPath = Join-Path $logDirectory "$($Instance.Name).stderr.log"
    if ($stdout.text_available) {
        [IO.File]::WriteAllText($stdoutPath, [string]$stdout.text)
    }
    if ($stderr.text_available) {
        [IO.File]::WriteAllText($stderrPath, [string]$stderr.text)
    }
    $Instance.LogCapture = [ordered]@{
        stdout = [ordered]@{
            path = $stdoutPath
            status = $stdout.status
            completed = $stdout.completed
            timed_out = $stdout.timed_out
            partial = $stdout.partial
            text_available = $stdout.text_available
            error = $stdout.error
        }
        stderr = [ordered]@{
            path = $stderrPath
            status = $stderr.status
            completed = $stderr.completed
            timed_out = $stderr.timed_out
            partial = $stderr.partial
            text_available = $stderr.text_available
            error = $stderr.error
        }
        timeout_milliseconds = $TimeoutMilliseconds
    }
    return $Instance.LogCapture
}

function Get-OptionalPropertyValue {
    param(
        [object]$InputObject,
        [Parameter(Mandatory)][string]$Name
    )

    if ($null -eq $InputObject) { return $null }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

if (-not (Test-Path -LiteralPath $repoRoot -PathType Container)) {
    throw "Repository root is unavailable: $repoRoot"
}
if (-not (Test-Path -LiteralPath $OpenCodeExecutable -PathType Leaf)) {
    throw 'Pass -OpenCodeExecutable or set OPENCODE_SPIKE_EXECUTABLE to an existing opencode.exe.'
}
if (Test-Path -LiteralPath (Join-Path $env:ProgramData 'opencode') -PathType Container) {
    throw 'Isolation cannot be guaranteed because the Windows managed OpenCode config directory exists.'
}

try {
    Write-ProgressEvent -Stage 'setup/directories' -Message 'Creating isolated sandbox directories.'
    foreach ($directory in @(
        $scratchParent, $sandbox, $projectDirectory, $configDirectory, $logDirectory,
        (Join-Path $sandbox 'home'), (Join-Path $sandbox 'xdg-config'),
        (Join-Path $sandbox 'xdg-data'), (Join-Path $sandbox 'xdg-cache'),
        (Join-Path $sandbox 'xdg-state'), (Join-Path $sandbox 'data')
    )) {
        if (-not (Test-Path -LiteralPath $directory)) {
            [IO.Directory]::CreateDirectory($directory) | Out-Null
        }
    }
    [IO.File]::WriteAllText((Join-Path $configDirectory 'opencode.json'), "{`n  `"plugin`": []`n}`n")
    Write-ProgressEvent -Stage 'setup/complete' -Message 'Isolated sandbox and configuration are ready.'

    $port1 = New-FreeLoopbackPort
    do { $port2 = New-FreeLoopbackPort } while ($port2 -eq $port1)
    Write-ProgressEvent -Stage 'ports/allocated' -Message "Loopback ports allocated: $port1 and $port2."

    Write-ProgressEvent -Stage 'launch/instance-1' -Message 'Starting instance-1.'
    $started1 = Start-OwnedInstance -Name 'instance-1' -Port $port1
    Write-ProgressEvent -Stage 'launch/instance-2' -Message 'Starting instance-2.' -ChildIdentity $started1.Instance.Identity
    $started2 = Start-OwnedInstance -Name 'instance-2' -Port $port2
    $instance1 = $started1.Instance
    $instance2 = $started2.Instance

    if ($null -ne $instance1.Identity -and $null -ne $instance2.Identity -and $instance1.Identity.pid -eq $instance2.Identity.pid) {
        throw 'The two instances unexpectedly have the same PID.'
    }

    $result.instances = @(
        [ordered]@{ name = $instance1.Name; port = $instance1.Port; identity = $instance1.Identity; readiness = $started1.Health },
        [ordered]@{ name = $instance2.Name; port = $instance2.Port; identity = $instance2.Identity; readiness = $started2.Health }
    )
    $result.isolation = [ordered]@{
        managed_config_directory_present = $false
        sandbox_project = $projectDirectory
        isolated_database = Join-Path $sandbox 'data\opencode.db'
        pure_mode = $true
        project_config_disabled = $true
        default_plugins_disabled = $true
        external_skills_disabled = $true
        model_fetch_disabled = $true
        server_credentials_removed = $true
        parent_environment_modified = $false
        path_modified = $false
        credential_variable_values_read_or_printed = $false
        removed_credential_variable_name_count_per_child = @(
            $instance1.RemovedCredentialVariableCount,
            $instance2.RemovedCredentialVariableCount
        )
    }

    # This client is constructed only after both launch functions returned.
    $result.probes.launch_functions_returned = $true
    $client = New-LoopbackHttpClient
    $result.probes.separate_http_caller_created_after_launch = $true
    try {
        Write-ProgressEvent -Stage 'probes/health' -Message 'Checking both loopback health endpoints.'
        $health1 = Invoke-BoundedHttp -Client $client -Method ([Net.Http.HttpMethod]::Get) -Uri "$($instance1.BaseUri)/global/health"
        $health2 = Invoke-BoundedHttp -Client $client -Method ([Net.Http.HttpMethod]::Get) -Uri "$($instance2.BaseUri)/global/health"
        $healthObject1 = $health1.Body | ConvertFrom-Json -ErrorAction Stop
        $healthObject2 = $health2.Body | ConvertFrom-Json -ErrorAction Stop
        if ($health1.StatusCode -ne 200 -or $health2.StatusCode -ne 200 -or $healthObject1.healthy -ne $true -or $healthObject2.healthy -ne $true) {
            throw 'Independent health probes did not return healthy HTTP 200 responses.'
        }

        $encodedDirectory = [Uri]::EscapeDataString($projectDirectory)
        $projectResponses = @()
        foreach ($instance in @($instance1, $instance2)) {
            Write-ProgressEvent -Stage "probes/$($instance.Name)/path" -Message 'Checking /path.directory against the isolated working directory.' -ChildIdentity $instance.Identity
            $pathResponse = Invoke-BoundedHttp -Client $client -Method ([Net.Http.HttpMethod]::Get) -Uri "$($instance.BaseUri)/path"
            if ($pathResponse.StatusCode -ne 200 -or $pathResponse.ContentType -notlike 'application/json*') {
                throw "$($instance.Name) /path did not return JSON HTTP 200."
            }
            $pathObject = $pathResponse.Body | ConvertFrom-Json -ErrorAction Stop
            $pathDirectory = [string](Get-OptionalPropertyValue -InputObject $pathObject -Name 'directory')
            if (-not [string]::Equals($pathDirectory, $projectDirectory, [StringComparison]::OrdinalIgnoreCase)) {
                throw "$($instance.Name) /path.directory did not identify the isolated working directory."
            }

            Write-ProgressEvent -Stage "probes/$($instance.Name)/project-current" -Message 'Recording project/current without treating worktree as cwd.' -ChildIdentity $instance.Identity
            $projectResponse = Invoke-BoundedHttp -Client $client -Method ([Net.Http.HttpMethod]::Get) -Uri "$($instance.BaseUri)/project/current?directory=$encodedDirectory"
            if ($projectResponse.StatusCode -ne 200 -or $projectResponse.ContentType -notlike 'application/json*') {
                throw "$($instance.Name) project/current did not return JSON HTTP 200."
            }
            $projectObject = $projectResponse.Body | ConvertFrom-Json -ErrorAction Stop
            $projectWorktree = [string](Get-OptionalPropertyValue -InputObject $projectObject -Name 'worktree')
            $projectVcs = Get-OptionalPropertyValue -InputObject $projectObject -Name 'vcs'
            $nonGitGlobalProject = ($projectWorktree -eq '/' -and $null -eq $projectVcs)
            $projectResponses += [ordered]@{
                instance = $instance.Name
                path_status_code = $pathResponse.StatusCode
                path_content_type = $pathResponse.ContentType
                path_directory = $pathDirectory
                path_directory_matches_isolated_project = $true
                status_code = $projectResponse.StatusCode
                content_type = $projectResponse.ContentType
                property_names = @($projectObject.PSObject.Properties.Name)
                worktree = $projectWorktree
                vcs = $projectVcs
                non_git_global_project = $nonGitGlobalProject
            }
        }

        $rootResponse = Invoke-BoundedHttp -Client $client -Method ([Net.Http.HttpMethod]::Get) -Uri "$($instance1.BaseUri)/"
        if ($rootResponse.StatusCode -ne 200 -or $rootResponse.ContentType -notlike 'text/html*' -or $rootResponse.Body -notmatch '(?i)<html') {
            throw 'Root did not return an HTML document with HTTP 200.'
        }
        $titleMatch = [regex]::Match($rootResponse.Body, '(?is)<title[^>]*>(.*?)</title>')
        $assetMatches = [regex]::Matches($rootResponse.Body, '(?is)<(?:script|link)\b[^>]*(?:src|href)=["'']([^"'']+)["'']')
        $assetResult = $null
        foreach ($match in $assetMatches) {
            $candidate = $match.Groups[1].Value
            if ($candidate -match '^(?:data:|javascript:|#)') { continue }
            $assetUri = [Uri]::new([Uri]$instance1.BaseUri, $candidate)
            if ($assetUri.Host -ne '127.0.0.1' -or $assetUri.Port -ne $instance1.Port) { continue }
            $assetResponse = Invoke-BoundedHttp -Client $client -Method ([Net.Http.HttpMethod]::Get) -Uri $assetUri.AbsoluteUri
            if ($assetResponse.StatusCode -eq 200 -and $assetResponse.Body.Length -gt 0) {
                $assetResult = [ordered]@{
                    path = $assetUri.PathAndQuery
                    status_code = $assetResponse.StatusCode
                    content_type = $assetResponse.ContentType
                    body_bytes = [Text.Encoding]::UTF8.GetByteCount($assetResponse.Body)
                    request_origin = $instance1.BaseUri
                }
                break
            }
        }
        if ($null -eq $assetResult) {
            throw 'Root HTML did not expose a usable loopback static asset.'
        }

        $sessionListUri1 = "$($instance1.BaseUri)/session?directory=$encodedDirectory"
        $sessionListUri2 = "$($instance2.BaseUri)/session?directory=$encodedDirectory"
        $initialSessions1Response = Invoke-BoundedHttp -Client $client -Method ([Net.Http.HttpMethod]::Get) -Uri $sessionListUri1
        $initialSessions2Response = Invoke-BoundedHttp -Client $client -Method ([Net.Http.HttpMethod]::Get) -Uri $sessionListUri2
        $initialSessions1 = ConvertFrom-Json -InputObject $initialSessions1Response.Body -NoEnumerate -ErrorAction Stop
        $initialSessions2 = ConvertFrom-Json -InputObject $initialSessions2Response.Body -NoEnumerate -ErrorAction Stop
        if ($initialSessions1Response.StatusCode -ne 200 -or $initialSessions2Response.StatusCode -ne 200) {
            throw 'Initial session lists did not return HTTP 200.'
        }
        if ($initialSessions1.Count -ne 0 -or $initialSessions2.Count -ne 0) {
            throw 'Isolated session storage was not empty before the test session was created.'
        }

        $sessionTitle = "OMW runtime spike $runId"
        $createBody = @{ title = $sessionTitle } | ConvertTo-Json -Compress
        $createdSessionResponse = Invoke-BoundedHttp -Client $client -Method ([Net.Http.HttpMethod]::Post) -Uri $sessionListUri1 -JsonBody $createBody
        if ($createdSessionResponse.StatusCode -ne 200) {
            throw "Empty session creation returned HTTP $($createdSessionResponse.StatusCode)."
        }
        $createdSession = $createdSessionResponse.Body | ConvertFrom-Json -ErrorAction Stop
        $createdSessionId = [string]$createdSession.id
        if ([string]::IsNullOrWhiteSpace($createdSessionId)) {
            throw 'Empty session creation did not return an id.'
        }

        $visibilityWatch = [Diagnostics.Stopwatch]::StartNew()
        $visibleOnInstance2 = $false
        do {
            $sessions2Response = Invoke-BoundedHttp -Client $client -Method ([Net.Http.HttpMethod]::Get) -Uri $sessionListUri2
            $sessions2 = ConvertFrom-Json -InputObject $sessions2Response.Body -NoEnumerate -ErrorAction Stop
            $visibleOnInstance2 = @($sessions2 | Where-Object { [string]$_.id -eq $createdSessionId }).Count -eq 1
            if (-not $visibleOnInstance2) { Start-Sleep -Milliseconds 200 }
        } while (-not $visibleOnInstance2 -and $visibilityWatch.ElapsedMilliseconds -lt 5000)
        if (-not $visibleOnInstance2) {
            throw 'The empty session created through instance 1 did not become visible through instance 2.'
        }

        $instance1Stop = Stop-OwnedInstance -Instance $instance1
        $health2AfterInstance1Stop = Invoke-BoundedHttp -Client $client -Method ([Net.Http.HttpMethod]::Get) -Uri "$($instance2.BaseUri)/global/health"
        $health2AfterStopObject = $health2AfterInstance1Stop.Body | ConvertFrom-Json -ErrorAction Stop
        if ($health2AfterInstance1Stop.StatusCode -ne 200 -or $health2AfterStopObject.healthy -ne $true) {
            throw 'Instance 2 was not healthy after instance 1 stopped.'
        }

        $deleteResponse = Invoke-BoundedHttp -Client $client -Method ([Net.Http.HttpMethod]::Delete) -Uri "$($instance2.BaseUri)/session/${createdSessionId}?directory=$encodedDirectory"
        $sessionDeleted = $deleteResponse.StatusCode -eq 200
        if (-not $sessionDeleted) {
            throw "Deleting the isolated test session returned HTTP $($deleteResponse.StatusCode)."
        }

        $result.probes = [ordered]@{
            launch_functions_returned = $result.probes.launch_functions_returned
            separate_http_caller_created_after_launch = $result.probes.separate_http_caller_created_after_launch
            health = @(
                [ordered]@{ instance = 'instance-1'; status_code = $health1.StatusCode; healthy = $true; version = [string]$healthObject1.version },
                [ordered]@{ instance = 'instance-2'; status_code = $health2.StatusCode; healthy = $true; version = [string]$healthObject2.version }
            )
            project_current = $projectResponses
            web_root = [ordered]@{
                status_code = $rootResponse.StatusCode
                content_type = $rootResponse.ContentType
                title = if ($titleMatch.Success) { $titleMatch.Groups[1].Value.Trim() } else { $null }
                contains_opencode_marker = $rootResponse.Body -match '(?i)opencode'
                html_bytes = [Text.Encoding]::UTF8.GetByteCount($rootResponse.Body)
                redirects_followed = $false
                request_origin = $instance1.BaseUri
                local_static_asset = $assetResult
                source_interpretation = 'Official UI delivered through the local OpenCode root; HTTP alone cannot distinguish embedded bytes from an internal upstream fallback.'
            }
            instance_1_stop = $instance1Stop
            instance_2_healthy_after_instance_1_stop = $true
        }
        $result.session_visibility = [ordered]@{
            initial_count_instance_1 = $initialSessions1.Count
            initial_count_instance_2 = $initialSessions2.Count
            empty_session_created_without_prompt = $true
            visible_on_instance_2 = $true
            visibility_elapsed_milliseconds = $visibilityWatch.ElapsedMilliseconds
            test_session_deleted = $sessionDeleted
            session_content_reported = $false
        }
    }
    finally {
        if ($client) { $client.Dispose() }
    }

    $result.status = 'passed'
}
catch {
    $testError = $_.Exception.Message
    $result.status = 'failed'
    $result['error'] = $testError
    Write-ProgressEvent -Stage 'run/failed' -Message $testError
}
finally {
    Write-ProgressEvent -Stage 'cleanup/start' -Message 'Stopping every registered started process.' -ChildIdentity $earliestChildIdentity
    foreach ($instance in $processes) {
        try {
            Write-ProgressEvent -Stage "cleanup/stop/$($instance.Name)" -Message 'Stopping registered process entry.' -ChildIdentity $instance.Identity
            Stop-OwnedInstance -Instance $instance | Out-Null
        }
        catch {
            $cleanupErrors.Add($_.Exception.Message)
        }
    }

    foreach ($instance in $processes) {
        try {
            Write-ProgressEvent -Stage "cleanup/logs/$($instance.Name)" -Message 'Capturing stdout/stderr with finite waits.' -ChildIdentity $instance.Identity
            Save-InstanceLogs -Instance $instance
        }
        catch {
            $cleanupErrors.Add("Could not save $($instance.Name) logs: $($_.Exception.Message)")
        }
    }

    $cleanupInstances = @()
    foreach ($instance in $processes) {
        $processExited = $null
        if ($instance.Started) {
            try { $processExited = $instance.Process.HasExited } catch { $processExited = $false }
        }
        $cleanupInstances += [ordered]@{
            name = $instance.Name
            pid = Get-IdentityValue -Identity $instance.Identity -Name 'pid'
            started = $instance.Started
            stopped = $instance.Stopped
            process_exited = $processExited
            port = $instance.Port
            port_released = -not (Test-TcpListener -Port $instance.Port)
            identity = $instance.Identity
            stop_result = $instance.StopResult
            log_capture = $instance.LogCapture
        }
        $instance.Process.Dispose()
    }
    Write-ProgressEvent -Stage 'cleanup/complete' -Message 'Process cleanup and finite log capture completed.' -ChildIdentity $earliestChildIdentity
    $startedCleanupInstances = @($cleanupInstances | Where-Object { $_.started })
    $result.cleanup = [ordered]@{
        attempted_for_all_started_instances = @($startedCleanupInstances | Where-Object { $_.stopped }).Count -eq $startedCleanupInstances.Count
        instances = $cleanupInstances
        errors = @($cleanupErrors)
        all_processes_exited = @($cleanupInstances | Where-Object { $_.started -and -not $_.process_exited }).Count -eq 0
        all_ports_released = @($cleanupInstances | Where-Object { -not $_.port_released }).Count -eq 0
        original_temp_sandbox_touched = $false
        sandbox_retained_for_evidence = $true
    }
    $result.progress = [ordered]@{
        current_stage = $currentStage
        earliest_child_identity = $earliestChildIdentity
        journal_path = $progressPath
        events = @($progressEvents)
        write_errors = @($progressErrors)
    }
    $result.elapsed_milliseconds = $runWatch.ElapsedMilliseconds

    if (-not (Test-Path -LiteralPath $sandbox -PathType Container)) {
        [IO.Directory]::CreateDirectory($sandbox) | Out-Null
    }
    [IO.File]::WriteAllText(
        (Join-Path $sandbox 'result.json'),
        ($result | ConvertTo-Json -Depth 12)
    )
}

$result | ConvertTo-Json -Depth 12
if ($result.status -ne 'passed' -or $cleanupErrors.Count -gt 0 -or -not $result.cleanup.all_processes_exited -or -not $result.cleanup.all_ports_released) {
    exit 1
}
