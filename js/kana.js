// Romaji -> hiragana conversion for reading answers, so readings can be typed
// on a normal keyboard without switching to an IME.

const DIGRAPHS = {
  kya: 'きゃ', kyu: 'きゅ', kyo: 'きょ', sha: 'しゃ', shu: 'しゅ', sho: 'しょ',
  sya: 'しゃ', syu: 'しゅ', syo: 'しょ', cha: 'ちゃ', chu: 'ちゅ', cho: 'ちょ',
  tya: 'ちゃ', tyu: 'ちゅ', tyo: 'ちょ', nya: 'にゃ', nyu: 'にゅ', nyo: 'にょ',
  hya: 'ひゃ', hyu: 'ひゅ', hyo: 'ひょ', mya: 'みゃ', myu: 'みゅ', myo: 'みょ',
  rya: 'りゃ', ryu: 'りゅ', ryo: 'りょ', gya: 'ぎゃ', gyu: 'ぎゅ', gyo: 'ぎょ',
  ja: 'じゃ', ju: 'じゅ', jo: 'じょ', jya: 'じゃ', jyu: 'じゅ', jyo: 'じょ',
  zya: 'じゃ', zyu: 'じゅ', zyo: 'じょ', bya: 'びゃ', byu: 'びゅ', byo: 'びょ',
  pya: 'ぴゃ', pyu: 'ぴゅ', pyo: 'ぴょ', dya: 'ぢゃ', dyu: 'ぢゅ', dyo: 'ぢょ',
  fa: 'ふぁ', fi: 'ふぃ', fe: 'ふぇ', fo: 'ふぉ', va: 'ゔぁ', vi: 'ゔぃ',
  ve: 'ゔぇ', vo: 'ゔぉ', tsa: 'つぁ', tsi: 'つぃ', tse: 'つぇ', tso: 'つぉ',
  she: 'しぇ', che: 'ちぇ', je: 'じぇ', ti: 'てぃ', di: 'でぃ', du: 'どぅ',
  wi: 'うぃ', we: 'うぇ', wo: 'を',
};

const BASIC = {
  a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お',
  ka: 'か', ki: 'き', ku: 'く', ke: 'け', ko: 'こ',
  sa: 'さ', shi: 'し', si: 'し', su: 'す', se: 'せ', so: 'そ',
  ta: 'た', chi: 'ち', ti: 'ち', tsu: 'つ', tu: 'つ', te: 'て', to: 'と',
  na: 'な', ni: 'に', nu: 'ぬ', ne: 'ね', no: 'の',
  ha: 'は', hi: 'ひ', fu: 'ふ', hu: 'ふ', he: 'へ', ho: 'ほ',
  ma: 'ま', mi: 'み', mu: 'む', me: 'め', mo: 'も',
  ya: 'や', yu: 'ゆ', yo: 'よ',
  ra: 'ら', ri: 'り', ru: 'る', re: 'れ', ro: 'ろ',
  wa: 'わ', n: 'ん', nn: 'ん',
  ga: 'が', gi: 'ぎ', gu: 'ぐ', ge: 'げ', go: 'ご',
  za: 'ざ', ji: 'じ', zi: 'じ', zu: 'ず', ze: 'ぜ', zo: 'ぞ',
  da: 'だ', de: 'で', do: 'ど',
  ba: 'ば', bi: 'び', bu: 'ぶ', be: 'べ', bo: 'ぼ',
  pa: 'ぱ', pi: 'ぴ', pu: 'ぷ', pe: 'ぺ', po: 'ぽ',
  vu: 'ゔ',
  '-': 'ー',
};

const SMALL = { xa: 'ぁ', xi: 'ぃ', xu: 'ぅ', xe: 'ぇ', xo: 'ぉ', xtsu: 'っ', xtu: 'っ' };

const TABLE = { ...BASIC, ...DIGRAPHS, ...SMALL };
const MAX_KEY = 4;

/**
 * Convert as much of the input as possible to hiragana. Trailing consonants
 * that could still become a kana (e.g. "ky") are left as-is so the field reads
 * naturally while typing.
 */
export function toKana(input) {
  const text = String(input || '').toLowerCase();
  let out = '';
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    // Doubled consonant -> small tsu ("kko" -> "っこ"). "nn" is handled by the
    // table, and "n" before a vowel is never a geminate.
    if (
      char !== 'n'
      && /[a-z]/.test(char)
      && !'aiueo'.includes(char)
      && text[index + 1] === char
    ) {
      out += 'っ';
      index += 1;
      continue;
    }

    if (char === 'n') {
      const next = text[index + 1];
      if (next === undefined || next === "'") {
        // Trailing "n", or the explicit "n'" separator.
        out += 'ん';
        index += next === "'" ? 2 : 1;
        continue;
      }
      if (next === 'n') {
        // "nna" is ん + な, but a bare "nn" is just ん.
        const after = text[index + 2];
        const vowelFollows = after !== undefined && 'aiueoy'.includes(after);
        out += 'ん';
        index += vowelFollows ? 1 : 2;
        continue;
      }
      if (/[a-z]/.test(next) && !'aiueoy'.includes(next)) {
        out += 'ん';
        index += 1;
        continue;
      }
    }

    let matched = false;
    for (let size = Math.min(MAX_KEY, text.length - index); size > 0; size -= 1) {
      const chunk = text.slice(index, index + size);
      if (TABLE[chunk]) {
        out += TABLE[chunk];
        index += size;
        matched = true;
        break;
      }
    }
    if (matched) {
      continue;
    }

    // A trailing "n" at the very end of the input is ん.
    if (char === 'n' && index === text.length - 1) {
      out += 'ん';
      index += 1;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

/** Fold katakana to hiragana so カタカナ readings compare equal. */
export function toHiragana(value) {
  return String(value || '').replace(/[ァ-ヶ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

/** True when the string is entirely kana (plus the long vowel mark). */
export function isKana(value) {
  return /^[぀-ゟ゠-ヿー]+$/.test(String(value || ''));
}
