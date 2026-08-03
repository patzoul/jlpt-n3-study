"""Build the N3 study decks from the sourced datasets.

Inputs (content/sources/):
    kanji_wk.json       kanji-data: KANJIDIC + updated JLPT levels + WaniKani info
    oajd_n3.csv         open-anki-jlpt-decks: the N3 vocabulary list
    dump_examples.json  Tatoeba sentences parsed out of jlpt-N3-tiered
    dump_wordmeta.json  frequency tier per word, from the same dump
    grammar_n3.json     hand-authored N3 grammar points

Outputs (content/):
    kanji.json  vocabulary.json  grammar.json  manifest.json

Levels are WaniKani-style: kanji are ordered by WaniKani level then frequency
and dealt into levels of KANJI_PER_LEVEL. A word belongs to the level of its
last-learned kanji, so you never meet a word before its characters.
"""

import csv
import json
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import furigana  # noqa: E402  (needs the path set above)

BASE = Path(__file__).resolve().parent.parent
SRC = BASE / 'content' / 'sources'
OUT = BASE / 'content'

KANJI_PER_LEVEL = 10
KANJI_RE = re.compile(r'[一-鿿]')
KANA_RE = re.compile(r'[぀-ヿ]')
ANNOTATION_RE = re.compile(r'\s*[（(][^）)]*[）)]\s*')

# Sentences are scored against these bounds; outside them they are rejected.
MIN_SENTENCE = 8
MAX_SENTENCE = 45

# Latin runs of three or more letters are English leaking into the sentence,
# except for these abbreviations, which are ordinary written Japanese.
LATIN_RUN = re.compile(r'[A-Za-z]{3,}')
LATIN_OK = {'cd', 'dvd', 'atm', 'ldk', 'mail', 'ok', 'tv', 'pc'}


def load_sources():
    kanji_all = json.loads((SRC / 'kanji_wk.json').read_text(encoding='utf-8'))
    with (SRC / 'oajd_n3.csv').open(encoding='utf-8') as handle:
        vocab_rows = list(csv.DictReader(handle))
    examples = json.loads((SRC / 'dump_examples.json').read_text(encoding='utf-8'))
    wordmeta = json.loads((SRC / 'dump_wordmeta.json').read_text(encoding='utf-8'))
    grammar_path = SRC / 'grammar_n3.json'
    grammar = (
        json.loads(grammar_path.read_text(encoding='utf-8'))
        if grammar_path.exists()
        else []
    )
    # N5/N4/N2 lists are not taught here; they only supply example words for
    # the handful of N3 kanji that appear in no N3 vocabulary entry.
    neighbour_rows = []
    for level in ('n5', 'n4', 'n2'):
        path = SRC / f'oajd_{level}.csv'
        if path.exists():
            with path.open(encoding='utf-8') as handle:
                neighbour_rows.extend(csv.DictReader(handle))

    authored_path = SRC / 'authored_examples.json'
    authored = (
        json.loads(authored_path.read_text(encoding='utf-8'))
        if authored_path.exists()
        else {}
    )
    return (
        kanji_all, vocab_rows, examples, wordmeta, grammar, authored, neighbour_rows
    )


def dedupe(values):
    """Preserve order, drop blanks and repeats."""
    seen = []
    for value in values:
        if value and value not in seen:
            seen.append(value)
    return seen


def split_meanings(text):
    """Split "a, b, c" into senses without breaking inside brackets.

    The vocabulary list writes glosses like "produce (e.g. rice, vegetables)",
    where a naive comma split would leave a dangling "produce (e.g.".
    """
    parts = []
    current = []
    depth = 0
    for ch in text or '':
        if ch in '([{（「':
            depth += 1
        elif ch in ')]}）」':
            depth = max(0, depth - 1)
        if ch in ',;' and depth == 0:
            parts.append(''.join(current))
            current = []
        else:
            current.append(ch)
    parts.append(''.join(current))

    cleaned = []
    for part in parts:
        part = part.rstrip('(').strip()
        # A few upstream glosses are truncated mid-bracket ("ridge (of roof").
        missing = part.count('(') - part.count(')')
        if missing > 0:
            part += ')' * missing
        if part:
            cleaned.append(part)
    return cleaned or ['(no meaning)']


