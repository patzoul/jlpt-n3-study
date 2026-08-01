// WaniKani-style spaced repetition.
//
// A subject sits at one SRS stage. Getting it right moves it up one stage;
// getting it wrong drops it by one stage in Apprentice, or two from Guru up,
// multiplied by the number of times it was missed in the session.

export const STAGES = [
  { stage: 0, name: 'Lesson',      group: 'lesson',      hours: 0 },
  { stage: 1, name: 'Apprentice I',   group: 'apprentice',  hours: 4 },
  { stage: 2, name: 'Apprentice II',  group: 'apprentice',  hours: 8 },
  { stage: 3, name: 'Apprentice III', group: 'apprentice',  hours: 24 },
  { stage: 4, name: 'Apprentice IV',  group: 'apprentice',  hours: 48 },
  { stage: 5, name: 'Guru I',         group: 'guru',        hours: 168 },
  { stage: 6, name: 'Guru II',        group: 'guru',        hours: 336 },
  { stage: 7, name: 'Master',         group: 'master',      hours: 720 },
  { stage: 8, name: 'Enlightened',    group: 'enlightened', hours: 2880 },
  { stage: 9, name: 'Burned',         group: 'burned',      hours: Infinity },
];

export const GURU = 5;
export const BURNED = 9;

export const STAGE_GROUPS = ['apprentice', 'guru', 'master', 'enlightened', 'burned'];

export function stageInfo(stage) {
  return STAGES[Math.max(0, Math.min(STAGES.length - 1, stage))];
}

export function stageName(stage) {
  return stageInfo(stage).name;
}

export function stageGroup(stage) {
  return stageInfo(stage).group;
}

/**
 * Next stage after a review.
 * @param {number} stage current stage
 * @param {number} incorrect how many times the subject was missed this session
 */
export function nextStage(stage, incorrect) {
  if (incorrect === 0) {
    return Math.min(BURNED, stage + 1);
  }
  // WaniKani's penalty: 1 per pair of misses below Guru, 2 per pair at Guru+.
  const wrongAdjustment = Math.ceil(incorrect / 2);
  const penalty = stage >= GURU ? 2 : 1;
  return Math.max(1, stage - wrongAdjustment * penalty);
}

/** When a subject at `stage` should next come up, in epoch milliseconds. */
export function nextReviewAt(stage, from = Date.now()) {
  const { hours } = stageInfo(stage);
  if (!Number.isFinite(hours)) {
    return null;
  }
  return from + hours * 3600 * 1000;
}

/**
 * Apply a graded review to a progress record and return the updated copy.
 * `incorrect` is the number of wrong answers given for the subject this session.
 */
export function applyReview(progress, incorrect, now = Date.now()) {
  const from = progress.stage;
  const to = nextStage(from, incorrect);
  const next = {
    ...progress,
    stage: to,
    nextReviewAt: nextReviewAt(to, now),
    lastReviewedAt: now,
    reviewCount: (progress.reviewCount || 0) + 1,
    correctCount: (progress.correctCount || 0) + (incorrect === 0 ? 1 : 0),
    incorrectCount: (progress.incorrectCount || 0) + (incorrect > 0 ? 1 : 0),
  };
  if (to >= GURU && from < GURU && !progress.passedAt) {
    next.passedAt = now;
  }
  if (to === BURNED && !progress.burnedAt) {
    next.burnedAt = now;
  }
  return next;
}

/** A freshly started subject: stage 1, due after the first interval. */
export function startSubject(subjectId, type, level, now = Date.now()) {
  return {
    id: subjectId,
    type,
    level,
    stage: 1,
    startedAt: now,
    nextReviewAt: nextReviewAt(1, now),
    lastReviewedAt: null,
    passedAt: null,
    burnedAt: null,
    reviewCount: 0,
    correctCount: 0,
    incorrectCount: 0,
  };
}

export function isDue(progress, now = Date.now()) {
  return (
    progress
    && progress.stage > 0
    && progress.stage < BURNED
    && progress.nextReviewAt !== null
    && progress.nextReviewAt <= now
  );
}
