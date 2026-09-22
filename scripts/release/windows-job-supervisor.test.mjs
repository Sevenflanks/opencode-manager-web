import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { access, mkdtemp, realpath, rm } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { PassThrough, Writable } from "node:stream"
import test from "node:test"
import { startWindowsJob } from "./windows-job-supervisor.mjs"

test("Windows Job timeout prevents an armed detached descendant from starting later", {
  skip: process.platform !== "win32" && "Windows Job Objects are Windows-only",
}, async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "omw-job-supervisor-"))
  const armed = path.join(root, "descendant-armed")
  const port = await availablePort()
  let job

  t.after(async () => {
    await job?.close()
    await rm(root, { recursive: true, force: true })
  })

  const descendant = [
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    "fs.writeFileSync(process.argv[1], 'armed')",
    "setTimeout(() => net.createServer().listen(Number(process.argv[2]), '127.0.0.1'), 1600)",
    "setTimeout(() => {}, 5000)",
  ].join(";")
  const parent = [
    "const { spawn } = require('node:child_process')",
    "spawn(process.execPath, ['-e', process.argv[1], process.argv[2], process.argv[3]], { detached: true, stdio: 'ignore' }).unref()",
    "setTimeout(() => {}, 5000)",
  ].join(";")

  job = await startWindowsJob(process.execPath, ["-e", parent, descendant, armed, String(port)], {
    cwd: root,
    env: process.env,
    root: path.join(root, "supervisor"),
    timeoutMs: 1000,
  })
  const result = await job.result
  assert.equal(result.timedOut, true)
  assert.equal(result.jobEmpty, true)
  assert.equal(await job.close(), result)
  await access(armed)

  await new Promise((resolve) => setTimeout(resolve, 1_000))
  assert.equal(await portOccupied(port), false)
})

test("missing supervisor executable rejects result and close without hanging", {
  skip: process.platform !== "win32" && "Windows process spawn behavior is Windows-only",
}, async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "omw-job-spawn-failure-"))
  t.after(() => rm(root, { recursive: true, force: true }))

  const job = await startWindowsJob(process.execPath, ["--version"], {
    cwd: root,
    env: process.env,
    root: path.join(root, "supervisor"),
    timeoutMs: 1000,
    powershellPath: path.join(root, "missing-pwsh.exe"),
  })

  const resultError = await rejection(job.result)
  assert.equal(resultError.code, "ENOENT")
  const closeError = await rejectionWithin(job.close(), 1000)
  assert.equal(closeError, resultError)
})

test("timeout result is parsed after process exit before terminal classification", async (t) => {
  const fixture = protocolFixture({
    start(child) {
      child.emit("exit", 0, null)
      setImmediate(() => child.finish([{ event: "result", timedOut: true, exitCode: null, jobEmpty: true }]))
    },
  })
  const { job } = await fixtureJob(t, fixture)

  const result = await job.result
  assert.equal(result.jobEmpty, true)
  assert.equal(await job.close(), result)
})

test("normal close waits for a closed event emitted after process exit", async (t) => {
  const fixture = protocolFixture({
    start(child) {
      child.write({ event: "result", timedOut: false, exitCode: 0, jobEmpty: false })
    },
    close(child) {
      child.emit("exit", 0, null)
      setImmediate(() => child.finish([{ event: "closed", graceful: true, jobEmpty: true }]))
    },
  })
  const { job } = await fixtureJob(t, fixture)

  await job.result
  assert.deepEqual(await job.close(), { event: "closed", graceful: true, jobEmpty: true })
})

test("normal close rejects when the drained protocol has no closed event", async (t) => {
  const fixture = protocolFixture({
    start(child) {
      child.write({ event: "result", timedOut: false, exitCode: 0, jobEmpty: false })
    },
    close(child) {
      child.emit("exit", 0, null)
      setImmediate(() => child.finish([]))
    },
  })
  const { job } = await fixtureJob(t, fixture)

  await job.result
  await assert.rejects(job.close(), /closed protocol event/)
})

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

function portOccupied(port) {
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

async function rejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail("Expected promise to reject")
}

function rejectionWithin(promise, timeoutMs) {
  let deadline
  return Promise.race([
    rejection(promise).finally(() => clearTimeout(deadline)),
    new Promise((resolve) => { deadline = setTimeout(() => resolve(new Error("close remained pending")), timeoutMs) }),
  ])
}

async function fixtureJob(t, fixture) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "omw-job-protocol-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const job = await startWindowsJob(process.execPath, ["--version"], {
    cwd: root,
    env: process.env,
    root: path.join(root, "supervisor"),
    timeoutMs: 1000,
    spawnProcess: fixture,
  })
  return { job, root }
}

function protocolFixture({ start, close }) {
  return () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
      final(callback) {
        close?.(child)
        callback()
      },
    })
    child.kill = () => {
      child.finish([])
      return true
    }
    child.write = (event) => child.stdout.write(`${JSON.stringify(event)}\n`)
    child.finish = (events) => {
      for (const event of events) child.write(event)
      child.stdout.end()
      child.stderr.end()
      child.emit("close", 0, null)
    }
    setImmediate(() => start(child))
    return child
  }
}
