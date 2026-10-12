import { readFile } from 'node:fs/promises'
import { build, coordinatorSecrets, list, options, outputDirectory, readPrivate } from './coordinator-resources.mjs'

async function main() {
  const o = options(process.argv.slice(2), ['--config', '--out', '--private'], ['--config', '--out'])
  const c = JSON.parse(await readFile(o['--config'], 'utf8'))
  const { items, gateway } = build(c)
  const secrets = o['--private'] ? coordinatorSecrets(c, gateway, await readPrivate(o['--private'], ['clientSecret', 'cookieSecret', 'sharedSecret', 'coordinatorPassword', 'registrationSecret'])) : undefined
  const write = await outputDirectory(o['--out'])
  await write('resources.json', list(items))
  await write('kustomization.yaml', { apiVersion: 'kustomize.config.k8s.io/v1beta1', kind: 'Kustomization', resources: ['resources.json'] })
  await write('gateway-public.json', gateway)
  await write('inventory.json', items.map(r => ({ kind: r.kind, name: r.metadata.name, namespace: r.metadata.namespace })))
  if (secrets) await write('private-secrets.json', list(secrets))
  console.log(JSON.stringify({ resources: items.length, privateRendered: Boolean(secrets), clusterCalls: 0 }))
}
main().catch(() => { console.error('OMW_COORDINATOR_RENDER_FAILED: check configuration, private files and fresh external output directory'); process.exitCode = 1 })
