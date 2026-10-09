# GlossQuote-Labs · Text Cleaner and Counter

文字整理與統計：在瀏覽器核對原文與結果，依序移除 ASCII 行首尾空格/Tab、空行、重複行。預設不勾選選項。統計 Unicode 碼點、LF 行數及 UTF-8 bytes，支援點擊複製與下載 cleaned-text.txt。

A bilingual static text workbench with a dedicated browser Worker. Trim ASCII line edges, remove empty lines, and remove exact duplicate lines while preserving their first occurrence. Compare input/output metrics, copy results, or download UTF-8 text without a BOM. No runtime dependencies, accounts, analytics, saved history, or processing API.

## Development

Node.js 24+ is required for development only. No package installation is needed.

```sh
npm test
npm run check
npm run build
npm run dev
```

Preview: http://127.0.0.1:4173/index.html and /en/index.html. Source and preview HTML remain noindex. Production uses an explicit checked build:

```sh
node scripts/build.mjs --production --cloudflare --site-url https://text.glossquote.com/
node scripts/check.mjs --production --cloudflare --site-url https://text.glossquote.com/
```

Live: [繁體中文](https://text.glossquote.com/index.html) · [English](https://text.glossquote.com/en/index.html) · [All GlossQuote tools](https://glossquote.com/index.html). See [verification and manual pending items](docs/VERIFICATION.md).

## Behavior and limits

- Raw input must satisfy both 200,000 UTF-16 code units and 262,144 UTF-8 bytes. Invalid surrogate sequences are rejected; input is never silently truncated.
- CRLF/CR newlines become LF. Case, full-width whitespace and Unicode normalization remain unchanged.
- Empty input has zero lines; a trailing LF creates an additional empty line. Code points include spaces and line breaks and are not linguistic word counts.
- Changing input or options invalidates the result. Cancel, clear, navigation and timeout terminate the Worker; delayed replies cannot restore cleared text.
- Clear resets this page. It does not delete downloaded files or erase the OS clipboard. Switching language starts a fresh page.
- Static modules must be available to start a fresh Worker. Offline use and browser-managed restoration are not guaranteed.

See the verification record for actual automated, browser and pending manual checks. No claim is made of search rankings, universal browser support or complete security certification.
