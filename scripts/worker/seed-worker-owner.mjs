import { spawn } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"

// 真 auth 的 Stop 契約：僅 scoped containers/networks；所有 volumes、seed 與 image 保留。
export function seedWorkerOwner(binding) {
  if (!/^omw-seed-[a-f0-9]{16}$/.test(binding.runId) || !/^[a-zA-Z0-9_.-]+$/.test(binding.context)
    || binding.workers.some(w => ![`${binding.runId}-a`, `${binding.runId}-b`].includes(w.project))) throw new Error("INVALID_OWNER_BINDING")
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(DOCKER_|COMPOSE_|OMW_)/.test(key)) delete env[key]
  let uncertain = false, finalizing = false
  async function docker(args, milliseconds = 90_000) {
    if (!finalizing && binding.deadlineAt && Date.now() >= binding.deadlineAt) throw new Error("DOCKER_OWNER_DEADLINE")
    return new Promise((resolve, reject) => {
      const child = spawn("docker", ["--context", binding.context, ...args], { cwd: binding.repo, env,
        windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
      let stdout = ""
      child.stdout.on("data", data => { stdout = (stdout + data).slice(-2_000_000) })
      // Docker errors may contain secret paths or upstream output: never publish them.
      child.stderr.resume()
      const timer = setTimeout(() => {
        uncertain = true; child.kill(); child.stdout.destroy(); child.stderr.destroy(); child.unref()
        reject(new Error("DOCKER_DEADLINE"))
      }, milliseconds)
      child.once("error", () => { clearTimeout(timer); reject(new Error("DOCKER_LAUNCH_FAILED")) })
      child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(stdout.trim()) : reject(new Error("DOCKER_COMMAND_FAILED")) })
    })
  }
  const composeArgs = worker => ["compose", "--project-name", worker.project, "--env-file", worker.envFile,
    "-f", path.join(binding.repo, "deploy/worker/compose.yaml"), ...(worker.seedEnabled === false ? [] : ["-f", path.join(binding.repo, "deploy/worker/compose.seed.yaml")]), "-f", worker.override]
  const compose = (worker, args, timeout) => docker([...composeArgs(worker), ...args], timeout)
  const owned = kind => docker([kind, "ls", ...(kind === "container" ? ["-a"] : []), "-q", "--filter", `label=io.omw.seed.run=${binding.runId}`])
  async function cleanup() {
    finalizing = true
    const errors = []
    for (const worker of binding.workers) {
      try {
        const ids = (await docker(["container", "ls", "-a", "-q", "--filter", `label=com.docker.compose.project=${worker.project}`])).split(/\s+/).filter(Boolean)
        if (ids.length && JSON.parse(await docker(["inspect", ...ids])).some(c => c.Config.Labels["io.omw.seed.run"] !== binding.runId)) {
          errors.push("PROJECT_OWNER_MISMATCH"); continue
        }
        await compose(worker, ["down", "--timeout", "15"], 60_000)
      } catch { errors.push("COMPOSE_STOP_FAILED") }
    }
    try {
      const containers = (await owned("container")).split(/\s+/).filter(Boolean)
      if (containers.length) await docker(["container", "rm", "-f", ...containers], 30_000)
      const networks = (await owned("network")).split(/\s+/).filter(Boolean)
      if (networks.length) await docker(["network", "rm", ...networks], 30_000)
    } catch { errors.push("SCOPED_STOP_FAILED") }
    const remaining = {}
    for (const kind of ["container", "network"]) {
      try { remaining[kind] = (await owned(kind)).split(/\s+/).filter(Boolean) } catch { remaining[kind] = ["query-failed"] }
    }
    let retainedVolumes = []
    try { retainedVolumes = JSON.parse(await docker(["volume", "ls", "--format", "json", "--filter", `label=io.omw.seed.run=${binding.runId}`]).then(text => `[${text.split("\n").filter(Boolean).join(",")}]`)).map(v => v.Name) }
    catch { errors.push("VOLUME_RETENTION_QUERY_FAILED") }
    return { status: !errors.length && Object.values(remaining).every(v => !v.length) ? "stopped" : "unresolved",
      commandTimedOut: uncertain, remaining, retainedVolumes, volumesDeleted: false, errors }
  }
  return { docker, compose, cleanup }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const binding = JSON.parse(await readFile(process.argv[2], "utf8"))
  const stop = async () => {
    const cleanup = await seedWorkerOwner(binding).cleanup()
    await writeFile(binding.watchdogEvidence, JSON.stringify({ at: new Date().toISOString(), cleanup }, null, 2))
    if (process.argv.includes("--stop")) {
      console.log(JSON.stringify({ lifecycle: cleanup.status, retainedVolumeCount: cleanup.retainedVolumes.length, volumesDeleted: false }))
      if (cleanup.status !== "stopped") process.exitCode = 1
    }
  }
  if (process.argv.includes("--stop")) await stop()
  else setTimeout(stop, binding.deadlineAt ? Math.max(1, binding.deadlineAt - Date.now()) : binding.watchdogMilliseconds)
}
