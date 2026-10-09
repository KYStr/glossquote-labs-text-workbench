import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { readFile, mkdir, mkdtemp, copyFile, cp, writeFile, symlink, rm, rmdir, lstat, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createPreviewServer } from '../scripts/serve.mjs';
import { isAllowedPublicPath, validateBrowserModule, validateProject } from '../scripts/check.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function request({ port, method = 'GET', path = '/' }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const clientRequest = httpRequest({
      hostname: '127.0.0.1',
      method,
      path,
      port,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolvePromise({
        body: Buffer.concat(chunks).toString('utf8'),
        headers: response.headers,
        statusCode: response.statusCode,
      }));
    });
    clientRequest.on('error', rejectPromise);
    clientRequest.end();
  });
}

test('package scripts and required scaffold files are fixed and dependency-free', async () => {
  const packageJson = JSON.parse(await readFile(resolve(PROJECT_ROOT, 'package.json'), 'utf8'));
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.type, 'module');
  assert.equal(packageJson.engines.node, '>=24');
  assert.deepEqual(packageJson.scripts, {
    dev: 'node scripts/serve.mjs',
    test: 'node --test',
    check: 'node scripts/check.mjs',
    build: 'node scripts/build.mjs',
  });
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies, undefined);

  for (const relativePath of [
    'scripts/serve.mjs',
    'scripts/check.mjs',
    'scripts/build.mjs',
    'scripts/release.mjs',
    'scripts/cloudflare.mjs',
    'public/index.html',
    'public/en/index.html',
    'public/styles/tokens.css',
    'public/styles/app.css',
    'public/js/app.mjs',
    'public/js/i18n.mjs',
    'test/release.test.mjs',
    'wrangler.jsonc',
  ]) {
    await assert.doesNotReject(readFile(resolve(PROJECT_ROOT, relativePath)));
  }
});

test('HTML is a noindex local scaffold with a worker-capable, closed-network CSP', async () => {
  const html = await readFile(resolve(PROJECT_ROOT, 'public/index.html'), 'utf8');
  assert.match(html, /<html\s+lang="zh-Hant">/i);
  assert.match(html, /name="robots"\s+content="noindex,\s*nofollow"/i);
  assert.match(html, /rel="alternate" hreflang="en" href="\.\/en\/index\.html"/i);
  assert.match(html, /rel="alternate" hreflang="zh-Hant" href="\.\/index\.html"/i);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /style-src 'self'/);
  assert.match(html, /worker-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /src="\.\/js\/app\.mjs"/);
  assert.match(html, /href="\.\/styles\/tokens\.css"/);
  assert.match(html, /href="\.\/styles\/app\.css"/);
  assert.match(html, /<main\b/);
});

test('project check accepts the actual bilingual source pages and bounded parent-relative assets', async () => {
  const temporaryRoot = resolve(PROJECT_ROOT, 'test');
  const workspace = await mkdtemp(resolve(temporaryRoot, 'source-check-'));
  const canonicalRoot = await realpath(temporaryRoot);
  const canonicalWorkspace = await realpath(workspace);
  assert.equal(dirname(canonicalWorkspace), canonicalRoot);
  assert.equal((await lstat(canonicalWorkspace)).isSymbolicLink(), false);
  const projectRoot = resolve(workspace, 'project');
  await mkdir(projectRoot);
  try {
    await copyFile(resolve(PROJECT_ROOT, 'package.json'), resolve(projectRoot, 'package.json'));
    await cp(resolve(PROJECT_ROOT, 'public'), resolve(projectRoot, 'public'), { recursive: true });
    await cp(resolve(PROJECT_ROOT, 'scripts'), resolve(projectRoot, 'scripts'), { recursive: true });
    await mkdir(resolve(projectRoot, 'test'));
    for (const name of ['scaffold.test.mjs', 'release.test.mjs']) {
      await writeFile(resolve(projectRoot, 'test', name), 'export {};\n');
    }

    const result = await validateProject({ projectRoot });
    assert.equal(result.projectRoot, projectRoot);
    assert.ok(result.publicFiles.includes('index.html'));
    assert.ok(result.publicFiles.includes('en/index.html'));
    assert.ok(result.publicFiles.includes('js/app.mjs'));
    assert.ok(result.publicFiles.includes('styles/app.css'));
  } finally {
    const finalWorkspace = await realpath(workspace);
    assert.equal(finalWorkspace, canonicalWorkspace);
    assert.equal(dirname(finalWorkspace), canonicalRoot);
    assert.equal((await lstat(finalWorkspace)).isSymbolicLink(), false);
    await rm(finalWorkspace, { recursive: true });
  }
});

