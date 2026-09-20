import { spawn } from "node:child_process"
import { mkdtemp, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { prepareIsolatedEnvironment } from "../apps/manager/dist/src/isolation.js"

const [, , mode, command, ...args] = process.argv
if (!command || !["development", "test", "acceptance"].includes(mode)) {
  throw new Error("Usage: isolated-entry.mjs <development|test|acceptance> <command> [...args]")
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const invocationDirectory = process.cwd()
const root = mode === "development"
  ? path.join(repositoryRoot, ".omw", "development")
  : await mkdtemp(path.join(tmpdir(), `omw-${mode}-`))
let context
try {
  context = await prepareIsolatedEnvironment({
    mode,
    root,
    sourceEnvironment: process.env,
    ...(mode === "development" && process.env.OMW_DEV_SHARED_CONFIG
      ? { sharedConfigFile: process.env.OMW_DEV_SHARED_CONFIG }
      : {}),
  })
} catch (error) {
  if (mode !== "development") process.stderr.write(`Retained failed isolation root for diagnosis: ${root}\n`)
  throw error
}

const executable = process.platform === "win32" && /^(?:npm|npx|pnpm|yarn)$/i.test(command)
  ? `${command}.cmd`
  : command
let exitCode = 1
try {
  process.stderr.write([
    `OMW isolated ${mode}: ${context.paths.root}`,
    `Manager: http://127.0.0.1:${context.environment.OMW_PORT}`,
    `Instance ports: ${context.environment.OMW_INSTANCE_PORT_MIN}-${context.environment.OMW_INSTANCE_PORT_MAX}`,
    "",
  ].join("\n"))
  const childArguments = mode === "test" ? await expandFilePatterns(args, invocationDirectory) : args

  const child = spawn(executable, childArguments, {
    cwd: invocationDirectory,
    env: context.environment,
    stdio: "inherit",
    windowsHide: true,
  })
  const forwardSignal = (signal) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  }
  const signals = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"]
  for (const signal of signals) process.once(signal, () => forwardSignal(signal))

  exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) => resolve(code ?? 1))
  })
} finally {
  if (!context.persistent) {
    // Direct child exit 無法證明 descendants 已停止；generic entry 必須保留資料供 owner 核對與診斷。
    process.stderr.write(`Retained fresh isolation root for owner-verified cleanup: ${context.paths.root}\n`)
  }
}
process.exitCode = exitCode

async function expandFilePatterns(values, cwd) {
  const expanded = []
  for (const value of values) {
    const basename = path.basename(value)
    if (!basename.includes("*") || path.dirname(value).includes("*")) {
      expanded.push(value)
      continue
    }
    const directory = path.dirname(value)
    const expression = new RegExp(`^${basename.split("*").map(escapeRegularExpression).join(".*")}$`)
    const matches = (await readdir(path.resolve(cwd, directory)))
      .filter((name) => expression.test(name))
      .sort()
      .map((name) => path.join(directory, name))
    expanded.push(...(matches.length ? matches : [value]))
  }
  return expanded
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
