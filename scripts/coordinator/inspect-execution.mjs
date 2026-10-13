// Own PID namespace, only the Worker's network namespace is shared.
// Never docker exec into the supervisor-owned execution PID namespace.
import { readFileSync } from 'node:fs'
const identity = JSON.parse(process.argv[2])
const token = readFileSync('/run/control', 'utf8')
const ttl = setTimeout(() => { process.exitCode = 1 }, 25000)
async function request(pathname, body) {
  const r = await fetch(`http://127.0.0.1:4175${pathname}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000), redirect: 'error' })
  const text = await r.text(); if (text.length > 4096) throw Error('BODY_LIMIT')
  return { status: r.status, body: JSON.parse(text) }
}
try {
  const inspected = await request('/v1/inspect', identity), execution = await request('/v1/execution')
  const source = inspected.body, e = execution.body
  const body = Object.fromEntries(['processState', 'running', 'matched', 'portOwnerMatched', 'portOwnedByOther', 'rootRunning', 'managedProcessCount', 'portAvailable'].filter(k => source[k] !== undefined).map(k => [k, source[k]]))
  console.log(JSON.stringify({ status: inspected.status, body, execution: { status: execution.status, body: { epoch: e.epoch, capacity: e.capacity, currentInstance: e.execution?.instanceId ?? null, currentPid: e.execution?.pid ?? null, currentDirectory: e.execution?.directory ?? null } } }))
  if (inspected.status !== 200 || execution.status !== 200) process.exitCode = 1
} catch { console.log(JSON.stringify({ errorCode: 'EXECUTION_INSPECTION_UNAVAILABLE' })); process.exitCode = 1 }
finally { clearTimeout(ttl) }
