import {
  loadContent, allSubjects, getSubject, getManifest, isUnlocked, blockingKanji,
  levelProgress, questionsFor,
} from './content.js';
import { checkAnswer, answersFor } from './answer.js';
import {
  STAGE_GROUPS, GURU, BURNED, applyReview, startSubject, isDue, stageName,
  stageGroup, stageInfo,
} from './srs.js';
import * as store from './store.js';
import { toKana } from './kana.js';
import { renderStats } from './stats.js';
import * as sync from './sync.js';

const state = {
  settings: { ...store.DEFAULT_SETTINGS },
  progress: new Map(),
  level: 1,
  streak: { count: 0, lastDate: null },
  daily: { newStarted: 0, reviewsDone: 0 },
  session: null,
  browse: { type: 'all', level: 'all', stage: 'all', query: '' },
};

// --------------------------------------------------------------- utilities

const $ = (selector) => document.querySelector(selector);

function todayKey(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function relativeTime(timestamp) {
  if (timestamp === null || timestamp === undefined) {
    return '—';
  }
  const diff = timestamp - Date.now();
  const abs = Math.abs(diff);
  const minute = 60000;
  const hour = 3600000;
  const day = 86400000;
  let text;
  if (abs < minute) text = 'less than a minute';
  else if (abs < hour) text = `${Math.round(abs / minute)} min`;
  else if (abs < day) text = `${Math.round(abs / hour)} hr`;
  else text = `${Math.round(abs / day)} days`;
  return diff <= 0 ? 'now' : `in ${text}`;
}

function typeLabel(type) {
  return { kanji: 'Kanji', vocabulary: 'Vocabulary', grammar: 'Grammar' }[type] || type;
}

// ----------------------------------------------------------------- queries

function dueSubjects(now = Date.now()) {
  return allSubjects().filter((subject) => isDue(state.progress.get(subject.id), now));
}

function availableLessons() {
  return allSubjects().filter(
    (subject) =>
      !state.progress.has(subject.id) && isUnlocked(subject, state.level, state.progress)
  );
}

function reviewsRemainingToday() {
  return Math.max(0, state.settings.reviewsPerDay - state.daily.reviewsDone);
}

function lessonsRemainingToday() {
  return Math.max(0, state.settings.newPerDay - state.daily.newStarted);
}

function nextReviewTime() {
  let soonest = null;
  state.progress.forEach((progress) => {
    if (progress.stage > 0 && progress.stage < BURNED && progress.nextReviewAt) {
      if (soonest === null || progress.nextReviewAt < soonest) {
        soonest = progress.nextReviewAt;
      }
    }
  });
  return soonest;
}

function stageCounts() {
  const counts = Object.fromEntries(STAGE_GROUPS.map((group) => [group, 0]));
  state.progress.forEach((progress) => {
    if (progress.stage > 0) {
      counts[stageGroup(progress.stage)] += 1;
    }
  });
  return counts;
}

// ----------------------------------------------------------------- session

function buildSession(mode) {
  const askReading = state.settings.askReading;
  let subjects;

  if (mode === 'review') {
    const cap = reviewsRemainingToday();
    if (cap <= 0) {
      return null;
    }
    subjects = shuffle(dueSubjects()).slice(0, cap);
  } else {
    const cap = Math.min(lessonsRemainingToday(), state.settings.lessonBatchSize);
    if (cap <= 0) {
      return null;
    }
    // Teach in syllabus order so kanji arrive before the words that use them.
    subjects = availableLessons()
      .sort(
        (a, b) =>
          a.level - b.level
          || ['kanji', 'vocabulary', 'grammar'].indexOf(a.type)
            - ['kanji', 'vocabulary', 'grammar'].indexOf(b.type)
          || (a.frequencyTier || 9) - (b.frequencyTier || 9)
      )
      .slice(0, cap);
  }

  if (!subjects.length) {
    return null;
  }

  const queue = [];
  subjects.forEach((subject) => {
    questionsFor(subject, askReading).forEach((question) => {
      queue.push({ subjectId: subject.id, kind: question.kind });
    });
  });

  return {
    mode,
    subjects: subjects.map((subject) => subject.id),
    queue: mode === 'review' ? shuffle(queue) : queue,
    total: queue.length,
    wrong: new Map(),
    done: new Set(),
    log: [],
    correct: 0,
    incorrect: 0,
    teaching: mode === 'lesson' ? 0 : -1,
    current: null,
    revealed: false,
  };
}

async function submitAnswer(raw) {
  const session = state.session;
  const item = session.current;
  if (!item || session.revealed) {
    return;
  }
  const subject = getSubject(item.subjectId);
  const correct = checkAnswer(subject, item.kind, raw);
  if (correct === null) {
    return;
  }

  session.log.push({
    subjectId: subject.id,
    type: subject.type,
    kind: item.kind,
    correct,
    at: Date.now(),
    level: subject.level,
  });

  if (correct) {
    session.correct += 1;
    session.done.add(`${item.subjectId}:${item.kind}`);
    session.queue.shift();
    await maybeCompleteSubject(subject);
  } else {
    session.incorrect += 1;
    session.wrong.set(item.subjectId, (session.wrong.get(item.subjectId) || 0) + 1);
    // Put it back a few places so it comes round again this session.
    const [failed] = session.queue.splice(0, 1);
    const position = Math.min(session.queue.length, 3 + Math.floor(Math.random() * 4));
    session.queue.splice(position, 0, failed);
  }

  session.revealed = true;
  session.lastCorrect = correct;
  session.lastAnswer = raw;
  renderSession();

  if (correct && state.settings.autoAdvance) {
    setTimeout(() => {
      if (state.session === session && session.revealed) {
        advance();
      }
    }, 700);
  }
}

/** When every question for a subject is answered, write its SRS update. */
async function maybeCompleteSubject(subject) {
  const session = state.session;
  const questions = questionsFor(subject, state.settings.askReading);
  const finished = questions.every((question) =>
    session.done.has(`${subject.id}:${question.kind}`)
  );
  if (!finished) {
    return;
  }

  const wrong = session.wrong.get(subject.id) || 0;
  const existing = state.progress.get(subject.id);

  // A lesson only introduces the item: it lands at Apprentice I whether or not
  // the closing quiz went smoothly. Reviews are what move it up the ladder.
  const updated = session.mode === 'lesson' || !existing
    ? startSubject(subject.id, subject.type, subject.level)
    : applyReview(existing, wrong);

  state.progress.set(subject.id, updated);
  await store.putProgress(updated);

  if (session.mode === 'review') {
    state.daily = await store.bumpDaily(todayKey(), 'reviewsDone');
  } else {
    state.daily = await store.bumpDaily(todayKey(), 'newStarted');
  }
}

function advance() {
  const session = state.session;
  session.revealed = false;
  session.lastCorrect = null;
  if (!session.queue.length) {
    finishSession();
    return;
  }
  session.current = session.queue[0];
  renderSession();
}

async function finishSession() {
  const session = state.session;
  await store.logReviews(session.log);
  await touchStreak();
  await maybeLevelUp();
  state.session = { ...session, finished: true };
  render();

  // Push the session to the other devices in the background. A failure here is
  // not worth interrupting the summary screen for — the next sync catches up.
  sync.syncQuietly().then(async (result) => {
    if (result) {
      await hydrate();
    }
  });
}

async function touchStreak() {
  const today = todayKey();
  const streak = state.streak;
  if (streak.lastDate === today) {
    return;
  }
  const yesterday = todayKey(new Date(Date.now() - 86400000));
  streak.count = streak.lastDate === yesterday ? streak.count + 1 : 1;
  streak.lastDate = today;
  await store.saveStreak(streak);
}

async function maybeLevelUp() {
  const manifest = getManifest();
  let levelled = false;
  while (state.level < manifest.levels) {
    const progress = levelProgress(
      state.level, state.progress, state.settings.levelUpThreshold
    );
    if (!progress.canLevelUp) {
      break;
    }
    state.level += 1;
    levelled = true;
  }
  if (levelled) {
    await store.saveLevel(state.level);
  }
  return levelled;
}

// ------------------------------------------------------------------ render

function render() {
  const view = location.hash.replace('#', '') || 'dashboard';
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.view === view);
  });
  $('#levelBadge').textContent = `Level ${state.level}`;

  const root = $('#view');
  if (state.session) {
    // Covers the in-progress session and the end-of-session summary.
    renderSession();
    return;
  }

  switch (view) {
    case 'lessons': root.innerHTML = lessonsView(); break;
    case 'reviews': root.innerHTML = reviewsView(); break;
    case 'browse': renderBrowse(root); return;
    case 'stats': renderStats(root, state); return;
    case 'settings': root.innerHTML = settingsView(); bindSettings(); return;
    default: root.innerHTML = dashboardView();
  }
  bindCommon();
}

