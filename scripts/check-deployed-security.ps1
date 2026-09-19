[CmdletBinding()]
param(
  [switch]$Plan,
  [Alias('CheckEnvironment')][switch]$Preflight,
  [ValidateRange(1, 65535)][int]$PublicPort = 40443,
  [ValidateRange(1, 65535)][int]$ExpectedLoopbackPort = 40443
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$probes = @(
  @{ Name = 'public-connectivity'; Target = 'public'; Method = 'GET'; Path = '/api/v1/connectivity'; Origin = $null; Csrf = $null; Status = 200; Code = $null; Baseline = $true }
  @{ Name = 'mutation-missing-csrf'; Target = 'public'; Method = 'POST'; Path = '/api/v1/instances'; Origin = 'valid'; Csrf = $null; Status = 403; Code = 'MUTATION_ORIGIN_REJECTED'; Baseline = $false }
  @{ Name = 'mutation-wrong-csrf'; Target = 'public'; Method = 'POST'; Path = '/api/v1/instances'; Origin = 'valid'; Csrf = '0'; Status = 403; Code = 'MUTATION_ORIGIN_REJECTED'; Baseline = $false }
  @{ Name = 'mutation-invalid-origin'; Target = 'public'; Method = 'POST'; Path = '/api/v1/instances'; Origin = 'invalid'; Csrf = '1'; Status = 403; Code = 'UNTRUSTED_ORIGIN'; Baseline = $false }
  @{ Name = 'mutation-valid-guard'; Target = 'public'; Method = 'POST'; Path = '/api/v1/instances'; Origin = 'valid'; Csrf = '1'; Status = 400; Code = 'REQUEST_INVALID'; Baseline = $false }
  @{ Name = 'loopback-connectivity'; Target = 'loopback'; Method = 'GET'; Path = '/api/v1/connectivity'; Origin = $null; Csrf = $null; Status = 200; Code = $null; Baseline = $true }
  @{ Name = 'launcher-browser-audience'; Target = 'loopback'; Method = 'POST'; Path = '/api/v1/launcher/reservations'; Origin = $null; Csrf = $null; Status = 401; Code = 'LAUNCHER_AUTH_REQUIRED'; Baseline = $false }
)

if ($Plan) {
  'Offline plan: no credentials, Tailscale process, or HTTP requests are used.'
  'Live target: this device Self.DNSName from the fixed local tailscale.exe, validated as lowercase *.ts.net.'
  foreach ($probe in $probes) {
    $expected = if ($null -eq $probe.Code) { $probe.Status } else { "$($probe.Status) $($probe.Code)" }
    "$($probe.Name): $($probe.Method) $($probe.Path) expected $expected"
  }
  'Limitation: browser-to-launcher rejection is checked; a valid launcher token is neither read nor tested.'
  exit 0
}

function Get-TailscaleSelfDnsName([scriptblock]$StartInfoFactory = $null) {
  if ($null -eq $StartInfoFactory) {
    $tailscale = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)) 'Tailscale\tailscale.exe'
    if (-not (Test-Path -LiteralPath $tailscale -PathType Leaf)) { throw 'TS_NOT_FOUND' }
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $tailscale
    [void]$startInfo.ArgumentList.Add('status')
    [void]$startInfo.ArgumentList.Add('--json')
  }
  else {
    $startInfo = & $StartInfoFactory
    if ($startInfo -isnot [Diagnostics.ProcessStartInfo]) { throw 'TS_START_FAILED' }
  }
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  $timeout = [Threading.CancellationTokenSource]::new(5000)
  $output = [IO.MemoryStream]::new()
  $started = $false
  try {
    if (-not $process.Start()) { throw 'TS_START_FAILED' }
    $started = $true
    $stderrTask = $process.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null, $timeout.Token)
    $buffer = [byte[]]::new(8192)
    while (($read = $process.StandardOutput.BaseStream.ReadAsync($buffer, 0, $buffer.Length, $timeout.Token).GetAwaiter().GetResult()) -gt 0) {
      if ($output.Length + $read -gt 1MB) { throw 'TS_OUTPUT_LIMIT' }
      [void]$output.Write($buffer, 0, $read)
    }
    # pwsh 會把 VoidTaskResult 放入函式輸出，必須明確丟棄，否則 DNS 字串會變成陣列。
    [void]$process.WaitForExitAsync($timeout.Token).GetAwaiter().GetResult()
    [void]$stderrTask.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw 'TS_COMMAND_FAILED' }
    $status = [Text.Encoding]::UTF8.GetString($output.ToArray()) | ConvertFrom-Json
    if ($status.BackendState -cne 'Running' -or $status.Self.Online -ne $true) { throw 'TS_NOT_ONLINE' }
    if ($status.Self.DNSName -isnot [string]) { throw 'TS_DNS_INVALID' }
    $dnsName = $status.Self.DNSName.TrimEnd('.')
    $label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
    if ($dnsName.Length -gt 253 -or $dnsName -cne $dnsName.ToLowerInvariant() -or $dnsName -notmatch "^(?:$label\.)+ts\.net$") {
      throw 'TS_DNS_INVALID'
    }
    return $dnsName
  }
  catch [OperationCanceledException] { throw 'TS_TIMEOUT' }
  finally {
    [void]$timeout.Cancel()
    if ($started) { try { if (-not $process.HasExited) { [void]$process.Kill($true) } } catch {} }
    [void]$output.Dispose()
    [void]$timeout.Dispose()
    [void]$process.Dispose()
  }
}

