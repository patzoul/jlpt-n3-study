const STORAGE_KEY = 'jlpt3-study-state';

const defaultItems = [
  {
    id: 'kanji-1',
    type: 'Kanji',
    japanese: '行く',
    reading: 'いく',
    meaning: 'to go',
    example: '私は学校に行きます。',
    mastery: 0,
    intervalDays: 1,
    nextReview: '2026-07-30',
    reviewCount: 0,
  },
  {
    id: 'vocab-1',
    type: 'Vocabulary',
    japanese: '必要',
    reading: 'ひつよう',
    meaning: 'necessary',
    example: 'それは必要です。',
    mastery: 0,
    intervalDays: 1,
    nextReview: '2026-07-30',
    reviewCount: 0,
  },
  {
    id: 'grammar-1',
    type: 'Grammar',
    japanese: '〜てください',
    reading: 'てください',
    meaning: 'please do ...',
    example: 'ちょっと待ってください。',
    mastery: 0,
    intervalDays: 1,
    nextReview: '2026-07-30',
    reviewCount: 0,
  },
  {
    id: 'kanji-2',
    type: 'Kanji',
    japanese: '聞く',
    reading: 'きく',
    meaning: 'to hear / to ask',
    example: '先生に聞きました。',
    mastery: 0,
    intervalDays: 1,
    nextReview: '2026-07-30',
    reviewCount: 0,
  },
  {
    id: 'vocab-2',
    type: 'Vocabulary',
    japanese: '最近',
    reading: 'さいきん',
    meaning: 'recently',
    example: '最近、忙しいです。',
    mastery: 0,
    intervalDays: 1,
    nextReview: '2026-07-30',
    reviewCount: 0,
  },
  {
    id: 'grammar-2',
    type: 'Grammar',
    japanese: '〜ようと思う',
    reading: 'ようとおもう',
    meaning: 'to think of doing',
    example: '日本語を勉強しようと思います。',
    mastery: 0,
    intervalDays: 1,
    nextReview: '2026-07-30',
    reviewCount: 0,
  },
  {
    id: 'kanji-3',
    type: 'Kanji',
    japanese: '作る',
    reading: 'つくる',
    meaning: 'to make / to create',
    example: 'ケーキを作りました。',
    mastery: 0,
    intervalDays: 1,
    nextReview: '2026-07-30',
    reviewCount: 0,
  },
  {
    id: 'kanji-4',
    type: 'Kanji',
    japanese: '始める',
    reading: 'はじめる',
    meaning: 'to start',
    example: '新しいプロジェクトを始めます。',
    mastery: 0,
    intervalDays: 1,
    nextReview: '2026-07-30',
    reviewCount: 0,
  },
  {
    id: 'vocab-3',
    type: 'Vocabulary',
    japanese: '予定',
    reading: 'よてい',
    meaning: 'schedule / plan',
    example: '今日の予定を確認します。',
    mastery: 0,
    intervalDays: 1,
    nextReview: '2026-07-30',
    reviewCount: 0,
  },
  {
    id: 'vocab-4',
    type: 'Vocabulary',
    japanese: '安心',
    reading: 'あんしん',
    meaning: 'peace of mind',
    example: 'その話を聞いて安心しました。',
    mastery: 0,
    intervalDays: 1,
    nextReview: '2026-07-30',
    reviewCount: 0,
  },
  {
    id: 'grammar-3',
    type: 'Grammar',
    japanese: '〜ながら',
    reading: 'ながら',
    meaning: 'while doing',
    example: '音楽を聞きながら勉強します。',
    mastery: 0,
    intervalDays: 1,
    nextReview: '2026-07-30',
    reviewCount: 0,
  },
  {
    id: 'grammar-4',
    type: 'Grammar',
    japanese: '〜くらい/ぐらい',
    reading: 'くらい/ぐらい',
    meaning: 'about / approximately',
    example: '10分くらい待ちました。',
    mastery: 0,
    intervalDays: 1,
    nextReview: '2026-07-30',
    reviewCount: 0,
  },
];

let state = createEmptyState();
let currentFlashcard = null;
let currentQuizItem = null;
let currentQuizOptions = [];
let showReading = true;
let activeCategory = 'all';
let showDueOnly = false;
let maxNewCardsPerDay = 10;
let maxReviewsPerDay = 10;

function createEmptyState() {
  return {
    items: [],
    streak: 0,
    lastStudyDate: null,
    sessions: 0,
    preferences: {
      category: 'all',
      showDueOnly: false,
      maxNewCardsPerDay: 10,
      maxReviewsPerDay: 10,
    },
  };
}