# WaniKani flags its primary answer with "^" on meanings and "!" on readings.
# We use the flag to pick the primary, then drop the marker.
PRIMARY_MARKS = '^!'


def is_primary(value):
    return value.startswith(tuple(PRIMARY_MARKS))


def unmark(value):
    return value.lstrip(PRIMARY_MARKS).strip()


def title_meanings(values):
    """kanji-data title-cases meanings ("come To An End"); fold to lowercase.

    The vocabulary list is already lowercase, so this keeps both decks reading
    the same way. Acronyms are left alone.
    """
    out = []
    for value in values:
        value = unmark(value)
        if not value:
            continue
        words = [word if word.isupper() else word.lower() for word in value.split(' ')]
        out.append(' '.join(words))
    return out


def assign_kanji_levels(kanji_all):
    """Order the 367 N3 kanji and deal them into levels."""
    n3 = {char: data for char, data in kanji_all.items() if data.get('jlpt_new') == 3}
    ordered = sorted(
        n3.items(),
        key=lambda kv: (kv[1].get('wk_level') or 99, kv[1].get('freq') or 9999, kv[0]),
    )
    levels = {}
    for index, (char, _) in enumerate(ordered):
        levels[char] = index // KANJI_PER_LEVEL + 1
    return n3, ordered, levels


def in_level_charset(kanji_all):
    """Kanji a learner at N3 can be expected to read: N5, N4 and N3."""
    return {
        char
        for char, data in kanji_all.items()
        if data.get('jlpt_new') in (3, 4, 5)
    }


def score_sentence(sentence, word, readable):
    """Higher is better; None means reject."""
    text = sentence['ja']
    if word not in text:
        return None
    length = len(text)
    if not MIN_SENTENCE <= length <= MAX_SENTENCE:
        return None
    if not sentence.get('en'):
        return None

    # Some Tatoeba sentences are English grammar notes written in Japanese
    # ("thatには、主格..."), which teach nothing about the word.
    if any(run.lower() not in LATIN_OK for run in LATIN_RUN.findall(text)):
        return None

    out_of_level = [ch for ch in text if KANJI_RE.match(ch) and ch not in readable]
    score = 100.0
    score -= 6.0 * len(set(out_of_level))       # unknown kanji hurt most
    score -= abs(length - 20) * 0.8             # ~20 chars reads best at N3
    score -= 4.0 * text.count('、')              # multi-clause sentences are harder
    if sentence.get('common'):
        score += 5.0
    score += (5 - sentence.get('tier', 4)) * 2.0
    return score


FURIGANA_STATS = {'aligned': 0, 'tokenised': 0, 'failed': 0}


def attach_furigana(example):
    """Add ruby segments so the sentence can be shown with readings on top."""
    if not example:
        return example
    segments = furigana.build(example['ja'], example.get('reading'))
    if segments is None:
        FURIGANA_STATS['failed'] += 1
    else:
        example['furigana'] = segments
        if example.get('reading'):
            FURIGANA_STATS['aligned'] += 1
        else:
            FURIGANA_STATS['tokenised'] += 1
    return example


def build_sentence_pool(examples):
    """Flatten every sentence in the dump, de-duplicated by Japanese text.

    Sentences are filed in the dump under one headword, but a sentence written
    for one word very often contains several others. Pooling them lets a word
    borrow a sentence that was filed elsewhere.
    """
    pool = {}
    for sentences in examples.values():
        for sentence in sentences:
            existing = pool.get(sentence['ja'])
            if existing is None or sentence.get('tier', 4) < existing.get('tier', 4):
                pool[sentence['ja']] = sentence
    return list(pool.values())