test('public allowlist includes only scaffold assets and the planned worker/core modules', () => {
  assert.equal(isAllowedPublicPath('index.html'), true);
  assert.equal(isAllowedPublicPath('en/index.html'), true);
  assert.equal(isAllowedPublicPath('js/app.mjs'), true);
  assert.equal(isAllowedPublicPath('js/i18n.mjs'), true);
  assert.equal(isAllowedPublicPath('js/worker.mjs'), true);
  assert.equal(isAllowedPublicPath('js/core/text.mjs'), true);
  assert.equal(isAllowedPublicPath('js/core/session.mjs'), true);
  assert.equal(isAllowedPublicPath('js/core/nested/text.mjs'), false);
  assert.equal(isAllowedPublicPath('en/nested/index.html'), false);
  assert.equal(isAllowedPublicPath('js/vendor/library.mjs'), false);
  assert.equal(isAllowedPublicPath('package.json'), false);
});

test('check resolves existing nested core imports and rejects missing modules', () => {
  const publicFiles = new Set(['js/app.mjs', 'js/core/text.mjs']);
  const validProblems = [];
  validateBrowserModule(
    "import { cleanText } from './core/text.mjs';",
    'js/app.mjs',
    publicFiles,
    validProblems,
  );
  assert.deepEqual(validProblems, []);

  const missingProblems = [];
  validateBrowserModule(
    "import { cleanText } from './core/missing.mjs';",
    'js/app.mjs',
    publicFiles,
    missingProblems,
  );
  assert.deepEqual(missingProblems, ['js/app.mjs imports a missing or unapproved local module.']);
});

test('preview server binds to loopback and limits methods and paths', async (t) => {
  const server = await createPreviewServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  t.after(() => new Promise((resolvePromise) => server.close(resolvePromise)));

  const address = server.address();
  assert.equal(address.address, '127.0.0.1');

  const root = await request({ port: address.port, path: '/?fixture=local-only' });
  assert.equal(root.statusCode, 200);
  assert.match(root.headers['content-type'], /^text\/html; charset=utf-8$/);
  assert.equal(root.headers['x-content-type-options'], 'nosniff');
  assert.match(root.headers['content-security-policy'], /worker-src 'self'/);
  assert.match(root.headers['content-security-policy'], /connect-src 'none'/);
  assert.match(root.body, /文字整理與行數統計/);

  const head = await request({ port: address.port, method: 'HEAD', path: '/' });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');

  const englishRedirect = await request({ port: address.port, path: '/en/' });
  assert.equal(englishRedirect.statusCode, 301);
  assert.equal(englishRedirect.headers.location, '/en/index.html');
  const english = await request({ port: address.port, path: '/en/index.html' });
  assert.equal(english.statusCode, 200);
  assert.match(english.body, /<html\s+lang="en">/i);

  const deniedMethod = await request({ port: address.port, method: 'POST', path: '/' });
  assert.equal(deniedMethod.statusCode, 405);
  assert.equal(deniedMethod.headers.allow, 'GET, HEAD');

  const traversal = await request({ port: address.port, path: '/%2e%2e/package.json' });
  assert.equal(traversal.statusCode, 403);
  const dotfile = await request({ port: address.port, path: '/.git/config' });
  assert.equal(dotfile.statusCode, 403);
  const malformed = await request({ port: address.port, path: '/%E0%A4%A' });
  assert.equal(malformed.statusCode, 400);
  const outsidePublic = await request({ port: address.port, path: '/package.json' });
  assert.equal(outsidePublic.statusCode, 404);
});

test('check stops at a rejected linked public root before attempting any content read', async () => {
  const temporaryRoot = resolve(PROJECT_ROOT, 'test/.tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const fixture = await mkdtemp(resolve(temporaryRoot, 'linked-root-'));
  assert.equal(dirname(fixture), temporaryRoot);
  try {
    const project = resolve(fixture, 'project');
    const external = resolve(fixture, 'outside-public');
    await mkdir(resolve(project, 'scripts'), { recursive: true });
    await mkdir(resolve(project, 'test'));
    await mkdir(external);
    await copyFile(resolve(PROJECT_ROOT, 'package.json'), resolve(project, 'package.json'));
    await copyFile(resolve(PROJECT_ROOT, 'scripts/check.mjs'), resolve(project, 'scripts/check.mjs'));
    for (const name of ['scripts/release.mjs', 'scripts/cloudflare.mjs']) {
      await copyFile(resolve(PROJECT_ROOT, name), resolve(project, name));
    }
    for (const name of ['scripts/serve.mjs', 'scripts/build.mjs', 'test/scaffold.test.mjs', 'test/release.test.mjs']) {
      await writeFile(resolve(project, name), 'export {};\n');
    }
    // Empty test-owned destination deliberately has no index.html to read.
    await symlink(external, resolve(project, 'public'), process.platform === 'win32' ? 'junction' : 'dir');
    const run = spawnSync(process.execPath, [resolve(project, 'scripts/check.mjs')], {
      cwd: project, encoding: 'utf8', shell: false,
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /public must be a regular directory/);
    assert.doesNotMatch(run.stderr, /Unable to read public\/index.html/);
  } finally {
    // mkdtemp result was checked above; remove only this test-owned fixture.
    await rm(fixture, { recursive: true, force: true });
    await rmdir(temporaryRoot);
  }
});
