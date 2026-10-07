import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile, rm, readlink, chmod, stat, readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { initializeWorker } from "./bootstrap.mjs"
import { dockerOwner } from "./docker-owner.mjs"

const repo = fileURLToPath(new URL("../..", import.meta.url))
const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
const acpTools = ["compress", "decompress", "search_context", "acp_status", "acp_context_recap"]
const curatedSkills = ["development-test", "git-github-workflow", "git-commit-co-author", "linux-process-lifecycle", "officecli", "officecli-docx", "officecli-xlsx", "officecli-pptx"]
const allowed = ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "GH_TOKEN", "GH_CONFIG_DIR", "GIT_CONFIG_GLOBAL", "JAVA_HOME", "MAVEN_HOME", "OFFICECLI_SKIP_UPDATE", "OFFICECLI_NO_AUTO_INSTALL", "OFFICECLI_NO_AUTO_RESIDENT"]
const forbidden = ["OMW_BROWSER_PASSWORD", "OMW_BROWSER_PASSWORD_FILE", "OMW_EXECUTION_TOKEN", "OMW_EXECUTION_TOKEN_FILE", "OMW_AUTH_SEED_FILE", "OMW_GITHUB_TOKEN_FILE", "OMW_WORKER_PROFILE_SOURCE", "OMW_WORKER_DEPENDENCIES_SOURCE", "UNRELATED_FIXTURE_ENV"]

async function nativeShellSmoke(request) {
  const session = await request("/session", { title: "offline native toolchain" })
  const commands = [
    'printf "OPT_PATH="; case "$PATH" in *"/opt/omw-worker/toolchain/gh/bin"*) echo yes;; *) echo no;; esac',
    `node -e 'console.log("PROFILE_PATH="+JSON.stringify(require("fs").readFileSync("/etc/profile","utf8").split("\\n").filter(line=>/PATH=|export PATH/.test(line))))'`,
    ...["gh", "java", "javac", "mvn", "officecli", "node", "python3", "git"].map(name =>
      `location=$(command -v ${name} || true); printf "LOOKUP ${name}=%s\\n" "$location"; ${name} ${name === "java" || name === "javac" ? "-version" : "--version"}; printf "EXIT ${name}=%s\\n" "$?"`),
    'printf "JAVA_HOME="; test "$JAVA_HOME" = /opt/omw-worker/toolchain/java && echo fixed || echo wrong',
    'scratch=$(mktemp -d); printf "class NativeSmoke { public static void main(String[] args) { System.out.print(25); } }" > "$scratch/NativeSmoke.java"; javac --release 25 -d "$scratch" "$scratch/NativeSmoke.java" && java -cp "$scratch" NativeSmoke; printf "\\nCOMPILER_EXIT=%s\\n" "$?"; rm -rf "$scratch"',
    ...["java", "javac", "mvn", "gh"].map(name => `test ! -w "$(readlink -f "$(command -v ${name})")"; printf "READONLY ${name}=%s\\n" "$?"`),
    'test ! -w /usr/local/bin && test ! -w /opt/omw-worker/toolchain && test ! -w "$JAVA_HOME/bin"; printf "IMAGE_BIN_BOUNDARY=%s\\n" "$?"',
    // product helper 以 PATH 尋找 gh；只檢查公開 synthetic token 的 boolean，不輸出 credential response。
    `node -e 'const r=require("child_process").spawnSync("git",["credential","fill"],{input:"protocol=https\\nhost=github.com\\n\\n",encoding:"utf8",timeout:5000}); console.log("GIT_HELPER="+(r.status===0&&r.stdout.includes("password="+process.env.GH_TOKEN)))'`,
  ]
  // 固定版 eval 的 JSON quoting 不接受 multiline command；script 不設定 PATH，繼承原生 login shell。
  await writeFile("/workspace/native-toolchain.sh", commands.join("\n"))
  const result = await request(`/session/${session.id}/shell`, { agent: "build", model: { providerID: "openai", modelID: "gpt-6-luna-fast" },
    command: "shopt -q login_shell && echo LOGIN=yes; /bin/bash /workspace/native-toolchain.sh" })
  const tool = result.parts.find(part => part.type === "tool" && part.tool === "bash")
  assert.equal(tool?.state.status, "completed")
  const output = tool.state.output
  // Native shell 不回傳 exit code；command 自己留下 marker，避免 HTTP200 被誤當工具成功。
  console.log(`NATIVE_SHELL_OUTPUT\n${output}`)
  assert.match(output, /LOGIN=yes/)
  for (const name of ["gh", "java", "javac", "mvn", "officecli", "node", "python3", "git"]) {
    assert.match(output, new RegExp(`LOOKUP ${name}=/`), `${name} missing from native login shell`)
    assert.match(output, new RegExp(`EXIT ${name}=0\\b`), `${name} version failed`)
  }
  assert.match(output, /JAVA_HOME=fixed/)
  assert.match(output, /javac 25\./)
  assert.match(output, /Apache Maven 3\.9\.11/)
  assert.match(output, /Java version: 25\./)
  assert.match(output, /runtime: \/opt\/omw-worker\/toolchain\/java/)
  assert.match(output, /25\nCOMPILER_EXIT=0/)
  for (const name of ["java", "javac", "mvn", "gh"]) assert.match(output, new RegExp(`READONLY ${name}=0\\b`))
  assert.match(output, /IMAGE_BIN_BOUNDARY=0/)
  assert.match(output, /GIT_HELPER=true/)
  assert.equal(result.info.cost, 0)
  assert.equal(result.info.tokens.input, 0)
  assert.equal(result.info.tokens.output, 0)
  return { shell: "native-login", tools: 8, modelCalls: 0, pathOverride: false }
}

