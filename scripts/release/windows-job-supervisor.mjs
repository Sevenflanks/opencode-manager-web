import { spawn } from "node:child_process"
import { access, readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"

const supervisorScript = path.join(import.meta.dirname, "windows-job-supervisor.ps1")

export async function startWindowsJob(command, args, { cwd, env, root, timeoutMs }) {
  const executable = await resolveExecutable(command, cwd, env)
  await mkdir(root, { recursive: true })
  const argumentsFile = path.join(root, "arguments.json")
  const stdoutPath = path.join(root, "stdout.log")
  const stderrPath = path.join(root, "stderr.log")
  await writeFile(argumentsFile, JSON.stringify(args), "utf8")

  const supervisor = spawn("pwsh.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File", supervisorScript,
    "-Executable", executable,
    "-ArgumentsFile", argumentsFile,
    "-WorkingDirectory", cwd,
    "-StdoutPath", stdoutPath,
    "-StderrPath", stderrPath,
    "-TimeoutMs", String(timeoutMs),
  ], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })

  let stderr = ""
  let resultReceived = false
  let closedEvent = null
  let exit = null
  supervisor.stderr.setEncoding("utf8")
  supervisor.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-64 * 1024) })

  const exitPromise = new Promise((resolve) => {
    supervisor.once("exit", (code, signal) => {
      exit = { code, signal }
      resolve(exit)
    })
  })
  const lines = readline.createInterface({ input: supervisor.stdout })
  const result = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      supervisor.kill()
      reject(new Error(`Windows Job supervisor exceeded ${timeoutMs + 15_000}ms.`))
    }, timeoutMs + 15_000)

    lines.on("line", (line) => {
      let event
      try {
        event = JSON.parse(line)
      } catch {
        clearTimeout(deadline)
        supervisor.kill()
        reject(new Error(`Windows Job supervisor returned invalid protocol output: ${line}`))
        return
      }
      if (event.event === "result") {
        clearTimeout(deadline)
        resultReceived = true
        resolve(event)
      } else if (event.event === "closed") {
        closedEvent = event
      }
    })
    supervisor.once("error", (error) => {
      clearTimeout(deadline)
      reject(error)
    })
    exitPromise.then(({ code, signal }) => {
      if (resultReceived) return
      clearTimeout(deadline)
      reject(new Error(`Windows Job supervisor exited before result (${code ?? signal}): ${stderr.trim()}`))
    })
  })

  return {
    result,
    async output() {
      return {
        stdout: await readFile(stdoutPath, "utf8").catch(() => ""),
        stderr: await readFile(stderrPath, "utf8").catch(() => ""),
      }
    },
    async close() {
      if (!exit) {
        if (resultReceived) supervisor.stdin.end("close\n")
        else supervisor.kill()
      }
      let closeDeadline
      const completed = await Promise.race([
        exitPromise.finally(() => clearTimeout(closeDeadline)),
        new Promise((resolve) => { closeDeadline = setTimeout(() => resolve(null), 10_000) }),
      ])
      if (!completed) {
        supervisor.kill()
        await exitPromise
        throw new Error("Windows Job supervisor did not close within 10000ms.")
      }
      if (completed.code !== 0) {
        throw new Error(`Windows Job supervisor close failed (${completed.code ?? completed.signal}): ${stderr.trim()}`)
      }
      return closedEvent
    },
  }
}

async function resolveExecutable(command, cwd, env) {
  if (path.isAbsolute(command)) return command
  if (command.includes("/") || command.includes("\\")) return path.resolve(cwd, command)

  const searchPath = env.PATH ?? env.Path ?? env.path ?? ""
  const extensions = path.extname(command)
    ? [""]
    : (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/g, ""), `${command}${extension}`)
      try {
        await access(candidate)
        return candidate
      } catch {
        // Continue through the current process environment's executable search path.
      }
    }
  }
  throw new Error(`Executable not found on PATH: ${command}`)
}
