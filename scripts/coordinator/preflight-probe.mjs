// Separate PID namespace, shared NETWORK only. Read-only requests, bounded output.
import http from 'node:http'
import net from 'node:net'
import { readFile } from 'node:fs/promises'
const host = 'coordinator.example.test'
const control = (await readFile('/run/proof/a-control', 'utf8')).trim()
const password = (await readFile('/run/proof/a-basic', 'utf8')).trim()
const coordPassword = (await readFile('/run/proof/coordinator-basic', 'utf8')).trim()
const codes = new Set(['AUTH_REQUIRED', 'EXECUTION_DRAINING', 'EXECUTION_UNAVAILABLE', 'WORKER_CAPACITY_UNAVAILABLE', 'EXECUTION_REJECTED', 'EXECUTION_IDENTITY_INVALID', 'REQUEST_INVALID', 'EACCES', 'EPERM', 'ENOENT', 'ESRCH', 'ECONNREFUSED', 'ECONNRESET', 'ABORT_ERR', 'START_FAILED'])
const phases = new Set(['namespace-owner', 'directory', 'spawn', 'listener-owners', 'authenticated-health', 'child-exited'])
function safeBody(kind, body) {
  const result = {}
  const code = typeof body?.error === 'string' ? body.error : body?.error?.code
  if (code !== undefined) result.errorCode = codes.has(code) ? code : 'UNCLASSIFIED_ERROR_REDACTED'
  if (kind === 'execution') {
    result.epoch = typeof body?.epoch === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(body.epoch) ? body.epoch : null
    result.state = ['available', 'occupied', 'unknown'].includes(body?.capacity) ? body.capacity : null
    result.currentInstance = body?.execution === null ? null : typeof body?.execution?.instanceId === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(body.execution.instanceId) ? body.execution.instanceId : 'unavailable'
    // /v1/execution does not expose process count or port-owner diagnostics.
    result.rootProcessCount = null
    result.rootProcessCountAvailable = false
    if (body?.startupFailure) result.startupFailure = { phase: phases.has(body.startupFailure.phase) ? body.startupFailure.phase : 'REDACTED', code: codes.has(body.startupFailure.code) ? body.startupFailure.code : 'REDACTED' }
  }
  if (kind === 'capacity') {
    result.state = ['available', 'occupied', 'unknown'].includes(body?.state) ? body.state : null
    result.maxInstances = Number.isSafeInteger(body?.maxInstances) ? body.maxInstances : null
  }
  if (kind === 'health') result.payloadStatus = ['ok', 'unavailable'].includes(body?.status) ? body.status : null
  if (kind === 'manager') result.instanceStates = Array.isArray(body?.instances) ? body.instances.map(i => ['ready', 'starting', 'stopped', 'unreachable', 'failed'].includes(i.state) ? i.state : 'REDACTED') : null
  if (kind === 'coordinator') result.workers = Array.isArray(body?.workers) ? body.workers.map(w => ({ id: w.id === 'a' ? 'a' : 'REDACTED', health: ['connecting', 'online', 'unstable', 'offline'].includes(w.health) ? w.health : null, freshness: ['fresh', 'stale', 'unknown'].includes(w.freshness) ? w.freshness : null, capacity: ['available', 'occupied', 'unknown'].includes(w.capacity?.state) ? w.capacity.state : null })) : null
  return result
}
async function request(kind, port, pathname, authorization, hostname = '127.0.0.1') {
  return new Promise(resolve => {
    const req = http.request({ hostname, port, path: pathname, method: 'GET', agent: false, headers: { host, ...(authorization ? { authorization } : {}) }, signal: AbortSignal.timeout(10000) }, res => {
      let bytes = 0, text = ''
      res.on('data', chunk => { bytes += chunk.length; if (bytes > 32768) req.destroy(); else text += chunk })
      res.once('end', () => { let body; try { body = JSON.parse(text) } catch {} resolve({ method: 'GET', port, pathname, status: res.statusCode, ...safeBody(kind, body) }) })
      res.once('error', () => resolve({ method: 'GET', port, pathname, status: null, errorCode: 'RESPONSE_STREAM_FAILED' }))
    })
    req.once('error', error => resolve({ method: 'GET', port, pathname, status: null, errorCode: codes.has(error.code) ? error.code : 'TRANSPORT_ERROR_REDACTED' }))
    req.end()
  })
}
async function listening(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    const timer = setTimeout(() => { socket.destroy(); resolve({ port, listening: false, deadline: true }) }, 1000)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve({ port, listening: true }) })
    socket.once('error', () => { clearTimeout(timer); resolve({ port, listening: false }) })
  })
}
const ttl = setTimeout(() => { process.exitCode = 1; process.exit(1) }, 25000)
try {
  const execution = await request('execution', 4175, '/v1/execution', `Bearer ${control}`)
  const [capacity, manager, executionHealth, managerHealth, coordinator] = await Promise.all([
    request('capacity', 4174, '/api/v1/worker/capacity', `Basic ${Buffer.from(`worker-a:${password}`).toString('base64')}`),
    request('manager', 4174, '/api/v1/overview?view=compact', `Basic ${Buffer.from(`worker-a:${password}`).toString('base64')}`),
    request('health', 4177, '/health/ready'), request('health', 4176, '/health/ready'),
    request('coordinator', 4174, '/api/v1/coordinator/overview', `Basic ${Buffer.from(`omw-coordinator:${coordPassword}`).toString('base64')}`, 'coordinator'),
  ])
  console.log(JSON.stringify({ execution, capacity, manager, executionHealth, managerHealth, coordinator, ports: await Promise.all([4175, 4180, 4096].map(listening)) }))
} finally { clearTimeout(ttl) }