function createDefaultState(items = defaultItems) {
  return {
    items: normalizeItems(items.map((item) => ({ ...item, nextReview: todayKey() }))),
    streak: 0,
    lastStudyDate: null,
    sessions: 0,
    preferences: {
      category: 'all',
      showDueOnly: false,
      maxNewCardsPerDay: 10,
      maxReviewsPerDay: 10,
    },
  };
}

async function loadContentItems() {
  try {
    const [kanjiItems, vocabularyItems, grammarItems] = await Promise.all([
      fetch('content/kanji.json').then((response) => response.json()),
      fetch('content/vocabulary.json').then((response) => response.json()),
      fetch('content/grammar.json').then((response) => response.json()),
    ]);

    return [...kanjiItems, ...vocabularyItems, ...grammarItems];
  } catch (error) {
    console.warn('Unable to load content JSON files, using fallback items.', error);
    return defaultItems;
  }
}

function loadState(contentItems) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const defaultState = createDefaultState(contentItems);

    if (!raw) {
      return defaultState;
    }

    const parsed = JSON.parse(raw);
    const contentMap = new Map(contentItems.map((item) => [item.id, item]));
    const persistedItems = Array.isArray(parsed.items) ? parsed.items : [];
    const mergedItems = contentItems.map((item) => {
      const persistedItem = persistedItems.find((entry) => entry.id === item.id);
      return {
        ...item,
        ...(persistedItem || {}),
        reading: normalizeReading((persistedItem && persistedItem.reading) || item.reading || ''),
        nextReview: persistedItem?.nextReview || todayKey(),
        mastery: persistedItem?.mastery ?? 0,
        intervalDays: persistedItem?.intervalDays ?? 1,
        reviewCount: persistedItem?.reviewCount ?? 0,
      };
    });

    const stateWithMergedItems = {
      ...defaultState,
      ...parsed,
      items: mergedItems,
      preferences: {
        ...defaultState.preferences,
        ...(parsed.preferences || {}),
      },
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(stateWithMergedItems));
    return stateWithMergedItems;
  } catch (error) {
    console.warn('Unable to load saved study state, using default content.', error);
    return createDefaultState(contentItems);
  }
}

