// Read-only, local OS probe benchmark. It never connects to or stops any Instance.
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const [baseline, candidate] = process.argv.slice(2)
if (!baseline) throw new Error('Usage: node scripts/benchmark-overview-inspect.mjs <baseline.ps1> [candidate.ps1]')
const db = new DatabaseSync(join(process.env.OMW_DATA_DIR ?? join(process.env.LOCALAPPDATA, 'OMW'), 'omw.sqlite'), { readOnly: true })
let instances, visible
try {
  instances = db.prepare(`SELECT pid, creation_time_ticks AS ticks, executable, port FROM managed_instances
    WHERE tracking_hidden = 0 AND state <> 'stopped' AND pid IS NOT NULL
    ORDER BY launched_at DESC, id`).all()
  visible = db.prepare(`SELECT id, kind, project_name, project_directory, state, endpoint, port, pid,
    creation_time_utc, creation_time_ticks, executable, launched_at, health_version, stopped_at,
    error FROM managed_instances WHERE tracking_hidden = 0 ORDER BY launched_at DESC, id`).all()
} finally {
  db.close()
}
if (instances.length === 0) throw new Error('No active candidates in read-only snapshot')

function inspect(helper, instance) {
  const start = performance.now()
  return new Promise((resolveResult, reject) => {
    const child = spawn('pwsh.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', resolve(helper), '-Action', 'Inspect',
      '-ProcessId', String(instance.pid), '-ExpectedCreationTicks', instance.ticks,
      '-ExpectedExecutable', instance.executable, '-Port', String(instance.port),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let errorBytes = 0
    const timeout = setTimeout(() => child.kill(), 12_000)
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 32768) child.kill() })
    child.stderr.on('data', chunk => { errorBytes += chunk.length; if (errorBytes > 32768) child.kill() })
    child.once('error', reject)
    child.once('close', code => {
      clearTimeout(timeout)
      if (code !== 0 || errorBytes) return reject(new Error('Inspect helper failed'))
      try { resolveResult({ ms: Math.round(performance.now() - start), result: JSON.parse(output) }) }
      catch { reject(new Error('Inspect helper returned invalid JSON')) }
    })
  })
}

const { ManagerRepository } = await import('../apps/manager/dist/src/repository.js')
const { ManagerService } = await import('../apps/manager/dist/src/service.js')
const repository = new ManagerRepository(':memory:')
for (const row of visible) repository.createInstance({
  id: row.id, kind: row.kind, projectName: row.project_name, projectDirectory: row.project_directory,
  state: row.state, endpoint: row.endpoint, port: row.port, pid: row.pid,
  creationTimeUtc: row.creation_time_utc, creationTimeTicks: row.creation_time_ticks,
  executable: row.executable, launchedAt: row.launched_at, healthVersion: row.health_version,
  stoppedAt: row.stopped_at, error: row.error, stderrSummary: null, trackingHidden: false,
})

async function round(helper) {
  const phases = { inspectMs: [], summaryMs: [], remoteMs: [] }
  const runtime = {
    inspect: async record => {
      const probe = await inspect(helper, record)
      phases.inspectMs.push(probe.ms)
      return probe.result
    },
    // Reproducible read-only fixture: never send HTTP to a real Instance.
    summary: async () => {
      const start = performance.now()
      const result = { activity: 'none-reported', busySessions: 0, retrySessions: 0,
        pendingQuestions: 0, pendingPermissions: 0, error: null, sessions: [] }
      phases.summaryMs.push(Math.round(performance.now() - start))
      return result
    },
    remoteUrlUnavailableReason: () => null,
  }
  const verifyRemoteUrl = async () => {
    const start = performance.now()
    phases.remoteMs.push(Math.round(performance.now() - start))
  }
  const service = new ManagerService(repository, runtime, undefined, verifyRemoteUrl)
  const start = performance.now()
  const overview = await service.overview()
  return { wallMs: Math.round(performance.now() - start), phases,
    returned: overview.instances.length,
    matched: overview.instances.filter(item => item.stopAllowed).length,
    unreachable: overview.instances.filter(item => item.state === 'unreachable').length }
}

console.log(JSON.stringify({ visible: visible.length, active: instances.length, helper: candidate ? 'paired' : 'baseline', platform: process.platform,
  scope: 'real Windows inspect + in-memory overview; synthetic summary/remote probes, no Instance HTTP' }))
for (let index = 0; index < 6; index++) {
  const first = await round(index % 2 && candidate ? candidate : baseline)
  const second = candidate ? await round(index % 2 ? baseline : candidate) : null
  const before = index % 2 && candidate ? second : first
  const after = index % 2 && candidate ? first : second
  if (after && (before.returned !== after.returned || before.matched !== after.matched || before.unreachable !== after.unreachable)) {
    throw new Error(`Inspect result mismatch at round ${index + 1}`)
  }
  const summarize = value => value && ({ wallMs: value.wallMs,
    inspectMs: value.phases.inspectMs, summaryMs: value.phases.summaryMs,
    remoteProbes: value.phases.remoteMs.length,
    remoteMaxMs: Math.max(0, ...value.phases.remoteMs),
    returned: value.returned, matched: value.matched, unreachable: value.unreachable })
  console.log(JSON.stringify({ round: index + 1, temperature: index ? 'warm' : 'cold', first: index % 2 && candidate ? 'candidate' : 'baseline', baseline: summarize(before), ...(after ? { candidate: summarize(after) } : {}) }))
}
repository.close()
