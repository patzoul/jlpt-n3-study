"""Turn example sentences into furigana segments for ruby rendering.

Output per sentence is a list of [text, reading] pairs, where reading is None
for anything that needs no gloss:

    この坂を下ると駅に出ます。
    -> [["この", null], ["坂", "さか"], ["を", null], ["下", "くだ"], ["る", null], ...]

Ruby has to sit over the kanji alone — 下[くだ]る, never 下る[くだる] — so a
token's reading is split against its own okurigana before being emitted.

Two sources feed this:
  * Tatoeba sentences carry no reading, so janome supplies one per token.
  * Sentences written for this app carry a full kana transcription. That
    transcription is the authority, but it still has to be cut up and laid over
    the right characters. Kana anchors alone cannot do it: in 本人に直に聞いた
    the particle に also occurs inside ほんにん, and a greedy match puts the
    cut in the wrong place. So the sentence is tokenised first and the
    transcription is fitted to the tokens, preferring the tokeniser's own
    reading wherever the two agree.

Anything that cannot be fitted returns None, and the caller falls back to
showing the plain sentence rather than guessing.
"""

import re
from functools import lru_cache

KANJI_RE = re.compile(r'[一-鿿々]')  # 々 counts as kanji here
# Characters whose reading is not simply themselves: kanji, digits, Latin.
FLEXIBLE_RE = re.compile(r'[一-鿿々0-9０-９A-Za-zＡ-Ｚａ-ｚ]')
PUNCTUATION = set('、。，．,.!?！？「」『』（）()・…― 　')
# A Japanese word never starts on these, so a reading that does was cut wrong.
BAD_START = set('んゃゅょぁぃぅぇぉっゎー')
IMPOSSIBLE = float('inf')


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


def reading_penalty(surface, reading):
    """How implausible `reading` is for the kanji in `surface`. 0 is fine."""
    if not reading:
        return IMPOSSIBLE
    penalty = 0
    kanji = len(KANJI_RE.findall(surface))
    if reading[0] in BAD_START or reading[0] in PUNCTUATION:
        penalty += 50
    if any(ch in PUNCTUATION for ch in reading):
        penalty += 50
    if kanji and len(reading) < kanji:
        penalty += 50                      # less than one kana per kanji
    if kanji and len(reading) > 4 * kanji:
        penalty += 10                      # more than four kana per kanji
    return penalty


def align(surface, reading):
    """Match a mixed kanji/kana surface against its all-kana reading.

    Tries every place the surface's own kana could sit in the reading and
    keeps the most plausible fit. Returns [[text, reading_or_None], ...] or
    None when the two cannot be reconciled.
    """
    if not surface or not reading:
        return None
    if not has_kanji(surface):
        return [[surface, None]]

    runs = split_runs(surface)
    kana = to_hiragana(reading)
    best = [IMPOSSIBLE, None]

    def walk(index, position, cost, segments):
        if cost >= best[0]:
            return
        if index == len(runs):
            if position == len(kana):
                best[0], best[1] = cost, list(segments)
            return
        kind, value = runs[index]
        if kind == 'other':
            literal = to_hiragana(value)
            if kana.startswith(literal, position):
                segments.append([value, None])
                walk(index + 1, position + len(literal), cost, segments)
                segments.pop()
            return

        if index + 1 == len(runs):
            ends = [len(kana)]
        else:
            literal = to_hiragana(runs[index + 1][1])
            ends = []
            found = kana.find(literal, position + 1)
            while found != -1:
                ends.append(found)
                found = kana.find(literal, found + 1)
        for end in ends:
            piece = kana[position:end]
            segments.append([value, piece])
            walk(index + 1, end, cost + reading_penalty(value, piece), segments)
            segments.pop()

    walk(0, 0, 0, [])
    return best[1]


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


@lru_cache(maxsize=None)
def tokenize(sentence):
    """(surface, reading-or-None) per token; None when janome has no reading."""
    tokens = []
    for token in get_tokenizer().tokenize(sentence):
        reading = token.reading
        known = bool(reading) and reading != '*'
        tokens.append((token.surface, to_hiragana(reading) if known else None))
    return tuple(tokens)


def token_segments(surface, reading):
    """Segments for one token whose reading is known."""
    if not has_kanji(surface):
        # Digits and Latin letters get their reading as ruby when it differs.
        if FLEXIBLE_RE.search(surface) and reading and reading != to_hiragana(surface):
            return [[surface, reading]]
        return [[surface, None]]
    aligned = align(surface, reading)
    # Fall back to glossing the whole token rather than dropping the sentence:
    # 下る[くだる] still reads correctly, just less prettily.
    return aligned if aligned is not None else [[surface, reading]]


