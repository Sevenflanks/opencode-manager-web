import { readFile } from 'node:fs/promises'
import { buildWorker, buildJobIngress, workerSecrets, list, options, outputDirectory, readPrivate } from './coordinator-resources.mjs'

async function main() {
  const o = options(process.argv.slice(2), ['--config', '--worker', '--out', '--private', '--created-job'], ['--config', '--worker', '--out'])
  const c = JSON.parse(await readFile(o['--config'], 'utf8'))
  const w = JSON.parse(await readFile(o['--worker'], 'utf8'))
  const { template, workload } = buildWorker(c, w)
  const ingress = o['--created-job'] ? buildJobIngress(c, w, JSON.parse(await readFile(o['--created-job'], 'utf8'))) : undefined
  const secrets = o['--private'] ? workerSecrets(c, w, await readPrivate(o['--private'], ['registrationSecret', 'password', 'executionToken'])) : undefined
  const write = await outputDirectory(o['--out'])
  await write('worker-pod-template.json', template)
  if (workload) await write('worker.json', workload)
  if (ingress) await write('ingress.json', ingress)
  if (secrets) await write('private-secrets.json', list(secrets))
  console.log(JSON.stringify({ workloadRendered: Boolean(workload), ingressRendered: Boolean(ingress), privateRendered: Boolean(secrets), clusterCalls: 0 }))
}
main().catch(() => { console.error('OMW_COORDINATOR_JOB_RENDER_FAILED: check worker, current Job UID, private files and fresh external output directory'); process.exitCode = 1 })
