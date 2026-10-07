// Synthetic-only OIDC/edge/upstream fixture, distilled from the #102 PoC.
// Never logs headers, callback queries, tokens or keys.
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { randomBytes, generateKeyPairSync, sign, createHash } from 'node:crypto'
const cfg = JSON.parse(readFileSync('/run/proof/fixture.json'))
const issuer = 'https://idp.example.test'
const callback = 'https://auth.example.test/oauth2/callback'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', use: 'sig', alg: 'RS256' }
const cases = { admin: ['admin'], operator: ['Operator'], guest: ['guest'], missing: undefined, scalar: 'admin', object: { admin: true }, mixed: ['admin', 42], wrongcase: ['Admin'], null: null }
const codes = new Map(), tokens = new Map()
const json = (res, data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)) }
function jwt(claims) {
  const body = [{ alg: 'RS256', kid: 'fixture' }, claims].map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.')
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`
}
async function request(req, res) {
  const url = new URL(req.url, issuer)
  if (req.headers.host === 'idp.example.test') {
    if (url.pathname === '/.well-known/openid-configuration') return json(res, { issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks', userinfo_endpoint: issuer + '/userinfo', response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'], scopes_supported: ['openid', 'profile', 'email', 'groups'], code_challenge_methods_supported: ['S256'] })
    if (url.pathname === '/jwks') return json(res, { keys: [jwk] })
    if (url.pathname === '/userinfo') return json(res, tokens.get(req.headers.authorization?.replace(/^Bearer /, '')) ?? {}, tokens.has(req.headers.authorization?.replace(/^Bearer /, '')) ? 200 : 401)
    if (url.pathname === '/authorize' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>Synthetic IdP</title><form method="post">' + Object.keys(cases).map(k => `<button name="user" value="${k}">${k}</button>`).join('') + '</form>')
    }
    let body = ''; for await (const data of req) { body += data; if (body.length > 16384) return json(res, {}, 413) }
    const form = new URLSearchParams(body)
    if (url.pathname === '/authorize') {
      const user = form.get('user'), p = url.searchParams
      if (!Object.hasOwn(cases, user) || p.get('client_id') !== 'omw' || p.get('redirect_uri') !== callback || p.get('response_type') !== 'code') return json(res, {}, 400)
      const code = randomBytes(24).toString('hex'); codes.set(code, { user, nonce: p.get('nonce'), challenge: p.get('code_challenge'), created: Date.now() })
      const target = new URL(callback); target.searchParams.set('code', code); target.searchParams.set('state', p.get('state'))
      res.writeHead(302, { location: target.href }); return res.end()
    }
    if (url.pathname === '/token') {
      const basic = Buffer.from(req.headers.authorization?.replace(/^Basic /, '') ?? '', 'base64').toString().split(':').map(x => decodeURIComponent(x.replaceAll('+', ' ')))
      const clientOk = (basic[0] === 'omw' && basic[1] === cfg.clientSecret) || (form.get('client_id') === 'omw' && form.get('client_secret') === cfg.clientSecret)
      const grant = codes.get(form.get('code')); codes.delete(form.get('code'))
      if (!clientOk || !grant || form.get('redirect_uri') !== callback || Date.now() - grant.created > 120000 || (grant.challenge && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== grant.challenge)) return json(res, {}, 400)
      const claims = { iss: issuer, sub: grant.user, aud: 'omw', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, nonce: grant.nonce, email: `${grant.user}@synthetic.invalid`, email_verified: true, ...(grant.user === 'missing' ? {} : { groups: cases[grant.user] }) }
      const access = randomBytes(24).toString('hex'); tokens.set(access, claims)
      return json(res, { access_token: access, token_type: 'Bearer', expires_in: 3600, id_token: jwt(claims) })
    }
    return json(res, {}, 404)
  }
  const upstream = http.request({ host: 'gateway', port: 8080, path: req.url, method: req.method, headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); res.on('close', () => response.destroy()) })
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() }); req.pipe(upstream)
}
const edge = https.createServer({ key: readFileSync('/run/proof/tls.key'), cert: readFileSync('/run/proof/tls.crt') }, (req, res) => void request(req, res).catch(() => { res.writeHead(500); res.end() }))
edge.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(8080, 'gateway', () => { upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries({ ...req.headers, 'x-forwarded-proto': 'https' }).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`); upstream.write(head); socket.pipe(upstream); upstream.pipe(socket) })
  upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy())
})
edge.listen(443, '0.0.0.0')
for (const port of [4174, 4180]) {
  const echo = http.createServer((req, res) => {
    if (!cfg.basics.includes(req.headers.authorization)) return json(res, {}, 401)
    if (req.url === '/sse') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: ok\n\n'); const timer = setInterval(() => res.write('data: ok\n\n'), 1000); res.on('close', () => clearInterval(timer)); return }
    json(res, { basicMatches: true, host: req.headers.host, origin: req.headers.origin ?? null, identityAbsent: ['x-pomerium-jwt-assertion', 'x-forwarded-user', 'x-pomerium-claim-groups'].every(k => !req.headers[k]) })
  })
  echo.on('upgrade', (req, socket) => {
    if (!cfg.basics.includes(req.headers.authorization)) return socket.destroy()
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const timer = setInterval(() => socket.write(Buffer.from([0x81, 2, 111, 107])), 1000); socket.on('error', () => {}); socket.on('close', () => clearInterval(timer))
  })
  echo.listen(port, '0.0.0.0')
}
setTimeout(() => process.exit(0), 18 * 60000)
