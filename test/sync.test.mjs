// Merge semantics for cross-device sync. These matter more than they look:
// a bad merge silently deletes answers and corrupts the SRS schedule.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeState } from '../js/sync.js';

const record = (id, stage, lastReviewedAt) => ({
  id, type: 'kanji', level: 1, stage, startedAt: 0, lastReviewedAt,
  nextReviewAt: lastReviewedAt + 1000, reviewCount: stage, correctCount: stage,
  incorrectCount: 0, passedAt: null, burnedAt: null,
});

const answer = (subjectId, at, kind = 'meaning') => ({
  subjectId, type: 'kanji', kind, correct: true, at, level: 1,
});

const base = (overrides = {}) => ({
  progress: [], reviews: [], daily: {}, streak: { count: 0, lastDate: null },
  settings: {}, level: 1, updatedAt: 0, ...overrides,
});

test('a missing remote leaves local untouched', () => {
  const local = base({ progress: [record('k-王', 3, 500)] });
  const merged = mergeState(local, null);
  assert.equal(merged.changed, false);
  assert.deepEqual(merged.progress, local.progress);
});

test('the more recently reviewed record wins', () => {
  const local = base({ progress: [record('k-王', 2, 100)] });
  const remote = base({ progress: [record('k-王', 5, 900)] });
  const merged = mergeState(local, remote);
  assert.equal(merged.progress[0].stage, 5, 'later review should win');
  assert.equal(merged.changed, true);
});

test('a stale remote does not roll local progress back', () => {
  const local = base({ progress: [record('k-王', 6, 900)] });
  const remote = base({ progress: [record('k-王', 2, 100)] });
  const merged = mergeState(local, remote);
  assert.equal(merged.progress[0].stage, 6, 'local is newer and must survive');
});

test('subjects only started on the other device are pulled in', () => {
  const local = base({ progress: [record('k-王', 1, 100)] });
  const remote = base({ progress: [record('k-才', 1, 100)] });
  const merged = mergeState(local, remote);
  assert.deepEqual(merged.progress.map((p) => p.id).sort(), ['k-才', 'k-王']);
});

test('review logs are unioned, never replaced', () => {
  const local = base({ reviews: [answer('k-王', 100), answer('k-王', 200)] });
  const remote = base({ reviews: [answer('k-王', 200), answer('k-才', 300)] });
  const merged = mergeState(local, remote);
  assert.equal(merged.reviews.length, 3, 'shared entry deduped, both kept');
  assert.deepEqual(merged.reviews.map((r) => r.at), [100, 200, 300]);
});

test('the same subject answered on both devices keeps both answers', () => {
  const local = base({ reviews: [answer('k-王', 100, 'meaning')] });
  const remote = base({ reviews: [answer('k-王', 100, 'reading')] });
  const merged = mergeState(local, remote);
  assert.equal(merged.reviews.length, 2, 'meaning and reading are distinct');
});

test('daily caps take the maximum so spent allowance is not refunded', () => {
  const local = base({ daily: { '2026-08-01': { newStarted: 5, reviewsDone: 20 } } });
  const remote = base({ daily: { '2026-08-01': { newStarted: 2, reviewsDone: 45 } } });
  const merged = mergeState(local, remote);
  assert.deepEqual(merged.daily['2026-08-01'], { newStarted: 5, reviewsDone: 45 });
});

test('days seen only on one device are kept', () => {
  const local = base({ daily: { '2026-08-01': { newStarted: 5, reviewsDone: 1 } } });
  const remote = base({ daily: { '2026-07-31': { newStarted: 3, reviewsDone: 2 } } });
  const merged = mergeState(local, remote);
  assert.deepEqual(Object.keys(merged.daily).sort(), ['2026-07-31', '2026-08-01']);
});

test('level takes the furthest progressed', () => {
  assert.equal(mergeState(base({ level: 3 }), base({ level: 7 })).level, 7);
  assert.equal(mergeState(base({ level: 9 }), base({ level: 2 })).level, 9);
});

test('streak follows the most recent study date', () => {
  const local = base({ streak: { count: 3, lastDate: '2026-07-30' } });
  const remote = base({ streak: { count: 8, lastDate: '2026-08-01' } });
  assert.equal(mergeState(local, remote).streak.count, 8);
  assert.equal(mergeState(remote, local).streak.count, 8, 'order must not matter');
});

test('same-day streaks take the higher count', () => {
  const local = base({ streak: { count: 3, lastDate: '2026-08-01' } });
  const remote = base({ streak: { count: 9, lastDate: '2026-08-01' } });
  assert.equal(mergeState(local, remote).streak.count, 9);
});

test('settings follow the more recent edit', () => {
  const local = base({ settings: { newPerDay: 10 }, updatedAt: 100 });
  const remote = base({ settings: { newPerDay: 25 }, updatedAt: 900 });
  assert.equal(mergeState(local, remote).settings.newPerDay, 25);
  assert.equal(mergeState(remote, local).settings.newPerDay, 25);
});

test('merging is idempotent', () => {
  const local = base({
    progress: [record('k-王', 4, 500)],
    reviews: [answer('k-王', 100)],
    daily: { '2026-08-01': { newStarted: 3, reviewsDone: 9 } },
    level: 4,
  });
  const remote = base({
    progress: [record('k-才', 2, 700)],
    reviews: [answer('k-才', 700)],
    level: 2,
  });
  const once = mergeState(local, remote);
  const twice = mergeState(once, remote);
  assert.deepEqual(twice.progress.length, once.progress.length);
  assert.deepEqual(twice.reviews, once.reviews);
  assert.equal(twice.changed, false, 'a second merge finds nothing new');
});

test('merge is symmetric for the data that matters', () => {
  const a = base({
    progress: [record('k-王', 4, 500)], reviews: [answer('k-王', 500)], level: 4,
  });
  const b = base({
    progress: [record('k-才', 6, 800)], reviews: [answer('k-才', 800)], level: 6,
  });
  const ab = mergeState(a, b);
  const ba = mergeState(b, a);
  assert.deepEqual(
    ab.progress.map((p) => [p.id, p.stage]).sort(),
    ba.progress.map((p) => [p.id, p.stage]).sort()
  );
  assert.deepEqual(ab.reviews, ba.reviews);
  assert.equal(ab.level, ba.level);
});

test('an empty device pulls the full remote history', () => {
  const fresh = base();
  const established = base({
    progress: [record('k-王', 7, 900), record('k-才', 3, 400)],
    reviews: [answer('k-王', 900), answer('k-才', 400)],
    daily: { '2026-08-01': { newStarted: 10, reviewsDone: 50 } },
    streak: { count: 12, lastDate: '2026-08-01' },
    level: 5,
  });
  const merged = mergeState(fresh, established);
  assert.equal(merged.progress.length, 2);
  assert.equal(merged.reviews.length, 2);
  assert.equal(merged.level, 5);
  assert.equal(merged.streak.count, 12);
  assert.equal(merged.changed, true);
});
