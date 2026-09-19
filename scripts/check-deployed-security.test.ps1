[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
trap {
  [pscustomobject]@{
    ReturnedObjectCount = 0
    ReturnedObjectTypes = @($_.Exception.GetType().FullName)
    UriValid = $false
    SanitizedStage = 'TEST_HARNESS'
    ErrorCode = 'TEST_HARNESS_FAILED'
  } | ConvertTo-Json -Compress
  exit 1
}

$scriptPath = Join-Path $PSScriptRoot 'check-deployed-security.ps1'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) {
  [pscustomobject]@{
    ReturnedObjectCount = 0
    ReturnedObjectTypes = @()
    UriValid = $false
    SanitizedStage = 'PARSE'
    ErrorCode = 'SCRIPT_PARSE_FAILED'
  } | ConvertTo-Json -Compress
  exit 1
}

$functionAst = $ast.Find({
  param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Get-TailscaleSelfDnsName'
}, $true)
if ($null -eq $functionAst) { throw 'TEST_FUNCTION_NOT_FOUND' }

$functionSource = $functionAst.Extent.Text
$injectedTestSeam = $false
if ($functionSource -notmatch '\$StartInfoFactory') {
  $injectedTestSeam = $true
  $functionSource = $functionSource.Replace(
    'function Get-TailscaleSelfDnsName {',
    'function Get-TailscaleSelfDnsName([scriptblock]$StartInfoFactory) {'
  )
  $setupPattern = '(?ms)^  \$tailscale = Join-Path .*?^  \[void\]\$startInfo\.ArgumentList\.Add\(''--json''\)\r?\n'
  $functionSource = [regex]::Replace($functionSource, $setupPattern, "  `$startInfo = & `$StartInfoFactory`r`n")
}
if (($injectedTestSeam -and $functionSource -match 'tailscale\.exe') -or $functionSource -notmatch '& \$StartInfoFactory') {
  throw 'TEST_SEAM_INJECTION_FAILED'
}

. ([scriptblock]::Create($functionSource))

try {
  $dnsName = Get-TailscaleSelfDnsName -StartInfoFactory {
    $fakeStartInfo = [Diagnostics.ProcessStartInfo]::new()
    $fakeStartInfo.FileName = (Get-Command pwsh -ErrorAction Stop).Source
    $fakeStartInfo.UseShellExecute = $false
    $fakeStartInfo.CreateNoWindow = $true
    $fakeStartInfo.RedirectStandardOutput = $true
    $fakeStartInfo.RedirectStandardError = $true
    [void]$fakeStartInfo.ArgumentList.Add('-NoLogo')
    [void]$fakeStartInfo.ArgumentList.Add('-NoProfile')
    [void]$fakeStartInfo.ArgumentList.Add('-Command')
    $syntheticDns = (-join ([char[]](110, 111, 100, 101))) + '.tail.ts.net.'
    $json = @{ BackendState = 'Running'; Self = @{ Online = $true; DNSName = $syntheticDns } } | ConvertTo-Json -Compress
    [void]$fakeStartInfo.ArgumentList.Add("[Console]::Out.Write('$json')")
    return $fakeStartInfo
  }
} catch {
  [pscustomobject]@{
    ReturnedObjectCount = 0
    ReturnedObjectTypes = @($_.Exception.GetType().FullName)
    UriValid = $false
    SanitizedStage = 'TAILSCALE_RETURN'
    ErrorCode = 'FAKE_PROCESS_FAILED'
  } | ConvertTo-Json -Compress
  exit 1
}

$returnedObjects = @($dnsName)
$returnedTypes = @($returnedObjects | ForEach-Object { $_.GetType().FullName })
$uri = $null
$uriValid = [Uri]::TryCreate("https://${dnsName}:40443/", [UriKind]::Absolute, [ref]$uri)
$passed = $returnedObjects.Count -eq 1 -and $returnedTypes.Count -eq 1 -and
  $returnedTypes[0] -ceq 'System.String' -and $uriValid

[pscustomobject]@{
  ReturnedObjectCount = $returnedObjects.Count
  ReturnedObjectTypes = $returnedTypes
  UriValid = $uriValid
  SanitizedStage = 'TAILSCALE_RETURN'
  ErrorCode = $(if ($passed) { 'NONE' } else { 'RETURN_VALUE_POLLUTION' })
} | ConvertTo-Json -Compress

if (-not $passed) { exit 1 }
