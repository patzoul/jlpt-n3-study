// Grading a typed answer against a subject.

import { toKana, toHiragana } from './kana.js';
import { meaningAnswers, readingAnswers } from './content.js';

const LEADING_ARTICLE = /^(?:to|a|an|the)\s+/;

function normaliseMeaning(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')   // drop stray punctuation from the datasets
    .replace(/\s+/g, ' ')
    .trim();
}

function meaningKey(value) {
  return normaliseMeaning(value).replace(LEADING_ARTICLE, '').trim();
}

export function answersFor(subject, kind) {
  return kind === 'meaning' ? meaningAnswers(subject) : readingAnswers(subject);
}

/**
 * @returns {boolean|null} true/false, or null when there is nothing to grade
 *   (empty input, or a subject with no answer of this kind).
 */
export function checkAnswer(subject, kind, raw) {
  const input = String(raw || '').trim();
  if (!input) {
    return null;
  }

  const answers = answersFor(subject, kind).filter(Boolean);
  if (!answers.length) {
    return null;
  }

  if (kind === 'reading') {
    const typed = toHiragana(toKana(input));
    return answers.some((answer) => toHiragana(answer) === typed);
  }

  const typed = meaningKey(input);
  if (!typed) {
    return false;
  }
  return answers.some((answer) => meaningKey(answer) === typed);
}