function statCard(label, value, hint = '') {
  return `<article class="stat">
    <p class="stat-label">${escapeHtml(label)}</p>
    <p class="stat-value">${escapeHtml(value)}</p>
    ${hint ? `<p class="stat-hint">${escapeHtml(hint)}</p>` : ''}
  </article>`;
}

function dashboardView() {
  const due = dueSubjects().length;
  const lessons = availableLessons().length;
  const reviewCap = reviewsRemainingToday();
  const lessonCap = lessonsRemainingToday();
  const counts = stageCounts();
  const manifest = getManifest();
  const progress = levelProgress(
    state.level, state.progress, state.settings.levelUpThreshold
  );
  const started = state.progress.size;
  const total = allSubjects().length;
  const next = nextReviewTime();

  const forecast = buildForecast(24);
  const forecastMax = Math.max(1, ...forecast.map((slot) => slot.count));

  return `
  <section class="grid stats-grid">
    ${statCard('Reviews due', Math.min(due, reviewCap), due > reviewCap ? `${due} due, ${reviewCap} left in today's cap` : `next ${relativeTime(next)}`)}
    ${statCard('Lessons ready', Math.min(lessons, lessonCap), `${lessonCap} of ${state.settings.newPerDay} new left today`)}
    ${statCard('Level', `${state.level} / ${manifest.levels}`, `${progress.passed}/${progress.total} kanji at Guru`)}
    ${statCard('Streak', `${state.streak.count} d`, `${started} of ${total} items started`)}
  </section>

  <section class="card">
    <div class="card-head">
      <h2>Today</h2>
      <div class="button-row">
        <button class="primary" data-action="start-review" ${due && reviewCap ? '' : 'disabled'}>
          Review ${Math.min(due, reviewCap) || ''}
        </button>
        <button class="secondary" data-action="start-lesson" ${lessons && lessonCap ? '' : 'disabled'}>
          Learn ${Math.min(lessons, lessonCap, state.settings.lessonBatchSize) || ''}
        </button>
      </div>
    </div>
    <p class="muted">${dashboardMessage(due, reviewCap, lessons, lessonCap, next)}</p>
    <div class="bar-stack">
      ${STAGE_GROUPS.map((group) => {
        const value = counts[group];
        const width = started ? (value / started) * 100 : 0;
        return `<div class="bar-seg stage-${group}" style="width:${width}%" title="${group}: ${value}"></div>`;
      }).join('')}
    </div>
    <ul class="legend">
      ${STAGE_GROUPS.map((group) => `<li><span class="dot stage-${group}"></span>${group} <strong>${counts[group]}</strong></li>`).join('')}
    </ul>
  </section>

  <section class="card">
    <h2>Next 24 hours</h2>
    <div class="forecast">
      ${forecast.map((slot) => `
        <div class="forecast-col" title="${slot.count} reviews at ${slot.label}">
          <div class="forecast-bar" style="height:${(slot.count / forecastMax) * 100}%"></div>
          <span class="forecast-label">${slot.label}</span>
        </div>`).join('')}
    </div>
    <p class="muted">${forecast.reduce((sum, slot) => sum + slot.count, 0)} reviews arriving in the next 24 hours.</p>
  </section>

  <section class="card">
    <h2>Level ${state.level} progress</h2>
    <div class="progress-track"><div class="progress-fill" style="width:${Math.round(progress.ratio * 100)}%"></div></div>
    <p class="muted">
      ${progress.passed} of ${progress.total} level kanji have reached Guru.
      You level up at ${Math.round(state.settings.levelUpThreshold * 100)}%.
    </p>
  </section>`;
}

function dashboardMessage(due, reviewCap, lessons, lessonCap, next) {
  if (due && reviewCap) {
    return `${Math.min(due, reviewCap)} reviews waiting. Clearing them keeps the schedule honest.`;
  }
  if (due && !reviewCap) {
    return `You have hit today's review cap of ${state.settings.reviewsPerDay}. Raise it in Settings if you want to keep going.`;
  }
  if (lessons && lessonCap) {
    return 'No reviews due. Good time to take on new material.';
  }
  if (!lessons && !due) {
    return `All caught up. Your next review is ${relativeTime(next)}.`;
  }
  return `Today's new-card cap of ${state.settings.newPerDay} is used up. Next review ${relativeTime(next)}.`;
}

