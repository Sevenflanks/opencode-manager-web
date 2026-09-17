param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Unprotect")]
  [string]$Action
)

$ErrorActionPreference = "Stop"

try {
  $cipherBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
  try {
    $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
      $cipherBytes,
      $null,
      [Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plainBytes))
  }
  finally {
    if ($null -ne $plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
    if ($null -ne $cipherBytes) { [Array]::Clear($cipherBytes, 0, $cipherBytes.Length) }
  }
}
catch {
  [Console]::Error.Write("Windows DPAPI operation failed.")
  exit 1
}
