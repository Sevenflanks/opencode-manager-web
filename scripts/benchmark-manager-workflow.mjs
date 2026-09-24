// #55: Manager public HTTP + controlled RuntimePort/protocol fixture; no real OpenCode process or user data.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { cpus, platform, release, tmpdir, totalmem } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { buildApp } from '../apps/manager/dist/src/app.js'
import { ManagerRepository } from '../apps/manager/dist/src/repository.js'
import { OpenCodeRuntime } from '../apps/manager/dist/src/runtime.js'
import { ManagerService } from '../apps/manager/dist/src/service.js'

const rounds = Number(process.argv[2] ?? 6)
if (!Number.isInteger(rounds) || rounds < 2 || rounds > 30) {
  throw new Error('Usage: node scripts/benchmark-manager-workflow.mjs [rounds: 2..30] (build Manager first)')
}
const authority = '127.0.0.1:4174'
const fixtureIds = ['busy-a', 'busy-b', 'idle-a', 'idle-b', 'partial', 'identity-unknown']
const requests = new Map()
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const snapshot = counters => Object.fromEntries(Object.entries(counters).map(([key, value]) => [key, value]))
const difference = (after, before) => Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - (before[key] ?? 0)]))
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', cwd: path.resolve(import.meta.dirname, '..') }).trim()

function protocol() {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const directory = url.searchParams.get('directory')
    const id = fixtureIds.find(candidate => directory?.endsWith(`${path.sep}${candidate}`))
    const key = url.pathname
    requests.set(key, (requests.get(key) ?? 0) + 1)
    response.setHeader('content-type', 'application/json')
    // A bounded, deterministic I/O delay makes concurrency and repeated reads visible.
    await pause(3)
    if (!id || id === 'identity-unknown') {
      response.statusCode = 404
      return response.end('{}')
    }
    const root = `root-${id}`
    if (key === '/session') return response.end(JSON.stringify([
      { id: root, title: `Root ${id}`, directory },
      { id: `child-${id}`, title: `Child ${id}`, parentID: root, directory },
    ]))
    if (key === `/session/${root}/children`) return response.end(JSON.stringify([
      { id: `child-${id}`, title: `Child ${id}`, parentID: root, directory },
    ]))
    if (key === '/session/status') {
      if (id === 'partial') { response.statusCode = 503; return response.end('{}') }
      return response.end(JSON.stringify(id.startsWith('busy') ? { [root]: { type: 'busy' } } : {}))
    }
    if (key === '/question' || key === '/permission') return response.end('[]')
    response.statusCode = 404
    return response.end('{}')
  })
}