function buildForecast(hours) {
  const now = Date.now();
  const slots = [];
  for (let hour = 0; hour < hours; hour += 1) {
    const start = now + hour * 3600000;
    slots.push({
      label: new Date(start).getHours().toString().padStart(2, '0'),
      count: 0,
    });
  }
  state.progress.forEach((progress) => {
    if (!progress.nextReviewAt || progress.stage >= BURNED) {
      return;
    }
    const offset = Math.floor((progress.nextReviewAt - now) / 3600000);
    if (offset >= 0 && offset < hours) {
      slots[offset].count += 1;
    } else if (progress.nextReviewAt <= now) {
      slots[0].count += 1;
    }
  });
  return slots;
}

function lessonsView() {
  const lessons = availableLessons();
  const cap = lessonsRemainingToday();
  const byType = { kanji: [], vocabulary: [], grammar: [] };
  lessons.forEach((subject) => byType[subject.type].push(subject));

  const locked = allSubjects().filter(
    (subject) =>
      subject.level <= state.level
      && !state.progress.has(subject.id)
      && !isUnlocked(subject, state.level, state.progress)
  );

  return `
  <section class="card">
    <div class="card-head">
      <h2>Lessons</h2>
      <button class="primary" data-action="start-lesson" ${lessons.length && cap ? '' : 'disabled'}>
        Start ${Math.min(lessons.length, cap, state.settings.lessonBatchSize)}
      </button>
    </div>
    <p class="muted">
      ${lessons.length} items are unlocked and unstarted.
      ${cap} of today's ${state.settings.newPerDay} new-card allowance is left.
    </p>
    <div class="grid three">
      ${Object.entries(byType).map(([type, items]) => `
        <div class="mini-card">
          <p class="stat-label">${typeLabel(type)}</p>
          <p class="stat-value">${items.length}</p>
          <p class="stat-hint">${items.slice(0, 6).map((s) => escapeHtml(s.characters)).join(' ') || '—'}</p>
        </div>`).join('')}
    </div>
  </section>

  <section class="card">
    <h2>Waiting on kanji</h2>
    <p class="muted">${locked.length} words in your levels are held back until their kanji reach Guru.</p>
    <ul class="item-list">
      ${locked.slice(0, 12).map((subject) => `
        <li>
          <span class="jp">${escapeHtml(subject.characters)}</span>
          <span class="muted">${escapeHtml(subject.primaryMeaning)}</span>
          <span class="chips">${blockingKanji(subject, state.progress).map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('')}</span>
        </li>`).join('') || '<li class="muted">Nothing is blocked right now.</li>'}
    </ul>
  </section>`;
}

