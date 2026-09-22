import { spawn } from "node:child_process"
import { access, readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"

const supervisorScript = path.join(import.meta.dirname, "windows-job-supervisor.ps1")

export async function startWindowsJob(command, args, { cwd, env, root, timeoutMs, powershellPath = "pwsh.exe" }) {
  const executable = await resolveExecutable(command, cwd, env)
  await mkdir(root, { recursive: true })
  const argumentsFile = path.join(root, "arguments.json")
  const stdoutPath = path.join(root, "stdout.log")
  const stderrPath = path.join(root, "stderr.log")
  await writeFile(argumentsFile, JSON.stringify(args), "utf8")

  const supervisor = spawn(powershellPath, [
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
  let terminal = null
  supervisor.stderr.setEncoding("utf8")
  supervisor.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-64 * 1024) })

  const terminalPromise = new Promise((resolve) => {
    const finish = (outcome) => {
      if (terminal) return
      terminal = outcome
      resolve(outcome)
    }
    supervisor.once("exit", (code, signal) => {
      finish({ kind: "exit", code, signal })
    })
    supervisor.once("error", (error) => finish({ kind: "error", error }))
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
    terminalPromise.then((outcome) => {
      if (resultReceived) return
      clearTimeout(deadline)
      if (outcome.kind === "error") {
        reject(outcome.error)
        return
      }
      reject(new Error(`Windows Job supervisor exited before result (${outcome.code ?? outcome.signal}): ${stderr.trim()}`))
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
      if (!terminal) {
        if (resultReceived) supervisor.stdin.end("close\n")
        else supervisor.kill()
      }
      let completed = await boundedOutcome(terminalPromise, 10_000)
      if (!completed) {
        supervisor.kill()
        completed = await boundedOutcome(terminalPromise, 2_000)
        if (!completed) throw new Error("Windows Job supervisor emitted neither exit nor error after termination.")
      }
      if (completed.kind === "error") throw completed.error
      if (completed.code !== 0) {
        throw new Error(`Windows Job supervisor close failed (${completed.code ?? completed.signal}): ${stderr.trim()}`)
      }
      return closedEvent
    },
  }
}

function boundedOutcome(promise, timeoutMs) {
  let deadline
  return Promise.race([
    promise.finally(() => clearTimeout(deadline)),
    new Promise((resolve) => { deadline = setTimeout(() => resolve(null), timeoutMs) }),
  ])
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
