// IndexedDB persistence: SRS progress, a review log for the stats view, daily
// counters for the new/review caps, and settings.

const DB_NAME = 'jlpt-n3-study';
const DB_VERSION = 1;
const LEGACY_KEY = 'jlpt3-study-state';

export const DEFAULT_SETTINGS = {
  newPerDay: 10,
  reviewsPerDay: 100,
  askReading: true,
  typeAnswers: true,
  autoAdvance: false,
  showFurigana: true,
  lessonBatchSize: 5,
  levelUpThreshold: 0.9,
};

let db = null;

function open() {
  if (db) {
    return Promise.resolve(db);
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('progress')) {
        const store = database.createObjectStore('progress', { keyPath: 'id' });
        store.createIndex('nextReviewAt', 'nextReviewAt');
        store.createIndex('level', 'level');
      }
      if (!database.objectStoreNames.contains('reviews')) {
        const store = database.createObjectStore('reviews', {
          keyPath: 'key',
          autoIncrement: true,
        });
        store.createIndex('at', 'at');
      }
      if (!database.objectStoreNames.contains('meta')) {
        database.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
}

function tx(storeName, mode, run) {
  return open().then(
    (database) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        let result;
        try {
          result = run(store);
        } catch (error) {
          reject(error);
          return;
        }
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      })
  );
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---------------------------------------------------------------- progress