def index_pool(pool):
    """Bucket sentences by the characters they contain for a fast lookup."""
    index = defaultdict(list)
    for sentence in pool:
        for ch in set(sentence['ja']):
            index[ch].append(sentence)
    return index


def standalone(text, word):
    """True when `word` is not glued into a longer compound.

    Without a tokeniser this is a heuristic: a kanji directly adjacent to the
    match usually means we matched part of a bigger word (上 inside 上手).
    """
    start = text.find(word)
    while start != -1:
        before = text[start - 1] if start > 0 else ''
        after_index = start + len(word)
        after = text[after_index] if after_index < len(text) else ''
        if not KANJI_RE.match(before or ' ') and not KANJI_RE.match(after or ' '):
            return True
        start = text.find(word, start + 1)
    return False


def pick_example(word, examples, readable, index=None, authored=None, reading=None):
    # A hand-written sentence always wins: it is pitched at N3 on purpose.
    # Homographs are keyed "word|reading" so 不 (ふ) and 不 (ぶ) can differ.
    if authored:
        entry = authored.get(f'{word}|{reading}') or authored.get(word)
        if entry:
            return attach_furigana({
                'ja': entry['ja'],
                'reading': entry.get('reading', ''),
                'en': entry['en'],
                'source': 'authored',
            })

    candidates = []

    def consider(sentence, bonus):
        score = score_sentence(sentence, word, readable)
        if score is not None and standalone(sentence['ja'], word):
            candidates.append((score + bonus, sentence))

    # Sentences filed under this exact word are the most trustworthy.
    for sentence in examples.get(word, []):
        consider(sentence, 15.0)

    if index is not None:
        # Otherwise scan sentences that contain the word's rarest character.
        rarest = min(word, key=lambda ch: len(index.get(ch, ())), default=None)
        for sentence in index.get(rarest, ()):
            if word in sentence['ja']:
                consider(sentence, 0.0)

    if not candidates:
        return None
    candidates.sort(key=lambda item: -item[0])
    best = candidates[0][1]
    return attach_furigana(
        {'ja': best['ja'], 'en': best['en'], 'source': 'tatoeba'}
    )


def normalise_reading(value):
    """Fold KANJIDIC readings to plain hiragana.

    KANJIDIC marks okurigana with a dot (おこ.る) and prefix/suffix positions
    with a hyphen (-のう); neither belongs on a flashcard.
    """
    out = []
    for ch in unmark(value):
        code = ord(ch)
        if 0x30A1 <= code <= 0x30F6:
            out.append(chr(code - 0x60))
        else:
            out.append(ch)
    return ''.join(out).split('.')[0].strip('-').strip()