async function linuxSmoke(fixtureOnly) {
  assert.equal(process.platform, "linux")
  assert.notEqual(process.getuid(), 0)
  const { buildExecutionApp } = await import("../../apps/manager/dist/src/worker/supervisor.js")
  const scratch = await mkdtemp("/tmp/omw-profile-smoke-")
  const global = path.join(process.env.XDG_CONFIG_HOME, "opencode")
  const runtime = process.env.OMW_WORKER_PROFILE_DIR
  const ordinary = path.join(global, "opencode.json")
  const configContent = JSON.stringify({ $schema: "https://opencode.ai/config.json", username: "public-profile-fixture" })
  await mkdir(global, { recursive: true, mode: 0o755 })
  await chmod(global, 0o755)
  await writeFile(ordinary, configContent)
  const tokenFile = path.join(scratch, "synthetic-pat")
  await writeFile(tokenFile, "synthetic-public-fixture-token\n", { mode: 0o400 })
  const environment = { ...process.env, OMW_GITHUB_TOKEN_FILE: tokenFile }
  for (const name of forbidden) if (environment[name] === undefined) environment[name] = "synthetic-forbidden-fixture"
  // auth seed 不進這個測試；只能給原生 startup 空 auth，禁止模型／登入呼叫。
  delete environment.OMW_AUTH_SEED_FILE
  const initialized = await initializeWorker(environment)
  assert.equal(initialized.profile, "ready")
  assert.equal(initialized.dependencies, "ready")
  assert.equal(initialized.github, "ready")
  assert.equal(await readFile(ordinary, "utf8"), configContent)
  const before = []
  for (const directory of [runtime, global]) {
    assert.equal(await readlink(path.join(directory, "node_modules")), "/opt/omw-worker/acp/node_modules")
    for (const filename of ["package.json", "package-lock.json"]) before.push(await readFile(path.join(directory, filename), "utf8"))
  }
  assert.equal((await stat("/opt/omw-worker/acp/node_modules")).mode & 0o222, 0)
  await initializeWorker(environment)
  const instructionsFile = path.join(runtime, "AGENTS.md")
  const customizedInstructions = await readFile(instructionsFile, "utf8") + "\n<!-- public runtime customization fixture -->\n"
  await writeFile(instructionsFile, customizedInstructions)
  await initializeWorker(environment)
  assert.equal(await readFile(instructionsFile, "utf8"), customizedInstructions)
  const inventory = JSON.parse(await readFile("/opt/omw-worker/acp/dependencies.json", "utf8"))
  assert.equal(inventory["node_modules/opencode-acp"].version, "1.18.3")
  for (const artifact of ["acp.mjs", "tiktoken_bg.wasm", "metafile.json", "source/build.mjs", "source/package-lock.json",
    "source/opencode-acp-f0502e7eee3430ffb1532d303c4c0b26f6d74494.tar.gz"]) assert.ok((await stat(`/opt/omw-worker/acp/${artifact}`)).size > 0)
  assert.ok((await readdir("/opt/omw-worker/acp/licenses/node_modules_opencode-acp")).some(name => /^LICENSE/i.test(name)))
  const helper = await readFile(environment.GIT_CONFIG_GLOBAL, "utf8")
  assert.match(helper, /gh auth git-credential/)
  assert.ok(!helper.includes(environment.GH_TOKEN))
  assert.equal(environment.GH_CONFIG_DIR, path.join(runtime, "gh"))
  for (const name of forbidden) if (environment[name] === undefined) environment[name] = "synthetic-forbidden-fixture"
  const controlToken = "synthetic-profile-control-32-characters"
  const nativeOrigin = "http://127.0.0.1:41966"
  let app, identity
  const deadline = setTimeout(() => process.exit(124), 75_000)
  const checks = []
  try {
    let executable = "/usr/local/bin/opencode", args
    if (fixtureOnly) {
      executable = process.execPath
      const fixture = path.join(scratch, "environment.cjs")
      // 回傳存在／值相符的 boolean，永不回傳 token、密碼或 seed path。
      await writeFile(fixture, `const http=require('node:http');const {spawnSync}=require('node:child_process');
        const allowed=${JSON.stringify(allowed)}, forbidden=${JSON.stringify(forbidden)};
        const helper=spawnSync('git',['config','--global','--get-all','credential.https://github.com.helper'],{encoding:'utf8',timeout:5000});
        const expected='Basic '+Buffer.from('opencode:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
        const server=http.createServer((req,res)=>{if(req.headers.authorization!==expected){res.writeHead(401);res.end('{}');return}
          res.setHeader('content-type','application/json');
          res.end(JSON.stringify(req.url==='/global/health'?{healthy:true,version:'fixture'}:{
            allowed:Object.fromEntries(allowed.map(k=>[k,Boolean(process.env[k])])),
            forbiddenAbsent:forbidden.every(k=>process.env[k]===undefined),
            toolchainPath:process.env.PATH.includes('/opt/omw-worker/toolchain/java/bin')&&process.env.PATH.includes('/opt/omw-worker/toolchain/maven/bin')&&process.env.PATH.includes('/opt/omw-worker/toolchain/gh/bin'),
            officeFlags:['OFFICECLI_SKIP_UPDATE','OFFICECLI_NO_AUTO_INSTALL','OFFICECLI_NO_AUTO_RESIDENT'].every(k=>process.env[k]==='1'),
            scopedToken:process.env.GH_TOKEN==='synthetic-public-fixture-token',
            scopedGitHelper:helper.status===0&&helper.stdout.trim()==='!gh auth git-credential'
          }));}).listen(4096,'127.0.0.1');
        setTimeout(()=>process.exit(124),60000);process.on('SIGTERM',()=>{server.close();process.exit(0)});`)
      args = [fixture]
    }
    app = buildExecutionApp({ token: controlToken, executable, arguments: args, environment,
      runtimePort: 4096, nativeOrigin, browserUsername: "fixture", browserPassword: "synthetic-browser-fixture" })
    const origin = await app.listen({ host: "127.0.0.1", port: 0 })
    await app.nativeGateway.listen({ host: "127.0.0.1", port: 41966 })
    const control = async (pathname, body) => {
      const response = await fetch(origin + pathname, { headers: { authorization: `Bearer ${controlToken}`, "content-type": "application/json" },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(35_000) })
      assert.equal(response.status, 200, `control ${pathname}`)
      return response.json()
    }
    const info = await control("/v1/execution")
    assert.equal(info.capacity, "available", "bootstrap/build helpers 不可留在 execution namespace")
    identity = { epoch: info.epoch, instanceId: "profile-smoke" }
    await control("/v1/start", { ...identity, directory: "/workspace" })
    const get = async (pathname, body) => {
      const response = await fetch(nativeOrigin + pathname, { headers: { authorization: `Basic ${Buffer.from("fixture:synthetic-browser-fixture").toString("base64")}`, origin: nativeOrigin, "content-type": "application/json" },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(35_000) })
      assert.equal(response.status, 200, `native ${pathname}`)
      return response.json()
    }
    if (fixtureOnly) {
      const availability = await get("/fixture/environment")
      assert.deepEqual(availability.allowed, Object.fromEntries(allowed.map(name => [name, true])))
      assert.equal(availability.forbiddenAbsent, true)
      assert.equal(availability.toolchainPath, true)
      assert.equal(availability.officeFlags, true)
      assert.equal(availability.scopedToken, true)
      assert.equal(availability.scopedGitHelper, true)
      checks.push({ name: "supervisor-child-environment", availability })
    } else {
      const health = await get("/global/health")
      assert.equal(health.version, "1.18.34")
      const ids = await get("/experimental/tool/ids")
      for (const id of acpTools) assert.ok(ids.includes(id), `ACP tool missing: ${id}`)
      const config = await get("/config")
      assert.equal(config.compaction.auto, false)
      assert.equal(config.autoupdate, false)
      assert.equal(config.username, "public-profile-fixture")
      assert.ok(config.plugin.some(spec => spec === "file:///opt/omw-worker/acp/acp.mjs" || spec[0] === "file:///opt/omw-worker/acp/acp.mjs"))
      assert.ok(config.instructions.includes(`${runtime}/AGENTS.md`))
      assert.ok(config.skills.paths.includes(`${runtime}/skills`))
      const skills = await get("/skill")
      for (const name of curatedSkills) assert.ok(skills.some(skill => skill.name === name && skill.description), `skill missing: ${name}`)
      const commands = await get("/command")
      for (const name of ["task-plan", "verify", "deliver", "acp"]) assert.ok(commands.some(command => command.name === name), `command missing: ${name}`)
      checks.push({ name: "native-offline-profile", version: health.version, compactionAuto: config.compaction.auto,
        acpTools: ids.filter(id => acpTools.includes(id)), skills: skills.filter(skill => curatedSkills.includes(skill.name)).map(skill => skill.name),
        commands: commands.filter(command => ["task-plan", "verify", "deliver", "acp"].includes(command.name)).map(command => command.name),
        responseCounts: { tools: ids.length, skills: skills.length, commands: commands.length }, ordinaryConfigMerged: true })
      checks.push({ name: "native-shell-toolchain", ...await nativeShellSmoke(get) })
    }
    const after = []
    for (const directory of [runtime, global]) for (const filename of ["package.json", "package-lock.json"]) after.push(await readFile(path.join(directory, filename), "utf8"))
    assert.deepEqual(after, before, "OpenCode 不需 reify package/lock")
    assert.equal(await readFile(ordinary, "utf8"), configContent)
    assert.equal((await control("/v1/stop", identity)).stopped, true)
    identity = undefined
    assert.equal((await control("/v1/execution")).capacity, "available")
    assert.deepEqual(await readdir(environment.GH_CONFIG_DIR), [])
    checks.push({ name: "private-gh-settings-and-offline-dependencies", passed: true, configPreserved: true, manifestsUnchanged: true,
      runtimeCustomizationPreserved: true, acpVersion: "1.18.3", completeArtifact: true, restartInitialized: true, namespaceEmptyAfterStop: true })
    // 舊／不完整 profile 與不相容 ordinary dependencies 固定錯誤，不讀取宿主設定。
    const bad = path.join(scratch, "bad-profile")
    await mkdir(bad)
    await assert.rejects(initializeWorker({ HOME: scratch, OMW_WORKER_PROFILE_SOURCE: bad }), /OMW_WORKER_PROFILE_SOURCE/)
    await writeFile(path.join(global, "package.json"), JSON.stringify({ dependencies: { "synthetic-unprepared": "1.0.0" } }))
    delete environment.OMW_AUTH_SEED_FILE
    await assert.rejects(initializeWorker(environment), error => error.message.startsWith("OMW_WORKER_DEPENDENCIES_SOURCE") && !error.message.includes("synthetic-"))
    checks.push({ name: "invalid-profile-and-unprepared-user-dependencies-fail-closed", passed: true })
    console.log(JSON.stringify({ mode: fixtureOnly ? "fixture" : "native", checks }))
  } finally {
    if (identity && app) {
      const stopped = await app.inject({ method: "POST", url: "/v1/stop", headers: { authorization: `Bearer ${controlToken}` }, payload: identity })
      assert.equal(stopped.json().stopped, true)
    }
    await app?.close()
    await rm(scratch, { recursive: true, force: true })
    clearTimeout(deadline)
  }
}

