[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Describe', 'Inspect', 'Stop')][string]$Action,
    [int]$ProcessId,
    [string]$ExpectedCreationTicks,
    [string]$ExpectedExecutable,
    [int]$Port
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

function Get-PortOwners {
    # Query failure must not look like a free port, or Stop could be granted without port-reuse evidence.
    $listeners = @(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $_.State -eq 'Listen' -and $_.LocalPort -eq $Port })
    return @($listeners | ForEach-Object { [int]$_.OwningProcess } | Select-Object -Unique)
}

function Test-PortSafeForStop {
    $owners = @(Get-PortOwners)
    return $owners.Count -eq 0 -or @($owners | Where-Object { $_ -ne $ProcessId }).Count -eq 0
}

$process = $null
try {
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
