# JLPT N3 Study

A WaniKani-style spaced-repetition app for the JLPT N3 syllabus — kanji,
vocabulary and grammar — with per-day control over new items and reviews, and a
progress view that shows where the time is actually going.

No build step, no dependencies. Plain ES modules, IndexedDB for storage.
Installs as an offline app on a phone, and can sync your schedule between
devices through a small self-hosted endpoint.

## Running it

The decks are fetched over HTTP, so the folder has to be served — opening
`index.html` from disk will not work.

```bash
python -m http.server 8123
```

Then open <http://localhost:8123>.

## Using it on your phone

The app is a PWA: open it over HTTPS and your browser will offer to install it
to the home screen. Once installed the whole thing — shell and all three decks,
about 1.6 MB — is cached, so it opens and reviews work with no connection. The
decks refresh in the background whenever you next have one.

## Syncing between devices

By default your progress is local to one browser. That is a real problem for an
SRS: study on a phone and a laptop and you end up with two unrelated schedules,
each with a wrong idea of what is due.

`worker/` holds a small Cloudflare Worker that fixes this. Deploy it once (see
`worker/README.md`, about five minutes), then in **Settings → Sync across
devices** give every device the same server address and passphrase.

Two things worth knowing about how it works:

**The server cannot read your data.** Your passphrase derives an encryption key
and a storage id via PBKDF2; the payload is encrypted with AES-GCM in the
browser and only the ciphertext is uploaded. The passphrase never leaves the
device, so nobody — including whoever runs the Worker — can recover it or read
what you are studying. Lose it and the synced copy is unrecoverable.

**Syncing merges, it never overwrites.** If both devices studied offline, each
holds answers the other has not seen. A last-write-wins sync would throw one
side away and quietly corrupt your schedule. Instead the review logs are
unioned, the more recently reviewed record wins per subject, daily counters take
the maximum so spent allowance is not refunded, and level and streak take
whichever is further along. `test/sync.test.mjs` pins all of that down.

## What is in the decks

| | Count | Examples |
| --- | --- | --- |
| Kanji | 367 | every card has a sentence and example words |
| Vocabulary | 2,140 | every card has a sentence |
| Grammar | 150 | every card has two sentences |

Content is split across 37 levels of 10 kanji, with vocabulary attached to the
level of its last-learned kanji.

Of the 2,657 example sentences, 801 are hand-written for this app and the rest
are Tatoeba sentences filtered to N3 level. Authored sentences also carry a kana
reading, so the whole sentence can be read back.

## How study works

**Levels.** Kanji are ordered by WaniKani level then frequency and dealt into
levels of ten. You level up when 90% of the current level's kanji reach Guru
(configurable in Settings).

**Unlocking.** Kanji and grammar unlock with their level. A vocabulary word
unlocks once every N3 kanji it is written with has reached Guru, so you never
meet a word before its characters. The Lessons view lists what is currently
blocked and on which kanji.

**SRS.** Nine stages, WaniKani intervals: Apprentice I–IV (4h, 8h, 1d, 2d),
Guru I–II (1w, 2w), Master (1mo), Enlightened (4mo), Burned. A correct answer
moves up one stage. A wrong answer drops one stage below Guru, two at Guru and
above, scaled by how many times you missed it in the session.

**Reviews.** Each kanji and vocabulary item is asked for both meaning and
reading; the item only advances when both are answered correctly in the same
session. Readings are typed in romaji and converted to kana as you type
(`gakkou` → `がっこう`), or you can type kana directly. Grammar is asked for
meaning only.

**Daily caps.** `New items per day` and `Reviews per day` in Settings are
enforced against per-day counters that reset at local midnight. This is the main
lever for controlling workload; the review forecast on the Progress page shows
what a given pace will cost you two weeks out.

## Progress view

Syllabus coverage by type, 60 days of answer history with accuracy, accuracy
split by item type and by question kind, a 14-day review forecast, per-level
completion, and a list of items you have missed three or more times.

## Rebuilding the content

```bash
python content/parse_dump.py && python content/build_content.py && python content/validate.py
```

- `parse_dump.py` pulls Tatoeba example sentences out of the Anki-export CSVs in
  `jlpt-N3-tiered/` (they arrive as styled HTML blobs) into
  `content/sources/dump_examples.json`.
- `build_content.py` joins the syllabus lists with that sentence pool and the
  hand-authored sources, and writes `content/{kanji,vocabulary,grammar,manifest}.json`.
- `validate.py` checks the result: duplicate ids and duplicate card fronts,
  missing fields, unbalanced brackets, sentences that do not contain the word
  they teach, English words left inside Japanese text, and stray characters
  from other scripts (a Hangul or Cyrillic lookalike typed into a Japanese
  sentence is easy to miss by eye and impossible to miss here).

Entries in `authored_examples.json` are keyed by the vocabulary word. Homographs
that need different sentences per reading are keyed `word|reading` — for example
`"為る|する"` and `"為る|なる"`. A kanji that appears in no N3 vocabulary entry
can be keyed by the character itself.

Example sentences are chosen by a scorer that rejects anything with kanji above
N3, prefers roughly 20 characters, and penalises multi-clause sentences.
Hand-written sentences in `content/sources/authored_examples.json` always win
over a Tatoeba one.

### Sources

| Source | Used for |
| --- | --- |
| [davidluzgouveia/kanji-data](https://github.com/davidluzgouveia/kanji-data) | The 367 N3 kanji, readings, stroke counts, WaniKani levels and radicals |
| [jamsinclair/open-anki-jlpt-decks](https://github.com/jamsinclair/open-anki-jlpt-decks) | The 2,140-word N3 vocabulary list (N5/N4/N2 lists supply example words only) |
| `jlpt-N3-tiered/` (local) | Tatoeba example sentences and frequency tiers |
| `content/sources/grammar_n3.json` | Grammar points, written for this app |

Note that `jlpt-N3-tiered/` is a frequency-tiered JMdict dump, not an N3 deck —
it tags all 69,000 of its entries `N3`. It is used only as a sentence and
frequency source; the syllabus scoping comes from the lists above.

## Tests

```bash
npm test
```

42 tests, no dependencies beyond Node:

- `answer.test.mjs` — romaji-to-kana conversion, answer grading (including an
  exhaustive check that junk input is rejected by every subject in the deck),
  SRS stage transitions and interval growth.
- `sync.test.mjs` — merge semantics, the part where a bug would silently delete
  answers: staleness, unioning, idempotence and symmetry.
- `crypto.test.mjs` — id derivation is deterministic across devices, payloads
  round-trip, ciphertext leaks nothing, a wrong passphrase or a tampered blob is
  rejected.
- `worker.test.mjs` — the sync endpoint's HTTP contract against a KV stub.

## Your data

Progress lives in IndexedDB. Settings has export and import for moving machines
by hand, and sync (above) if you want it automatic. Progress from the first
version of this app is migrated from localStorage automatically on first load.