function Invoke-Probe([Net.Http.HttpClient]$Client, [hashtable]$Spec, [Uri]$BaseUri, [string]$PublicOrigin, [string]$BasicToken) {
  $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($Spec.Method), [Uri]::new($BaseUri, $Spec.Path))
  $response = $null
  try {
    $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Basic', $BasicToken)
    if ($Spec.Origin -eq 'valid') { [void]$request.Headers.TryAddWithoutValidation('Origin', $PublicOrigin) }
    if ($Spec.Origin -eq 'invalid') { [void]$request.Headers.TryAddWithoutValidation('Origin', 'https://example.invalid') }
    if ($null -ne $Spec.Csrf) { [void]$request.Headers.TryAddWithoutValidation('X-OMW-CSRF', $Spec.Csrf) }
    if ($Spec.Method -eq 'POST') { $request.Content = [Net.Http.StringContent]::new('{}', [Text.Encoding]::UTF8, 'application/json') }

    # 完整回應一起受 HttpClient 的 deadline 與 buffer 上限約束，避免 headers 已回但 body 永遠不結束。
    $response = $Client.SendAsync($request).GetAwaiter().GetResult()
    $observedCode = $null
    if ($null -ne $Spec.Code) {
      try {
        $candidate = ($response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json).error.code
        if (@('MUTATION_ORIGIN_REJECTED', 'UNTRUSTED_ORIGIN', 'REQUEST_INVALID', 'LAUNCHER_AUTH_REQUIRED') -ccontains $candidate) {
          $observedCode = $candidate
        }
      }
      catch {}
    }
    return @{ Status = [int]$response.StatusCode; Code = $observedCode }
  }
  finally {
    if ($null -ne $response) { [void]$response.Dispose() }
    [void]$request.Dispose()
  }
}

function Write-ProbeResult([hashtable]$Spec, [hashtable]$Actual) {
  $passed = $Actual.Status -eq $Spec.Status -and ($null -eq $Spec.Code -or $Actual.Code -ceq $Spec.Code)
  [void][Console]::WriteLine('{0} actualHTTP={1} expectedHTTP={2} {3}', $Spec.Name, $Actual.Status, $Spec.Status, $(if ($passed) { 'PASS' } else { 'FAIL' }))
  return $passed
}