function reviewsView() {
  const due = dueSubjects();
  const cap = reviewsRemainingToday();
  const grouped = { kanji: 0, vocabulary: 0, grammar: 0 };
  due.forEach((subject) => { grouped[subject.type] += 1; });

  return `
  <section class="card">
    <div class="card-head">
      <h2>Reviews</h2>
      <button class="primary" data-action="start-review" ${due.length && cap ? '' : 'disabled'}>
        Start ${Math.min(due.length, cap)}
      </button>
    </div>
    <p class="muted">
      ${due.length} items are due. Today's cap leaves room for ${cap}.
      ${state.settings.askReading ? 'Each item asks for meaning and reading.' : 'Each item asks for meaning only.'}
    </p>
    <div class="grid three">
      ${Object.entries(grouped).map(([type, count]) => `
        <div class="mini-card">
          <p class="stat-label">${typeLabel(type)}</p>
          <p class="stat-value">${count}</p>
        </div>`).join('')}
    </div>
  </section>

  <section class="card">
    <h2>Coming up</h2>
    <ul class="item-list">
      ${[...state.progress.values()]
        .filter((p) => p.nextReviewAt && p.stage < BURNED && p.nextReviewAt > Date.now())
        .sort((a, b) => a.nextReviewAt - b.nextReviewAt)
        .slice(0, 10)
        .map((p) => {
          const subject = getSubject(p.id);
          if (!subject) return '';
          return `<li>
            <span class="jp">${escapeHtml(subject.characters)}</span>
            <span class="muted">${escapeHtml(subject.primaryMeaning)}</span>
            <span class="chip stage-${stageGroup(p.stage)}">${escapeHtml(stageName(p.stage))}</span>
            <span class="muted">${escapeHtml(relativeTime(p.nextReviewAt))}</span>
          </li>`;
        }).join('') || '<li class="muted">Nothing scheduled yet.</li>'}
    </ul>
  </section>`;
}

// ---------------------------------------------------------- session render

function renderSession() {
  const session = state.session;
  const root = $('#view');

  if (session.finished) {
    root.innerHTML = summaryView(session);
    bindCommon();
    return;
  }

  if (session.mode === 'lesson' && session.teaching >= 0 && session.teaching < session.subjects.length) {
    root.innerHTML = teachView(session);
    bindCommon();
    return;
  }

  if (!session.current) {
    session.current = session.queue[0];
  }
  const subject = getSubject(session.current.subjectId);
  const kind = session.current.kind;
  const answeredTotal = session.done.size;
  const percent = Math.round((answeredTotal / session.total) * 100);

  root.innerHTML = `
  <section class="session">
    <div class="session-bar">
      <div class="session-fill" style="width:${percent}%"></div>
    </div>
    <div class="session-meta">
      <span>${session.queue.length} left</span>
      <span class="ok">${session.correct} correct</span>
      <span class="bad">${session.incorrect} missed</span>
      <button class="link" data-action="end-session">End session</button>
    </div>

    <div class="prompt-card type-${subject.type} ${session.revealed ? (session.lastCorrect ? 'correct' : 'incorrect') : ''}">
      <p class="prompt-type">${typeLabel(subject.type)} — ${kind === 'meaning' ? 'meaning' : 'reading'}</p>
      <p class="prompt-characters ${subject.characters.length > 6 ? 'long' : ''}">${escapeHtml(subject.characters)}</p>
      ${kind === 'reading' && subject.type === 'vocabulary' ? '' : ''}
    </div>

    <form id="answerForm" class="answer-form" autocomplete="off">
      <input id="answerInput" class="answer-input ${kind === 'reading' ? 'kana' : ''}"
             type="text" placeholder="${kind === 'meaning' ? 'meaning in English' : 'reading in romaji or kana'}"
             ${session.revealed ? 'readonly' : ''} />
      <button class="primary" type="submit">${session.revealed ? 'Next' : 'Check'}</button>
    </form>

    ${session.revealed ? feedbackBlock(subject, kind, session) : '<p class="muted hint">Press Enter to check. Readings can be typed in romaji.</p>'}
  </section>`;

  bindSessionEvents();
}

