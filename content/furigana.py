"""Turn example sentences into furigana segments for ruby rendering.

Output per sentence is a list of [text, reading] pairs, where reading is None
for anything that needs no gloss:

    この坂を下ると駅に出ます。
    -> [["この", null], ["坂", "さか"], ["を", null], ["下", "くだ"], ["る", null], ...]

Ruby has to sit over the kanji alone — 下[くだ]る, never 下る[くだる] — so a
token's reading is split against its own okurigana before being emitted.

Two sources feed this:
  * sentences written for this app carry a full kana transcription, which is
    aligned against the sentence directly and needs no tokeniser;
  * Tatoeba sentences carry no reading, so janome supplies one per token.

Anything that cannot be aligned confidently returns None, and the caller falls
back to showing the plain sentence rather than guessing.
"""

import re

KANJI_RE = re.compile(r'[一-鿿々]')  # 々 counts as kanji here


def to_hiragana(text):
    out = []
    for ch in text:
        code = ord(ch)
        # Katakana -> hiragana, so surface kana and readings compare equal.
        if 0x30A1 <= code <= 0x30F6:
            out.append(chr(code - 0x60))
        else:
            out.append(ch)
    return ''.join(out)


def has_kanji(text):
    return bool(KANJI_RE.search(text))


def split_runs(text):
    """Split into alternating kanji / non-kanji runs, in order."""
    runs = []
    for ch in text:
        kind = 'kanji' if KANJI_RE.match(ch) else 'other'
        if runs and runs[-1][0] == kind:
            runs[-1][1] += ch
        else:
            runs.append([kind, ch])
    return [(kind, value) for kind, value in runs]


def align(surface, reading):
    """Match a mixed kanji/kana surface against its all-kana reading.

    Returns [[text, reading_or_None], ...] or None when the two cannot be
    reconciled — which usually means the reading is wrong rather than that the
    algorithm failed, so it is worth surfacing rather than papering over.
    """
    if not surface or not reading:
        return None
    if not has_kanji(surface):
        return [[surface, None]]

    runs = split_runs(surface)
    kana = to_hiragana(reading)
    segments = []
    position = 0

    for index, (kind, value) in enumerate(runs):
        if kind == 'other':
            # Literal kana in the surface must appear next in the reading.
            literal = to_hiragana(value)
            if not kana.startswith(literal, position):
                return None
            segments.append([value, None])
            position += len(literal)
            continue

        # A kanji run is read up to wherever the following literal starts.
        following = runs[index + 1][1] if index + 1 < len(runs) else ''
        if following:
            literal = to_hiragana(following)
            end = kana.find(literal, position + 1)
            if end == -1:
                return None
        else:
            end = len(kana)

        if end <= position:
            return None
        segments.append([value, kana[position:end]])
        position = end

    if position != len(kana):
        return None  # reading left over: the alignment drifted
    return segments


def merge_adjacent(segments):
    """Join neighbouring un-glossed pieces so the markup stays small."""
    merged = []
    for text, reading in segments:
        if reading is None and merged and merged[-1][1] is None:
            merged[-1][0] += text
        else:
            merged.append([text, reading])
    return merged


_tokenizer = None


def get_tokenizer():
    global _tokenizer
    if _tokenizer is None:
        from janome.tokenizer import Tokenizer
        _tokenizer = Tokenizer()
    return _tokenizer


def from_tokenizer(sentence):
    """Furigana for a sentence with no supplied reading."""
    try:
        tokens = list(get_tokenizer().tokenize(sentence))
    except Exception:
        return None

    segments = []
    for token in tokens:
        surface = token.surface
        if not has_kanji(surface):
            segments.append([surface, None])
            continue

        reading = token.reading
        # janome yields '*' for words outside its dictionary. Show that one
        # token bare rather than dropping furigana for the whole sentence —
        # missing help is fine, a guessed reading would not be.
        if not reading or reading == '*':
            segments.append([surface, None])
            continue

        aligned = align(surface, to_hiragana(reading))
        if aligned is None:
            # Fall back to glossing the whole token rather than dropping the
            # sentence: 下る[くだる] still reads correctly, just less prettily.
            segments.append([surface, to_hiragana(reading)])
        else:
            segments.extend(aligned)

    return merge_adjacent(segments)


def build(sentence, reading=None):
    """Furigana segments for a sentence, preferring a supplied reading."""
    if reading:
        aligned = align(sentence, reading)
        if aligned is not None:
            return merge_adjacent(aligned)
    return from_tokenizer(sentence)


def flatten(segments):
    """The full kana reading implied by a segment list, for cross-checking."""
    return ''.join(reading if reading else to_hiragana(text)
                   for text, reading in segments)
