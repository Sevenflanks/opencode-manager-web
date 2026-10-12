// Synthetic IdP distilled from scripts/k8s/fixtures/oidc.mjs; no real SSO.
// Exact edge routes may grow; Pomerium policy/config and callback stay frozen.
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { randomBytes, generateKeyPairSync, sign, createHash } from 'node:crypto'
const cfg = JSON.parse(readFileSync('/run/proof/fixture.json'))
const issuer = 'https://idp.example.test', callback = 'https://auth.example.test/oauth2/callback'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', use: 'sig', alg: 'RS256' }
const codes = new Map(), tokens = new Map()
const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)) }
const jwt = claims => { const body = [{ alg: 'RS256', kid: 'fixture' }, claims].map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.'); return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}` }
const allowed = host => JSON.parse(readFileSync('/run/proof/routes.json')).includes(host)
async function request(req, res) {
  const url = new URL(req.url, issuer)
  if (req.headers.host === 'idp.example.test') {
    if (url.pathname === '/__fixture/request' && req.method === 'POST') {
      if (req.headers.authorization !== `Bearer ${cfg.control}`) return json(res, {}, 401)
      let input = ''; for await (const chunk of req) { input += chunk; if (input.length > 32768) return json(res, {}, 413) }
      const m = JSON.parse(input), targets = JSON.parse(readFileSync('/run/proof/targets.json'))
      const target = targets[m.target]
      if (!target || ![4174, 4175, 4180].includes(m.port ?? 4174) || typeof m.pathname !== 'string' || !m.pathname.startsWith('/')) return json(res, {}, 400)
      const headers = { host: m.host ?? 'coordinator.example.test', ...(m.auth === false ? {} : { authorization: m.port === 4175 ? `Bearer ${target.control}` : `Basic ${Buffer.from(`${target.username}:${target.password}`).toString('base64')}` }), ...(m.origin ? { origin: m.origin } : {}), ...(m.headers ?? {}) }
      const bytes = m.body === undefined ? undefined : Buffer.from(JSON.stringify(m.body))
      if (bytes) { headers['content-type'] = 'application/json'; headers['content-length'] = bytes.length }
      const result = await new Promise((resolve, reject) => {
        const outgoing = http.request({ host: target.address, port: m.port ?? 4174, path: m.pathname, method: m.method ?? 'GET', headers, signal: AbortSignal.timeout(10000) }, response => {
          let data = ''; response.on('data', chunk => { data += chunk; if (data.length > 1000000) outgoing.destroy() }); response.on('end', () => { let body; try { body = JSON.parse(data) } catch { body = null } resolve({ status: response.statusCode, body }) }); response.on('error', reject)
        }); outgoing.on('error', reject); outgoing.end(bytes)
      })
      return json(res, result)
    }
    if (url.pathname === '/.well-known/openid-configuration') return json(res, { issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks', userinfo_endpoint: issuer + '/userinfo', response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'], scopes_supported: ['openid', 'profile', 'email', 'groups'], code_challenge_methods_supported: ['S256'] })
    if (url.pathname === '/jwks') return json(res, { keys: [jwk] })
    if (url.pathname === '/userinfo') return json(res, tokens.get(req.headers.authorization?.replace(/^Bearer /, '')) ?? {}, tokens.has(req.headers.authorization?.replace(/^Bearer /, '')) ? 200 : 401)
    if (url.pathname === '/authorize' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>Synthetic IdP</title><form method="post"><button name="user" value="admin">admin</button><button name="user" value="guest">guest</button></form>') }
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 16384) return json(res, {}, 413) }
    const form = new URLSearchParams(body)
    if (url.pathname === '/authorize') {
      const user = form.get('user'), p = url.searchParams
      if (!['admin', 'guest'].includes(user) || p.get('client_id') !== 'omw' || p.get('redirect_uri') !== callback || p.get('response_type') !== 'code') return json(res, {}, 400)
      const code = randomBytes(24).toString('hex'); codes.set(code, { user, nonce: p.get('nonce'), challenge: p.get('code_challenge'), created: Date.now() })
      const target = new URL(callback); target.searchParams.set('code', code); target.searchParams.set('state', p.get('state'))
      res.writeHead(302, { location: target.href }); return res.end()
    }
    if (url.pathname === '/token') {
      const basic = Buffer.from(req.headers.authorization?.replace(/^Basic /, '') ?? '', 'base64').toString().split(':').map(x => decodeURIComponent(x.replaceAll('+', ' ')))
      const ok = (basic[0] === 'omw' && basic[1] === cfg.clientSecret) || (form.get('client_id') === 'omw' && form.get('client_secret') === cfg.clientSecret)
      const grant = codes.get(form.get('code')); codes.delete(form.get('code'))
      if (!ok || !grant || form.get('redirect_uri') !== callback || Date.now() - grant.created > 120000 || (grant.challenge && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== grant.challenge)) return json(res, {}, 400)
      const claims = { iss: issuer, sub: grant.user, aud: 'omw', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, nonce: grant.nonce, email: `${grant.user}@synthetic.invalid`, email_verified: true, groups: [grant.user] }
      const access = randomBytes(24).toString('hex'); tokens.set(access, claims)
      return json(res, { access_token: access, token_type: 'Bearer', expires_in: 3600, id_token: jwt(claims) })
    }
    return json(res, {}, 404)
  }
  if (!allowed(req.headers.host)) return json(res, {}, 404)
  const upstream = http.request({ host: 'gateway', port: 8080, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); res.on('close', () => response.destroy()) })
  upstream.setTimeout(120000, () => upstream.destroy())
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() }); req.pipe(upstream)
}
const edge = https.createServer({ key: readFileSync('/run/proof/tls.key'), cert: readFileSync('/run/proof/tls.crt') }, (req, res) => void request(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() }))
edge.on('upgrade', (req, socket, head) => {
  if (!allowed(req.headers.host)) return socket.end('HTTP/1.1 404 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  const upstream = net.connect(8080, 'gateway', () => { upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries({ ...req.headers, 'x-forwarded-proto': 'https' }).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`); upstream.write(head); socket.pipe(upstream); upstream.pipe(socket) })
  upstream.setTimeout(60000, () => upstream.destroy()); upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy())
})
edge.listen(443, '0.0.0.0')
setTimeout(() => process.exit(0), Math.max(1000, cfg.deadline - Date.now()))
