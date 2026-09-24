# Dashboard languages

The dashboard ships in English. To add a language, drop a JSON file named after its language code (`de.json`, `es.json`, `pt-BR.json`, …) into the locales folder:

- default: `<data dir>/locales/` (e.g. `~/.agent-trading-journal/locales/de.json`)
- or any folder set with `JOURNAL_LOCALES_DIR`

Reload the dashboard. A language button appears in the header, and the first visit follows the browser language when a matching file exists.

## Format

Same keys as the `EN` object at the top of the script in [`public/index.html`](../public/index.html). Missing keys fall back to English, so a partial translation works.

```json
{
  "_name": "Deutsch",
  "overview": "Übersicht",
  "winRate": "Trefferquote",
  "skipReview": "geprüft: {0} richtig · {1} falsch",
  "trades": { "one": "{0} Trade", "other": "{0} Trades" },
  "riskStatus": { "ok": "OK", "caution": "VORSICHT", "stop": "STOPP" }
}
```

- `{0}`, `{1}` … are placeholders for values.
- `{ "one", "other" }` gives singular and plural forms.
- `_name` is shown as the button tooltip.

Strategy names, field labels and rule texts are not translated. They are whatever the trader wrote during onboarding, in their own language.
