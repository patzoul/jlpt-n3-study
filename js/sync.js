// Cross-device sync.
//
// Progress is encrypted in the browser with a key derived from your passphrase,
// so the server stores an opaque blob and never sees what you are studying.
// The passphrase also derives the storage id, so two devices with the same
// passphrase find the same record without any account or login.
//
// Syncing is a MERGE, never a copy. Two devices that both studied offline have
// each seen reviews the other has not; overwriting either one would throw away
// real answers and corrupt the schedule. See mergeState.

import * as store from './store.js';

const KDF_SALT = 'jlpt-n3-study/v1';
const KDF_ITERATIONS = 150000;
const MAX_PAYLOAD_BYTES = 20 * 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let credentials = null; // { id, key }

// ------------------------------------------------------------------- crypto

export async function deriveCredentials(passphrase) {
  const material = await crypto.subtle.importKey(
    'raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode(KDF_SALT),
      iterations: KDF_ITERATIONS,
      hash: 'SHA-256',
    },
    material,
    512
  );

  const bytes = new Uint8Array(bits);
  // First half names the record, second half encrypts it. The server only ever
  // sees the id, which reveals nothing about the passphrase.
  const id = [...bytes.slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const key = await crypto.subtle.importKey(
    'raw', bytes.slice(32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
  );
  return { id, key };
}

export async function encrypt(key, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(payload))
  );
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return combined;
}

export async function decrypt(key, bytes) {
  const iv = bytes.slice(0, 12);
  const data = bytes.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return JSON.parse(decoder.decode(plaintext));
}

// -------------------------------------------------------------------- merge

/**
 * How recently a progress record was touched. Records that have never been
 * reviewed fall back to when they were started.
 */
function progressTime(record) {
  return record.lastReviewedAt || record.startedAt || 0;
}

function reviewKey(entry) {
  return `${entry.subjectId}|${entry.kind}|${entry.at}`;
}

/**
 * Combine two snapshots without losing work from either side.
 *
 * Every rule here is chosen so that a device which has been offline can never
 * erase reviews done elsewhere:
 *  - progress: the more recently reviewed record wins, so the later session's
 *    SRS stage and due date survive;
 *  - reviews: a union, because both logs are records of things that genuinely
 *    happened;
 *  - daily counters: the maximum, so caps already spent are not handed back;
 *  - level and streak: whichever is further along.
 */
export function mergeState(local, remote) {
  if (!remote) {
    return { ...local, changed: false };
  }

  const progress = new Map();
  for (const record of local.progress || []) {
    progress.set(record.id, record);
  }
  let changed = false;
  for (const record of remote.progress || []) {
    const mine = progress.get(record.id);
    if (!mine) {
      progress.set(record.id, record);
      changed = true;
    } else if (progressTime(record) > progressTime(mine)) {
      progress.set(record.id, record);
      changed = true;
    }
  }

  const reviews = new Map();
  for (const entry of local.reviews || []) {
    reviews.set(reviewKey(entry), entry);
  }
  for (const entry of remote.reviews || []) {
    const key = reviewKey(entry);
    if (!reviews.has(key)) {
      reviews.set(key, entry);
      changed = true;
    }
  }

  const daily = { ...(local.daily || {}) };
  for (const [date, counts] of Object.entries(remote.daily || {})) {
    const mine = daily[date];
    daily[date] = mine
      ? {
          newStarted: Math.max(mine.newStarted || 0, counts.newStarted || 0),
          reviewsDone: Math.max(mine.reviewsDone || 0, counts.reviewsDone || 0),
        }
      : counts;
  }

  const localStreak = local.streak || { count: 0, lastDate: null };
  const remoteStreak = remote.streak || { count: 0, lastDate: null };
  const streak =
    (remoteStreak.lastDate || '') > (localStreak.lastDate || '')
      ? remoteStreak
      : (remoteStreak.lastDate === localStreak.lastDate
          ? { ...localStreak, count: Math.max(localStreak.count, remoteStreak.count) }
          : localStreak);

  // Settings are a preference, not a record of events, so the newer edit wins.
  const settings = (remote.updatedAt || 0) > (local.updatedAt || 0)
    ? { ...local.settings, ...remote.settings }
    : local.settings;

  return {
    progress: [...progress.values()],
    reviews: [...reviews.values()].sort((a, b) => a.at - b.at),
    daily,
    streak,
    settings,
    level: Math.max(local.level || 1, remote.level || 1),
    updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0),
    changed,
  };
}

// ------------------------------------------------------------------ transport

async function request(endpoint, id, method, body) {
  const url = `${endpoint.replace(/\/$/, '')}/state/${id}`;
  const response = await fetch(url, {
    method,
    body,
    headers: body ? { 'Content-Type': 'application/octet-stream' } : undefined,
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Sync server returned ${response.status}`);
  }
  return response;
}

// --------------------------------------------------------------------- API

export async function getConfig() {
  return store.getSyncConfig();
}

export async function configure({ endpoint, passphrase }) {
  if (!endpoint || !passphrase) {
    throw new Error('Both a server address and a passphrase are required.');
  }
  if (passphrase.length < 12) {
    throw new Error(
      'Use a passphrase of at least 12 characters — it is the only thing '
      + 'protecting your data.'
    );
  }
  credentials = await deriveCredentials(passphrase);
  await store.saveSyncConfig({
    endpoint: endpoint.replace(/\/$/, ''),
    passphrase,
    lastSyncedAt: null,
  });
  return credentials.id;
}

export async function disable() {
  credentials = null;
  await store.saveSyncConfig(null);
}

async function ensureCredentials(config) {
  if (!credentials) {
    credentials = await deriveCredentials(config.passphrase);
  }
  return credentials;
}

export function isConfigured(config) {
  return Boolean(config && config.endpoint && config.passphrase);
}

/**
 * Pull, merge, save locally, push the merged result back.
 * Returns a short summary for the UI.
 */
export async function sync() {
  const config = await store.getSyncConfig();
  if (!isConfigured(config)) {
    throw new Error('Sync is not set up yet.');
  }
  const { id, key } = await ensureCredentials(config);

  const local = await store.snapshot();

  let remote = null;
  const response = await request(config.endpoint, id, 'GET');
  if (response) {
    try {
      remote = await decrypt(key, new Uint8Array(await response.arrayBuffer()));
    } catch (error) {
      throw new Error(
        'Could not decrypt the stored data. The passphrase probably differs '
        + 'from the one used on your other device.'
      );
    }
  }

  const merged = mergeState(local, remote);
  if (merged.changed) {
    await store.applySnapshot(merged);
  }

  const payload = await encrypt(key, {
    progress: merged.progress,
    reviews: merged.reviews,
    daily: merged.daily,
    streak: merged.streak,
    settings: merged.settings,
    level: merged.level,
    updatedAt: Date.now(),
  });
  if (payload.byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error('Your history is too large to sync in one request.');
  }
  await request(config.endpoint, id, 'PUT', payload);

  const syncedAt = Date.now();
  await store.saveSyncConfig({ ...config, lastSyncedAt: syncedAt });

  return {
    syncedAt,
    pulledChanges: merged.changed,
    subjects: merged.progress.length,
    reviews: merged.reviews.length,
  };
}

/** Fire-and-forget sync used after a study session; never throws. */
export async function syncQuietly() {
  try {
    const config = await store.getSyncConfig();
    if (!isConfigured(config)) {
      return null;
    }
    return await sync();
  } catch (error) {
    console.warn('Background sync failed; will retry later.', error);
    return null;
  }
}