function feedbackBlock(subject, kind, session) {
  const answers = answersFor(subject, kind);
  return `
  <div class="feedback ${session.lastCorrect ? 'ok' : 'bad'}">
    <p class="feedback-head">${session.lastCorrect ? 'Correct' : 'Not quite'} — ${escapeHtml(answers.join(', '))}</p>
    ${subjectDetail(subject)}
  </div>`;
}

function subjectDetail(subject) {
  const parts = [];

  if (subject.type === 'kanji') {
    parts.push(`<dl class="detail">
      <div><dt>Meanings</dt><dd>${escapeHtml(subject.meanings.join(', '))}</dd></div>
      ${subject.readingsOn.length ? `<div><dt>On'yomi</dt><dd class="jp">${escapeHtml(subject.readingsOn.join('、'))}</dd></div>` : ''}
      ${subject.readingsKun.length ? `<div><dt>Kun'yomi</dt><dd class="jp">${escapeHtml(subject.readingsKun.join('、'))}</dd></div>` : ''}
      ${subject.radicals.length ? `<div><dt>Radicals</dt><dd>${escapeHtml(subject.radicals.join(' + '))}</dd></div>` : ''}
      <div><dt>Strokes</dt><dd>${subject.strokes ?? '—'}</dd></div>
    </dl>`);
    if (subject.exampleWords.length) {
      parts.push(`<div class="examples"><p class="detail-head">Words using it</p>${
        subject.exampleWords.map((word) => `
          <p class="example-word">
            <span class="jp">${escapeHtml(word.characters)}</span>
            <span class="muted jp">${escapeHtml(word.reading)}</span>
            <span class="muted">${escapeHtml(word.meaning)}</span>
          </p>`).join('')
      }</div>`);
    }
  }

  if (subject.type === 'vocabulary') {
    parts.push(`<dl class="detail">
      <div><dt>Reading</dt><dd class="jp">${escapeHtml(subject.reading)}</dd></div>
      <div><dt>Meanings</dt><dd>${escapeHtml(subject.meanings.join(', '))}</dd></div>
      ${subject.componentKanji.length ? `<div><dt>Kanji</dt><dd class="jp">${escapeHtml(subject.componentKanji.join(' '))}</dd></div>` : ''}
    </dl>`);
  }

  if (subject.type === 'grammar') {
    parts.push(`<dl class="detail">
      <div><dt>Meanings</dt><dd>${escapeHtml(subject.meanings.join('; '))}</dd></div>
      ${subject.formation ? `<div><dt>Formation</dt><dd class="jp">${escapeHtml(subject.formation)}</dd></div>` : ''}
      ${subject.nuance ? `<div><dt>Nuance</dt><dd>${escapeHtml(subject.nuance)}</dd></div>` : ''}
    </dl>`);
  }

  if (subject.examples && subject.examples.length) {
    parts.push(`<div class="examples"><p class="detail-head">Example${subject.examples.length > 1 ? 's' : ''}</p>${
      subject.examples.map((example) => `
        <blockquote class="example">
          <p class="jp">${highlight(example.ja, subject.characters)}</p>
          ${example.reading ? `<p class="muted jp small">${escapeHtml(example.reading)}</p>` : ''}
          <p class="muted">${escapeHtml(example.en)}</p>
        </blockquote>`).join('')
    }</div>`);
  }

  return parts.join('');
}

/** Mark the target word inside an example sentence. */
function highlight(sentence, target) {
  const safe = escapeHtml(sentence);
  const needle = escapeHtml(target);
  if (!needle || !safe.includes(needle)) {
    return safe;
  }
  return safe.split(needle).join(`<mark>${needle}</mark>`);
}

function teachView(session) {
  const subject = getSubject(session.subjects[session.teaching]);
  const position = `${session.teaching + 1} / ${session.subjects.length}`;
  return `
  <section class="session">
    <div class="session-meta">
      <span>Lesson ${position}</span>
      <button class="link" data-action="end-session">End session</button>
    </div>
    <div class="prompt-card type-${subject.type} teaching">
      <p class="prompt-type">${typeLabel(subject.type)} — level ${subject.level}</p>
      <p class="prompt-characters ${subject.characters.length > 6 ? 'long' : ''}">${escapeHtml(subject.characters)}</p>
      <p class="prompt-reading jp">${escapeHtml(subject.type === 'vocabulary' ? subject.reading : (subject.primaryReading || subject.reading || ''))}</p>
      <p class="prompt-meaning">${escapeHtml(subject.primaryMeaning)}</p>
    </div>
    <div class="feedback">${subjectDetail(subject)}</div>
    <div class="button-row end">
      ${session.teaching > 0 ? '<button class="secondary" data-action="teach-prev">Back</button>' : ''}
      <button class="primary" data-action="teach-next">
        ${session.teaching + 1 === session.subjects.length ? 'Start quiz' : 'Next'}
      </button>
    </div>
  </section>`;
}

function summaryView(session) {
  const total = session.correct + session.incorrect;
  const accuracy = total ? Math.round((session.correct / total) * 100) : 100;
  const missed = [...session.wrong.keys()].map((id) => getSubject(id)).filter(Boolean);

  return `
  <section class="card">
    <h2>Session complete</h2>
    <div class="grid stats-grid">
      ${statCard('Answered', total)}
      ${statCard('Accuracy', `${accuracy}%`)}
      ${statCard('Subjects', session.subjects.length)}
      ${statCard('Level', state.level)}
    </div>
    ${missed.length ? `
      <h3>Worth another look</h3>
      <ul class="item-list">
        ${missed.map((subject) => `
          <li>
            <span class="jp">${escapeHtml(subject.characters)}</span>
            <span class="muted">${escapeHtml(subject.primaryMeaning)}</span>
            <span class="chip">${session.wrong.get(subject.id)} missed</span>
          </li>`).join('')}
      </ul>` : '<p class="muted">Everything correct on the first try.</p>'}
    <div class="button-row">
      <button class="primary" data-action="continue">Back to dashboard</button>
      ${dueSubjects().length && reviewsRemainingToday() ? '<button class="secondary" data-action="start-review">Keep reviewing</button>' : ''}
    </div>
  </section>`;
}

// ------------------------------------------------------------------ browse

function renderBrowse(root) {
  const manifest = getManifest();
  const { type, level, stage, query } = state.browse;
  const needle = query.trim().toLowerCase();

  const items = allSubjects().filter((subject) => {
    if (type !== 'all' && subject.type !== type) return false;
    if (level !== 'all' && subject.level !== Number(level)) return false;
    const progress = state.progress.get(subject.id);
    if (stage !== 'all') {
      if (stage === 'unstarted' && progress) return false;
      if (stage !== 'unstarted' && (!progress || stageGroup(progress.stage) !== stage)) return false;
    }
    if (!needle) return true;
    return (
      subject.characters.includes(query)
      || (subject.reading || '').includes(query)
      || subject.meanings.some((meaning) => meaning.toLowerCase().includes(needle))
    );
  });

  root.innerHTML = `
  <section class="card">
    <div class="filters">
      <label>Type
        <select data-filter="type">
          ${['all', 'kanji', 'vocabulary', 'grammar'].map((value) => `<option value="${value}" ${type === value ? 'selected' : ''}>${value === 'all' ? 'All' : typeLabel(value)}</option>`).join('')}
        </select>
      </label>
      <label>Level
        <select data-filter="level">
          <option value="all">All</option>
          ${Array.from({ length: manifest.levels }, (_, i) => i + 1).map((value) => `<option value="${value}" ${String(level) === String(value) ? 'selected' : ''}>${value}</option>`).join('')}
        </select>
      </label>
      <label>Stage
        <select data-filter="stage">
          ${['all', 'unstarted', ...STAGE_GROUPS].map((value) => `<option value="${value}" ${stage === value ? 'selected' : ''}>${value}</option>`).join('')}
        </select>
      </label>
      <label class="grow">Search
        <input type="search" data-filter="query" value="${escapeHtml(query)}" placeholder="kanji, reading or meaning" />
      </label>
    </div>
    <p class="muted">${items.length} items</p>
    <div class="browse-grid">
      ${items.slice(0, 300).map((subject) => {
        const progress = state.progress.get(subject.id);
        const group = progress ? stageGroup(progress.stage) : 'unstarted';
        return `<button class="browse-item stage-${group} type-${subject.type}" data-subject="${escapeHtml(subject.id)}">
          <span class="jp">${escapeHtml(subject.characters)}</span>
          <span class="browse-meaning">${escapeHtml(subject.primaryMeaning)}</span>
          <span class="browse-level">L${subject.level}</span>
        </button>`;
      }).join('')}
    </div>
    ${items.length > 300 ? `<p class="muted">Showing the first 300 of ${items.length}. Narrow the filters to see more.</p>` : ''}
  </section>
  <section class="card" id="browseDetail" hidden></section>`;

  root.querySelectorAll('[data-filter]').forEach((control) => {
    const event = control.tagName === 'SELECT' ? 'change' : 'input';
    control.addEventListener(event, () => {
      state.browse[control.dataset.filter] = control.value;
      renderBrowse(root);
      if (event === 'input') {
        const field = root.querySelector('[data-filter="query"]');
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      }
    });
  });

  root.querySelectorAll('[data-subject]').forEach((button) => {
    button.addEventListener('click', () => showSubjectDetail(button.dataset.subject));
  });
}

function showSubjectDetail(id) {
  const subject = getSubject(id);
  const progress = state.progress.get(id);
  const panel = $('#browseDetail');
  panel.hidden = false;
  panel.innerHTML = `
    <div class="card-head">
      <h2 class="jp big">${escapeHtml(subject.characters)}</h2>
      <span class="chip stage-${progress ? stageGroup(progress.stage) : 'unstarted'}">
        ${progress ? escapeHtml(stageName(progress.stage)) : 'Not started'}
      </span>
    </div>
    <p class="muted">${typeLabel(subject.type)} · level ${subject.level}${
      progress ? ` · next review ${escapeHtml(relativeTime(progress.nextReviewAt))} · ${progress.reviewCount} reviews` : ''
    }</p>
    ${subjectDetail(subject)}`;
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------------------------------------------------------------- settings

function settingsView() {
  const s = state.settings;
  return `
  <section class="card">
    <h2>Daily limits</h2>
    <p class="muted">Caps reset at midnight local time. Today: ${state.daily.newStarted} new, ${state.daily.reviewsDone} reviews.</p>
    <div class="settings-grid">
      <label>New items per day
        <input type="number" min="0" max="200" data-setting="newPerDay" value="${s.newPerDay}" />
      </label>
      <label>Reviews per day
        <input type="number" min="0" max="1000" data-setting="reviewsPerDay" value="${s.reviewsPerDay}" />
      </label>
      <label>Items per lesson batch
        <input type="number" min="1" max="30" data-setting="lessonBatchSize" value="${s.lessonBatchSize}" />
      </label>
      <label>Level-up threshold (%)
        <input type="number" min="50" max="100" step="5" data-setting="levelUpThreshold" value="${Math.round(s.levelUpThreshold * 100)}" />
      </label>
    </div>
  </section>

  <section class="card">
    <h2>Reviews</h2>
    <label class="toggle">
      <input type="checkbox" data-setting="askReading" ${s.askReading ? 'checked' : ''} />
      <span>Ask for readings as well as meanings</span>
    </label>
    <label class="toggle">
      <input type="checkbox" data-setting="autoAdvance" ${s.autoAdvance ? 'checked' : ''} />
      <span>Advance automatically after a correct answer</span>
    </label>
  </section>

  <section class="card">
    <h2>Sync across devices</h2>
    ${state.syncConfig
      ? `<p class="muted">
           Connected to <code>${escapeHtml(state.syncConfig.endpoint)}</code>.
           Last synced ${escapeHtml(
             state.syncConfig.lastSyncedAt
               ? relativeTime(state.syncConfig.lastSyncedAt).replace('in ', '') + ' ago'
               : 'never'
           )}.
         </p>
         <p id="syncStatus" class="muted"></p>
         <div class="button-row">
           <button class="primary" data-action="sync-now">Sync now</button>
           <button class="secondary" data-action="sync-off">Disconnect</button>
         </div>`
      : `<p class="muted">
           Your progress lives in this browser. Connect a sync server to share
           one schedule between your phone and your computer. Data is encrypted
           here before it is sent — the server cannot read it, and nobody can
           recover your passphrase if you lose it.
         </p>
         <div class="settings-grid">
           <label>Server address
             <input type="url" id="syncEndpoint" placeholder="https://jlpt-n3-sync.you.workers.dev" />
           </label>
           <label>Passphrase (12+ characters)
             <input type="password" id="syncPassphrase" placeholder="the same on every device" />
           </label>
         </div>
         <p id="syncStatus" class="muted"></p>
         <div class="button-row">
           <button class="primary" data-action="sync-connect">Connect</button>
         </div>
         <p class="muted">See <code>worker/README.md</code> for a one-off five-minute setup.</p>`}
  </section>

  <section class="card">
    <h2>Your data</h2>
    <p class="muted">Progress is stored in this browser only. Export it if you switch machines.</p>
    <div class="button-row">
      <button class="secondary" data-action="export">Export progress</button>
      <button class="secondary" data-action="import">Import progress</button>
      <button class="danger" data-action="reset">Reset all progress</button>
    </div>
    <input type="file" id="importFile" accept="application/json" hidden />
  </section>`;
}

function bindSettings() {
  document.querySelectorAll('[data-setting]').forEach((control) => {
    control.addEventListener('change', async () => {
      const key = control.dataset.setting;
      let value = control.type === 'checkbox' ? control.checked : Number(control.value);
      if (key === 'levelUpThreshold') {
        value = Math.min(1, Math.max(0.5, value / 100));
      }
      state.settings = { ...state.settings, [key]: value };
      await store.saveSettings(state.settings);
    });
  });

  $('[data-action="export"]').addEventListener('click', async () => {
    const payload = await store.exportAll();
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `jlpt-n3-progress-${todayKey()}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  });

  const fileInput = $('#importFile');
  $('[data-action="import"]').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      await store.importAll(JSON.parse(await file.text()));
      await hydrate();
      render();
    } catch (error) {
      alert(`Import failed: ${error.message}`);
    }
  });

  const syncStatus = (message, tone = '') => {
    const el = $('#syncStatus');
    if (el) {
      el.textContent = message;
      el.className = `muted ${tone}`;
    }
  };

  $('[data-action="sync-connect"]')?.addEventListener('click', async () => {
    const endpoint = $('#syncEndpoint').value.trim();
    const passphrase = $('#syncPassphrase').value;
    syncStatus('Connecting…');
    try {
      await sync.configure({ endpoint, passphrase });
      const result = await sync.sync();
      await hydrate();
      render();
      syncStatus(
        `Synced ${result.subjects} subjects and ${result.reviews} answers.`, 'ok'
      );
    } catch (error) {
      syncStatus(error.message, 'bad');
    }
  });

  $('[data-action="sync-now"]')?.addEventListener('click', async () => {
    syncStatus('Syncing…');
    try {
      const result = await sync.sync();
      await hydrate();
      render();
      syncStatus(
        result.pulledChanges
          ? `Merged changes from your other device — ${result.subjects} subjects, ${result.reviews} answers.`
          : `Up to date — ${result.subjects} subjects, ${result.reviews} answers.`,
        'ok'
      );
    } catch (error) {
      syncStatus(error.message, 'bad');
    }
  });

  $('[data-action="sync-off"]')?.addEventListener('click', async () => {
    if (!confirm('Stop syncing this device? Your local progress is kept.')) {
      return;
    }
    await sync.disable();
    await hydrate();
    render();
  });

  $('[data-action="reset"]').addEventListener('click', async () => {
    if (!confirm('Delete all progress and start from level 1? This cannot be undone.')) {
      return;
    }
    await store.clearProgress();
    await store.clearReviewLog();
    await store.saveLevel(1);
    await store.saveStreak({ count: 0, lastDate: null });
    await hydrate();
    location.hash = 'dashboard';
    render();
  });
}

