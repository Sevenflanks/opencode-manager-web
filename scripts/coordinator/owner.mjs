// Official Docker current-run IDs; no host Job helper, PID inference or global prune.
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
export const label = 'io.omw.coordinator.integration'
export function owner(binding, commands = []) {
  if (!/^omw-coord-[a-f0-9]{16}$/.test(binding.project) || binding.context !== 'desktop-linux') throw Error('INVALID_OWNER')
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^(DOCKER_|COMPOSE_|OMW_)/.test(key)) delete env[key]
  let uncertain = false
  const uncertaintyFile = path.join(path.dirname(binding.watchdogEvidence), 'uncertain-commands.json')
  async function docker(args, timeout = 30000) {
    if (Date.now() >= binding.deadline && ['create', 'start', 'build', 'restart', 'unpause'].includes(args[0])) throw Error('LAUNCH_DEADLINE')
    const record = { operation: args[0], args, started: new Date().toISOString(), timeoutMs: timeout, exit: null }
    commands.push(record)
    return new Promise((resolve, reject) => {
      const child = spawn('docker', ['--context', binding.context, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let out = '', err = '', expired = false
      child.stdout.on('data', chunk => { out = (out + chunk).slice(-1500000) })
      child.stderr.on('data', chunk => { err = (err + chunk).slice(-1500000) })
      const timer = setTimeout(async () => {
        expired = true; uncertain = true; record.outcomeUnknown = true
        // Only the CLI handle created here; engine resources are reconciled separately.
        child.kill(); child.stdout.destroy(); child.stderr.destroy(); child.unref()
        // Watchdog must not forget uncertainty merely because its own CLI calls succeed.
        try { await writeFile(uncertaintyFile, JSON.stringify({ project: binding.project, operation: args[0], at: new Date().toISOString(), outcomeUnknown: true })) } catch { record.uncertaintyPersistenceFailed = true }
        reject(Object.assign(Error('DOCKER_COMMAND_DEADLINE'), { operation: args[0], diagnostic: err }))
      }, timeout)
      child.once('error', () => { clearTimeout(timer); record.spawnFailed = true; reject(Error('DOCKER_SPAWN_FAILED')) })
      child.once('close', code => {
        clearTimeout(timer); record.exit = code; record.finished = new Date().toISOString()
        if (expired) return
        if (args[0] === 'build' && args.some(arg => arg === '--progress' || arg.startsWith('--progress='))) {
          const cached = new Set([...err.matchAll(/^#(\d+) CACHED$/gm)].map(m => m[1]))
          const runs = [...err.matchAll(/^#(\d+) \[[^\n]+\] RUN /gm)].map(m => ({ step: Number(m[1]), cached: cached.has(m[1]) }))
          record.cacheEvidence = { cachedSteps: cached.size, runSteps: runs, allRunStepsCached: runs.length > 0 && runs.every(r => r.cached) }
        }
        if (code === 0) resolve((args[0] === 'logs' ? out + err : out).trim())
        else reject(Object.assign(Error(`DOCKER_${args[0].toUpperCase()}_EXIT_${code}`), { diagnostic: err, output: out }))
      })
    })
  }
  const owned = async kind => (await docker([kind, 'ls', ...(kind === 'container' ? ['-a'] : []), '-q', '--filter', `label=${label}=${binding.project}`])).split(/\s+/).filter(Boolean)
  async function cleanup() {
    try { if (JSON.parse(await readFile(uncertaintyFile, 'utf8')).outcomeUnknown) uncertain = true } catch {}
    const errors = [], rounds = []
    // Two official-interface reconciliations; unknown CLI outcomes remain unresolved.
    for (let round = 0; round < 2; round++) {
      for (const kind of ['container', 'network', 'volume']) {
        try {
          for (const id of await owned(kind)) {
            const facts = JSON.parse(await docker([kind, 'inspect', id]))[0]
            if ((facts.Config?.Labels ?? facts.Labels)?.[label] !== binding.project) throw Error('OWNER_MISMATCH')
            await docker([kind, 'rm', ...(kind === 'container' ? ['-f'] : []), id], 30000)
          }
        } catch { errors.push(`${kind}-cleanup`) }
      }
      const remaining = {}
      for (const kind of ['container', 'network', 'volume']) {
        try { remaining[kind] = await owned(kind) } catch { remaining[kind] = ['query-failed'] }
      }
      rounds.push({ at: new Date().toISOString(), remaining })
      if (round === 0) await delay(1500)
    }
    let aliasRemoved = false
    try {
      const images = JSON.parse(await docker(['image', 'inspect', binding.image]))
      if (images[0]?.Config.Labels?.[label] !== binding.project) throw Error('IMAGE_OWNER_MISMATCH')
      await docker(['image', 'rm', binding.image]); aliasRemoved = true
    } catch { // A build that never produced the predeclared alias has nothing to remove.
      try { aliasRemoved = !(await docker(['image', 'ls', '-q', binding.image])).length } catch { errors.push('image-query') }
    }
    const remaining = rounds.at(-1).remaining
    return { status: !uncertain && !errors.length && aliasRemoved && Object.values(remaining).every(ids => !ids.length) ? 'stopped' : 'unresolved', uncertainCommands: uncertain, rounds, remaining, aliasRemoved, errors }
  }
  return { docker, owned, cleanup }
}
if (process.argv[2] === '--watchdog') {
  const binding = JSON.parse(await readFile(process.argv[3], 'utf8')), o = owner(binding)
  let finalize = false, disconnected = false
  process.on('message', message => { if (message === 'finalize') finalize = true })
  process.on('disconnect', () => { disconnected = true })
  while (!finalize && !disconnected && Date.now() < binding.watchdogDeadline) await delay(250)
  const until = disconnected ? binding.watchdogDeadline : Date.now()
  do {
    const result = await o.cleanup()
    await writeFile(binding.watchdogEvidence, JSON.stringify({ project: binding.project, independentTTL: true, result }, null, 2))
    if (Date.now() < until) await delay(1000)
  } while (Date.now() < until)
  if (process.connected) process.disconnect()
}
