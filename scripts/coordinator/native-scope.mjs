import assert from 'node:assert/strict'

// API entry encodes the Project; the native frontend may canonicalize to its
// exact server origin. In that case Project scope comes from native metadata,
// never from a permissive pathname suffix or another Worker's server segment.
export function nativeScope(value, host, directory, sessionId, metadata) {
  const url = new URL(value), origin = `https://${host}`
  assert.equal(url.origin, origin, 'NATIVE_FOREIGN_ORIGIN')
  assert.equal(url.username + url.password, '', 'NATIVE_URL_CREDENTIALS')
  const segments = url.pathname.split('/').slice(1).map(s => decodeURIComponent(s))
  const decode = segment => {
    assert.match(segment, /^[A-Za-z0-9_-]+={0,2}$/, 'NATIVE_INVALID_BASE64')
    const bytes = Buffer.from(segment, 'base64url')
    assert.equal(bytes.toString('base64url'), segment.replace(/=+$/, ''), 'NATIVE_INVALID_BASE64')
    return bytes.toString('utf8')
  }
  let routeKind
  if (segments.length === 3 && segments[1] === 'session') {
    assert.equal(decode(segments[0]), directory, 'NATIVE_ENCODED_PROJECT_MISMATCH')
    routeKind = 'project'
  } else {
    assert.ok(segments.length === 4 && segments[0] === 'server' && segments[2] === 'session', 'NATIVE_ROUTE_SHAPE')
    assert.equal(decode(segments[1]), origin, 'NATIVE_SERVER_ORIGIN_MISMATCH')
    assert.ok(metadata, 'NATIVE_METADATA_REQUIRED')
    routeKind = 'server'
  }
  assert.equal(segments.at(-1), sessionId, 'NATIVE_WRONG_SESSION')
  if (metadata) {
    assert.equal(metadata.sessionId, sessionId, 'NATIVE_METADATA_WRONG_SESSION')
    assert.equal(metadata.directory, directory, 'NATIVE_METADATA_WRONG_PROJECT')
    assert.equal(metadata.sessionStatus, 200, 'NATIVE_METADATA_STATUS')
  }
  // Only the controlled synthetic pathname is retained, never OAuth query/hash.
  return { pathname: url.pathname, routeKind, verifiedProject: directory, verifiedSessionId: sessionId, ...(routeKind === 'server' ? { verifiedServerOrigin: origin, nativeMetadataVerified: true } : {}) }
}
