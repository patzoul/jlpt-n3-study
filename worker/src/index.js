// Sync endpoint for the JLPT N3 study app.
//
// It is deliberately dumb: it stores and returns one opaque blob per id. The
// blob is AES-GCM ciphertext produced in the browser, and the id is derived
// from the user's passphrase, so this Worker never sees a passphrase, a key or
// any study data it could read.
//
//   GET  /state/:id  -> 200 ciphertext | 404
//   PUT  /state/:id  -> 204
//
// :id must be 32 hex characters, which is what js/sync.js derives.

const ID_PATTERN = /^\/state\/([0-9a-f]{32})$/;
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const RETENTION_SECONDS = 60 * 60 * 24 * 365; // a year without a sync

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  // With no allowlist configured, accept any origin: the data is encrypted and
  // the id is unguessable, so an origin check adds little. Set ALLOWED_ORIGINS
  // to lock it to your Pages site anyway.
  const allowOrigin = allowed.length === 0
    ? (origin || '*')
    : (allowed.includes(origin) ? origin : null);

  if (allowOrigin === null) {
    return null;
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (!cors) {
      return new Response('Origin not allowed', { status: 403 });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('jlpt-n3-study sync: ok\n', {
        headers: { ...cors, 'Content-Type': 'text/plain' },
      });
    }

    const match = ID_PATTERN.exec(url.pathname);
    if (!match) {
      return new Response('Not found', { status: 404, headers: cors });
    }
    const id = match[1];

    if (request.method === 'GET') {
      const stored = await env.STATE.get(id, { type: 'arrayBuffer' });
      if (!stored) {
        return new Response('No saved state', { status: 404, headers: cors });
      }
      return new Response(stored, {
        headers: {
          ...cors,
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-store',
        },
      });
    }

    if (request.method === 'PUT') {
      const body = await request.arrayBuffer();
      if (body.byteLength === 0) {
        return new Response('Empty body', { status: 400, headers: cors });
      }
      if (body.byteLength > MAX_BODY_BYTES) {
        return new Response('Too large', { status: 413, headers: cors });
      }
      await env.STATE.put(id, body, { expirationTtl: RETENTION_SECONDS });
      return new Response(null, { status: 204, headers: cors });
    }

    return new Response('Method not allowed', { status: 405, headers: cors });
  },
};
