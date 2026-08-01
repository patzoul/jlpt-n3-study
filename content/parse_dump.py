"""Parse the Anki-export CSVs in jlpt-N3-tiered/ into a structured example-sentence index.

The dump ships each card as a styled HTML blob. The only part of it that is not
already covered by better sources (kanji-data, open-anki-jlpt-decks) is the
Tatoeba example sentences, so that is what we pull out here.

Outputs:
    content/sources/dump_examples.json
        { "<word>": [ {"kana", "ja", "en", "tier", "common"} , ... ] }
    content/sources/dump_wordmeta.json
        { "<word>": {"tier": 1-4, "common": bool} }   frequency signal for ordering
"""

import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
DUMP = BASE / 'jlpt-N3-tiered'
OUT = BASE / 'content' / 'sources' / 'dump_examples.json'
OUT_META = BASE / 'content' / 'sources' / 'dump_wordmeta.json'

csv.field_size_limit(min(sys.maxsize, 2**31 - 1))

# Front card: big word div then the kana reading div underneath it.
RE_WORD = re.compile(
    r"text-shadow:2px 2px 4px rgba\(0,0,0,0\.2\)'>(.*?)</div>\s*"
    r"<div style='font-size:20px;opacity:0\.95;letter-spacing:2px'>(.*?)</div>",
    re.S,
)
# Back card: the Example block holds numbered JP sentences each followed by an
# italic English gloss. The block runs from the header to the tag footer.
RE_EXAMPLE_BLOCK = re.compile(
    r">Example</div>\s*(.*?)(?=<div style='margin-top:12px;text-align:center'>|\Z)",
    re.S,
)
# The final gloss in a block is not always closed, so end on </div> or the end
# of the block, whichever comes first.
RE_PAIR = re.compile(
    r"<div style='font-size:16px;color:#333;margin-bottom:6px'>\d+\.\s*(.*?)</div>\s*"
    r"<div style='font-size:13px;color:#666;font-style:italic'>→\s*(.*?)(?:</div>|\Z)",
    re.S,
)
RE_TAG = re.compile(r'<[^>]+>')


def clean(text):
    return RE_TAG.sub('', text).replace('&amp;', '&').replace('&nbsp;', ' ').strip()


def parse_vocab_file(path, tier):
    """Yield (word, kana, common, [examples]) for every card in the file."""
    with path.open(encoding='utf-8') as handle:
        for row in csv.DictReader(handle):
            word_match = RE_WORD.search(row['word'])
            if not word_match:
                continue
            word, kana = clean(word_match.group(1)), clean(word_match.group(2))
            if not word:
                continue

            common = 'common' in row['tags']
            examples = []
            block = RE_EXAMPLE_BLOCK.search(row['back'])
            if block:
                for ja, en in RE_PAIR.findall(block.group(1)):
                    ja, en = clean(ja), clean(en)
                    if ja and en:
                        examples.append({
                            'kana': kana,
                            'ja': ja,
                            'en': en,
                            'tier': tier,
                            'common': common,
                        })

            yield word, kana, common, examples


def main():
    index = defaultdict(list)
    meta = {}
    for tier in (1, 2, 3, 4):
        path = DUMP / f'Tier_{tier}' / 'vocab.csv'
        if not path.exists():
            continue
        count = 0
        for word, kana, common, examples in parse_vocab_file(path, tier):
            # Tier 1 is the most frequent, so an earlier tier always wins.
            existing = meta.get(word)
            if existing is None or tier < existing['tier']:
                meta[word] = {'tier': tier, 'common': common, 'kana': kana}
            index[word].extend(examples)
            count += len(examples)
        print(f'Tier {tier}: {count} example sentences')

    index = {word: items for word, items in index.items() if items}

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(index, ensure_ascii=False, indent=0), encoding='utf-8')
    OUT_META.write_text(json.dumps(meta, ensure_ascii=False, indent=0), encoding='utf-8')

    total = sum(len(v) for v in index.values())
    print(f'\n{len(index)} words, {total} sentences -> {OUT.relative_to(BASE)}')
    print(f'{len(meta)} word frequency entries -> {OUT_META.relative_to(BASE)}')


if __name__ == '__main__':
    main()