async function initializeState() {
  const contentItems = await loadContentItems();
  state = loadState(contentItems);
  return state;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateInput, days) {
  const safeDateInput = typeof dateInput === 'string' && dateInput
    ? dateInput
    : todayKey();
  const date = new Date(safeDateInput);
  if (Number.isNaN(date.getTime())) {
    return todayKey();
  }
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeReading(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .trim()
    .replace(/[\u30A0-\u30FF]/g, '')
    .replace(/[^\u3040-\u309F\/\s]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*/g, ' / ')
    .trim();
}

function normalizeItems(items) {
  const defaultMap = Object.fromEntries(defaultItems.map((item) => [item.id, item]));

  return items.map((item) => {
    const reference = defaultMap[item.id] || {};
    const rawReading = item.reading || reference.reading || '';
    const normalizedReading = normalizeReading(rawReading);

    let correctedReading = normalizedReading;
    if (item.id === 'grammar-2') {
      correctedReading = 'ようとおもう';
    } else if (!correctedReading && reference.reading) {
      correctedReading = normalizeReading(reference.reading);
    }

    return {
      ...reference,
      ...item,
      reading: correctedReading,
    };
  });
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function getContentItems() {
  return Array.isArray(state.items) ? state.items : [];
}

function getFilteredItems() {
  const items = getContentItems();
  const byCategory = activeCategory === 'all'
    ? items
    : items.filter((item) => {
        const categories = Array.isArray(item.categories) ? item.categories : [];
        return categories.includes(activeCategory);
      });

  if (!showDueOnly) {
    return byCategory;
  }

  const today = todayKey();
  return byCategory.filter((item) => item.nextReview <= today);
}

function getDueItems() {
  const today = todayKey();
  return getFilteredItems().filter((item) => item.nextReview <= today);
}

function getStudyItems() {
  const filtered = getFilteredItems();
  const due = getDueItems();
  const reviewedDue = due.filter((item) => (item.reviewCount ?? 0) > 0);
  const newCards = filtered.filter((item) => (item.reviewCount ?? 0) === 0);

  const reviewItems = reviewedDue.slice(0, maxReviewsPerDay);
  const newItemPool = newCards.slice(0, maxNewCardsPerDay);
  const combined = [...reviewItems, ...newItemPool];

  if (combined.length) {
    return combined;
  }

  return filtered.slice(0, Math.max(maxNewCardsPerDay, maxReviewsPerDay));
}

function updateStreak() {
  const today = todayKey();
  if (!state.lastStudyDate) {
    state.streak = 1;
  } else if (state.lastStudyDate === today) {
    state.streak = state.streak;
  } else {
    const yesterday = addDays(today, -1);
    if (state.lastStudyDate === yesterday) {
      state.streak += 1;
    } else {
      state.streak = 1;
    }
  }
  state.lastStudyDate = today;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getPrimaryReading(reading) {
  if (typeof reading !== 'string') {
    return '';
  }

  const trimmed = reading.trim();
  if (!trimmed) {
    return '';
  }

  const [firstReading] = trimmed.split('/');
  return firstReading.trim();
}

function formatReadingDisplay(reading) {
  if (typeof reading !== 'string') {
    return '';
  }

  const normalized = normalizeReading(reading);
  if (!normalized) {
    return '';
  }

  const parts = normalized.split('/').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 2) {
    return `${parts[0]} / ${parts[1]}`;
  }

  return normalized.replace(/\s*\/\s*/g, ' / ');
}

function getExampleReading(item, exampleText) {
  if (!item) {
    return '';
  }

  if (typeof item.exampleReading === 'string' && item.exampleReading.trim()) {
    return item.exampleReading.trim();
  }

  const overrides = {
    'kanji-004': 'よん',
    'kanji-007': 'なな',
    'kanji-011': 'きょう',
    'kanji-012': 'げつ',
    'kanji-014': 'みず',
    'kanji-015': 'き',
    'kanji-016': 'かね',
    'kanji-017': 'つち',
  };

  if (overrides[item.id]) {
    return overrides[item.id];
  }

  const reading = typeof item.reading === 'string' ? item.reading : '';
  if (!reading) {
    return '';
  }

  const parts = normalizeReading(reading).split('/').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 2 && exampleText) {
    if (typeof item.japanese === 'string' && item.japanese.length === 1 && /[一二三四五六七八九十日月火水木金土]/.test(item.japanese)) {
      return parts[1] || parts[0];
    }
  }

  return getPrimaryReading(reading);
}

function renderFuriganaExample(item) {
  if (!item) {
    return '';
  }

  const example = item.example || '';
  if (!example) {
    return escapeHtml(example);
  }

  const itemsByJapanese = new Map();
  const allItems = Array.isArray(state.items) ? state.items : [];
  allItems.forEach((entry) => {
    if (entry && typeof entry.japanese === 'string' && entry.japanese.length === 1) {
      itemsByJapanese.set(entry.japanese, entry);
    }
  });

  const segments = [];
  Array.from(example).forEach((char) => {
    const entry = itemsByJapanese.get(char);
    if (!entry) {
      segments.push(escapeHtml(char));
      return;
    }

    const reading = getExampleReading(entry, example);
    if (!reading) {
      segments.push(escapeHtml(char));
      return;
    }

    segments.push(`<ruby>${escapeHtml(char)}<rt>${escapeHtml(reading)}</rt></ruby>`);
  });

  return segments.join('');
}

function renderDashboard() {
  const dueItems = getDueItems();
  const masteredItems = getFilteredItems().filter((item) => item.mastery >= 70).length;
  const studyItems = getStudyItems();

  document.getElementById('dueToday').textContent = dueItems.length;
  document.getElementById('masteredCount').textContent = masteredItems;
  document.getElementById('streakCount').textContent = state.streak;

  const overview = dueItems.length
    ? `${dueItems.length} items are ready for review today. ${studyItems.length} will be pulled into your current study session.`
    : 'All items are caught up. Great work!';
  document.getElementById('overviewText').textContent = overview;

  const list = document.getElementById('dueList');
  list.innerHTML = '';
  dueItems.slice(0, 6).forEach((item) => {
    const li = document.createElement('li');
    li.textContent = `${item.japanese} — ${item.meaning}`;
    list.appendChild(li);
  });
}

function renderFlashcard() {
  const items = getStudyItems();
  currentFlashcard = items[Math.floor(Math.random() * items.length)] || state.items[0];

  const typeEl = document.getElementById('flashcardType');
  const frontEl = document.getElementById('flashcardFront');
  const readingEl = document.getElementById('flashcardReading');
  const hintEl = document.getElementById('flashcardHint');
  const backEl = document.getElementById('flashcardBack');
  const reviewActions = document.getElementById('reviewActions');
  const toggleButton = document.getElementById('toggleReadingButton');

  const formattedReading = showReading && currentFlashcard.reading
    ? `Reading: ${formatReadingDisplay(currentFlashcard.reading)}`
    : '';
  const frontText = showReading
    ? currentFlashcard.japanese
    : formatReadingDisplay(currentFlashcard.reading) || currentFlashcard.japanese;

  typeEl.textContent = currentFlashcard.type;
  frontEl.textContent = frontText;
  frontEl.classList.toggle('kana-only', !showReading && Boolean(currentFlashcard.reading));
  readingEl.textContent = formattedReading;
  readingEl.style.display = showReading ? 'block' : 'none';
  toggleButton.textContent = showReading ? 'Hide reading' : 'Show reading';
  hintEl.textContent = 'Tap reveal to see the meaning and example.';
  backEl.hidden = true;
  backEl.innerHTML = '';
  reviewActions.hidden = true;
}

function revealFlashcard() {
  if (!currentFlashcard) {
    renderFlashcard();
    return;
  }
  const backEl = document.getElementById('flashcardBack');
  const categories = Array.isArray(currentFlashcard.categories) && currentFlashcard.categories.length
    ? currentFlashcard.categories.join(', ')
    : '—';
  const readingText = formatReadingDisplay(currentFlashcard.reading || '—') || '—';
  backEl.hidden = false;
  backEl.innerHTML = `<strong>${escapeHtml(currentFlashcard.meaning)}</strong><br />Reading: ${escapeHtml(readingText)}<br />Categories: ${escapeHtml(categories)}<br />Example: <span class="example-text">${renderFuriganaExample(currentFlashcard)}</span>`;
  document.getElementById('reviewActions').hidden = false;
}

function handleReview(rating) {
  if (!currentFlashcard) {
    return;
  }

  const item = state.items.find((entry) => entry.id === currentFlashcard.id);
  if (!item) {
    return;
  }

  item.reviewCount += 1;
  item.mastery = Math.min(100, item.mastery + (rating === 'again' ? 0 : rating === 'good' ? 12 : 22));
  const intervalMap = {
    again: 1,
    good: Math.max(2, item.intervalDays + 1),
    easy: Math.max(3, item.intervalDays * 2),
  };
  item.intervalDays = intervalMap[rating];
  item.nextReview = addDays(todayKey(), item.intervalDays);

  updateStreak();
  saveState();
  renderDashboard();
  renderFlashcard();
}

function buildQuiz() {
  const items = getStudyItems().slice(0, 5);
  if (!items.length) {
    return;
  }

  const item = items[Math.floor(Math.random() * items.length)];
  const distractors = getFilteredItems()
    .filter((entry) => entry.id !== item.id)
    .sort(() => 0.5 - Math.random())
    .slice(0, 3)
    .map((entry) => entry.meaning);

  currentQuizItem = item;
  currentQuizOptions = [item.meaning, ...distractors].sort(() => 0.5 - Math.random());

  document.getElementById('quizType').textContent = `${item.type} quiz`;
  document.getElementById('quizPrompt').textContent = `What does “${item.japanese}” mean?`;
  const optionsEl = document.getElementById('quizOptions');
  optionsEl.innerHTML = '';
  currentQuizOptions.forEach((option) => {
    const button = document.createElement('button');
    button.className = 'quiz-option';
    button.textContent = option;
    button.addEventListener('click', () => handleQuizAnswer(option));
    optionsEl.appendChild(button);
  });

  document.getElementById('quizFeedback').hidden = true;
  document.getElementById('nextQuizButton').hidden = true;
}

function handleQuizAnswer(option) {
  if (!currentQuizItem) {
    return;
  }
  const isCorrect = option === currentQuizItem.meaning;
  const feedbackEl = document.getElementById('quizFeedback');
  feedbackEl.hidden = false;
  feedbackEl.textContent = isCorrect
    ? `Correct! ${currentQuizItem.japanese} means “${currentQuizItem.meaning}”.`
    : `Not quite. The correct answer is “${currentQuizItem.meaning}”.`;
  document.getElementById('nextQuizButton').hidden = false;

  const item = state.items.find((entry) => entry.id === currentQuizItem.id);
  if (item) {
    item.reviewCount += 1;
    item.mastery = Math.min(100, item.mastery + (isCorrect ? 10 : 0));
    item.intervalDays = isCorrect ? Math.max(2, item.intervalDays + 1) : 1;
    item.nextReview = addDays(todayKey(), item.intervalDays);
  }

  updateStreak();
  saveState();
  renderDashboard();
}

function switchView(viewName) {
  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('active', view.id === viewName);
  });
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.view === viewName);
  });
}

