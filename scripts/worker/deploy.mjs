import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, realpath, lstat, open } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createPlan, deploy, guard, reconcile, safeCode, validatePlan } from './deploy-core.mjs'

const checkout = fileURLToPath(new URL('../..', import.meta.url))
export const usage = `Worker operator CLI (Node 24)
  node scripts/worker/deploy.mjs plan --config C:/private/omw/environment.json
  node scripts/worker/deploy.mjs plan --config C:/private/omw/environment.json --execute --out C:/private/omw/plan-001
  node scripts/worker/deploy.mjs deploy --plan C:/private/omw/plan-001/plan.json
  node scripts/worker/deploy.mjs deploy --plan C:/private/omw/plan-001/plan.json --execute --out C:/private/omw/deploy-001 --ack-discard sha256:PLAN_HASH --maintenance-window
  node scripts/worker/deploy.mjs status --journal C:/private/omw/deploy-001
預設不寫入。--out parent 必須已存在、checkout 外且由 operator 限制 ACL；run 目錄必須不存在。
build/publish 的獨立人工步驟：docs/worker-deploy.md。`

export function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === '--help') return { phase: 'help' }
  const phase = argv[0]
  guard(['plan', 'deploy', 'status'].includes(phase), 'PHASE_INVALID')
  const result = { phase }
  const values = new Set(['--config', '--plan', '--out', '--ack-discard', '--journal'])
  const flags = new Set(['--execute', '--maintenance-window'])
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i]
    guard(values.has(key) || flags.has(key), 'OPTION_INVALID')
    const name = key.slice(2)
    guard(result[name] === undefined, 'OPTION_DUPLICATE')
    if (flags.has(key)) result[name] = true
    else { guard(typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--'), 'OPTION_VALUE_REQUIRED'); result[name] = argv[++i] }
  }
  const allowed = { plan: ['config', 'execute', 'out'], deploy: ['plan', 'execute', 'out', 'ack-discard', 'maintenance-window'], status: ['journal'] }
  guard(Object.keys(result).every(k => k === 'phase' || allowed[phase].includes(k)), 'PHASE_OPTION_INVALID')
  guard(result[phase === 'plan' ? 'config' : phase === 'deploy' ? 'plan' : 'journal'], 'INPUT_REQUIRED')
  guard(!result.out || result.execute, 'OUTPUT_REQUIRES_EXECUTE')
  guard(!result.execute || result.out, 'PRIVATE_OUTPUT_REQUIRED')
  if (phase === 'deploy' && result.execute) guard(result['ack-discard'] && result['maintenance-window'], 'DISCARD_AND_MAINTENANCE_ACK_REQUIRED')
  return result
}

// foreground bounded CLI；timeout 只終止本次直接 child，不宣稱 plugin/browser descendants 或遠端 mutation 已停止。
export async function processRunner(executable, args, { timeout }) {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) if (/^(DOCKER_|COMPOSE_|OMW_)/.test(key)) delete environment[key]
  if (executable === 'npm' && process.platform === 'win32') {
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    executable = process.execPath; args = [npmCli, ...args]
  }
  return new Promise(resolve => {
    let output = '', settled = false
    const child = spawn(executable, args, { shell: false, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result) } }
    const abandon = reason => {
      child.kill(); child.stdout.destroy(); child.stderr.destroy(); child.unref()
      finish({ code: null, stdout: '', timedOut: true, producer: { rootPid: child.pid ?? null, reason, descendantExitVerified: false } })
    }
    const timer = setTimeout(() => abandon('deadline'), timeout)
    child.stdout.on('data', data => { output += data.toString(); if (Buffer.byteLength(output) > 4_000_000) abandon('output-limit') })
    // Raw stderr can contain credentials, auth headers or HTTP body; never publish or persist it.
    child.stderr.on('data', () => {})
    child.once('error', () => finish({ code: null, stdout: '', timedOut: false }))
    child.once('close', code => finish({ code, stdout: code === 0 ? output : '', timedOut: false }))
  })
}

async function readJson(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')) } catch { throw new Error('INPUT_JSON_UNREADABLE') }
}
async function durableJson(filename, value) {
  const handle = await open(filename, 'wx', 0o600)
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync() } finally { await handle.close() }
}
async function privateRun(output) {
  guard(path.isAbsolute(output), 'PRIVATE_OUTPUT_ABSOLUTE_REQUIRED')
  const parent = path.dirname(output)
  const info = await lstat(parent)
  guard(info.isDirectory() && !info.isSymbolicLink(), 'PRIVATE_PARENT_REQUIRED')
  const parentReal = await realpath(parent)
  const repoReal = await realpath(checkout)
  const relative = path.relative(repoReal, parentReal)
  guard(relative !== '' && (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)), 'OUTPUT_MUST_BE_OUTSIDE_CHECKOUT')
  guard(path.basename(output) !== '.' && path.basename(output) !== '..', 'OUTPUT_NAME_INVALID')
  await mkdir(output, { mode: 0o700 }) // exclusive run directory; never overwrite an unresolved journal.
  let sequence = 0
  return {
    savePlan: plan => durableJson(path.join(output, 'plan.json'), plan),
    checkpoint: record => durableJson(path.join(output, `${String(sequence++).padStart(4, '0')}.json`), { at: new Date().toISOString(), ...record }),
    patchFile: async (target, patch) => {
      const filename = path.join(output, `${target}-patch.json`)
      await durableJson(filename, patch)
      return filename
    },
  }
}

export async function main(argv, { runner = processRunner, print = text => console.log(text) } = {}) {
  const args = parseArgs(argv)
  if (args.phase === 'help') { print(usage); return { status: 'help' } }
  if (args.phase === 'status') {
    const plan = await readJson(path.join(args.journal, 'plan.json'))
    validatePlan(plan)
    const filenames = (await readdir(args.journal)).filter(v => /^\d{4}\.json$/.test(v)).sort()
    guard(filenames.length > 0 && filenames.length < 100, 'JOURNAL_INCOMPLETE')
    const records = []
    for (const filename of filenames) {
      const record = await readJson(path.join(args.journal, filename))
      guard(record.planDigest === plan.digest, 'JOURNAL_PLAN_MISMATCH')
      records.push({ status: record.status, target: record.target ?? null, reason: record.reason ?? null, producer: record.producer ?? null })
    }
    const result = { ...(await reconcile(plan, runner)), journal: records, completionClaimed: false }
    print(JSON.stringify(result, null, 2)); return result
  }
  if (args.phase === 'plan') {
    const config = await readJson(args.config)
    const plan = await createPlan(config, runner)
    if (args.execute) { const journal = await privateRun(args.out); await journal.savePlan(plan); await journal.checkpoint({ status: 'planned', planDigest: plan.digest }) }
    print(JSON.stringify(plan, null, 2)); return plan
  }
  const plan = await readJson(args.plan)
  validatePlan(plan)
  if (!args.execute) { const result = await deploy(plan); print(JSON.stringify(result)); return result }
  guard(args['ack-discard'] === plan.digest, 'DISCARD_ACK_MISMATCH')
  const journal = await privateRun(args.out)
  await journal.savePlan(plan)
  await journal.checkpoint({ status: 'opened', planDigest: plan.digest })
  const result = await deploy(plan, { runner, ...journal, execute: true, ackDiscard: args['ack-discard'], maintenanceWindow: true })
  print(JSON.stringify(result, null, 2)); return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({ status: 'unresolved', reason: safeCode(error), ...(error.producer ? { producer: error.producer } : {}) }))
    process.exitCode = 1
  })
}
