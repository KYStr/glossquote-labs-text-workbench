import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../scripts/build.mjs';
import { checkReleaseOutput } from '../scripts/check.mjs';
import { cloudflarePolicy } from '../scripts/cloudflare.mjs';
import { assertProductionHtml, parseReleaseArgs, previewSeoTags, productionHtml, releasePolicy } from '../scripts/release.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TEST_ROOT = resolve(ROOT, 'test');
const SITE = 'https://text.glossquote.com/';
const PUBLIC_FILES = [
  'index.html',
  'en/index.html',
  'styles/tokens.css',
  'styles/app.css',
  'js/app.mjs',
  'js/i18n.mjs',
  'js/worker.mjs',
  'js/core/text.mjs',
  'js/core/session.mjs',
  'js/core/export.mjs',
];

function contained(root, path) {
  const part = relative(root, path);
  return part !== '' && !isAbsolute(part) && part.split(sep)[0] !== '..';
}

function fixturePage(page, language, body) {
  return `<!doctype html>\n<html lang="${language}"><head><title>Fixture</title>\n${previewSeoTags(page).join('\n')}\n</head><body>${body}</body></html>\n`;
}

async function writeFixtureProject(projectRoot) {
  for (const directory of ['public/en', 'public/styles', 'public/js/core']) {
    await mkdir(resolve(projectRoot, directory), { recursive: true });
  }
  await writeFile(resolve(projectRoot, 'public/index.html'), fixturePage('index.html', 'zh-Hant', '中文'), 'utf8');
  await writeFile(resolve(projectRoot, 'public/en/index.html'), fixturePage('en/index.html', 'en', 'English'), 'utf8');
  await writeFile(resolve(projectRoot, 'public/styles/tokens.css'), ':root { color-scheme: light; }\n', 'utf8');
  await writeFile(resolve(projectRoot, 'public/styles/app.css'), 'body { margin: 0; }\n', 'utf8');
  for (const name of ['app', 'i18n', 'worker']) {
    await writeFile(resolve(projectRoot, `public/js/${name}.mjs`), `export const name = '${name}';\n`, 'utf8');
  }
  for (const name of ['text', 'session', 'export']) {
    await writeFile(resolve(projectRoot, `public/js/core/${name}.mjs`), `export const name = '${name}';\n`, 'utf8');
  }
}

async function withFixture(action) {
  const workspace = await mkdtemp(resolve(TEST_ROOT, 'release-'));
  const canonicalTestRoot = await realpath(TEST_ROOT);
  const canonicalWorkspace = await realpath(workspace);
  assert.ok(contained(canonicalTestRoot, canonicalWorkspace));
  assert.equal((await lstat(canonicalWorkspace)).isSymbolicLink(), false);
  const projectRoot = resolve(workspace, 'product');
  await mkdir(projectRoot);
  try {
    await writeFixtureProject(projectRoot);
    const checkProject = async () => ({ projectRoot, publicFiles: [...PUBLIC_FILES], javascriptFiles: [] });
    return await action({ projectRoot, checkProject });
  } finally {
    const finalWorkspace = await realpath(workspace);
    assert.ok(contained(canonicalTestRoot, finalWorkspace));
    assert.equal((await lstat(finalWorkspace)).isSymbolicLink(), false);
    await rm(finalWorkspace, { recursive: true });
  }
}

test('production arguments require the exact HTTPS site and explicit Cloudflare flags', () => {
  assert.deepEqual(parseReleaseArgs([]), { production: false });
  assert.deepEqual(parseReleaseArgs(['--production', '--cloudflare', '--site-url', SITE]), {
    production: true,
    cloudflare: true,
    siteUrl: SITE,
  });
  for (const args of [
    ['--production'],
    ['--production', '--site-url', SITE],
    ['--cloudflare', '--site-url', SITE],
    ['--production', '--cloudflare'],
    ['--production', '--cloudflare', '--site-url', 'https://text.example.invalid/'],
    ['--production', '--production', '--cloudflare', '--site-url', SITE],
    ['--production', '--cloudflare', '--site-url', SITE, 'extra'],
    ['--production', '--cloudflare', '--site-url', '--production'],
    ['--production', '--cloudflare', '--site-url', SITE, '--unknown'],
  ]) assert.throws(() => parseReleaseArgs(args));
  for (const siteUrl of [
    undefined,
    '',
    'http://text.glossquote.com/',
    'https://user@text.glossquote.com/',
    'https://text.glossquote.com/?q=1',
    'https://text.glossquote.com/#frag',
    'https://text.glossquote.com/../other/',
    'https://text.glossquote.com.evil.invalid/',
  ]) assert.throws(() => releasePolicy(siteUrl));
  assert.throws(() => cloudflarePolicy('https://text.example.invalid/'), /text\.glossquote\.com/);
});

