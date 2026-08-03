"""Sanity-check the built decks and the hand-authored sources.

Run after build_content.py. Exits non-zero if anything looks wrong.
"""

import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
OUT = BASE / 'content'
SRC = OUT / 'sources'

# Everything a Japanese sentence in this app is allowed to contain.
ALLOWED = re.compile(
    r'[぀-ゟ'      # hiragana
    r'゠-ヿ'       # katakana
    r'一-鿿'       # kanji
    r'　-〿'       # CJK punctuation
    r'！-｠'       # fullwidth forms
    r'A-Za-z0-9'
    r' \-–—/,.:;!?\'"()\[\]%&+~°]'
)

# Scripts that have no business being here — usually a typo from a lookalike.
FORBIDDEN_RANGES = [
    (0xAC00, 0xD7AF, 'Hangul syllable'),
    (0x1100, 0x11FF, 'Hangul jamo'),
    (0x0400, 0x04FF, 'Cyrillic'),
    (0x0370, 0x03FF, 'Greek'),
]

problems = []


def word_forms(word):
    """The word plus its stems, since verbs appear conjugated in sentences.

    広がる is taught in dictionary form but a natural sentence says 広がった,
    so requiring the exact headword would reject perfectly good examples.
    """
    # A leading tilde marks a suffix/counter (～敗) and never appears in text.
    word = word.lstrip('～〜')
    forms = {word}
    for trim in (1, 2):
        if len(word) > trim:
            forms.add(word[:-trim])
    return forms


def contains_word(sentence, word):
    return any(form in sentence for form in word_forms(word))


def report(where, message):
    problems.append(f'{where}: {message}')


# A run of Latin letters this long inside a Japanese sentence is an English
# word that leaked in. Short runs are legitimate (B五判, CD, OK).
LATIN_RUN = re.compile(r'[A-Za-z]{3,}')
LATIN_ALLOWED = {'cd', 'dvd', 'atm', 'pc', 'tv', 'ldk', 'mail', 'ok'}


def check_japanese(where, text):
    """check_text plus a guard against untranslated English."""
    check_text(where, text)
    for run in LATIN_RUN.findall(text):
        if run.lower() not in LATIN_ALLOWED:
            report(where, f'Latin word {run!r} in Japanese text {text!r}')


def check_text(where, text):
    for ch in text:
        code = ord(ch)
        for low, high, name in FORBIDDEN_RANGES:
            if low <= code <= high:
                report(where, f'{name} character {ch!r} in {text!r}')
                return
        if not ALLOWED.match(ch):
            report(
                where,
                f'unexpected character {ch!r} '
                f'({unicodedata.name(ch, "unnamed")}) in {text!r}',
            )
            return


def check_deck(name, required):
    path = OUT / f'{name}.json'
    items = json.loads(path.read_text(encoding='utf-8'))

    ids = Counter(item['id'] for item in items)
    for item_id, count in ids.items():
        if count > 1:
            report(name, f'duplicate id {item_id} ({count}x)')

    # Two cards with the same front are unanswerable as a pair. Vocabulary is
    # exempt: homographs are legitimately distinguished by their reading.
    if name != 'vocabulary':
        fronts = Counter(item['characters'] for item in items)
        for front, count in fronts.items():
            if count > 1:
                report(name, f'duplicate front {front!r} ({count}x)')

    for item in items:
        where = f"{name}/{item['id']}"
        for field in required:
            if not item.get(field):
                report(where, f'missing {field}')

        check_text(where, item['characters'])
        if item.get('reading'):
            check_text(where, item['reading'])

        for meaning in item['meanings']:
            if not meaning.strip():
                report(where, 'blank meaning')
            if meaning.count('(') != meaning.count(')'):
                report(where, f'unbalanced brackets in meaning {meaning!r}')

        for example in item.get('examples', []):
            check_japanese(f'{where}/example', example['ja'])
            if example.get('reading'):
                check_text(f'{where}/example', example['reading'])
            if not example.get('en'):
                report(where, 'example has no translation')

            # Ruby segments must reassemble into exactly the sentence, or the
            # readings would sit over the wrong characters.
            segments = example.get('furigana')
            if segments:
                rebuilt = ''.join(text for text, _ in segments)
                if rebuilt != example['ja']:
                    report(
                        where,
                        f'furigana segments do not reassemble: '
                        f'{rebuilt!r} != {example["ja"]!r}',
                    )
                for text, reading in segments:
                    if reading and re.search(r'[一-鿿]', reading):
                        report(where, f'furigana reading {reading!r} contains kanji')
            # An authored sentence must actually contain the word it teaches.
            if example.get('source') == 'authored' and item['type'] == 'vocabulary':
                if not contains_word(example['ja'], item['characters']):
                    report(
                        where,
                        f"authored example does not contain {item['characters']!r}",
                    )

    return items


def check_authored_sources():
    path = SRC / 'authored_examples.json'
    if not path.exists():
        return
    authored = json.loads(path.read_text(encoding='utf-8'))
    vocab = json.loads((OUT / 'vocabulary.json').read_text(encoding='utf-8'))
    kanji = json.loads((OUT / 'kanji.json').read_text(encoding='utf-8'))
    # Entries are normally keyed by a vocabulary word, but a kanji that appears
    # in no N3 word may be keyed by the character itself.
    words = {item['characters'] for item in vocab}
    words |= {item['characters'] for item in kanji}

    for key, entry in authored.items():
        # Homograph entries are keyed "word|reading".
        word = key.split('|')[0]
        where = f'authored/{key}'
        check_japanese(where, entry['ja'])
        check_text(where, entry.get('reading', ''))
        if word not in words:
            report(where, 'word is not in the N3 vocabulary list')
        if not contains_word(entry['ja'], word):
            report(where, f'sentence does not contain {word!r}')
        if not entry.get('en'):
            report(where, 'no translation')
        reading = entry.get('reading', '')
        if reading and re.search(r'[一-鿿]', reading):
            report(where, 'reading still contains kanji')


def main():
    kanji = check_deck('kanji', ['characters', 'meanings', 'primaryReading', 'level'])
    vocab = check_deck('vocabulary', ['characters', 'reading', 'meanings', 'level'])
    grammar = check_deck('grammar', ['characters', 'meanings', 'level'])
    check_authored_sources()

    print(f'kanji {len(kanji)}  vocabulary {len(vocab)}  grammar {len(grammar)}')
    for name, items in (('kanji', kanji), ('vocabulary', vocab), ('grammar', grammar)):
        covered = sum(1 for item in items if item['examples'])
        ruby = sum(
            1 for item in items
            if any(e.get('furigana') for e in item['examples'])
        )
        authored = sum(
            1 for item in items
            if any(e.get('source') == 'authored' for e in item['examples'])
        )
        print(
            f'  {name:11} examples {covered}/{len(items)} '
            f'({covered * 100 // len(items)}%), {authored} authored, '
            f'{ruby} with furigana'
        )

    if problems:
        print(f'\n{len(problems)} problem(s):')
        for problem in problems[:60]:
            print(f'  - {problem}')
        if len(problems) > 60:
            print(f'  ... and {len(problems) - 60} more')
        return 1

    print('\nNo problems found.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
