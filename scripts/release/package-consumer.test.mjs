import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { startWindowsJob } from "./windows-job-supervisor.mjs"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const npmCli = process.env.npm_execpath
  ?? path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")
test("packed production consumer starts omw with its runtime contracts", {
  skip: process.platform !== "win32" && "@sevenflanks/omw supports Windows only",
}, async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "omw-package-consumer-"))
  const artifacts = path.join(root, "artifacts")
  const consumer = path.join(root, "consumer")
  const runtime = path.join(root, "runtime")
  const credentials = {
    manager: {
      username: `package-smoke-${randomBytes(8).toString("hex")}`,
      password: randomBytes(24).toString("base64url"),
    },
    launcherToken: randomBytes(32).toString("base64url"),
  }
  let launchAttempted = false
  let launchJob
  let origin = ""

  t.after(async () => {
    let cleanupError
    try {
      if (launchAttempted) await stopOwnedManager(origin, root, credentials)
    } catch (error) {
      cleanupError = error
    }
    try {
      const closed = await launchJob?.close()
      if (closed) {
        assert.equal(closed.jobEmpty, true, `retaining ${root} because the current-run Windows Job did not become empty`)
        assert.equal(closed.graceful, true, `retaining ${root} because official shutdown did not drain the current-run Windows Job`)
      }
    } catch (error) {
      cleanupError ??= error
    }
    if (cleanupError) throw cleanupError
    await rm(root, { recursive: true, force: true })
  })

  await Promise.all([mkdir(artifacts), mkdir(consumer)])
  await runChecked(process.execPath, [npmCli, "pack", "--workspace", "@sevenflanks/omw", "--pack-destination", artifacts], {
    cwd: repositoryRoot,
    ownerRoot: root,
    timeoutMs: 120_000,
  })
  const tarballs = (await readdir(artifacts)).filter((name) => name.endsWith(".tgz"))
  assert.equal(tarballs.length, 1, "npm pack should create exactly one launcher tarball")

  await writeFile(path.join(consumer, "package.json"), `${JSON.stringify({
    name: "omw-package-smoke-consumer",
    private: true,
    scripts: { smoke: "omw" },
  }, null, 2)}\n`)
  await runChecked(process.execPath, [
    npmCli,
    "install",
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    path.join(artifacts, tarballs[0]),
  ], { cwd: consumer, ownerRoot: root, timeoutMs: 120_000 })

  const isolationModule = path.join(repositoryRoot, "apps/manager/dist/src/isolation.js")
  const { prepareIsolatedEnvironment } = await import(pathToFileURL(isolationModule).href)
  const context = await prepareIsolatedEnvironment({
    mode: "test",
    root: runtime,
    sourceEnvironment: process.env,
  })
  const port = await availablePort()
  origin = `http://127.0.0.1:${port}`
  const executable = path.join(runtime, "opencode.exe")
  await writeFile(executable, windowsPeFixture())

  const packageRoot = path.join(consumer, "node_modules", "@sevenflanks", "omw")
  const powershell = context.environment.OMW_POWERSHELL_EXECUTABLE ?? "pwsh.exe"
  const credentialScript = path.join(packageRoot, "dist", "scripts", "credential-store.ps1")
  const protectCommand = `$reader = [IO.StringReader]::new($env:OMW_PACKAGE_TEST_CREDENTIALS); try { [Console]::SetIn($reader); & '${credentialScript.replaceAll("'", "''")}' -Action Protect } finally { $reader.Dispose() }`
  const protectedCredentials = await runChecked(powershell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    protectCommand,
  ], {
    cwd: consumer,
    env: { ...process.env, OMW_PACKAGE_TEST_CREDENTIALS: JSON.stringify(credentials) },
    ownerRoot: root,
    timeoutMs: 10_000,
  })
  await writeFile(path.join(context.paths.omwData, "credentials.dpapi"), protectedCredentials.stdout, "utf8")

  launchAttempted = true
  const launchArgs = [npmCli, "run", "smoke", "--silent"]
  launchJob = await startWindowsJob(process.execPath, launchArgs, {
    cwd: consumer,
    env: {
      ...context.environment,
      OMW_DATA_DIR: context.paths.omwData,
      OMW_OPENCODE_EXECUTABLE: executable,
      OMW_PORT: String(port),
      OMW_POWERSHELL_EXECUTABLE: powershell,
      OMW_REMOTE_ACCESS: "0",
    },
    root: path.join(root, "launcher-job"),
    timeoutMs: 20_000,
  })
  const launchResult = await launchJob.result
  if (launchResult.timedOut) {
    assert.equal(launchResult.jobEmpty, true, `retaining ${root} because timed-out launcher Job was not empty`)
  }
  const launchOutput = await launchJob.output()
  const result = processResult(process.execPath, launchArgs, launchResult, launchOutput)
  assert.equal(result.code, 0, commandFailure(result))
  assert.equal(result.timedOut, false, commandFailure(result))

  const identity = await fetchIdentity(origin, credentials)
  assert.deepEqual(identity, { product: "omw-manager", protocolVersion: 1 })
})