function resetProgress() {
  const contentItems = getContentItems().length ? getContentItems() : defaultItems;
  const savedPreferences = state.preferences || {};
  state = createDefaultState(contentItems);
  state.preferences = {
    ...state.preferences,
    ...savedPreferences,
    maxNewCardsPerDay: Number(document.getElementById('newCardsLimit')?.value) || 10,
    maxReviewsPerDay: Number(document.getElementById('reviewLimit')?.value) || 10,
  };
  saveState();
  syncDailyLimitsFromState();
  renderDashboard();
  renderFlashcard();
  buildQuiz();
}

function toggleReadingView() {
  showReading = !showReading;
  renderFlashcard();
}

function syncFilterControlsFromState() {
  const select = document.getElementById('categoryFilter');
  const quizSelect = document.getElementById('quizCategoryFilter');
  const dueToggle = document.getElementById('dueOnlyFilter');
  const quizDueToggle = document.getElementById('quizDueOnlyFilter');

  activeCategory = state.preferences?.category || 'all';
  showDueOnly = Boolean(state.preferences?.showDueOnly);

  if (select) {
    select.value = activeCategory;
  }
  if (quizSelect) {
    quizSelect.value = activeCategory;
  }
  if (dueToggle) {
    dueToggle.checked = showDueOnly;
  }
  if (quizDueToggle) {
    quizDueToggle.checked = showDueOnly;
  }
}

