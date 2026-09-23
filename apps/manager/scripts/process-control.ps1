[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Describe', 'Inspect', 'Stop', 'Listener', 'WaitForExit')][string]$Action,
    [int]$ProcessId,
    [string]$ExpectedCreationTicks,
    [string]$ExpectedExecutable,
    [int]$Port,
    [ValidateRange(1, 60000)][int]$TimeoutMilliseconds = 10000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-NormalizedPath([string]$Value) {
    return [IO.Path]::GetFullPath($Value).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Get-Identity([Diagnostics.Process]$Process) {
    if ($Process.HasExited) { throw "PID $($Process.Id) has exited." }
    $handle = $Process.SafeHandle
    if ($handle.IsInvalid -or $handle.IsClosed) { throw "PID $($Process.Id) has no usable handle." }
    $creation = $Process.StartTime.ToUniversalTime()
    $image = [string]$Process.MainModule.FileName
    if ([string]::IsNullOrWhiteSpace($image)) { throw "PID $($Process.Id) has no executable image." }
    return [ordered]@{
        pid = [int]$Process.Id
        creationTimeUtc = $creation.ToString('O')
        creationTimeTicks = [string]$creation.Ticks
        executable = Get-NormalizedPath $image
    }
}

function Test-Expected([object]$Identity) {
    return $Identity.pid -eq $ProcessId -and
        $Identity.creationTimeTicks -eq $ExpectedCreationTicks -and
        [string]::Equals((Get-NormalizedPath $Identity.executable), (Get-NormalizedPath $ExpectedExecutable), [StringComparison]::OrdinalIgnoreCase)
}

function Test-ListenerOverlapsManagerEndpoint([string]$LocalAddress) {
    try {
        $address = [Net.IPAddress]::Parse($LocalAddress)
    }
    catch {
        return $false
    }

    if ($address.Equals([Net.IPAddress]::Loopback) -or
        $address.Equals([Net.IPAddress]::Any) -or
        $address.Equals([Net.IPAddress]::IPv6Any)) {
        return $true
    }
    return $address.IsIPv4MappedToIPv6 -and $address.MapToIPv4().Equals([Net.IPAddress]::Loopback)
}

function Get-PortOwners {
    # Query failure must not look like a free port, or Stop could be granted without port-reuse evidence.
    # Manager 只 probe 127.0.0.1；具體 Tailnet 或其他 loopback 位址的同 port listener 不會重疊。
    # -p tcp 會漏掉純 IPv6 listener；不指定 -p 才能同時取得 TCP 與 TCPv6。
    # 所有 TCP 列都要能解析，否則不可把查詢失敗誤判成無 port owner。
    $netstat = Join-Path $env:SystemRoot 'System32\netstat.exe'
    $lines = @(& $netstat -ano)
    if ($LASTEXITCODE -ne 0 -or $lines.Count -eq 0) { throw 'TCP owner query failed.' }
    $owners = [Collections.Generic.HashSet[int]]::new()
    $parsedRows = 0
    foreach ($line in $lines) {
        if ($line -notmatch '^\s*TCP\s') { continue }
        if ($line -notmatch '^\s*TCP\s+(\S+)\s+\S+\s+(\S+)\s+(\d+)\s*$') {
            throw 'TCP owner query returned an invalid row.'
        }
        $localEndpoint = $Matches[1]
        $state = $Matches[2]
        $owner = [int]$Matches[3]
        if ($localEndpoint -notmatch '^(\[[^]]+\]|[^:]+):(\d+)$') {
            throw 'TCP owner query returned an invalid endpoint.'
        }
        $address = $Matches[1].Trim('[', ']')
        $localPort = [int]$Matches[2]
        $parsedAddress = $null
        if ($localPort -lt 0 -or $localPort -gt 65535 -or
            -not [Net.IPAddress]::TryParse($address, [ref]$parsedAddress) -or
            $state -notin @('BOUND', 'CLOSED', 'LISTENING', 'ESTABLISHED', 'TIME_WAIT', 'CLOSE_WAIT',
                'FIN_WAIT_1', 'FIN_WAIT_2', 'LAST_ACK', 'CLOSING', 'SYN_SENT', 'SYN_RECEIVED', 'DELETE_TCB')) {
            throw 'TCP owner query returned an invalid endpoint or state.'
        }
        $parsedRows++
        if ($localPort -eq $Port -and $state -eq 'LISTENING' -and
            (Test-ListenerOverlapsManagerEndpoint $address)) { $null = $owners.Add($owner) }
    }
    if ($parsedRows -eq 0) { throw 'TCP owner query returned no TCP rows.' }
    return @($owners)
}

function Test-PortSafeForStop {
    $owners = @(Get-PortOwners)
    return $owners.Count -eq 0 -or @($owners | Where-Object { $_ -ne $ProcessId }).Count -eq 0
}

$process = $null
try {
    if ($Action -eq 'Listener') {
        if ($Port -lt 1) { throw 'Listener requires Port.' }
        $owners = @(Get-PortOwners)
        if ($owners.Count -eq 0) {
            [Console]::Out.WriteLine('{"state":"absent"}')
            exit 0
        }
        if ($owners.Count -ne 1) {
            [Console]::Out.WriteLine('{"state":"ambiguous"}')
            exit 0
        }
        try {
            $process = [Diagnostics.Process]::GetProcessById($owners[0])
            $identity = Get-Identity $process
            $finalOwners = @(Get-PortOwners)
            $finalIdentity = Get-Identity $process
            $stable = $finalOwners.Count -eq 1 -and
                $finalOwners[0] -eq $identity.pid -and
                $identity.creationTimeTicks -eq $finalIdentity.creationTimeTicks -and
                [string]::Equals($identity.executable, $finalIdentity.executable, [StringComparison]::OrdinalIgnoreCase)
            if (-not $stable) {
                [Console]::Out.WriteLine('{"state":"ambiguous"}')
                exit 0
            }
            $result = [ordered]@{ state = 'owned' }
            foreach ($entry in $finalIdentity.GetEnumerator()) { $result[$entry.Key] = $entry.Value }
            [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
            exit 0
        }
        catch {
            [Console]::Out.WriteLine('{"state":"ambiguous"}')
            exit 0
        }
    }

    if ($Action -eq 'WaitForExit') {
        if ($ProcessId -lt 1 -or [string]::IsNullOrWhiteSpace($ExpectedCreationTicks) -or [string]::IsNullOrWhiteSpace($ExpectedExecutable)) {
            throw 'WaitForExit requires exact process identity.'
        }
        try {
            $process = [Diagnostics.Process]::GetProcessById($ProcessId)
        }
        catch {
            $processNotFound = $_.Exception -is [System.ArgumentException] -or
                $_.Exception.InnerException -is [System.ArgumentException]
            if (-not $processNotFound) { throw }
            [Console]::Out.WriteLine('{"exited":true}')
            exit 0
        }
        try {
            $identity = Get-Identity $process
        }
        catch {
            if ($process.HasExited) {
                [Console]::Out.WriteLine('{"exited":true}')
                exit 0
            }
            throw
        }
        if (-not (Test-Expected $identity)) {
            # PID 已被重用時，先前驗證的 exact process 必然已退出；這不授予新 process 任何 Stop authority。
            [Console]::Out.WriteLine('{"exited":true}')
            exit 0
        }
        $exited = $process.WaitForExit($TimeoutMilliseconds)
        [Console]::Out.WriteLine((@{ exited = $exited } | ConvertTo-Json -Compress))
        exit 0
    }

    if ($Action -eq 'Describe') {
        if ([string]::IsNullOrWhiteSpace($ExpectedExecutable)) { throw 'Describe requires ExpectedExecutable.' }
        $process = [Diagnostics.Process]::GetProcessById($ProcessId)
        $identity = Get-Identity $process
        if (-not [string]::Equals(
            (Get-NormalizedPath $identity.executable),
            (Get-NormalizedPath $ExpectedExecutable),
            [StringComparison]::OrdinalIgnoreCase
        )) {
            throw "PID $ProcessId executable does not match the expected launch image."
        }
        # The same retained Process handle must still describe the same creation before it becomes persisted identity.
        $finalIdentity = Get-Identity $process
        if ($identity.creationTimeTicks -ne $finalIdentity.creationTimeTicks) {
            throw "PID $ProcessId identity changed during Describe."
        }
        [Console]::Out.WriteLine(($finalIdentity | ConvertTo-Json -Compress))
        exit 0
    }

    try {
        $process = [Diagnostics.Process]::GetProcessById($ProcessId)
    }
    catch {
        $processNotFound = $_.Exception -is [System.ArgumentException] -or
            $_.Exception.InnerException -is [System.ArgumentException]
        if ($Action -ne 'Inspect' -or -not $processNotFound) { throw }
        [Console]::Out.WriteLine(([ordered]@{
            processState = 'not-found'
            running = $false
            matched = $false
            portOwnerMatched = $false
            portOwnedByOther = $false
        } | ConvertTo-Json -Compress))
        exit 0
    }
    $identity = Get-Identity $process
    $matched = Test-Expected $identity
    $portOwners = @(Get-PortOwners)
    $portOwnerMatched = @($portOwners | Where-Object { $_ -eq $ProcessId }).Count -gt 0
    $portOwnedByOther = @($portOwners | Where-Object { $_ -ne $ProcessId }).Count -gt 0
    if ($Action -eq 'Inspect') {
        [Console]::Out.WriteLine(([ordered]@{
            processState = 'running'
            running = $true
            matched = $matched
            portOwnerMatched = $portOwnerMatched
            portOwnedByOther = $portOwnedByOther
        } | ConvertTo-Json -Compress))
        exit 0
    }

    $portSafeForStop = Test-PortSafeForStop
    if (-not $matched -or -not $portSafeForStop) {
        [Console]::Out.WriteLine(([ordered]@{
            stopped = $false
            reason = if (-not $matched) { 'process identity mismatch' } else { 'port is owned by another process' }
        } | ConvertTo-Json -Compress))
        exit 0
    }

    # Keep this exact Process handle open and re-read identity immediately before tree kill.
    $finalIdentity = Get-Identity $process
    if (-not (Test-Expected $finalIdentity) -or -not (Test-PortSafeForStop)) {
        [Console]::Out.WriteLine('{"stopped":false,"reason":"process identity changed before stop"}')
        exit 0
    }
    $process.Kill($true)
    if (-not $process.WaitForExit(5000)) { throw "PID $ProcessId did not exit within 5000 ms." }
    [Console]::Out.WriteLine('{"stopped":true,"reason":null}')
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
finally {
    if ($null -ne $process) { $process.Dispose() }
}
