// Run with: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { toKana, toHiragana } from '../js/kana.js';
import { checkAnswer } from '../js/answer.js';
import * as content from '../js/content.js';
import { nextStage, nextReviewAt, applyReview, startSubject, GURU, BURNED } from '../js/srs.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (name) => JSON.parse(readFileSync(join(root, 'content', name), 'utf8'));

const kanji = load('kanji.json');
const vocabulary = load('vocabulary.json');
const grammar = load('grammar.json');
const all = [...kanji, ...vocabulary, ...grammar];

// content.js reads from module state populated by loadContent(); stub fetch so
// the same code path works under Node.
globalThis.fetch = async (url) => {
  const name = url.split('/').pop();
  const map = {
    'kanji.json': kanji,
    'vocabulary.json': vocabulary,
    'grammar.json': grammar,
    'manifest.json': load('manifest.json'),
  };
  return { json: async () => map[name] };
};
await content.loadContent();

const find = (characters) => all.find((s) => s.characters === characters);

test('romaji converts to kana', () => {
  assert.equal(toKana('ou'), 'おう');
  assert.equal(toKana('shinbun'), 'しんぶん');
  assert.equal(toKana('kippu'), 'きっぷ');
  assert.equal(toKana('gakkou'), 'がっこう');
  assert.equal(toKana('jisho'), 'じしょ');
  assert.equal(toKana('n'), 'ん');
  assert.equal(toKana('konnichiha'), 'こんにちは');
  assert.equal(toKana('ryokou'), 'りょこう');
  assert.equal(toHiragana('カタカナ'), 'かたかな');
});

// The reading field converts on every keystroke, so replay typing one key at
// a time: the field holds kana plus whatever romaji is still undecided.
function typeLive(romaji) {
  let field = '';
  for (const key of romaji) {
    field = toKana(field + key, { partial: true });
  }
  return field;
}

test('a typed "n" waits for the next key instead of becoming ん', () => {
  assert.equal(typeLive('n'), 'n');
  assert.equal(typeLive('na'), 'な');
  assert.equal(typeLive('ni'), 'に');
  assert.equal(typeLive('nya'), 'にゃ');
  assert.equal(typeLive('nani'), 'なに');
  assert.equal(typeLive('hana'), 'はな');
  assert.equal(typeLive('onna'), 'おんな');
  assert.equal(typeLive("kin'en"), 'きんえn');
});

test('typing key by key ends up where converting the whole word does', () => {
  const words = [
    'na', 'nani', 'onna', 'konnichiha', 'shinbun', 'kippu', 'gakkou', 'ryokou',
    'nyuugaku', 'konnyaku', "gen'in", "tan'i", 'sannin', 'minna', 'annai',
    'benkyou', 'kantan', 'unten', 'nn', 'n', 'hon', 'honya', "hon'ya",
  ];
  for (const word of words) {
    // Submitting applies the final conversion to whatever is in the field.
    assert.equal(toKana(typeLive(word)), toKana(word), word);
  }
});

test('correct meanings are accepted', () => {
  const king = find('王');
  assert.equal(checkAnswer(king, 'meaning', 'king'), true);
  assert.equal(checkAnswer(king, 'meaning', ' King '), true);
  assert.equal(checkAnswer(king, 'meaning', 'the king'), true);
});

test('correct readings are accepted in romaji or kana', () => {
  const king = find('王');
  assert.equal(checkAnswer(king, 'reading', 'ou'), true);
  assert.equal(checkAnswer(king, 'reading', 'おう'), true);
  assert.equal(checkAnswer(king, 'reading', 'オウ'), true);
});

test('wrong answers are rejected', () => {
  const king = find('王');
  assert.equal(checkAnswer(king, 'meaning', 'queen'), false);
  assert.equal(checkAnswer(king, 'reading', 'ki'), false);
});

test('empty input is not graded', () => {
  const king = find('王');
  assert.equal(checkAnswer(king, 'meaning', ''), null);
  assert.equal(checkAnswer(king, 'meaning', '   '), null);
});

test('a junk string is rejected by every subject in the deck', () => {
  const junk = ['deliberately-wrong', 'zzzzz', '???', '.', '-', '  -  '];
  const accepted = [];
  for (const subject of all) {
    for (const kind of ['meaning', 'reading']) {
      for (const value of junk) {
        if (checkAnswer(subject, kind, value) === true) {
          accepted.push([subject.id, kind, value]);
        }
      }
    }
  }
  assert.deepEqual(accepted, []);
});

test('every subject accepts its own primary answers', () => {
  const failures = [];
  for (const subject of all) {
    if (checkAnswer(subject, 'meaning', subject.primaryMeaning) !== true) {
      failures.push([subject.id, 'meaning', subject.primaryMeaning]);
    }
    const reading = subject.type === 'vocabulary' ? subject.reading : subject.primaryReading;
    if (reading && checkAnswer(subject, 'reading', reading) !== true) {
      failures.push([subject.id, 'reading', reading]);
    }
  }
  assert.deepEqual(failures.slice(0, 10), []);
});

test('srs advances and demotes the way WaniKani does', () => {
  assert.equal(nextStage(1, 0), 2);
  assert.equal(nextStage(4, 0), 5);
  assert.equal(nextStage(9, 0), 9, 'burned stays burned');
  assert.equal(nextStage(4, 1), 3, 'one miss below guru drops one stage');
  assert.equal(nextStage(6, 1), 4, 'one miss at guru drops two stages');
  assert.equal(nextStage(1, 5), 1, 'never falls below apprentice I');
});

test('intervals grow with the stage', () => {
  const now = 0;
  const hours = (stage) => (nextReviewAt(stage, now) - now) / 3600000;
  assert.equal(hours(1), 4);
  assert.equal(hours(3), 24);
  assert.equal(hours(5), 168);
  assert.equal(nextReviewAt(BURNED, now), null, 'burned items never come back');
});

test('passing to guru is stamped once', () => {
  let progress = startSubject('k-王', 'kanji', 1, 0);
  for (let i = 0; i < 4; i += 1) {
    progress = applyReview(progress, 0, 1000);
  }
  assert.ok(progress.stage >= GURU);
  assert.equal(progress.passedAt, 1000);
  const first = progress.passedAt;
  progress = applyReview(progress, 0, 5000);
  assert.equal(progress.passedAt, first, 'passedAt is not overwritten');
});