export async function allProgress() {
  const database = await open();
  return new Promise((resolve, reject) => {
    const request = database
      .transaction('progress', 'readonly')
      .objectStore('progress')
      .getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export function putProgress(records) {
  const list = Array.isArray(records) ? records : [records];
  return tx('progress', 'readwrite', (store) => {
    list.forEach((record) => store.put(record));
  });
}

export function clearProgress() {
  return tx('progress', 'readwrite', (store) => store.clear());
}

// ------------------------------------------------------------- review log

export function logReviews(entries) {
  if (!entries.length) {
    return Promise.resolve();
  }
  return tx('reviews', 'readwrite', (store) => {
    entries.forEach((entry) => store.add(entry));
  });
}

export async function reviewLog(sinceMs = 0) {
  const database = await open();
  return new Promise((resolve, reject) => {
    const store = database.transaction('reviews', 'readonly').objectStore('reviews');
    const range = sinceMs ? IDBKeyRange.lowerBound(sinceMs) : undefined;
    const request = store.index('at').getAll(range);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export function clearReviewLog() {
  return tx('reviews', 'readwrite', (store) => store.clear());
}

// ------------------------------------------------------------------- meta

async function metaGet(key, fallback) {
  const database = await open();
  const store = database.transaction('meta', 'readonly').objectStore('meta');
  const record = await requestValue(store.get(key));
  return record ? record.value : fallback;
}

function metaPut(key, value) {
  return tx('meta', 'readwrite', (store) => store.put({ key, value }));
}

export async function getSettings() {
  const stored = await metaGet('settings', {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(settings, touch = true) {
  await metaPut('settings', settings);
  // Sync resolves competing settings by recency, so record when they changed.
  if (touch) {
    await metaPut('settingsUpdatedAt', Date.now());
  }
}

export function getLevel() {
  return metaGet('level', 1);
}

export function saveLevel(level) {
  return metaPut('level', level);
}

/** Per-day counters backing the "new cards / reviews per day" caps. */
export async function getDaily(dateKey) {
  const daily = await metaGet('daily', {});
  return daily[dateKey] || { newStarted: 0, reviewsDone: 0 };
}

export async function bumpDaily(dateKey, field, amount = 1) {
  const daily = await metaGet('daily', {});
  const day = daily[dateKey] || { newStarted: 0, reviewsDone: 0 };
  day[field] = (day[field] || 0) + amount;
  daily[dateKey] = day;

  // Keep a rolling year; the stats view reads history from the review log.
  const keys = Object.keys(daily).sort();
  while (keys.length > 400) {
    delete daily[keys.shift()];
  }
  await metaPut('daily', daily);
  return day;
}

export function getDailyHistory() {
  return metaGet('daily', {});
}

export async function getStreak() {
  return metaGet('streak', { count: 0, lastDate: null });
}

export function saveStreak(streak) {
  return metaPut('streak', streak);
}

// -------------------------------------------------------------- migration

/**
 * The first version of this app kept everything in one localStorage blob with
 * `mastery` percentages and `nextReview` date strings. Map what we can onto SRS
 * stages so an existing user does not restart from zero.
 */
export async function migrateLegacyState(subjectsById) {
  const migrated = await metaGet('legacyMigrated', false);
  if (migrated) {
    return 0;
  }

  let count = 0;
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      const records = [];
      const now = Date.now();

      items.forEach((item) => {
        if (!item || !item.reviewCount) {
          return;
        }
        // Old ids were kanji-001 / vocab-001; match on the Japanese text
        // instead, which is the only stable key across the rebuild.
        const subject = subjectsById.get(`k-${item.japanese}`)
          || subjectsById.get(`v-${item.japanese}-${item.reading}`);
        if (!subject) {
          return;
        }
        const mastery = Number(item.mastery) || 0;
        const stage = mastery >= 70 ? 5 : mastery >= 40 ? 3 : mastery > 0 ? 2 : 1;
        records.push({
          id: subject.id,
          type: subject.type,
          level: subject.level,
          stage,
          startedAt: now,
          nextReviewAt: now,
          lastReviewedAt: null,
          passedAt: stage >= 5 ? now : null,
          burnedAt: null,
          reviewCount: Number(item.reviewCount) || 0,
          correctCount: 0,
          incorrectCount: 0,
        });
      });

      if (records.length) {
        await putProgress(records);
        count = records.length;
      }

      if (parsed.preferences) {
        const settings = await getSettings();
        await saveSettings({
          ...settings,
          newPerDay: Number(parsed.preferences.maxNewCardsPerDay) || settings.newPerDay,
          reviewsPerDay:
            Number(parsed.preferences.maxReviewsPerDay) || settings.reviewsPerDay,
        });
      }
      if (parsed.streak) {
        await saveStreak({ count: Number(parsed.streak) || 0, lastDate: parsed.lastStudyDate || null });
      }
    }
  } catch (error) {
    console.warn('Could not migrate the old localStorage state.', error);
  }

  await metaPut('legacyMigrated', true);
  return count;
}

// --------------------------------------------------------------- sync state

export function getSyncConfig() {
  return metaGet('sync', null);
}

export function saveSyncConfig(config) {
  return metaPut('sync', config);
}

/** Everything sync cares about, in one object. */
export async function snapshot() {
  return {
    progress: await allProgress(),
    reviews: (await reviewLog()).map(({ key, ...rest }) => rest),
    daily: await getDailyHistory(),
    streak: await getStreak(),
    settings: await getSettings(),
    level: await getLevel(),
    updatedAt: await metaGet('settingsUpdatedAt', 0),
  };
}

/**
 * Replace local state with a merged snapshot. Sync has already combined both
 * sides, so this overwrites rather than merges again.
 */
export async function applySnapshot(state) {
  if (Array.isArray(state.progress)) {
    await clearProgress();
    await putProgress(state.progress);
  }
  if (Array.isArray(state.reviews)) {
    await clearReviewLog();
    await logReviews(state.reviews);
  }
  if (state.daily) {
    await metaPut('daily', state.daily);
  }
  if (state.streak) {
    await saveStreak(state.streak);
  }
  if (state.settings) {
    // Keep the original edit time, otherwise every sync would look like a
    // fresh settings change and the two devices would fight over them.
    await saveSettings({ ...DEFAULT_SETTINGS, ...state.settings }, false);
    await metaPut('settingsUpdatedAt', state.updatedAt || 0);
  }
  if (state.level) {
    await saveLevel(state.level);
  }
}

export async function exportAll() {
  return {
    version: DB_VERSION,
    exportedAt: new Date().toISOString(),
    progress: await allProgress(),
    reviews: await reviewLog(),
    settings: await getSettings(),
    level: await getLevel(),
    daily: await getDailyHistory(),
    streak: await getStreak(),
  };
}

export async function importAll(payload) {
  if (!payload || !Array.isArray(payload.progress)) {
    throw new Error('That file does not look like a study export.');
  }
  await clearProgress();
  await clearReviewLog();
  await putProgress(payload.progress);
  if (Array.isArray(payload.reviews) && payload.reviews.length) {
    await logReviews(payload.reviews.map(({ key, ...rest }) => rest));
  }
  if (payload.settings) {
    await saveSettings({ ...DEFAULT_SETTINGS, ...payload.settings });
  }
  if (payload.level) {
    await saveLevel(payload.level);
  }
  if (payload.daily) {
    await metaPut('daily', payload.daily);
  }
  if (payload.streak) {
    await saveStreak(payload.streak);
  }
}
