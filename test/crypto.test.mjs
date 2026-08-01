// The encryption that keeps study data unreadable to the sync server, and the
// id derivation that lets two devices find the same record without an account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

const { deriveCredentials, encrypt, decrypt } = await import('../js/sync.js');

const PASSPHRASE = 'correct horse battery staple';

test('the same passphrase derives the same id on every device', async () => {
  const a = await deriveCredentials(PASSPHRASE);
  const b = await deriveCredentials(PASSPHRASE);
  assert.equal(a.id, b.id);
  assert.match(a.id, /^[0-9a-f]{32}$/, 'must match the Worker route pattern');
});

test('a different passphrase derives a different id', async () => {
  const a = await deriveCredentials(PASSPHRASE);
  const b = await deriveCredentials(`${PASSPHRASE}!`);
  assert.notEqual(a.id, b.id);
});

test('a payload round-trips through encryption', async () => {
  const { key } = await deriveCredentials(PASSPHRASE);
  const payload = {
    progress: [{ id: 'k-王', stage: 4, nextReviewAt: 1234567890 }],
    reviews: [{ subjectId: 'k-王', kind: 'meaning', correct: true, at: 1 }],
    level: 7,
  };
  const restored = await decrypt(key, await encrypt(key, payload));
  assert.deepEqual(restored, payload);
});

test('the ciphertext does not leak what is being studied', async () => {
  const { key } = await deriveCredentials(PASSPHRASE);
  const bytes = await encrypt(key, { progress: [{ id: 'k-王', stage: 4 }] });
  const asText = Buffer.from(bytes).toString('binary');
  assert.ok(!asText.includes('progress'), 'field names must not be visible');
  assert.ok(!asText.includes('stage'), 'field names must not be visible');
});

test('encrypting twice gives different ciphertext', async () => {
  const { key } = await deriveCredentials(PASSPHRASE);
  const payload = { level: 3 };
  const first = Buffer.from(await encrypt(key, payload));
  const second = Buffer.from(await encrypt(key, payload));
  assert.notDeepEqual(first, second, 'a fresh IV must be used each time');
});

test('the wrong passphrase cannot decrypt', async () => {
  const mine = await deriveCredentials(PASSPHRASE);
  const theirs = await deriveCredentials('some other passphrase entirely');
  const bytes = await encrypt(mine.key, { level: 9 });
  await assert.rejects(() => decrypt(theirs.key, bytes));
});

test('tampered ciphertext is rejected rather than silently accepted', async () => {
  const { key } = await deriveCredentials(PASSPHRASE);
  const bytes = await encrypt(key, { level: 9 });
  bytes[bytes.length - 1] ^= 0xff;
  await assert.rejects(() => decrypt(key, bytes), 'AES-GCM must catch this');
});
