param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Protect", "Unprotect")]
  [string]$Action
)

$ErrorActionPreference = "Stop"

try {
  $inputText = [Console]::In.ReadToEnd()
  if ($Action -eq "Protect") {
    $plainBytes = [Text.Encoding]::UTF8.GetBytes($inputText)
    try {
      $cipherBytes = [Security.Cryptography.ProtectedData]::Protect(
        $plainBytes,
        $null,
        [Security.Cryptography.DataProtectionScope]::CurrentUser
      )
      [Console]::Out.Write([Convert]::ToBase64String($cipherBytes))
    }
    finally {
      if ($null -ne $plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
      if ($null -ne $cipherBytes) { [Array]::Clear($cipherBytes, 0, $cipherBytes.Length) }
    }
    exit 0
  }

  $cipherBytes = [Convert]::FromBase64String($inputText.Trim())
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
