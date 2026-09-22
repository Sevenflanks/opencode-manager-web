[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Executable,
    [Parameter(Mandatory)][string]$ArgumentsFile,
    [Parameter(Mandatory)][string]$WorkingDirectory,
    [Parameter(Mandatory)][string]$StdoutPath,
    [Parameter(Mandatory)][string]$StderrPath,
    [Parameter(Mandatory)][int]$TimeoutMs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-ProtocolEvent([hashtable]$Value) {
    [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}

$nativeSource = Join-Path $PSScriptRoot '..\..\docs\acceptance\Issue11TuiNative.cs'
$job = $null
$child = $null

try {
    Add-Type -Path $nativeSource
    $arguments = @((Get-Content -LiteralPath $ArgumentsFile -Raw | ConvertFrom-Json))
    $environment = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
        if ($null -ne $entry.Value) { $environment[[string]$entry.Key] = [string]$entry.Value }
    }

    $job = [Omw.Issue11Acceptance.OwnedJob]::new()
    $child = $job.StartRedirected($Executable, [string[]]$arguments, $WorkingDirectory, $environment, $StdoutPath, $StderrPath)
    Write-ProtocolEvent @{ event = 'started'; pid = $child.ProcessId }

    if (-not $child.WaitForExit($TimeoutMs)) {
        $job.Terminate(124)
        $empty = $job.WaitEmpty(5000)
        Write-ProtocolEvent @{ event = 'result'; timedOut = $true; exitCode = $null; jobEmpty = $empty }
        if (-not $empty) { throw 'Timed-out Windows Job did not become empty.' }
    }
    else {
        Write-ProtocolEvent @{ event = 'result'; timedOut = $false; exitCode = $child.ExitCode; jobEmpty = $false }
        if ([Console]::In.ReadLine() -ne 'close') { throw 'Windows Job supervisor lost its owner before close.' }

        $graceful = $job.WaitEmpty(5000)
        if (-not $graceful) { $job.Terminate(124) }
        $empty = $job.WaitEmpty(5000)
        Write-ProtocolEvent @{ event = 'closed'; graceful = $graceful; jobEmpty = $empty }
        if (-not $empty) { throw 'Windows Job did not become empty during close.' }
    }
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
finally {
    if ($null -ne $child) { $child.Dispose() }
    if ($null -ne $job) { $job.Dispose() }
}