async function hostVerification() {
  const context = option("--context")
  if (!context) throw new Error("必須明確指定 --context <local-docker-context>。")
  const project = `omw-verify-${randomBytes(8).toString("hex")}`
  const image = `${project}:verification`
  const runDirectory = await mkdtemp(path.join(os.tmpdir(), `${project}-profile-`))
  const evidencePath = path.join(runDirectory, "evidence.json")
  const composeFile = path.join(runDirectory, "compose.yaml")
  const envFile = path.join(runDirectory, "empty.env")
  await writeFile(envFile, "")
  await writeFile(composeFile, `services:\n  unused:\n    image: ${image}\n`)
  const binding = { context, project, repo, image, envFile, composeFile, secretDirectory: path.join(runDirectory, "unused-secrets"),
    watchdogMilliseconds: option("--image") && process.argv.includes("--shell-only") ? 3 * 60_000 : 25 * 60_000,
    watchdogEvidence: path.join(runDirectory, "watchdog-cleanup.json") }
  const owner = dockerOwner(binding)
  const evidence = { project, context, image, startedAt: new Date().toISOString(), checks: [], versions: {}, noModelCalls: true, noCredentials: true }
  let watchdog, authorized = false
  const save = () => writeFile(evidencePath, JSON.stringify(evidence, null, 2))
  const check = async (name, operation) => {
    const started = Date.now()
    try { const detail = await operation(); evidence.checks.push({ name, status: "passed", milliseconds: Date.now() - started, detail }); console.log(`PASS ${name}`) }
    catch (error) {
      const message = ["synthetic-public-fixture-token", "synthetic-profile-control-32-characters", "synthetic-browser-fixture"].reduce((text, value) => text.replaceAll(value, "[REDACTED]"), error.message)
      evidence.checks.push({ name, status: "failed", milliseconds: Date.now() - started, error: message })
      throw new Error(`驗證失敗：${name}：${message}`)
    }
    finally { await save() }
  }
  try {
    await check("explicit-local-context", async () => {
      const configuration = JSON.parse(await owner.docker(["context", "inspect", context]))[0]
      assert.match(configuration.Endpoints.docker.Host, /^(npipe|unix):\/\//)
      return { endpointKind: configuration.Endpoints.docker.Host.split(":")[0] }
    })
    authorized = true
    const bindingFile = path.join(runDirectory, "ownership.json")
    await writeFile(bindingFile, JSON.stringify(binding))
    watchdog = spawn(process.execPath, [fileURLToPath(new URL("./watchdog.mjs", import.meta.url)), bindingFile], { detached: true, stdio: "ignore", windowsHide: true })
    await new Promise((resolve, reject) => { watchdog.once("spawn", resolve); watchdog.once("error", reject) })
    evidence.lifecycle = { applicable: true, platform: "Windows", selected_tier: "external-launcher", owner_binding: { kind: "official-interface-current-run", project, image },
      final_disposition: { requested: "Stop", status: "planned" }, os_inspection_performed: false, lifecycle_shell_calls: [], downstream_result: null,
      watchdog: { deadlineMilliseconds: binding.watchdogMilliseconds, evidencePath: binding.watchdogEvidence } }
    const reuse = option("--image")
    if (reuse) {
      await check("reuse-fixed-image", async () => {
        const id = await owner.docker(["image", "inspect", reuse, "--format", "{{.Id}}"])
        assert.match(id, /^sha256:[a-f0-9]{64}$/)
        await owner.docker(["image", "tag", id, image])
        return { imageId: id }
      })
    } else {
      await check("build-full-current-worker-image", async () => {
        const args = ["build", "--target", "worker", "-f", "deploy/worker/Dockerfile", "-t", image]
        const cache = option("--cache-from")
        if (cache) args.push("--cache-from", cache)
        const output = await owner.docker([...args, "."], 20 * 60_000)
        await writeFile(path.join(runDirectory, "build.log"), output)
        return { command: `docker --context ${context} ${[...args, "."].join(" ")}`, logPath: path.join(runDirectory, "build.log") }
      })
    }
    evidence.versions.imageId = await owner.docker(["image", "inspect", image, "--format", "{{.Id}}"])
    const run = (name, args, timeout = 100_000) => owner.docker(["run", "--rm", "--init", "--network", "none", "--name", `${project}-${name}`,
      "--label", `com.docker.compose.project=${project}`, "--entrypoint", "/usr/bin/timeout", image, "--signal=TERM", "--kill-after=5s", "90s", "node", ...args], timeout)
    if (!process.argv.includes("--shell-only")) await check("linux-bootstrap-20-zero-skips", async () => {
      const output = await run("bootstrap", ["--test", "scripts/worker/bootstrap.test.mjs"])
      await writeFile(path.join(runDirectory, "bootstrap.log"), output)
      assert.match(output, /(?:#|ℹ) pass 20\b/)
      assert.match(output, /(?:#|ℹ) fail 0\b/)
      assert.match(output, /(?:#|ℹ) skipped 0\b/)
      return { passed: 20, failed: 0, skipped: 0 }
    })
    for (const mode of process.argv.includes("--shell-only") ? ["native"] : ["fixture", "native"]) await check(`${mode}-profile-no-network`, async () => {
      // supervisor 必須直接為 tini child，不能用 timeout/shell 當 namespace owner。
      const output = await owner.docker(["run", "--rm", "--init", "--network", "none", "--name", `${project}-${mode}`,
        "--label", `com.docker.compose.project=${project}`, "--mount", `type=bind,source=${path.join(repo, "scripts/worker/verify-profile.mjs")},target=/opt/omw/scripts/worker/verify-profile.mjs,readonly`,
        "--entrypoint", "node", image, "scripts/worker/verify-profile.mjs", `--${mode}`], 100_000)
      await writeFile(path.join(runDirectory, `${mode}.log`), output)
      const json = output.split("\n").findLast(line => line.startsWith('{"mode"'))
      assert.ok(json, "profile evidence missing")
      return JSON.parse(json)
    })
    await check("toolchain-command-collision-fail-closed", async () => {
      const output = await owner.docker(["run", "--rm", "--init", "--network", "none", "--user", "0", "--name", `${project}-collision`,
        "--label", `com.docker.compose.project=${project}`, "--entrypoint", "/usr/bin/timeout", image, "--signal=TERM", "--kill-after=5s", "30s",
        "node", "--test", "scripts/worker/toolchain-command-collision.test.mjs"], 45_000)
      await writeFile(path.join(runDirectory, "collision.log"), output)
      assert.match(output, /COLLISION_CASES=10/)
      return { cases: 10, existingCommandsPreserved: true }
    })
    if (!process.argv.includes("--shell-only")) await check("toolchain-bounded-version-smoke", async () => {
      const output = await run("toolchain", ["scripts/worker/toolchain-smoke.mjs"])
      return JSON.parse(output)
    })
    evidence.completedAt = new Date().toISOString()
  } finally {
    if (authorized) {
      evidence.cleanup = await owner.cleanup()
      if (evidence.cleanup.status === "stopped" && watchdog) watchdog.kill()
      if (evidence.lifecycle) {
        evidence.lifecycle.final_disposition.status = evidence.cleanup.status
        evidence.lifecycle.lifecycle_result = { status: evidence.cleanup.status }
        evidence.lifecycle.downstream_result = { passed: evidence.checks.every(check => check.status === "passed") }
        evidence.lifecycle.minimum_outcomes = Object.fromEntries(["ownership_binding", "stdio", "readiness", "observation", "disposition", "cleanup_or_handoff", "lifecycle_callback"].map(name => [name, "owner handled"]))
      }
    }
    await save()
    console.log(`Evidence: ${evidencePath}`)
    if (evidence.cleanup?.status !== "stopped") throw new Error("Current-run cleanup 未確認；請依 ownership.json reconcile。")
  }
}

try {
  if (process.argv.includes("--native") || process.argv.includes("--fixture")) await linuxSmoke(process.argv.includes("--fixture"))
  else await hostVerification()
} catch (error) { console.error(error.message); process.exitCode = 1 }