def build_kanji(n3, ordered, levels, vocab_by_kanji, examples, readable,
                index=None, authored=None):
    items = []
    for char, data in ordered:
        raw_wk_meanings = data.get('wk_meanings') or []
        wk_meanings = title_meanings(raw_wk_meanings)
        meanings = wk_meanings or title_meanings(data.get('meanings') or [])
        # A "^"-marked meaning is the one WaniKani quizzes on; lead with it.
        primary_meaning = next(
            (title_meanings([m])[0] for m in raw_wk_meanings if is_primary(m)),
            meanings[0] if meanings else '?',
        )
        if primary_meaning in meanings:
            meanings.remove(primary_meaning)
        meanings.insert(0, primary_meaning)

        readings_on = dedupe(normalise_reading(r) for r in data.get('readings_on') or [])
        readings_kun = dedupe(
            normalise_reading(r) for r in data.get('readings_kun') or []
        )
        # The "!"-marked reading is the one WaniKani teaches for this kanji.
        raw_wk = (data.get('wk_readings_on') or []) + (data.get('wk_readings_kun') or [])
        wk_all = dedupe(normalise_reading(r) for r in raw_wk)
        primary = next(
            (normalise_reading(r) for r in raw_wk if is_primary(r)),
            (wk_all or readings_on or readings_kun or [''])[0],
        )

        # Whatever WaniKani teaches must be gradeable, even if KANJIDIC groups
        # it differently.
        for reading in wk_all:
            if reading not in readings_on and reading not in readings_kun:
                readings_on.append(reading)
        if primary and primary not in readings_on and primary not in readings_kun:
            readings_on.insert(0, primary)

        words = vocab_by_kanji.get(char, [])[:3]

        # Show the kanji in a real sentence, preferring one built around a word
        # that actually uses it.
        example = None
        for word in words:
            example = pick_example(
                word['characters'], examples, readable, index, authored, word['reading']
            )
            if example:
                break
        if not example:
            # A few kanji only appear in words outside the N3 list, written in
            # orthography Tatoeba never uses (浮ぶ, 御飯). Those get a sentence
            # authored against the character itself.
            example = pick_example(char, examples, readable, index, authored)
        items.append({
            'id': f'k-{char}',
            'type': 'kanji',
            'level': levels[char],
            'characters': char,
            'meanings': meanings,
            'primaryMeaning': primary_meaning,
            'readingsOn': readings_on,
            'readingsKun': readings_kun,
            'primaryReading': primary,
            'strokes': data.get('strokes'),
            'grade': data.get('grade'),
            'frequency': data.get('freq'),
            'wkLevel': data.get('wk_level'),
            'radicals': data.get('wk_radicals') or [],
            'exampleWords': [
                {'characters': w['characters'], 'reading': w['reading'],
                 'meaning': w['meanings'][0]}
                for w in words
            ],
            'examples': [example] if example else [],
        })
    return items


