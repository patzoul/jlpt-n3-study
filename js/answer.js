// Grading a typed answer against a subject.

import { toKana, toHiragana } from './kana.js';
import { allSubjects, meaningAnswers, readingAnswers } from './content.js';

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
  return answers.some((answer) => {
    const variants = meaningVariants(answer);
    if (variants.has(typed)) {
      return true;
    }
    // "night" is one letter from "light", but it is a real answer to another
    // card, so it is a wrong answer here rather than a slip of the finger.
    if (knownMeanings().has(typed)) {
      return false;
    }
    for (const variant of variants) {
      if (isTypoOf(typed, variant)) {
        return true;
      }
    }
    return false;
  });
}

let knownCache = null;
let knownCacheSize = -1;

/** Every accepted meaning of every card, to tell a typo from a wrong word. */
function knownMeanings() {
  const subjects = allSubjects();
  if (!knownCache || knownCacheSize !== subjects.length) {
    knownCache = new Set();
    for (const subject of subjects) {
      for (const meaning of meaningAnswers(subject)) {
        for (const variant of meaningVariants(meaning)) {
          knownCache.add(variant);
        }
      }
    }
    knownCacheSize = subjects.length;
  }
  return knownCache;
}

// Short answers are left strict: one letter is the whole difference between
// "form" and "from", or "then" and "than".
const MIN_TYPO_LENGTH = 5;

/**
 * True when `typed` is one slip away from `answer`: a wrong, missing or extra
 * character, or two neighbours swapped ("recieve").
 */
export function isTypoOf(typed, answer) {
  if (answer.length < MIN_TYPO_LENGTH || /\d/.test(answer)) {
    return false;
  }
  // Slips rarely land on the first letter, while a different first letter is
  // usually a different word: other/mother, rice/price, fault/vault.
  if (typed[0] !== answer[0]) {
    return false;
  }
  const gap = typed.length - answer.length;
  if (Math.abs(gap) > 1) {
    return false;
  }

  let start = 0;
  while (start < typed.length && start < answer.length && typed[start] === answer[start]) {
    start += 1;
  }
  const restTyped = typed.slice(start);
  const restAnswer = answer.slice(start);

  if (gap === 1) {
    return restTyped.slice(1) === restAnswer;            // extra character
  }
  if (gap === -1) {
    return restTyped === restAnswer.slice(1);            // missing character
  }
  if (restTyped.slice(1) === restAnswer.slice(1)) {
    return true;                                         // wrong character
  }
  return (
    restTyped.length >= 2
    && restTyped[0] === restAnswer[1]
    && restTyped[1] === restAnswer[0]
    && restTyped.slice(2) === restAnswer.slice(2)        // swapped neighbours
  );
}

const BRACKETED = /\(([^()]*)\)/;
const MAX_BRACKETS = 4;

/**
 * Every way of reading the brackets in a gloss. Each bracket is optional, so
 * it can be typed or left out:
 *
 *   content(s)             -> content, contents
 *   to spread (out)        -> to spread, to spread out
 *   (gram) particle(s)     -> particle, particles, gram particle, gram particles
 *
 * A bracket glued to a word is a suffix (contents); one standing apart is a
 * separate word (spread out).
 */
function expandBrackets(text, depth = 0) {
  const match = BRACKETED.exec(text);
  if (!match || depth >= MAX_BRACKETS) {
    return [text];
  }
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  const inside = match[1];

  // "content(s)", "immediate(ly)": a short ending stuck to a word.
  const isSuffix = /[a-z]$/i.test(before) && /^[a-z]{1,3}$/i.test(inside);
  const kept = expandBrackets(
    `${before}${isSuffix ? '' : ' '}${inside}${after}`, depth + 1
  );

  // "(not) always" without its bracket means the opposite, so that bracket is
  // part of the answer rather than an optional extra.
  if (/\b(?:not|no|non)\b/i.test(inside)) {
    return kept;
  }
  return [...expandBrackets(`${before} ${after}`, depth + 1), ...kept];
}

const variantCache = new Map();

/** The normalised forms of one gloss that count as a correct answer. */
export function meaningVariants(answer) {
  let variants = variantCache.get(answer);
  if (!variants) {
    // The literal gloss stays valid too, so typing "content(s)" still passes.
    variants = new Set(
      [answer, ...expandBrackets(answer)].map(meaningKey).filter(Boolean)
    );
    variantCache.set(answer, variants);
  }
  return variants;
}
