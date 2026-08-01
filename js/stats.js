// Progress view: what has been learned, how accurately, and what is coming.

import { allSubjects, getManifest, getSubject } from './content.js';
import { STAGE_GROUPS, GURU, BURNED, stageGroup } from './srs.js';
import { reviewLog, getDailyHistory } from './store.js';

const DAY = 86400000;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function dayKey(timestamp) {
  const date = new Date(timestamp);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export async function renderStats(root, state) {
  root.innerHTML = '<section class="card"><p class="muted">Loading your history…</p></section>';

  const [log, daily] = await Promise.all([reviewLog(), getDailyHistory()]);
  const subjects = allSubjects();
  const manifest = getManifest();

  root.innerHTML = `
    ${coverageSection(subjects, state)}
    ${activitySection(log, daily)}
    ${accuracySection(log, state)}
    ${forecastSection(state)}
    ${levelSection(subjects, state, manifest)}
    ${leechSection(log, state)}
  `;
}

// ------------------------------------------------------------------ pieces

function coverageSection(subjects, state) {
  const byType = { kanji: [], vocabulary: [], grammar: [] };
  subjects.forEach((subject) => byType[subject.type].push(subject));

  const rows = Object.entries(byType).map(([type, items]) => {
    let started = 0;
    let guru = 0;
    let burned = 0;
    items.forEach((subject) => {
      const progress = state.progress.get(subject.id);
      if (!progress) return;
      started += 1;
      if (progress.stage >= GURU) guru += 1;
      if (progress.stage >= BURNED) burned += 1;
    });
    return { type, total: items.length, started, guru, burned };
  });

  return `
  <section class="card">
    <h2>Syllabus coverage</h2>
    <table class="table">
      <thead><tr><th></th><th>Total</th><th>Started</th><th>Guru+</th><th>Burned</th><th>Progress</th></tr></thead>
      <tbody>
        ${rows.map((row) => `
          <tr>
            <td class="strong">${row.type}</td>
            <td>${row.total}</td>
            <td>${row.started}</td>
            <td>${row.guru}</td>
            <td>${row.burned}</td>
            <td class="cell-bar">
              <div class="progress-track small">
                <div class="progress-fill guru" style="width:${(row.guru / row.total) * 100}%"></div>
                <div class="progress-fill started" style="width:${(row.started / row.total) * 100}%"></div>
              </div>
              <span class="muted">${Math.round((row.started / row.total) * 100)}%</span>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
    <p class="muted">The darker bar is items at Guru or above — the point where a word is reliably stuck.</p>
  </section>`;
}

function activitySection(log, daily) {
  const days = 60;
  const today = Date.now();
  const buckets = new Map();
  for (let i = days - 1; i >= 0; i -= 1) {
    buckets.set(dayKey(today - i * DAY), { reviews: 0, correct: 0, lessons: 0 });
  }

  log.forEach((entry) => {
    const bucket = buckets.get(dayKey(entry.at));
    if (!bucket) return;
    bucket.reviews += 1;
    if (entry.correct) bucket.correct += 1;
  });
  Object.entries(daily || {}).forEach(([key, value]) => {
    const bucket = buckets.get(key);
    if (bucket) bucket.lessons = value.newStarted || 0;
  });

  const values = [...buckets.values()];
  const max = Math.max(1, ...values.map((value) => value.reviews));
  const total = values.reduce((sum, value) => sum + value.reviews, 0);
  const activeDays = values.filter((value) => value.reviews > 0).length;

  return `
  <section class="card">
    <div class="card-head">
      <h2>Activity</h2>
      <span class="muted">${total} answers over ${activeDays} active days</span>
    </div>
    <div class="chart">
      ${[...buckets.entries()].map(([key, value]) => `
        <div class="chart-col" title="${key}: ${value.reviews} answers, ${value.lessons} new">
          <div class="chart-bar" style="height:${(value.reviews / max) * 100}%">
            <div class="chart-bar-correct" style="height:${value.reviews ? (value.correct / value.reviews) * 100 : 0}%"></div>
          </div>
        </div>`).join('')}
    </div>
    <p class="muted">Last 60 days. The lighter portion of each bar is correct answers.</p>
  </section>`;
}

function accuracySection(log, state) {
  const byType = {};
  const byKind = {};
  log.forEach((entry) => {
    for (const [map, key] of [[byType, entry.type], [byKind, entry.kind]]) {
      if (!map[key]) map[key] = { total: 0, correct: 0 };
      map[key].total += 1;
      map[key].correct += entry.correct ? 1 : 0;
    }
  });

  const recent = log.slice(-200);
  const recentAccuracy = recent.length
    ? Math.round((recent.filter((entry) => entry.correct).length / recent.length) * 100)
    : null;

  const block = (title, map) => `
    <div class="mini-card grow">
      <p class="stat-label">${title}</p>
      ${Object.entries(map).length ? Object.entries(map).map(([key, value]) => {
        const pct = Math.round((value.correct / value.total) * 100);
        return `<div class="rate-row">
          <span>${escapeHtml(key)}</span>
          <div class="progress-track small"><div class="progress-fill ${pct >= 85 ? 'good' : pct >= 70 ? 'ok' : 'poor'}" style="width:${pct}%"></div></div>
          <span class="strong">${pct}%</span>
          <span class="muted">${value.total}</span>
        </div>`;
      }).join('') : '<p class="muted">No reviews yet.</p>'}
    </div>`;

  return `
  <section class="card">
    <div class="card-head">
      <h2>Accuracy</h2>
      <span class="muted">${recentAccuracy === null ? 'no data yet' : `${recentAccuracy}% over the last ${recent.length} answers`}</span>
    </div>
    <div class="grid two">
      ${block('By item type', byType)}
      ${block('By question', byKind)}
    </div>
  </section>`;
}

function forecastSection(state) {
  const days = 14;
  const now = Date.now();
  const buckets = Array.from({ length: days }, (_, index) => ({
    label: new Date(now + index * DAY).toLocaleDateString(undefined, { weekday: 'short' }),
    count: 0,
  }));
  let overdue = 0;

  state.progress.forEach((progress) => {
    if (!progress.nextReviewAt || progress.stage >= BURNED) return;
    if (progress.nextReviewAt <= now) {
      overdue += 1;
      return;
    }
    const offset = Math.floor((progress.nextReviewAt - now) / DAY);
    if (offset < days) buckets[offset].count += 1;
  });

  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));

  return `
  <section class="card">
    <div class="card-head">
      <h2>Review forecast</h2>
      <span class="muted">${overdue} due now</span>
    </div>
    <div class="chart tall">
      ${buckets.map((bucket) => `
        <div class="chart-col" title="${bucket.count} reviews">
          <div class="chart-bar forecast" style="height:${(bucket.count / max) * 100}%"></div>
          <span class="chart-label">${escapeHtml(bucket.label)}</span>
        </div>`).join('')}
    </div>
    <p class="muted">
      Two weeks ahead, based on current intervals. Big spikes mean a heavy day —
      lower your new-item cap a few days beforehand to smooth it out.
    </p>
  </section>`;
}

function levelSection(subjects, state, manifest) {
  const levels = [];
  for (let level = 1; level <= manifest.levels; level += 1) {
    const items = subjects.filter((subject) => subject.level === level);
    let started = 0;
    let guru = 0;
    items.forEach((subject) => {
      const progress = state.progress.get(subject.id);
      if (!progress) return;
      started += 1;
      if (progress.stage >= GURU) guru += 1;
    });
    levels.push({ level, total: items.length, started, guru });
  }

  return `
  <section class="card">
    <h2>Levels</h2>
    <div class="level-grid">
      ${levels.map((entry) => {
        const ratio = entry.total ? entry.guru / entry.total : 0;
        const status = entry.level < state.level ? 'done'
          : entry.level === state.level ? 'current' : 'locked';
        return `<div class="level-cell ${status}" title="Level ${entry.level}: ${entry.guru}/${entry.total} at Guru">
          <span class="level-number">${entry.level}</span>
          <div class="level-fill" style="height:${ratio * 100}%"></div>
        </div>`;
      }).join('')}
    </div>
    <p class="muted">Fill height shows how much of each level has reached Guru.</p>
  </section>`;
}

function leechSection(log, state) {
  const misses = new Map();
  log.forEach((entry) => {
    if (entry.correct) return;
    misses.set(entry.subjectId, (misses.get(entry.subjectId) || 0) + 1);
  });

  const leeches = [...misses.entries()]
    .map(([id, count]) => ({ subject: getSubject(id), count, progress: state.progress.get(id) }))
    .filter((entry) => entry.subject && entry.count >= 3)
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  return `
  <section class="card">
    <h2>Trouble items</h2>
    ${leeches.length ? `
      <ul class="item-list">
        ${leeches.map((entry) => `
          <li>
            <span class="jp">${escapeHtml(entry.subject.characters)}</span>
            <span class="muted">${escapeHtml(entry.subject.primaryMeaning)}</span>
            <span class="chip stage-${entry.progress ? stageGroup(entry.progress.stage) : 'unstarted'}">
              ${entry.count} misses
            </span>
          </li>`).join('')}
      </ul>
      <p class="muted">Items you have missed three or more times. Worth a mnemonic.</p>`
      : '<p class="muted">Nothing has tripped you up three times yet.</p>'}
  </section>`;
}
