// The sync Worker's HTTP contract, exercised against an in-memory KV stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/src/index.js';

function makeEnv(vars = {}) {
  const store = new Map();
  return {
    STATE: {
      async get(key, options) {
        const value = store.get(key);
        if (!value) return null;
        return options?.type === 'arrayBuffer' ? value : Buffer.from(value).toString();
      },
      async put(key, value) {
        store.set(key, value);
      },
    },
    ...vars,
    _store: store,
  };
}

const ID = 'a'.repeat(32);
const url = (path) => `https://sync.example${path}`;
const body = () => new Uint8Array([1, 2, 3, 4, 5]);

test('health check responds', async () => {
  const res = await worker.fetch(new Request(url('/health')), makeEnv());
  assert.equal(res.status, 200);
});

test('an unknown record returns 404 rather than an empty body', async () => {
  const res = await worker.fetch(new Request(url(`/state/${ID}`)), makeEnv());
  assert.equal(res.status, 404);
});

test('a stored blob round-trips byte for byte', async () => {
  const env = makeEnv();
  const put = await worker.fetch(
    new Request(url(`/state/${ID}`), { method: 'PUT', body: body() }), env
  );
  assert.equal(put.status, 204);

  const get = await worker.fetch(new Request(url(`/state/${ID}`)), env);
  assert.equal(get.status, 200);
  assert.deepEqual(new Uint8Array(await get.arrayBuffer()), body());
});

test('records are namespaced by id', async () => {
  const env = makeEnv();
  const other = 'b'.repeat(32);
  await worker.fetch(
    new Request(url(`/state/${ID}`), { method: 'PUT', body: body() }), env
  );
  const res = await worker.fetch(new Request(url(`/state/${other}`)), env);
  assert.equal(res.status, 404, 'another id must not see my data');
});

test('malformed ids are rejected', async () => {
  const env = makeEnv();
  for (const bad of ['/state/short', '/state/' + 'z'.repeat(32), '/state/', '/nope']) {
    const res = await worker.fetch(new Request(url(bad)), env);
    assert.equal(res.status, 404, `${bad} should not route`);
  }
});

test('an empty put is refused', async () => {
  const res = await worker.fetch(
    new Request(url(`/state/${ID}`), { method: 'PUT', body: new Uint8Array() }),
    makeEnv()
  );
  assert.equal(res.status, 400);
});

test('unsupported methods are refused', async () => {
  const res = await worker.fetch(
    new Request(url(`/state/${ID}`), { method: 'DELETE' }), makeEnv()
  );
  assert.equal(res.status, 405);
});

test('preflight succeeds and advertises the methods used', async () => {
  const res = await worker.fetch(
    new Request(url(`/state/${ID}`), {
      method: 'OPTIONS',
      headers: { Origin: 'https://patzoul.github.io' },
    }),
    makeEnv()
  );
  assert.equal(res.status, 204);
  const allow = res.headers.get('Access-Control-Allow-Methods');
  assert.ok(allow.includes('GET') && allow.includes('PUT'));
});

test('an origin allowlist keeps other sites out', async () => {
  const env = makeEnv({ ALLOWED_ORIGINS: 'https://patzoul.github.io' });

  const mine = await worker.fetch(
    new Request(url(`/state/${ID}`), {
      headers: { Origin: 'https://patzoul.github.io' },
    }),
    env
  );
  assert.equal(mine.status, 404, 'allowed origin routes normally');
  assert.equal(
    mine.headers.get('Access-Control-Allow-Origin'), 'https://patzoul.github.io'
  );

  const theirs = await worker.fetch(
    new Request(url(`/state/${ID}`), { headers: { Origin: 'https://evil.example' } }),
    env
  );
  assert.equal(theirs.status, 403);
});

test('responses are not cached by intermediaries', async () => {
  const env = makeEnv();
  await worker.fetch(
    new Request(url(`/state/${ID}`), { method: 'PUT', body: body() }), env
  );
  const res = await worker.fetch(new Request(url(`/state/${ID}`)), env);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});
