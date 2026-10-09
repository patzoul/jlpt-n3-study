"""Write today's JLPT N3 study note into an Obsidian vault.

The app does the quizzing; this gives Obsidian a daily page to read through
first: the next few kanji, words and grammar points in syllabus order, each
with its example sentence, furigana and translation, plus space for your own
notes on mistakes.

    python tools/obsidian_journal.py

Settings come from obsidian.local.json in the repo root (gitignored, because
it holds a path on your machine):

    {
      "vault": "C:/path/to/your/vault",
      "folder": "JLPT/N3",
      "kanji": 3, "vocabulary": 15, "grammar": 1,
      "app_url": "https://example.github.io/jlpt-n3-study/"
    }

Behaviour worth knowing:
  * One note per calendar day, and running it twice in a day changes nothing.
  * A note that already exists is never overwritten, since you may have typed
    in it.
  * A day the script did not run is simply skipped; nothing piles up.
  * Position is kept in <folder>/.journal-state.json inside the vault, so it
    travels with the notes.
"""

import argparse
import datetime as dt
import html
import json
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
CONTENT = BASE / 'content'
CONFIG_PATH = BASE / 'obsidian.local.json'

TYPES = ('kanji', 'vocabulary', 'grammar')
DEFAULTS = {'folder': 'JLPT/N3', 'kanji': 3, 'vocabulary': 15, 'grammar': 1,
            'app_url': ''}
NOTES_DIR = 'Daily reviews'
STATE_FILE = '.journal-state.json'
DASHBOARD = 'JLPT N3 Dashboard.md'
BLOCK_START = '<!-- journal:start -->'
BLOCK_END = '<!-- journal:end -->'


# ------------------------------------------------------------------ loading

def load_config(args):
    config = dict(DEFAULTS)
    if CONFIG_PATH.exists():
        config.update(json.loads(CONFIG_PATH.read_text(encoding='utf-8')))
    if args.vault:
        config['vault'] = args.vault
    if not config.get('vault'):
        sys.exit(f'No vault configured. Create {CONFIG_PATH.name} or pass --vault.')
    return config


def load_decks():
    return {
        name: json.loads((CONTENT / f'{name}.json').read_text(encoding='utf-8'))
        for name in TYPES
    }


def load_state(path):
    if path.exists():
        return json.loads(path.read_text(encoding='utf-8'))
    return {'version': 1, 'next': {name: 0 for name in TYPES}, 'days': {}}


# ---------------------------------------------------------------- rendering

def ruby(text, reading):
    return f'<ruby>{html.escape(text)}<rt>{html.escape(reading)}</rt></ruby>'


def sentence_html(example, target):
    """The sentence with readings above the kanji and the studied word bold."""
    text = example['ja']
    segments = example.get('furigana')
    if not segments:
        return html.escape(text)

    target = (target or '').lstrip('～〜')
    start = text.find(target) if target else -1
    end = start + len(target) if start != -1 else -1

    out = []
    offset = 0
    for piece, reading in segments:
        begin, stop = offset, offset + len(piece)
        offset = stop
        inside = start != -1 and begin < end and stop > start
        if reading:
            # A kanji run keeps its ruby whole, so it is bolded whole.
            body = ruby(piece, reading)
            out.append(f'<b>{body}</b>' if inside else body)
        elif not inside:
            out.append(html.escape(piece))
        else:
            lo, hi = max(begin, start), min(stop, end)
            out.append(
                html.escape(piece[:lo - begin])
                + f'<b>{html.escape(piece[lo - begin:hi - begin])}</b>'
                + html.escape(piece[hi - begin:])
            )
    return ''.join(out)


def example_lines(item, indent=''):
    lines = []
    for example in item.get('examples', []):
        lines.append(f'{indent}- {sentence_html(example, item["characters"])}')
        lines.append(f'{indent}  *{example["en"]}*')
    return lines


def render_kanji(item):
    lines = [f'### {item["characters"]} · {", ".join(item["meanings"][:3])}', '']
    if item['readingsOn']:
        lines.append(f'- **On:** {"、".join(item["readingsOn"])}')
    if item['readingsKun']:
        lines.append(f'- **Kun:** {"、".join(item["readingsKun"])}')
    detail = []
    if item.get('radicals'):
        detail.append(' + '.join(item['radicals']))
    if item.get('strokes'):
        detail.append(f'{item["strokes"]} strokes')
    if detail:
        lines.append(f'- **Parts:** {" · ".join(detail)}')
    if item.get('exampleWords'):
        words = '; '.join(
            f'{w["characters"]} ({w["reading"]}) {w["meaning"]}'
            for w in item['exampleWords']
        )
        lines.append(f'- **Words:** {words}')
    lines += example_lines(item)
    return lines + ['']


def render_vocabulary(item):
    meanings = ', '.join(item['meanings'][:3])
    lines = [f'- **{item["characters"]}** ({item["reading"]}): {meanings}']
    return lines + example_lines(item, indent='  ')


def render_grammar(item):
    lines = [f'### {item["characters"]} · {"; ".join(item["meanings"])}', '']
    if item.get('formation'):
        lines.append(f'- **Formation:** {item["formation"]}')
    if item.get('nuance'):
        lines.append(f'- **Nuance:** {item["nuance"]}')
    lines += example_lines(item)
    return lines + ['']