// ------------------------------------------------------------------- events

function bindCommon() {
  document.querySelectorAll('[data-action]').forEach((button) => {
    const action = button.dataset.action;
    // Settings wires its own handlers in bindSettings.
    if (action.startsWith('sync-') || ['export', 'import', 'reset'].includes(action)) {
      return;
    }
    button.addEventListener('click', () => handleAction(action));
  });
}

function bindSessionEvents() {
  const form = $('#answerForm');
  const input = $('#answerInput');
  const session = state.session;

  if (session.revealed) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      advance();
    });
    $('[data-action="end-session"]').addEventListener('click', () => handleAction('end-session'));
    input.blur();
    // Enter/space anywhere continues once the answer is shown.
    const onKey = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        document.removeEventListener('keydown', onKey);
        advance();
      }
    };
    document.addEventListener('keydown', onKey);
    return;
  }

  if (session.current.kind === 'reading') {
    input.addEventListener('input', () => {
      const caretAtEnd = input.selectionStart === input.value.length;
      const converted = toKana(input.value);
      if (converted !== input.value) {
        input.value = converted;
        if (caretAtEnd) {
          input.setSelectionRange(converted.length, converted.length);
        }
      }
    });
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitAnswer(input.value);
  });
  $('[data-action="end-session"]').addEventListener('click', () => handleAction('end-session'));
  input.focus();
}