def build_vocab(vocab_rows, kanji_levels, wordmeta, examples, readable, index, authored):
    seen = set()
    entries = []
    for row in vocab_rows:
        # A handful of entries carry a part-of-speech note in the headword
        # itself ("しまった (かん)"); that does not belong on a card front.
        word = ANNOTATION_RE.sub('', row['expression'] or '').strip()
        reading = ANNOTATION_RE.sub('', row['reading'] or '').strip() or word
        # "在る; 有る" lists two spellings of one word; teach the first.
        word = word.split(';')[0].strip()
        reading = reading.split(';')[0].strip()
        if not word:
            continue
        key = (word, reading)
        if key in seen:
            continue
        seen.add(key)

        chars = [ch for ch in word if KANJI_RE.match(ch)]
        n3_chars = [ch for ch in chars if ch in kanji_levels]
        meta = wordmeta.get(word, {})
        entries.append({
            'word': word,
            'reading': reading,
            'meanings': split_meanings(row['meaning']),
            'kanji': chars,
            'n3Kanji': n3_chars,
            'tier': meta.get('tier', 5),
            'common': bool(meta.get('common')),
        })

    max_level = max(kanji_levels.values()) if kanji_levels else 1

    # Words built from N3 kanji land on the level of their last kanji. Words
    # with no N3 kanji (kana words, N4/N5 compounds) are spread by frequency so
    # every level gets a workable mix instead of piling them all into level 1.
    free = [e for e in entries if not e['n3Kanji']]
    free.sort(key=lambda e: (e['tier'], not e['common'], e['word']))
    per_level = max(1, -(-len(free) // max_level))
    for position, entry in enumerate(free):
        entry['level'] = min(max_level, position // per_level + 1)
    for entry in entries:
        if entry['n3Kanji']:
            entry['level'] = max(kanji_levels[ch] for ch in entry['n3Kanji'])

    items = []
    for entry in sorted(entries, key=lambda e: (e['level'], e['tier'], e['word'])):
        example = pick_example(
            entry['word'], examples, readable, index, authored, entry['reading']
        )
        items.append({
            'id': f"v-{entry['word']}-{entry['reading']}",
            'type': 'vocabulary',
            'level': entry['level'],
            'characters': entry['word'],
            'reading': entry['reading'],
            'meanings': entry['meanings'],
            'primaryMeaning': entry['meanings'][0],
            'componentKanji': entry['n3Kanji'],
            'frequencyTier': entry['tier'],
            'common': entry['common'],
            'examples': [example] if example else [],
        })
    return items


def build_grammar(grammar, max_level):
    items = []
    total = len(grammar) or 1
    per_level = max(1, -(-total // max_level))
    for index, entry in enumerate(grammar):
        level = entry.get('level') or min(max_level, index // per_level + 1)
        items.append({
            'id': entry.get('id') or f'g-{index + 1:03d}',
            'type': 'grammar',
            'level': level,
            'characters': entry['pattern'],
            'reading': entry.get('reading', ''),
            'meanings': entry['meanings'],
            'primaryMeaning': entry['meanings'][0],
            'formation': entry.get('formation', ''),
            'nuance': entry.get('nuance', ''),
            'examples': [
                attach_furigana(dict(example))
                for example in entry.get('examples', [])
            ],
        })
    return items


def main():
    (kanji_all, vocab_rows, examples, wordmeta, grammar, authored,
     neighbour_rows) = load_sources()
    n3, ordered, kanji_levels = assign_kanji_levels(kanji_all)
    readable = in_level_charset(kanji_all)

    index = index_pool(build_sentence_pool(examples))
    vocab_items = build_vocab(
        vocab_rows, kanji_levels, wordmeta, examples, readable, index, authored
    )

    vocab_by_kanji = defaultdict(list)
    for item in sorted(vocab_items, key=lambda v: (v['frequencyTier'], v['level'])):
        for ch in item['componentKanji']:
            vocab_by_kanji[ch].append({
                'characters': item['characters'],
                'reading': item['reading'],
                'meanings': item['meanings'],
            })

    # Fall back to neighbouring JLPT levels for kanji that no N3 word uses.
    uncovered = {char for char, _ in ordered if not vocab_by_kanji.get(char)}
    if uncovered:
        for row in neighbour_rows:
            word = ANNOTATION_RE.sub('', row['expression'] or '').strip()
            for ch in uncovered:
                if ch in word and len(vocab_by_kanji[ch]) < 3:
                    vocab_by_kanji[ch].append({
                        'characters': word,
                        'reading': ANNOTATION_RE.sub('', row['reading'] or '').strip(),
                        'meanings': split_meanings(row['meaning']),
                    })

    kanji_items = build_kanji(
        n3, ordered, kanji_levels, vocab_by_kanji, examples, readable, index,
        authored,
    )
    max_level = max(kanji_levels.values())
    grammar_items = build_grammar(grammar, max_level)

    for name, items in (
        ('kanji', kanji_items),
        ('vocabulary', vocab_items),
        ('grammar', grammar_items),
    ):
        path = OUT / f'{name}.json'
        path.write_text(
            json.dumps(items, ensure_ascii=False, indent=1), encoding='utf-8'
        )
        with_example = sum(1 for item in items if item['examples'])
        print(
            f'{name:11} {len(items):5} items  '
            f'{with_example:5} with an example '
            f'({with_example * 100 // max(1, len(items))}%)'
        )

    manifest = {
        'levels': max_level,
        'kanjiPerLevel': KANJI_PER_LEVEL,
        'counts': {
            'kanji': len(kanji_items),
            'vocabulary': len(vocab_items),
            'grammar': len(grammar_items),
        },
        'sources': {
            'kanji': 'davidluzgouveia/kanji-data (KANJIDIC + WaniKani)',
            'vocabulary': 'jamsinclair/open-anki-jlpt-decks n3',
            'sentences': 'Tatoeba, via jlpt-N3-tiered dump',
            'grammar': 'authored for this app',
        },
    }
    (OUT / 'manifest.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1), encoding='utf-8'
    )
    print(f'\n{max_level} levels, {KANJI_PER_LEVEL} kanji each')


if __name__ == '__main__':
    main()
