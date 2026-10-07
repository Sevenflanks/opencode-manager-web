import { spawn } from "node:child_process"
import path from "node:path"

export function dockerOwner({ context, project, repo, envFile, composeFile, image, selectedComposeFiles = [composeFile], contextpathOnly }) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(context) || !/^omw-verify-[a-f0-9]{16}$/.test(project) || image !== `${project}:verification`) throw new Error("驗證 ownership binding 無效。")
  const environment = { ...process.env }
  let uncertainCommands = false
  // --context 的意義不能被 host DOCKER_* 或 COMPOSE_* 環境偷偷改成遠端 target。
  for (const key of Object.keys(environment)) if (/^(DOCKER_|COMPOSE_|OMW_)/.test(key)) delete environment[key]
  // 只回填本 run 明確選取的 build input 路徑；watchdog 從同一 binding 重建，不繼承 host OMW_*。
  if (contextpathOnly) environment.OMW_WORKER_SKILLS_CONTEXT = contextpathOnly
  async function docker(args, timeout = 90_000) {
    return await new Promise((resolve, reject) => {
      const child = spawn("docker", ["--context", context, ...args], { cwd: repo, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
      let output = "", expired = false
      const collect = (data) => { output = (output + data.toString()).slice(-64_000) }
      child.stdout.on("data", collect); child.stderr.on("data", collect)
      const timer = setTimeout(() => {
        expired = true; uncertainCommands = true
        child.kill(); child.stdout.destroy(); child.stderr.destroy(); child.unref()
        // 不把 CLI timeout 假裝成 Docker engine/plugin cleanup；watchdog 保留本 run finalization。
        reject(new Error(`docker ${args[0]} deadline exceeded：${output.slice(-4000)}`))
      }, timeout)
      child.once("error", (error) => { clearTimeout(timer); reject(error) })
      child.once("close", (code) => {
        clearTimeout(timer)
        if (expired) uncertainCommands = true
        if (expired || code !== 0) reject(new Error(`docker ${args[0]} ${expired ? "deadline exceeded" : `exit ${code}`}：${output.slice(-4000)}`))
        else resolve(output.trim())
      })
    })
  }
  const composeArgs = ["compose", "--project-name", project, "--project-directory", path.dirname(composeFile), "--env-file", envFile, ...selectedComposeFiles.flatMap((filename) => ["-f", filename])]
  const compose = (args, timeout) => docker([...composeArgs, ...args], timeout)
  const owned = (kind) => docker([kind, "ls", ...(kind === "container" ? ["-a"] : []), "-q", "--filter", `label=com.docker.compose.project=${project}`])
  async function cleanup() {
    const errors = []
    try { await compose(["down", "--volumes", "--remove-orphans", "--timeout", "10"], 60_000) } catch (error) { errors.push(error.message) }
    // 專用 namespace fixture 也帶同一 current-run project label。
    try {
      const containers = (await owned("container")).split(/\s+/).filter(Boolean)
      if (containers.length) await docker(["container", "rm", "-f", ...containers], 30_000)
      for (const kind of ["network", "volume"]) {
        const resources = (await owned(kind)).split(/\s+/).filter(Boolean)
        if (resources.length) await docker([kind, "rm", ...resources], 30_000)
      }
      // 只移除本輪隨機 tag，不動 base image、其他 tags 或全域 build cache。
      const images = await docker(["image", "ls", "-q", image])
      if (images) await docker(["image", "rm", image], 30_000)
    } catch (error) { errors.push(error.message) }
    const remaining = {}
    for (const kind of ["container", "network", "volume"]) {
      try { remaining[kind] = (await owned(kind)).split(/\s+/).filter(Boolean) } catch (error) { remaining[kind] = ["query-failed"]; errors.push(error.message) }
    }
    try { remaining.image = (await docker(["image", "ls", "-q", image])).split(/\s+/).filter(Boolean) } catch { remaining.image = ["query-failed"] }
    return { status: !uncertainCommands && Object.values(remaining).every((items) => items.length === 0) ? "stopped" : "unresolved", remaining, errors,
      ...(uncertainCommands ? { uncertainCommands: true, reason: "Docker CLI deadline；engine/plugin 可能仍完成 command，保留獨立 watchdog 最後清理。" } : {}) }
  }
  return { docker, compose, cleanup }
}