async function stopOwnedManager(origin, root, credentials) {
  const identity = await waitForIdentity(origin, credentials, 2_000)
  if (identity === null) {
    assert.equal(
      await portOccupied(origin),
      false,
      `retaining ${root} because ${origin} remains occupied without exact OMW identity`,
    )
    return
  }
  assert.deepEqual(identity, { product: "omw-manager", protocolVersion: 1 })
  const authorization = Buffer.from(`${credentials.manager.username}:${credentials.manager.password}`).toString("base64")
  const response = await fetch(`${origin}/api/v1/manager/shutdown`, {
    method: "POST",
    headers: {
      authorization: `Basic ${authorization}`,
      origin,
      "x-omw-csrf": "1",
    },
    signal: AbortSignal.timeout(1_000),
  })
  assert.equal(response.status, 202, `retaining ${root} because owned Manager rejected its shutdown request`)
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (!await portOccupied(origin)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(`retaining ${root} because owned Manager at ${origin} did not stop`)
}

async function waitForIdentity(origin, credentials, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const identity = await fetchIdentity(origin, credentials)
    if (identity !== null) return identity
    if (!await portOccupied(origin)) return null
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return null
}

async function fetchIdentity(origin, credentials) {
  try {
    const response = await fetch(`${origin}/api/v1/launcher/identity`, {
      headers: { "x-omw-launcher-token": credentials.launcherToken },
      redirect: "error",
      signal: AbortSignal.timeout(500),
    })
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

function availablePort() {
  const server = net.createServer()
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("Failed to reserve a loopback port"))
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

function portOccupied(origin) {
  const port = Number(new URL(origin).port)
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port })
    const finish = (occupied) => {
      socket.destroy()
      resolve(occupied)
    }
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
    socket.setTimeout(500, () => finish(false))
  })
}

function windowsPeFixture() {
  const fixture = Buffer.alloc(68)
  fixture.write("MZ", 0, "ascii")
  fixture.writeUInt32LE(64, 0x3c)
  fixture.write("PE\0\0", 64, "binary")
  return fixture
}

async function runChecked(command, args, options) {
  const jobRoot = await mkdtemp(path.join(options.ownerRoot, "process-job-"))
  const job = await startWindowsJob(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    root: jobRoot,
    timeoutMs: options.timeoutMs,
  })
  let event
  let closed
  try {
    event = await job.result
  } finally {
    closed = await job.close()
  }
  if (event.timedOut) {
    assert.equal(event.jobEmpty, true, `${command} timed out without emptying its Windows Job`)
  } else {
    assert.equal(closed?.jobEmpty, true, `${command} Windows Job did not become empty`)
    assert.equal(closed.graceful, true, `${command} left a descendant that required forced cleanup`)
  }
  const result = processResult(command, args, event, await job.output())
  assert.equal(result.code, 0, commandFailure(result))
  assert.equal(result.timedOut, false, commandFailure(result))
  return result
}

function processResult(command, args, event, output) {
  return {
    command: `${command} ${args.join(" ")}`,
    code: event.exitCode,
    stdout: output.stdout,
    stderr: output.stderr,
    timedOut: event.timedOut,
  }
}

function commandFailure(result) {
  return [
    `${result.command} failed with exit code ${result.code}${result.timedOut ? " after timeout" : ""}`,
    result.stdout.trim(),
    result.stderr.trim(),
  ].filter(Boolean).join("\n")
}
