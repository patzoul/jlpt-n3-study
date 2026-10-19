// Loads the built decks and answers questions about what is unlockable.

import { GURU } from './srs.js';

let subjects = [];
let byId = new Map();
let manifest = { levels: 1, counts: {} };
let editsVersion = 0;

export async function loadContent() {
  const [kanji, vocabulary, grammar, meta] = await Promise.all([
    fetch('content/kanji.json').then((r) => r.json()),
    fetch('content/vocabulary.json').then((r) => r.json()),
    fetch('content/grammar.json').then((r) => r.json()),
    fetch('content/manifest.json').then((r) => r.json()),
  ]);

  manifest = meta;
  subjects = [...kanji, ...vocabulary, ...grammar];
  subjects.forEach((subject) => {
    subject.deckMeanings = subject.meanings;
  });
  byId = new Map(subjects.map((subject) => [subject.id, subject]));
  // A merged homograph still answers to the ids of the cards it replaced, so
  // old progress and review history find it.
  subjects.forEach((subject) => {
    (subject.aliases || []).forEach((alias) => byId.set(alias, subject));
  });
  return { subjects, manifest };
}

/** Old card id → the id of the card it was merged into. */
export function aliasIds() {
  const map = new Map();
  subjects.forEach((subject) => {
    (subject.aliases || []).forEach((alias) => map.set(alias, subject.id));
  });
  return map;
}

/**
 * Put your own wording on cards. Edited meanings replace the deck's, both on
 * screen and when answers are checked; a card with no edit (or a restored
 * one) shows the deck's meanings again.
 *
 * @param {Object<string, {meanings: string[]|null}>} edits keyed by card id
 */
export function applyMeaningEdits(edits) {
  subjects.forEach((subject) => {
    const edit = edits[subject.id];
    const mine = edit && edit.meanings && edit.meanings.length ? edit.meanings : null;
    subject.meanings = mine || subject.deckMeanings;
    subject.primaryMeaning = subject.meanings[0];
    subject.edited = Boolean(mine);
  });
  editsVersion += 1;
}

/** Changes whenever meanings change, for caches built from them. */
export function meaningsVersion() {
  return editsVersion;
}

export function allSubjects() {
  return subjects;
}

export function getSubject(id) {
  return byId.get(id);
}

export function getManifest() {
  return manifest;
}

export function subjectsAtLevel(level) {
  return subjects.filter((subject) => subject.level === level);
}

/** The kanji subject for a single character, if it is part of the N3 set. */
export function kanjiSubject(character) {
  return byId.get(`k-${character}`);
}

/**
 * A subject can be started when its level is unlocked and its prerequisites
 * are at Guru. Vocabulary waits for the kanji it is written with; kanji and
 * grammar only wait for the level itself.
 */
export function isUnlocked(subject, currentLevel, progressById) {
  if (subject.level > currentLevel) {
    return false;
  }
  if (subject.type !== 'vocabulary' || !subject.componentKanji.length) {
    return true;
  }
  return subject.componentKanji.every((character) => {
    const progress = progressById.get(`k-${character}`);
    return progress && progress.stage >= GURU;
  });
}

/** Component kanji that are still holding a vocabulary subject back. */
export function blockingKanji(subject, progressById) {
  if (subject.type !== 'vocabulary') {
    return [];
  }
  return subject.componentKanji.filter((character) => {
    const progress = progressById.get(`k-${character}`);
    return !progress || progress.stage < GURU;
  });
}

/**
 * WaniKani levels up once 90% of the level's kanji have reached Guru.
 * Vocabulary and grammar do not gate progression.
 */
export function levelProgress(level, progressById, threshold = 0.9) {
  const kanji = subjects.filter(
    (subject) => subject.level === level && subject.type === 'kanji'
  );
  if (!kanji.length) {
    return { passed: 0, total: 0, ratio: 1, canLevelUp: true };
  }
  const passed = kanji.filter((subject) => {
    const progress = progressById.get(subject.id);
    return progress && progress.stage >= GURU;
  }).length;
  const ratio = passed / kanji.length;
  return { passed, total: kanji.length, ratio, canLevelUp: ratio >= threshold };
}

/** Every question a subject is reviewed on. */
export function questionsFor(subject, askReading) {
  const questions = [{ kind: 'meaning' }];
  if (askReading && subject.type !== 'grammar' && readingAnswers(subject).length) {
    questions.push({ kind: 'reading' });
  }
  return questions;
}

export function meaningAnswers(subject) {
  return (subject.meanings || []).map((meaning) => meaning.toLowerCase().trim());
}

export function readingAnswers(subject) {
  if (subject.type === 'vocabulary') {
    // A word written one way but read several (品: しな / ひん) takes any.
    return subject.readings || (subject.reading ? [subject.reading] : []);
  }
  if (subject.type === 'kanji') {
    // Any of the taught readings is accepted; WaniKani is stricter, but for
    // self-study accepting on'yomi or kun'yomi keeps the focus on recognition.
    return [...(subject.readingsOn || []), ...(subject.readingsKun || [])].filter(
      Boolean
    );
  }
  return [];
}
