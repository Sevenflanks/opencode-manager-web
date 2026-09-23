import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

interface CommandResult {
  status: number | null
  stdout: string
  stderr: string
}

function run(command: string, args: string[], cwd?: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  })
  assert.equal(result.error, undefined)
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

function runNpm(args: string[], cwd?: string): CommandResult {
  return run(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "npm.cmd", ...args], cwd)
}

test("npm global Windows shims run through a junction prefix", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "omw-global-shim-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = path.join(root, "fixture")
  const artifacts = path.join(root, "artifacts")
  const prefix = path.join(root, "prefix")
  const prefixAlias = path.join(root, "prefix-alias")
  await Promise.all([mkdir(fixture), mkdir(artifacts)])
  await Promise.all([
    cp(fileURLToPath(new URL("../src/", import.meta.url)), path.join(fixture, "src"), { recursive: true }),
    writeFile(path.join(fixture, "package.json"), JSON.stringify({
      name: "@omw-test/global-shim",
      version: "1.0.0",
      type: "module",
      bin: { omw: "src/manager-cli.js" },
    }), "utf8"),
  ])

  const packed = runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", artifacts], fixture)
  assert.equal(packed.status, 0, packed.stderr)
  const packResults = JSON.parse(packed.stdout) as Array<{ filename: string }>
  assert.equal(packResults.length, 1)
  const filename = packResults[0]!.filename
  const installed = runNpm([
    "install", "--global", "--prefix", prefix, path.join(artifacts, filename), "--ignore-scripts", "--no-audit", "--no-fund",
  ])
  assert.equal(installed.status, 0, installed.stderr)
  await symlink(prefix, prefixAlias, "junction")

  const commands = [
    [process.env.ComSpec ?? "cmd.exe", ["/d", "/c", path.join(prefixAlias, "omw.cmd"), "__entry_check__"]],
    ["pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", path.join(prefixAlias, "omw.ps1"), "__entry_check__"]],
  ] as const
  for (const [command, args] of commands) {
    const result = run(command, [...args])
    assert.equal(result.status, 70, `${command}: stdout=${result.stdout}\nstderr=${result.stderr}`)
    assert.match(result.stderr, /omw failed: .*未知命令/)
  }

  assert.match(await readFile(path.join(prefix, "omw.cmd"), "utf8"), /manager-cli\.js/)
  assert.match(await readFile(path.join(prefix, "omw.ps1"), "utf8"), /manager-cli\.js/)
})
