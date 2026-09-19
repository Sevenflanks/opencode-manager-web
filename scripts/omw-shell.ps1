& {
  $omwShellPath = [IO.Path]::GetFullPath($PSCommandPath)
  $omwLauncherPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\packages\launcher\dist\src\cli.js'))
  $omwExistingCommands = @(Get-Command omw -All -ErrorAction SilentlyContinue)

  $omwOwnedByThisScript = $omwExistingCommands.Count -eq 1 `
    -and $omwExistingCommands[0].CommandType -eq 'Function' `
    -and $omwExistingCommands[0].ScriptBlock.File `
    -and [string]::Equals(
      [IO.Path]::GetFullPath($omwExistingCommands[0].ScriptBlock.File),
      $omwShellPath,
      [StringComparison]::OrdinalIgnoreCase
    )

  if ($omwExistingCommands.Count -gt 0 -and -not $omwOwnedByThisScript) {
    $existing = $omwExistingCommands[0]
    throw "Cannot define omw: an existing $($existing.CommandType) binding named 'omw' is not owned by '$omwShellPath'."
  }
  if (-not (Test-Path -LiteralPath $omwLauncherPath -PathType Leaf)) {
    throw "Cannot define omw: compiled launcher not found at '$omwLauncherPath'. Run npm run build first."
  }
  if (-not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1)) {
    throw 'Cannot define omw: node executable was not found. Install Node.js 24+ or make node available before dot-sourcing.'
  }

}

function omw {
  $launcher = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\packages\launcher\dist\src\cli.js'))
  if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "Cannot run omw: compiled launcher not found at '$launcher'. Run npm run build first."
  }
  $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $node) {
    throw 'Cannot run omw: node executable was not found.'
  }

  & $node.Path $launcher @args
  $omwExitCode = $LASTEXITCODE
  Set-Variable -Name LASTEXITCODE -Value $omwExitCode -Scope 1
}