async function handleAction(action) {
  switch (action) {
    case 'start-review':
    case 'start-lesson': {
      const mode = action === 'start-review' ? 'review' : 'lesson';
      const session = buildSession(mode);
      if (!session) {
        return;
      }
      state.session = session;
      if (mode === 'review') {
        session.current = session.queue[0];
      }
      renderSession();
      break;
    }
    case 'teach-next': {
      const session = state.session;
      if (session.teaching + 1 < session.subjects.length) {
        session.teaching += 1;
      } else {
        session.teaching = -1;
        session.current = session.queue[0];
      }
      renderSession();
      break;
    }
    case 'teach-prev':
      state.session.teaching = Math.max(0, state.session.teaching - 1);
      renderSession();
      break;
    case 'end-session':
      if (state.session.log.length) {
        await store.logReviews(state.session.log);
        await touchStreak();
        await maybeLevelUp();
      }
      state.session = null;
      render();
      break;
    case 'continue':
      state.session = null;
      location.hash = 'dashboard';
      render();
      break;
    default:
      break;
  }
}

// -------------------------------------------------------------------- boot

async function hydrate() {
  const [settings, level, streak, progress, syncConfig] = await Promise.all([
    store.getSettings(),
    store.getLevel(),
    store.getStreak(),
    store.allProgress(),
    store.getSyncConfig(),
  ]);
  state.settings = settings;
  state.level = level;
  state.streak = streak;
  state.progress = new Map(progress.map((record) => [record.id, record]));
  state.syncConfig = syncConfig;
  state.daily = await store.getDaily(todayKey());
}

async function init() {
  await loadContent();

  const subjectsById = new Map(allSubjects().map((subject) => [subject.id, subject]));
  await store.migrateLegacyState(subjectsById);
  await hydrate();

  window.addEventListener('hashchange', () => {
    if (state.session && !state.session.finished) {
      return;
    }
    state.session = null;
    render();
  });

  render();

  // Pull anything studied elsewhere since this device was last open.
  if (sync.isConfigured(state.syncConfig)) {
    sync.syncQuietly().then(async (result) => {
      if (result && result.pulledChanges) {
        await hydrate();
        render();
      }
    });
  }
}

init().catch((error) => {
  $('#view').innerHTML = `
    <section class="card">
      <h2>Could not start</h2>
      <p class="muted">${escapeHtml(error.message)}</p>
      <p class="muted">This app loads its decks over HTTP. Serve the folder rather than opening the file directly.</p>
      <pre><code>python -m http.server 8000</code></pre>
    </section>`;
  console.error(error);
});