test('preview pages transform to exact bilingual production SEO and Cloudflare files', () => {
  const policy = releasePolicy(SITE);
  for (const [page, language] of [['index.html', 'zh-Hant'], ['en/index.html', 'en']]) {
    const source = fixturePage(page, language, 'Fixture');
    const production = productionHtml(source, page, policy);
    assertProductionHtml(production, page, policy);
    assert.match(production, /<meta name="robots" content="index, follow">/);
    assert.doesNotMatch(production, /noindex/);
    assert.match(production, new RegExp(`<link rel="canonical" href="${SITE.replaceAll('.', '\\.')}\/?${page.replaceAll('/', '\\/')}">`));
    assert.match(production, /<link rel="alternate" hreflang="zh-Hant" href="https:\/\/text\.glossquote\.com\/index\.html">/);
    assert.match(production, /<link rel="alternate" hreflang="en" href="https:\/\/text\.glossquote\.com\/en\/index\.html">/);
  }

  const generated = new Map([...policy.files, ...cloudflarePolicy(SITE).files]);
  assert.equal(generated.get('robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE}sitemap.xml\n`);
  assert.match(generated.get('sitemap.xml'), /<loc>https:\/\/text\.glossquote\.com\/index\.html<\/loc>/);
  assert.match(generated.get('sitemap.xml'), /<loc>https:\/\/text\.glossquote\.com\/en\/index\.html<\/loc>/);
  assert.match(generated.get('_headers'), /worker-src 'self'/);
  assert.match(generated.get('_headers'), /frame-ancestors 'none'/);
  assert.match(generated.get('_headers'), /X-Content-Type-Options: nosniff/);
  assert.match(generated.get('_headers'), /Referrer-Policy: no-referrer/);
  assert.match(generated.get('_headers'), /\n\/js\/\*\.mjs\n  Content-Type: text\/javascript; charset=utf-8\n/);
  assert.doesNotMatch(generated.get('_headers'), /\/js\/core\/\*\.mjs/);
  assert.equal(generated.get('_redirects'), '/ /index.html 301\n/en /en/index.html 301\n/en/ /en/index.html 301\n');
});

test('preview build stays noindex and production build contains only exact static and generated files', async () => {
  await withFixture(async ({ projectRoot, checkProject }) => {
    const preview = await buildSite({ projectPath: projectRoot, checkProject });
    assert.equal(preview.fileCount, PUBLIC_FILES.length);
    const previewHtml = await readFile(resolve(preview.outputDirectory, 'index.html'), 'utf8');
    assert.match(previewHtml, /noindex, nofollow/);
    assert.doesNotMatch(previewHtml, /rel="canonical"|text\.glossquote\.com/);
    await assert.rejects(readFile(resolve(preview.outputDirectory, 'robots.txt')), { code: 'ENOENT' });
    await assert.rejects(readFile(resolve(preview.outputDirectory, '_headers')), { code: 'ENOENT' });

    const production = await buildSite({
      projectPath: projectRoot,
      checkProject,
      production: true,
      cloudflare: true,
      siteUrl: SITE,
    });
    assert.equal(production.fileCount, PUBLIC_FILES.length + 4);
    for (const [page, language] of [['index.html', 'zh-Hant'], ['en/index.html', 'en']]) {
      const html = await readFile(resolve(production.outputDirectory, page), 'utf8');
      assert.match(html, new RegExp(`<html lang="${language}">`));
      assert.match(html, /<meta name="robots" content="index, follow">/);
      assert.doesNotMatch(html, /noindex/);
      assertProductionHtml(html, page, releasePolicy(SITE));
      assert.match(await readFile(resolve(projectRoot, 'public', page), 'utf8'), /noindex, nofollow/);
    }

    const checked = await checkReleaseOutput(production.outputDirectory, {
      projectRoot,
      siteUrl: SITE,
      cloudflare: true,
      checkProject,
    });
    assert.equal(checked.checkedFiles, PUBLIC_FILES.length + 4);
    const paths = (await readdir(production.outputDirectory)).sort();
    assert.deepEqual(paths, ['_headers', '_redirects', 'en', 'index.html', 'js', 'robots.txt', 'sitemap.xml', 'styles']);
  });
});

test('wrong host, unknown arguments, and malformed preview tags fail before dist is removed', async () => {
  await withFixture(async ({ projectRoot, checkProject }) => {
    const dist = resolve(projectRoot, 'dist');
    await mkdir(dist);
    const sentinel = resolve(dist, 'keep.txt');
    await writeFile(sentinel, 'preserve before rejected release', 'utf8');

    await assert.rejects(buildSite({
      projectPath: projectRoot,
      checkProject,
      production: true,
      cloudflare: true,
      siteUrl: 'https://text.example.invalid/',
    }), /text\.glossquote\.com/);
    assert.throws(() => parseReleaseArgs(['--production', '--cloudflare', '--site-url', SITE, '--unknown']));
    assert.equal(await readFile(sentinel, 'utf8'), 'preserve before rejected release');

    const sourcePath = resolve(projectRoot, 'public/index.html');
    const source = await readFile(sourcePath, 'utf8');
    await writeFile(sourcePath, source.replace('<meta name="robots" content="noindex, nofollow">', '<meta name="robots" content="noindex, nofollow"><link rel="canonical" href="https://text.glossquote.com/index.html">'), 'utf8');
    await assert.rejects(buildSite({
      projectPath: projectRoot,
      checkProject,
      production: true,
      cloudflare: true,
      siteUrl: SITE,
    }), /Unexpected preview SEO metadata/);
    assert.equal(await readFile(sentinel, 'utf8'), 'preserve before rejected release');
  });
});

test('production check detects changed bytes and unexpected output files', async () => {
  await withFixture(async ({ projectRoot, checkProject }) => {
    const { outputDirectory } = await buildSite({
      projectPath: projectRoot,
      checkProject,
      production: true,
      cloudflare: true,
      siteUrl: SITE,
    });
    const sitemap = resolve(outputDirectory, 'sitemap.xml');
    const original = await readFile(sitemap);
    await writeFile(sitemap, Buffer.concat([original, Buffer.from('tampered\n')]));
    await assert.rejects(checkReleaseOutput(outputDirectory, {
      projectRoot,
      siteUrl: SITE,
      cloudflare: true,
      checkProject,
    }), /release bytes differ/);
    await writeFile(sitemap, original);
    await writeFile(resolve(outputDirectory, 'unexpected.txt'), 'not approved', 'utf8');
    await assert.rejects(checkReleaseOutput(outputDirectory, {
      projectRoot,
      siteUrl: SITE,
      cloudflare: true,
      checkProject,
    }), /unexpected release file/);
  });
});