function instrument(runtime, counters, timings) {
  for (const method of ['inspect', 'summary', 'sessions', 'children', 'openUrl', 'remoteUrlUnavailableReason']) {
    const original = runtime[method].bind(runtime)
    runtime[method] = (...args) => {
      counters[method] = (counters[method] ?? 0) + 1
      const start = performance.now()
      const finish = () => { (timings[method] ??= []).push(Number((performance.now() - start).toFixed(3))) }
      try {
        const result = original(...args)
        if (result && typeof result.then === 'function') return result.finally(finish)
        finish()
        return result
      } catch (error) { finish(); throw error }
    }
  }
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'omw-benchmark-55-'))
  const server = protocol()
  let app, repository
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const port = address.port
    repository = new ManagerRepository(path.join(root, 'omw.sqlite'))
    const realHttp = new OpenCodeRuntime({ executable: process.execPath, dataDirectory: root })
    const counters = {}
    const timings = {}
    instrument(realHttp, counters, timings)
    // Only the OS identity probe is fake. All summaries and Session reads use OpenCodeRuntime HTTP parsing.
    const runtime = new Proxy(realHttp, {
      get(target, name) {
        if (name === 'inspect') return async record => {
          counters.inspect = (counters.inspect ?? 0) + 1
          const start = performance.now()
          await pause(5)
          ;(timings.inspect ??= []).push(Number((performance.now() - start).toFixed(3)))
          const matched = record.id !== 'identity-unknown'
          return { processState: matched ? 'running' : 'unknown', running: matched,
            matched, portOwnerMatched: matched, portOwnedByOther: !matched }
        }
        const value = Reflect.get(target, name, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    for (const [index, id] of fixtureIds.entries()) {
      repository.createInstance({ id, kind: 'headless', projectName: id,
        projectDirectory: path.join(root, id), state: 'ready',
        endpoint: `http://127.0.0.1:${port}`, port, pid: 10_000 + index,
        creationTimeUtc: '2026-09-23T00:00:00.000Z', creationTimeTicks: String(100_000 + index),
        executable: process.execPath, launchedAt: new Date(1_700_000_000_000 + index).toISOString(),
        healthVersion: 'fixture', stoppedAt: null, error: null, stderrSummary: null })
      repository.replacePrimarySession(id, { sessionId: `root-${id}`, title: `Root ${id}`,
        source: 'manual', boundAt: '2026-09-23T00:00:00.000Z' })
    }
    const service = new ManagerService(repository, runtime, undefined, async () => {
      counters.remoteVerify = (counters.remoteVerify ?? 0) + 1
      await pause(1)
    })
    app = buildApp({ service, authority: { hostname: '127.0.0.1', port: 4174 },
      allowedOrigins: new Set([`http://${authority}`]) })
    const read = async url => {
      const reply = await app.inject({ method: 'GET', url, headers: { host: authority } })
      assert.equal(reply.statusCode, 200, `${url}: ${reply.statusCode}`)
      return reply.json()
    }
    const open = async () => {
      const reply = await app.inject({ method: 'POST', url: '/api/v1/instances/busy-a/open-url',
        headers: { host: authority, origin: `http://${authority}`, 'x-omw-csrf': '1' },
        payload: { sessionId: 'root-busy-a' } })
      assert.equal(reply.statusCode, 200, `open-url: ${reply.statusCode}`)
      assert.equal(reply.json().sessionId, 'root-busy-a')
    }
    const status = git('status', '--porcelain', '--untracked-files=all')
    console.log(JSON.stringify({ type: 'environment', head: git('rev-parse', 'HEAD'),
      branch: git('branch', '--show-current'), dirty: status.length > 0,
      dirtyEntries: status ? status.split(/\r?\n/) : [],
      platform: platform(), osRelease: release(), node: process.version,
      cpu: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length,
      totalMemoryGiB: Number((totalmem() / 2 ** 30).toFixed(1)),
      scope: 'Manager Fastify inject (public HTTP route, no network socket) + real OpenCodeRuntime loopback HTTP reads; fake OS inspect and remote verification; isolated temporary SQLite and protocol server',
      fixture: { ready: 4, unreachable: 2, active: 2, instances: 6, httpDelayMs: 3, inspectDelayMs: 5 },
      rounds }))
    for (let index = 0; index < rounds; index++) {
      const phases = {}
      const steps = {}
      const beforeRound = snapshot(counters)
      const beforeRequests = Object.fromEntries(requests)
      const timingStarts = Object.fromEntries(Object.entries(timings).map(([key, values]) => [key, values.length]))
      const started = performance.now()
      async function step(name, operation) {
        const before = snapshot(counters)
        const httpBefore = Object.fromEntries(requests)
        const start = performance.now()
        const result = await operation()
        phases[name] = Number((performance.now() - start).toFixed(3))
        steps[name] = { calls: difference(counters, before), http: difference(Object.fromEntries(requests), httpBefore) }
        return result
      }
      const all = await step('overviewAll', () => read('/api/v1/overview?q=&filter=all'))
      const active = await step('overviewActive', () => read('/api/v1/overview?q=&filter=active'))
      const unreachable = await step('overviewUnreachable', () => read('/api/v1/overview?q=&filter=unreachable'))
      const roots = await step('sessionRoots', () => read('/api/v1/instances/busy-a/sessions'))
      const children = await step('sessionChildren', () => read('/api/v1/instances/busy-a/sessions/root-busy-a/children'))
      await step('openUrl', open)
      assert.equal(all.instances.length, 6)
      assert.equal(all.instances.filter(instance => instance.state === 'ready').length, 4)
      assert.equal(all.instances.filter(instance => instance.state === 'unreachable').length, 2)
      assert.equal(all.instances.filter(instance => instance.state === 'stopped').length, 0)
      assert.equal(active.instances.length, 2)
      assert.equal(unreachable.instances.length, 2)
      assert.equal(roots.roots.length, 1)
      assert.equal(children.children.length, 1)
      const http = difference(Object.fromEntries(requests), beforeRequests)
      // Assert observable behavior; do not pin baseline cost counts, so later optimizations can be measured.
      console.log(JSON.stringify({ type: 'round', index: index + 1,
        temperature: index === 0 ? 'cold' : 'warm', wallMs: Number((performance.now() - started).toFixed(3)),
        phases, counts: { ready: 4, active: active.instances.length, unreachable: unreachable.instances.length, stopped: 0 },
        calls: difference(counters, beforeRound), http,
        steps, runtimeMs: Object.fromEntries(Object.entries(timings).map(([key, values]) => [key, {
          count: values.length - (timingStarts[key] ?? 0),
          cumulativeMs: Number(values.slice(timingStarts[key] ?? 0).reduce((sum, value) => sum + value, 0).toFixed(3)),
        }])) }))
    }
  } finally {
    if (app) await app.close()
    repository?.close()
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
}

await main()
