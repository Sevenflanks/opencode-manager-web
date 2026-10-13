import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nativeScope } from './native-scope.mjs'

const origin = 'https://omw-job-a-code.example.test'
const projectRoute = `${origin}/L3dvcmtzcGFjZQ/session/ses_exact`
const serverRoute = `${origin}/server/aHR0cHM6Ly9vbXctam9iLWEtY29kZS5leGFtcGxlLnRlc3Q/session/ses_exact`
const metadata = { sessionStatus: 200, sessionId: 'ses_exact', directory: '/workspace' }
const scope = (url, m) => nativeScope(url, 'omw-job-a-code.example.test', '/workspace', 'ses_exact', m)
test('accepts original project entry and canonical exact-server entry with native Project metadata', () => {
  assert.equal(scope(projectRoute).routeKind, 'project')
  assert.equal(scope(serverRoute, metadata).routeKind, 'server')
  assert.equal(scope(`${serverRoute}?private=not-retained#not-retained`, metadata).pathname, '/server/aHR0cHM6Ly9vbXctam9iLWEtY29kZS5leGFtcGxlLnRlc3Q/session/ses_exact')
})
test('rejects a foreign outer origin and foreign encoded server origin', () => {
  assert.throws(() => scope(projectRoute.replace('job-a-', 'job-b-')), /NATIVE_FOREIGN_ORIGIN/)
  assert.throws(() => scope(`${origin}/server/aHR0cHM6Ly9mb3JlaWduLmV4YW1wbGUudGVzdA/session/ses_exact`, metadata), /NATIVE_SERVER_ORIGIN_MISMATCH/)
})
test('rejects wrong Session route or metadata, wrong Project, and missing canonical metadata', () => {
  assert.throws(() => scope(projectRoute.replace('ses_exact', 'ses_other')), /NATIVE_WRONG_SESSION/)
  assert.throws(() => scope(serverRoute, { ...metadata, sessionId: 'ses_other' }), /NATIVE_METADATA_WRONG_SESSION/)
  assert.throws(() => scope(serverRoute, { ...metadata, directory: '/workspace/other' }), /NATIVE_METADATA_WRONG_PROJECT/)
  assert.throws(() => scope(`${origin}/L290aGVy/session/ses_exact`), /NATIVE_ENCODED_PROJECT_MISMATCH/)
  assert.throws(() => scope(serverRoute), /NATIVE_METADATA_REQUIRED/)
  assert.throws(() => scope(serverRoute, { ...metadata, sessionStatus: 404 }), /NATIVE_METADATA_STATUS/)
})
test('rejects arbitrary prefixes, trailing segments and URL credentials', () => {
  assert.throws(() => scope(`${origin}/arbitrary/L3dvcmtzcGFjZQ/session/ses_exact`), /NATIVE_ROUTE_SHAPE/)
  assert.throws(() => scope(`${projectRoute}/`), /NATIVE_ROUTE_SHAPE/)
  assert.throws(() => scope(projectRoute.replace('https://', 'https://user:pass@')), /NATIVE_URL_CREDENTIALS/)
})
