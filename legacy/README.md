# Superseded files

Kept for reference only. Nothing here is loaded by the app.

| File | Replaced by | Why |
| --- | --- | --- |
| `app.js` | `js/app.js` + `js/srs.js`, `store.js`, `content.js`, `answer.js`, `kana.js`, `stats.js` | The original single-file app picked a random card from a filtered list and tracked a `mastery` percentage. It had no real scheduler. |
| `generate_content.py` | `content/build_content.py` | **Do not run this.** It writes to `content/kanji.json`, `content/vocabulary.json` and `content/grammar.json`, and would overwrite the current decks with template-generated placeholders (`会う` → example `"to meetです。"`). |
| `verify_cards.py` | `content/validate.py` | Checks the old item schema (`japanese`, `meaning`, `example`, `categories`), none of which exist now. |
| `audit_content_quality.py` | `content/validate.py` | Same — old schema. |

Progress saved by the old app (localStorage key `jlpt3-study-state`) is migrated
automatically on first load; see `migrateLegacyState` in `js/store.js`.
