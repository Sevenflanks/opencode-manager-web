// Separate owned PID namespace; only joins execution's network namespace.
// Bounded GET-only gate, before the first Start. No bootstrap or namespace exec.
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
const token = readFileSync('/run/control', 'utf8'), deadline = Date.now() + 20000
function get(port, pathname, authorized = false) {
  return new Promise(resolve => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', ...(authorized ? { headers: { authorization: `Bearer ${token}` } } : {}), signal: AbortSignal.timeout(3000) }, response => {
      let data = ''
      response.on('data', chunk => { data += chunk; if (data.length > 32768) request.destroy() })
      response.once('end', () => { let body; try { body = JSON.parse(data) } catch {} resolve({ status: response.statusCode, body }) })
      response.once('error', () => resolve({ status: null, errorCode: 'RESPONSE_UNAVAILABLE' }))
    })
    request.once('error', error => resolve({ status: null, errorCode: ['ECONNREFUSED', 'ECONNRESET', 'ABORT_ERR'].includes(error.code) ? error.code : 'REQUEST_UNAVAILABLE' })); request.end()
  })
}
const observations = []
while (Date.now() < deadline) {
  const [execution, health] = await Promise.all([get(4175, '/v1/execution', true), get(4177, '/health/ready')])
  const signal = { executionStatus: execution.status, executionState: ['available', 'occupied', 'unknown'].includes(execution.body?.capacity) ? execution.body.capacity : null, errorCode: execution.errorCode ?? null, epoch: /^[A-Za-z0-9_-]{1,80}$/.test(execution.body?.epoch ?? '') ? execution.body.epoch : null, healthStatus: health.status, healthPayload: ['ok', 'unavailable'].includes(health.body?.status) ? health.body.status : null }
  observations.push(signal)
  if (signal.executionStatus === 200 && signal.executionState === 'available' && signal.healthStatus === 200 && signal.healthPayload === 'ok') { console.log(JSON.stringify({ ready: true, observations })); break }
  await delay(500)
}
if (!observations.length || observations.at(-1).executionState !== 'available' || observations.at(-1).healthStatus !== 200) { console.log(JSON.stringify({ ready: false, observations })); process.exitCode = 1 }
