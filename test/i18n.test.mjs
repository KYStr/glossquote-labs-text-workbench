import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getMessages } from '../public/js/i18n.mjs';

const [zhHtml, enHtml, appHtml, css] = await Promise.all([
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/en/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/js/app.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../public/styles/app.css', import.meta.url), 'utf8'),
]);

const MESSAGE_KEYS = [
  'idle', 'dirty', 'running', 'success', 'copied', 'downloaded',
  'CLIPBOARD_FAILED', 'DOWNLOAD_FAILED', 'empty', 'cancelled',
  'INPUT_TOO_LARGE', 'INVALID_UNICODE', 'INVALID_OPTIONS', 'UNSUPPORTED',
  'TIMEOUT', 'WORKER_FAILED',
];

function ids(html) {
  return [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
}

function alternates(html) {
  return [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)]
    .map((match) => [match[1], match[2]])
    .sort(([a], [b]) => a.localeCompare(b));
}

test('message maps have matching frozen schemas and a Chinese fallback', () => {
  const zh = getMessages('zh-Hant');
  const en = getMessages('en');
  assert.equal(Object.isFrozen(zh), true);
  assert.equal(Object.isFrozen(en), true);
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  assert.deepEqual(Object.keys(en).sort(), [...MESSAGE_KEYS].sort());
  assert.equal(getMessages('unknown'), zh);
  assert.equal(getMessages(undefined), zh);
  assert.ok(Object.values(zh).every((message) => typeof message === 'string' && message.length > 0));
  assert.ok(Object.values(en).every((message) => typeof message === 'string' && message.length > 0));
  assert.match(appHtml, /const MESSAGES = getMessages\(doc\.documentElement\.lang\);/);
});

test('both static pages use the matching language, brand, preview metadata, and assets', () => {
  assert.match(zhHtml, /<html lang="zh-Hant">/);
  assert.match(enHtml, /<html lang="en">/);
  for (const html of [zhHtml, enHtml]) {
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    assert.match(html, /GlossQuote-Labs/);
    assert.doesNotMatch(html, /rel="canonical"|sitemap/i);
  }
  assert.match(zhHtml, /href="https:\/\/glossquote\.com\/index\.html" aria-label="GlossQuote-Labs 首頁"/);
  assert.match(enHtml, /href="https:\/\/glossquote\.com\/en\/index\.html" aria-label="GlossQuote-Labs home"/);
  assert.match(enHtml, /href="\.\.\/styles\/tokens\.css"/);
  assert.match(enHtml, /href="\.\.\/styles\/app\.css"/);
  assert.match(enHtml, /src="\.\.\/js\/app\.mjs"/);
  assert.match(zhHtml, /href="\.\/styles\/tokens\.css"/);
  assert.match(zhHtml, /href="\.\/styles\/app\.css"/);
  assert.match(zhHtml, /src="\.\/js\/app\.mjs"/);
});

test('each page has reciprocal language alternates and a visible clearing warning', () => {
  assert.deepEqual(alternates(zhHtml), [
    ['en', './en/index.html'],
    ['zh-Hant', './index.html'],
  ]);
  assert.deepEqual(alternates(enHtml), [
    ['en', './index.html'],
    ['zh-Hant', '../index.html'],
  ]);
  assert.match(zhHtml, /<nav class="language-switch" aria-label="語言">\s*<a href="\.\/en\/index\.html" lang="en">English<\/a>\s*<\/nav>/);
  assert.match(enHtml, /<nav class="language-switch" aria-label="Language">\s*<a href="\.\.\/index\.html" lang="zh-Hant">繁體中文<\/a>\s*<\/nav>/);
  assert.match(zhHtml, /id="language-warning">[^<]*(?:不會帶入|不會保留)[^<]*<\/p>/);
  assert.match(enHtml, /id="language-warning">[^<]*(?:does not transfer|does not carry)[^<]*<\/p>/);
});

test('English page has translated metadata, controls, guidance, and four FAQs', () => {
  assert.match(zhHtml, /<title>文字整理與重複行清除｜GlossQuote-Labs<\/title>/);
  assert.match(zhHtml, /<meta name="description" content="在瀏覽器內整理文字/);
  assert.match(zhHtml, /<h1 id="page-title">文字整理與行數統計<\/h1>/);
  assert.match(enHtml, /<title>Text Cleaning and Duplicate Line Removal \| GlossQuote-Labs<\/title>/);
  assert.match(enHtml, /<meta name="description" content="Clean text in your browser/);
  assert.match(enHtml, /<h1 id="page-title">Text Cleaning and Line Counts<\/h1>/);
  assert.match(enHtml, /200,000 UTF-16 code units and no more than 256 KiB in UTF-8/);
  assert.match(enHtml, /Split the text if it exceeds either limit/);
  assert.match(enHtml, /id="source-text"[\s\S]*?aria-describedby="source-help source-error"/);
  assert.match(enHtml, /id="output-text"[\s\S]*?readonly[\s\S]*?aria-describedby="output-help"/);
  assert.match(enHtml, /id="work-status" role="status" aria-live="polite"/);
  assert.equal((enHtml.match(/<article class="faq-item">/g) ?? []).length, 4);
  for (const label of [
    'Trim spaces or tabs at the start and end of each line',
    'Remove empty lines',
    'Remove duplicate lines',
    'Copy result',
    'Download text',
    'Data handling and clearing',
  ]) {
    assert.ok(enHtml.includes(label), `expected static label: ${label}`);
  }
  assert.equal(new Set(ids(enHtml)).size, ids(enHtml).length, 'English page IDs are unique');
});

test('English and Chinese pages expose the same workbench DOM contract and narrow header wraps', () => {
  assert.equal(new Set(ids(zhHtml)).size, ids(zhHtml).length, 'Chinese page IDs are unique');
  assert.deepEqual([...ids(enHtml)].sort(), [...ids(zhHtml)].sort());
  assert.match(css, /\.site-header__inner\s*\{[^}]*flex-wrap:\s*wrap;/);
  assert.match(css, /\.language-switch\s+a\s*\{[^}]*min-height:\s*var\(--gq-control-target-min-height\)/);
});