function syncDailyLimitsFromState() {
  const newCardsInput = document.getElementById('newCardsLimit');
  const reviewInput = document.getElementById('reviewLimit');

  maxNewCardsPerDay = Number(state.preferences?.maxNewCardsPerDay ?? 10) || 10;
  maxReviewsPerDay = Number(state.preferences?.maxReviewsPerDay ?? 10) || 10;

  if (newCardsInput) {
    newCardsInput.value = maxNewCardsPerDay;
  }
  if (reviewInput) {
    reviewInput.value = maxReviewsPerDay;
  }
}

function updateCategoryFilter() {
  const select = document.getElementById('categoryFilter');
  const quizSelect = document.getElementById('quizCategoryFilter');
  const dueToggle = document.getElementById('dueOnlyFilter');
  const quizDueToggle = document.getElementById('quizDueOnlyFilter');

  if (select) {
    activeCategory = select.value;
  }
  if (quizSelect) {
    activeCategory = quizSelect.value;
  }
  if (dueToggle) {
    showDueOnly = dueToggle.checked;
  }
  if (quizDueToggle) {
    showDueOnly = quizDueToggle.checked;
  }

  const newCardsInput = document.getElementById('newCardsLimit');
  const reviewInput = document.getElementById('reviewLimit');

  maxNewCardsPerDay = Number(newCardsInput?.value) || 10;
  maxReviewsPerDay = Number(reviewInput?.value) || 10;

  state.preferences = {
    ...state.preferences,
    category: activeCategory,
    showDueOnly,
    maxNewCardsPerDay,
    maxReviewsPerDay,
  };
  saveState();

  renderDashboard();
  renderFlashcard();
  buildQuiz();
}

async function init() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });
  document.getElementById('revealButton').addEventListener('click', revealFlashcard);
  document.querySelectorAll('[data-rating]').forEach((button) => {
    button.addEventListener('click', () => handleReview(button.dataset.rating));
  });
  document.getElementById('nextQuizButton').addEventListener('click', buildQuiz);
  document.getElementById('resetButton').addEventListener('click', resetProgress);
  document.getElementById('toggleReadingButton').addEventListener('click', toggleReadingView);
  document.getElementById('categoryFilter').addEventListener('change', updateCategoryFilter);
  document.getElementById('quizCategoryFilter').addEventListener('change', updateCategoryFilter);
  document.getElementById('dueOnlyFilter').addEventListener('change', updateCategoryFilter);
  document.getElementById('quizDueOnlyFilter').addEventListener('change', updateCategoryFilter);
  document.getElementById('newCardsLimit').addEventListener('change', updateCategoryFilter);
  document.getElementById('reviewLimit').addEventListener('change', updateCategoryFilter);

  await initializeState();
  syncFilterControlsFromState();
  syncDailyLimitsFromState();
  renderDashboard();
  renderFlashcard();
  buildQuiz();
}

init();