$securePassword = $null
$bstr = [IntPtr]::Zero
$plainPassword = $null
$basicBytes = $null
$basicToken = $null
$handler = $null
$client = $null
$stage = 'TAILSCALE'
try {
  $dnsName = Get-TailscaleSelfDnsName
  $stage = 'TARGET_URI'
  $publicOrigin = "https://${dnsName}:$PublicPort"
  $publicUri = $null
  if (-not [Uri]::TryCreate("$publicOrigin/", [UriKind]::Absolute, [ref]$publicUri) -or
    $publicUri.Scheme -cne 'https' -or $publicUri.Host -cne $dnsName -or $publicUri.Port -ne $PublicPort) {
    throw 'TARGET_URI_INVALID'
  }
  $targets = @{
    public = $publicUri
    loopback = [Uri]::new("http://127.0.0.1:$ExpectedLoopbackPort/")
  }
  if ($Preflight) {
    [void][Console]::WriteLine('PREFLIGHT stage=TARGET_URI code=NONE')
    exit 0
  }

  $stage = 'CREDENTIAL_INPUT'
  $username = Read-Host 'Username [omw]'
  if ([string]::IsNullOrWhiteSpace($username)) { $username = 'omw' }
  if ($username.Contains(':')) { throw 'USERNAME_INVALID' }
  $securePassword = Read-Host 'Password' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $basicBytes = [Text.Encoding]::UTF8.GetBytes("${username}:$plainPassword")
  $basicToken = [Convert]::ToBase64String($basicBytes)

  $stage = 'HTTP_CLIENT_SETUP'
  $handler = [Net.Http.HttpClientHandler]::new()
  $handler.UseProxy = $false
  $handler.UseCookies = $false
  $handler.UseDefaultCredentials = $false
  $handler.AllowAutoRedirect = $false
  $client = [Net.Http.HttpClient]::new($handler, $false)
  $client.Timeout = [TimeSpan]::FromSeconds(8)
  $client.MaxResponseContentBufferSize = 64KB

  $stage = 'HTTP_PROBES'
  $allPassed = $true
  foreach ($probe in $probes) {
    $actual = Invoke-Probe $client $probe $targets[$probe.Target] $publicOrigin $basicToken
    $passed = Write-ProbeResult $probe $actual
    $allPassed = $allPassed -and $passed
    if ($probe.Baseline -and -not $passed) { throw 'BASELINE_FAILED' }
  }
  if (-not $allPassed) { exit 1 }
  exit 0
}
catch {
  $safeCodes = @('TS_NOT_FOUND', 'TS_START_FAILED', 'TS_OUTPUT_LIMIT', 'TS_COMMAND_FAILED', 'TS_NOT_ONLINE', 'TS_DNS_INVALID', 'TS_TIMEOUT', 'TARGET_URI_INVALID', 'USERNAME_INVALID', 'BASELINE_FAILED')
  if ($safeCodes -ccontains $_.Exception.Message) {
    $code = $_.Exception.Message
  }
  else {
    $code = switch -CaseSensitive ($stage) {
      'TAILSCALE' { 'TS_PREFLIGHT_FAILED' }
      'TARGET_URI' { 'TARGET_URI_INVALID' }
      'CREDENTIAL_INPUT' { 'CREDENTIAL_INPUT_FAILED' }
      'HTTP_CLIENT_SETUP' { 'HTTP_CLIENT_SETUP_FAILED' }
      'HTTP_PROBES' { 'HTTP_PROBE_FAILED' }
      default { 'SECURITY_PROBE_FAILED' }
    }
  }
  [void][Console]::Error.WriteLine("ERROR stage=$stage code=$code")
  exit 1
}
finally {
  if ($null -ne $client) { [void]$client.Dispose() }
  if ($null -ne $handler) { [void]$handler.Dispose() }
  if ($null -ne $basicBytes) { [void][Array]::Clear($basicBytes, 0, $basicBytes.Length) }
  if ($bstr -ne [IntPtr]::Zero) { [void][Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  if ($null -ne $securePassword) { [void]$securePassword.Dispose() }
  $plainPassword = $null
  $basicToken = $null
}
