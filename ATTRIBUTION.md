# Attribution

The application code in this repository is MIT licensed (see `LICENSE`). The
study content is derived from the open datasets below, which carry their own
terms. Redistribution here is intended to comply with them; if you reuse this
content, keep these credits with it.

## Kanji

**[davidluzgouveia/kanji-data](https://github.com/davidluzgouveia/kanji-data)** —
the N3 kanji set, readings, stroke counts, grades, frequency ranks, WaniKani
levels and radical names.

That dataset is itself built from:

- **KANJIDIC2**, © the [Electronic Dictionary Research and Development Group](https://www.edrdg.org/),
  used under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- **WaniKani** level and radical data, © [Tofugu LLC](https://www.wanikani.com/).
  Used here for ordering and mnemonic hints only.

## Vocabulary

**[jamsinclair/open-anki-jlpt-decks](https://github.com/jamsinclair/open-anki-jlpt-decks)** —
the N3 word list with readings and glosses. The N5, N4 and N2 lists are used
only to supply example words for N3 kanji that appear in no N3 word.

Derived from **JMdict**, © the Electronic Dictionary Research and Development
Group, used under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

## Example sentences

Roughly 1,850 of the example sentences come from **[Tatoeba](https://tatoeba.org/)**,
released under [CC BY 2.0 FR](https://creativecommons.org/licenses/by/2.0/fr/).
They reached this project via the frequency-tiered Anki deck described in the
README, and were filtered to N3 level by `content/build_content.py`.

The remaining ~800 sentences, and all 150 grammar explanations, were written for
this project and are covered by the repository's MIT licence.

## A note on the seed deck

`jlpt-N3-tiered/` (not committed — see `.gitignore`) was a locally supplied Anki
export of JMdict/KANJIDIC/Tatoeba data, tagged `N3` on all 69,000 of its entries.
It is used here purely as a sentence and word-frequency source; the JLPT scoping
comes from the two lists above.