def from_tokenizer(sentence):
    """Furigana for a sentence with no supplied reading."""
    try:
        tokens = tokenize(sentence)
    except Exception:
        return None

    segments = []
    for surface, reading in tokens:
        if not has_kanji(surface) or reading is None:
            # janome has no reading for words outside its dictionary. Show
            # that token bare — missing help is fine, a guess would not be.
            segments.append([surface, None])
        else:
            segments.extend(token_segments(surface, reading))
    return merge_adjacent(segments)


def fit_reading(sentence, reading):
    """Lay a written kana transcription over the sentence's tokens.

    Dynamic programme over (token, position in the transcription). Kana and
    punctuation must match literally; a kanji token may take any stretch of
    the transcription, at no cost when it equals the tokeniser's reading and
    at a cost otherwise. Neighbouring kanji tokens may also be read as one
    unit, which is what 二十歳[はたち] needs.
    """
    try:
        tokens = tokenize(sentence)
    except Exception:
        return None
    kana = to_hiragana(reading)
    count, length = len(tokens), len(kana)

    # best[i][p] = (cost, previous i, previous p, segments) reaching token i at p
    best = [dict() for _ in range(count + 1)]
    best[0][0] = (0, None, None, None)

    def offer(i, p, cost, prev_i, prev_p, segments):
        current = best[i].get(p)
        if current is None or cost < current[0]:
            best[i][p] = (cost, prev_i, prev_p, segments)

    for i in range(count):
        for p, (cost, *_rest) in sorted(best[i].items()):
            surface, guess = tokens[i]
            if not FLEXIBLE_RE.search(surface):
                literal = to_hiragana(surface)
                if kana.startswith(literal, p):
                    offer(i + 1, p + len(literal), cost, i, p, [[surface, None]])
                continue

            # One token, or a run of kanji-only tokens read together.
            unit = ''
            for j in range(i, count):
                piece = tokens[j][0]
                if j > i and not (has_kanji(piece) and not split_runs(piece)[1:]):
                    break
                if j > i and len(split_runs(unit)) > 1:
                    break
                unit += piece
                single = j == i
                for end in range(p + 1, length + 1):
                    slice_ = kana[p:end]
                    if single and slice_ == guess:
                        step = 0
                    else:
                        # Each extra token read together costs a little more, so
                        # a token the tokeniser already reads correctly is not
                        # swallowed into its neighbour's unit.
                        step = 2 + 0.5 * (j - i) + reading_penalty(unit, slice_)
                    if step == IMPOSSIBLE:
                        continue
                    if has_kanji(unit):
                        segments = align(unit, slice_)
                        if segments is None:
                            continue
                    else:
                        segments = token_segments(unit, slice_)
                    offer(j + 1, end, cost + step, i, p, segments)

    if length not in best[count]:
        return None

    out = []
    i, p = count, length
    while i:
        _cost, prev_i, prev_p, segments = best[i][p]
        out[:0] = segments
        i, p = prev_i, prev_p
    return merge_adjacent(out)


def build(sentence, reading=None):
    """Furigana segments for a sentence, preferring a supplied reading."""
    if reading:
        fitted = fit_reading(sentence, reading)
        if fitted is not None:
            return fitted
    return from_tokenizer(sentence)


def flatten(segments):
    """The full kana reading implied by a segment list, for cross-checking."""
    return ''.join(reading if reading else to_hiragana(text)
                   for text, reading in segments)


def reading_of(segments, sentence, word):
    """How the sentence reads `word`, or None if it cannot be isolated.

    None means the word sits inside a longer glossed unit — 市 inside 市場 —
    so the sentence is not really showing that word at all.
    """
    start = sentence.find(word)
    if start == -1 or not segments:
        return None
    end = start + len(word)
    position = 0
    out = ''
    for text, reading in segments:
        begin, stop = position, position + len(text)
        position = stop
        if stop <= start or begin >= end:
            continue
        if reading:
            if begin < start or stop > end:
                return None
            out += reading
        else:
            out += to_hiragana(text[max(begin, start) - begin:min(stop, end) - begin])
    return out


def reads_as(segments, sentence, word, reading):
    """Whether the sentence uses `word` with the card's `reading`.

    Verbs and adjectives appear conjugated, so the stem is tried as well:
    広がる/ひろがる is satisfied by 広がった. Returns None when the word (or its
    stem) is not in the sentence or cannot be isolated.
    """
    word = word.lstrip('～〜')
    reading = to_hiragana(reading.lstrip('～〜'))
    if not has_kanji(word):
        return True
    for trim in (0, 1, 2):
        stem = word[:len(word) - trim]
        if not stem or not has_kanji(stem) or stem not in sentence:
            continue
        got = reading_of(segments, sentence, stem)
        if got is None:
            return None
        return got == reading[:len(reading) - trim]
    return None