RENDER = {'kanji': render_kanji, 'vocabulary': render_vocabulary,
          'grammar': render_grammar}
HEADINGS = {'kanji': 'Kanji', 'vocabulary': 'Vocabulary', 'grammar': 'Grammar'}


def long_date(day):
    return f'{day:%A} {day.day} {day:%B %Y}'


def render_note(day, number, ranges, decks, config, previous):
    counts = {name: ranges[name][1] - ranges[name][0] for name in TYPES}
    folder = config['folder']
    lines = [
        '---',
        'tags: [jlpt, n3, jlpt-daily]',
        f'date: {day.isoformat()}',
        f'day: {number}',
        *[f'{name}: {counts[name]}' for name in TYPES],
        '---',
        '',
        f'# JLPT N3 · Day {number} · {long_date(day)}',
        '',
    ]

    nav = [f'[[{folder}/{DASHBOARD[:-3]}|Dashboard]]']
    if previous:
        nav.insert(0, f'[[{folder}/{NOTES_DIR}/{previous}|← {previous}]]')
    if config.get('app_url'):
        nav.append(f'[Open the app]({config["app_url"]})')
    lines += [' · '.join(nav), '']

    if not any(counts.values()):
        lines += ['The whole syllabus has been covered. Keep up the reviews.', '']

    for name in TYPES:
        begin, stop = ranges[name]
        if begin == stop:
            continue
        lines += [f'## {HEADINGS[name]}', '']
        for item in decks[name][begin:stop]:
            lines += RENDER[name](item)
        if lines[-1] != '':
            lines.append('')

    lines += ['## Mistakes', '', '- ', '', '## Questions to revisit', '', '- ', '']
    return '\n'.join(lines)


# ---------------------------------------------------------------- dashboard

def progress_block(state, decks, config, today):
    rows = []
    days_left = 0
    for name in TYPES:
        done, total = state['next'][name], len(decks[name])
        rows.append(f'| {HEADINGS[name]} | {done} | {total} | {done * 100 // total}% |')
        per_day = int(config[name])
        if per_day > 0:
            days_left = max(days_left, -(-(total - done) // per_day))
    finish = today + dt.timedelta(days=days_left)
    latest = max(state['days']) if state['days'] else None

    lines = [BLOCK_START, '']
    if latest:
        lines += [f'**Latest note:** [[{config["folder"]}/{NOTES_DIR}/{latest}|{latest}]]', '']
    lines += [
        '| | Covered | Total | |',
        '| --- | --- | --- | --- |',
        *rows,
        '',
        f'At {config["kanji"]} kanji, {config["vocabulary"]} words and '
        f'{config["grammar"]} grammar a day, the journal reaches the end of the '
        f'syllabus around {long_date(finish)} if it runs every day.',
        '',
        BLOCK_END,
    ]
    return '\n'.join(lines)


def update_dashboard(path, block):
    """Refresh the generated block, leaving everything else as written."""
    if not path.exists():
        return False
    text = path.read_text(encoding='utf-8')
    begin, stop = text.find(BLOCK_START), text.find(BLOCK_END)
    if begin == -1 or stop == -1:
        return False
    updated = text[:begin] + block + text[stop + len(BLOCK_END):]
    if updated != text:
        path.write_text(updated, encoding='utf-8', newline='\n')
    return True


# --------------------------------------------------------------------- main

def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--vault', help='vault path (overrides the config file)')
    parser.add_argument('--date', help='YYYY-MM-DD, default today')
    args = parser.parse_args()

    config = load_config(args)
    day = dt.date.fromisoformat(args.date) if args.date else dt.date.today()
    key = day.isoformat()

    root = Path(config['vault']) / config['folder']
    if not root.is_dir():
        sys.exit(f'{root} does not exist.')
    notes = root / NOTES_DIR
    notes.mkdir(exist_ok=True)
    state_path = root / STATE_FILE
    note_path = notes / f'{key}.md'

    decks = load_decks()
    state = load_state(state_path)

    if key in state['days']:
        ranges = state['days'][key]
        status = 'already planned'
    else:
        ranges = {}
        for name in TYPES:
            begin = state['next'][name]
            stop = min(len(decks[name]), begin + max(0, int(config[name])))
            ranges[name] = [begin, stop]
            state['next'][name] = stop
        state['days'][key] = ranges
        status = 'new'

    ordered = sorted(state['days'])
    number = ordered.index(key) + 1
    previous = ordered[number - 2] if number > 1 else None

    if note_path.exists():
        print(f'{note_path.name}: exists, left untouched ({status})')
    else:
        note_path.write_text(
            render_note(day, number, ranges, decks, config, previous),
            encoding='utf-8', newline='\n',
        )
        size = ', '.join(f'{ranges[n][1] - ranges[n][0]} {n}' for n in TYPES)
        print(f'{note_path.name}: written (day {number}: {size})')

    state_path.write_text(
        json.dumps(state, ensure_ascii=False, indent=1), encoding='utf-8', newline='\n'
    )
    if update_dashboard(root / DASHBOARD, progress_block(state, decks, config, day)):
        print('dashboard: progress block refreshed')


if __name__ == '__main__':
    main()
