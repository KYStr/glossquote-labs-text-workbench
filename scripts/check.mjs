import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflarePolicy } from './cloudflare.mjs';
import { assertPreviewHtml, assertProductionHtml, PAGE_PATHS, parseReleaseArgs, previewSeoTags, productionHtml, releasePolicy } from './release.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_PUBLIC_FILES = [
  'index.html',
  'en/index.html',
  'styles/tokens.css',
  'styles/app.css',
  'js/app.mjs',
  'js/i18n.mjs',
];
const REQUIRED_SCRIPT_FILES = [
  'scripts/serve.mjs',
  'scripts/check.mjs',
  'scripts/build.mjs',
  'scripts/release.mjs',
  'scripts/cloudflare.mjs',
];
const REQUIRED_TEST_FILES = ['test/scaffold.test.mjs', 'test/release.test.mjs'];
const ALLOWED_PUBLIC_DIRECTORIES = new Set(['en', 'styles', 'js', 'js/core']);
const EXPECTED_PACKAGE_SCRIPTS = {
  dev: 'node scripts/serve.mjs',
  test: 'node --test',
  check: 'node scripts/check.mjs',
  build: 'node scripts/build.mjs',
};

const FORBIDDEN_RUNTIME_PATTERNS = [
  [/\b(?:innerHTML|outerHTML)\b|\binsertAdjacentHTML\s*\(/, 'dynamic HTML insertion'],
  [/\beval\s*\(|\bnew\s+Function\b/, 'dynamic code execution'],
  [/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/, 'network API'],
  [
    /\b(?:localStorage|sessionStorage|indexedDB)\b|\bdocument\s*\.\s*cookie\b|\bnavigator\s*\.\s*serviceWorker\b|\bconsole\s*\./,
    'browser persistence or logging API',
  ],
];

export function isAllowedPublicPath(publicPath) {
  return publicPath === 'index.html' ||
    publicPath === 'en/index.html' ||
    publicPath === 'styles/tokens.css' ||
    publicPath === 'styles/app.css' ||
    publicPath === 'js/app.mjs' ||
    publicPath === 'js/i18n.mjs' ||
    publicPath === 'js/worker.mjs' ||
    /^js\/core\/[^/]+\.mjs$/.test(publicPath);
}

function isMainModule() {
  return process.argv[1] !== undefined &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

async function requireRegularDirectory(directoryPath, label, problems) {
  let details;
  try {
    details = await lstat(directoryPath);
  } catch {
    problems.push(`Missing ${label} directory.`);
    return false;
  }
  if (details.isSymbolicLink() || !details.isDirectory()) {
    problems.push(`${label} must be a regular directory.`);
    return false;
  }
  return true;
}

async function scanPublicDirectory(problems, projectRoot = PROJECT_ROOT) {
  const publicRoot = join(projectRoot, 'public');
  const validRoot = await requireRegularDirectory(publicRoot, 'public', problems);
  if (!validRoot) return [];

  const foundFiles = [];
  async function walk(directoryPath, directoryRelative) {
    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch {
      problems.push(`Unable to read public/${directoryRelative || ''}.`);
      return;
    }

    for (const entry of entries) {
      const relativePath = directoryRelative
        ? `${directoryRelative}/${entry.name}`
        : entry.name;
      const absolutePath = join(directoryPath, entry.name);

      if (entry.isSymbolicLink()) {
        problems.push(`Public symlink is not allowed: ${relativePath}`);
      } else if (entry.isDirectory()) {
        if (!ALLOWED_PUBLIC_DIRECTORIES.has(relativePath)) {
          problems.push(`Unknown public directory: ${relativePath}`);
        } else {
          await walk(absolutePath, relativePath);
        }
      } else if (entry.isFile()) {
        if (!isAllowedPublicPath(relativePath)) {
          problems.push(`Unknown public file: ${relativePath}`);
        } else {
          foundFiles.push(relativePath);
        }
      } else {
        problems.push(`Unsupported public entry: ${relativePath}`);
      }
    }
  }

  await walk(publicRoot, '');
  const found = new Set(foundFiles);
  for (const requiredPath of REQUIRED_PUBLIC_FILES) {
    if (!found.has(requiredPath)) problems.push(`Missing public/${requiredPath}.`);
  }
  return foundFiles.sort();
}

async function scanFixedCodeDirectory(directoryName, allowFile, problems, projectRoot = PROJECT_ROOT) {
  const directoryPath = join(projectRoot, directoryName);
  const validRoot = await requireRegularDirectory(directoryPath, directoryName, problems);
  if (!validRoot) return [];

  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch {
    problems.push(`Unable to read ${directoryName}/.`);
    return [];
  }

  const files = [];
  for (const entry of entries) {
    const relativePath = `${directoryName}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      problems.push(`Code symlink is not allowed: ${relativePath}`);
    } else if (!entry.isFile() || !allowFile(entry.name)) {
      problems.push(`Unknown ${directoryName} entry: ${entry.name}`);
    } else {
      files.push(relativePath);
    }
  }
  return files.sort();
}

function parseAttributes(source) {
  const attributes = new Map();
  const duplicates = [];
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (attributes.has(name)) duplicates.push(name);
    attributes.set(name, value);
  }
  return { attributes, duplicates };
}

function resolveLocalAssetReference(reference, sourcePath, publicFiles) {
  if (typeof reference !== 'string' || reference.length === 0 || reference.trim() !== reference) return null;
  if (/[?#\\:%\u0000-\u001f\u007f]/.test(reference)) return null;
  if (reference.startsWith('/')) return null;

  const sourceDirectory = posix.dirname(sourcePath);
  const targetSegments = sourceDirectory === '.' ? [] : sourceDirectory.split('/');
  for (const segment of reference.split('/')) {
    if (segment === '' ) return null;
    if (segment === '.') continue;
    if (segment === '..') {
      if (targetSegments.length === 0) return null;
      targetSegments.pop();
      continue;
    }
    if (segment.startsWith('.')) return null;
    targetSegments.push(segment);
  }

  const targetPath = targetSegments.join('/');
  if (targetPath.length === 0) return null;
  return publicFiles.has(targetPath) ? targetPath : null;
}

function readMetaTags(html) {
  const tags = [];
  for (const match of html.matchAll(/<meta\b([^>]*)>/gi)) {
    tags.push(parseAttributes(match[1]));
  }
  return tags;
}

function validateCsp(html, problems) {
  const cspTags = readMetaTags(html).filter(({ attributes }) =>
    attributes.get('http-equiv')?.toLowerCase() === 'content-security-policy');
  if (cspTags.length !== 1) {
    problems.push('HTML must contain one Content-Security-Policy meta tag.');
    return;
  }

  const csp = cspTags[0].attributes.get('content') ?? '';
  const directives = new Map();
  for (const directive of csp.split(';')) {
    const [name, ...values] = directive.trim().split(/\s+/).filter(Boolean);
    if (name) directives.set(name.toLowerCase(), values);
  }
  const exactDirectives = new Map([
    ['default-src', ["'self'"]],
    ['script-src', ["'self'"]],
    ['style-src', ["'self'"]],
    ['worker-src', ["'self'"]],
    ['connect-src', ["'none'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'none'"]],
  ]);
  for (const [name, expectedValues] of exactDirectives) {
    const actualValues = directives.get(name);
    if (!actualValues || actualValues.length !== expectedValues.length ||
        actualValues.some((value, index) => value !== expectedValues[index])) {
      problems.push(`CSP directive ${name} must be ${expectedValues.join(' ')}.`);
    }
  }
}

function validateHtml(html, sourcePath, publicFiles, problems) {
  const language = sourcePath === 'index.html' ? 'zh-Hant' : 'en';
  if (!/^\s*<!doctype html>/i.test(html)) problems.push(`${sourcePath} needs an HTML doctype.`);
  if (!new RegExp(`<html\\b[^>]*\\blang\\s*=\\s*(["'])${language}\\1`, 'i').test(html)) {
    problems.push(`${sourcePath} needs lang="${language}".`);
  }
  try {
    assertPreviewHtml(html, sourcePath);
  } catch {
    problems.push(`${sourcePath} needs the exact noindex preview SEO tags.`);
  }
  if (/<\s*(?:base|iframe|object|embed)\b/i.test(html)) {
    problems.push('HTML base, frame, and embedded-document elements are not allowed.');
  }
  if (/\s(?:on[a-z]+|style)\s*=/i.test(html)) {
    problems.push('Inline event handlers and inline styles are not allowed.');
  }
  if (/javascript\s*:/i.test(html)) problems.push('javascript: URLs are not allowed.');
  if (/<\s*style\b/i.test(html)) problems.push('Inline style elements are not allowed.');
  validateCsp(html, problems);

  const scriptOpenCount = [...html.matchAll(/<script\b/gi)].length;
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  if (scriptTags.length !== scriptOpenCount) problems.push('Every script tag must have a closing tag.');
  for (const match of scriptTags) {
    const { attributes, duplicates } = parseAttributes(match[1]);
    if (duplicates.length) problems.push('Script tags must not contain duplicate attributes.');
    if (attributes.get('type')?.toLowerCase() !== 'module') {
      problems.push('Browser scripts must use type="module".');
    }
    if (!attributes.has('src') || match[2].trim() !== '') {
      problems.push('Inline script code is not allowed.');
    }
  }

  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const tagName = match[1].toLowerCase();
    const { attributes, duplicates } = parseAttributes(match[2]);
    if (duplicates.length) problems.push(`Duplicate HTML attributes found on <${tagName}>.`);

    for (const attributeName of ['src', 'poster']) {
      if (!attributes.has(attributeName)) continue;
      const reference = attributes.get(attributeName);
      if (!resolveLocalAssetReference(reference, sourcePath, publicFiles)) {
        problems.push(`HTML ${attributeName} must reference an allowlisted local asset.`);
      }
    }
    if (attributes.has('srcset')) problems.push('HTML srcset resources need an explicit reviewed allowlist.');

    if (tagName === 'link' && attributes.has('href')) {
      const relationship = attributes.get('rel')?.toLowerCase();
      if (relationship === 'alternate' && previewSeoTags(sourcePath).includes(match[0])) continue;
      if (relationship !== 'stylesheet' || !resolveLocalAssetReference(attributes.get('href'), sourcePath, publicFiles)) {
        problems.push(`${sourcePath} link resources must be exact preview alternates or local stylesheets.`);
      }
    }
  }
}

function validateCss(css, sourcePath, publicFiles, problems) {
  if (/@import\b/i.test(css)) problems.push(`${sourcePath} may not import external stylesheets.`);
  for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^'"\s)][^)]*))\s*\)/gi)) {
    const reference = match[1] ?? match[2] ?? match[3] ?? '';
    if (!resolveLocalAssetReference(reference, sourcePath, publicFiles)) {
      problems.push(`${sourcePath} contains a URL outside the public asset allowlist.`);
    }
  }
}

function findModuleSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /^\s*import\s+(?!\s*\.)(?:[\s\S]*?\s+from\s+)?(['"])([^'"]+)\1\s*;?/gm,
    /^\s*export\s+(?:\*|\{[\s\S]*?\})\s+from\s+(['"])([^'"]+)\1\s*;?/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[2]);
  }
  return specifiers;
}

export function validateBrowserModule(source, sourcePath, publicFiles, problems) {
  if (/\bimport\s*\(/.test(source)) problems.push(`${sourcePath} may not use dynamic import().`);
  for (const [pattern, label] of FORBIDDEN_RUNTIME_PATTERNS) {
    if (pattern.test(source)) problems.push(`${sourcePath} uses a forbidden ${label}.`);
  }

  for (const specifier of findModuleSpecifiers(source)) {
    if (!specifier.startsWith('./') || specifier.includes('?') || specifier.includes('#') ||
        specifier.includes('\\') || !specifier.endsWith('.mjs')) {
      problems.push(`${sourcePath} has a non-local or unsupported module import.`);
      continue;
    }
    const targetPath = posix.normalize(posix.join(posix.dirname(sourcePath), specifier));
    if (!isAllowedPublicPath(targetPath) || !publicFiles.has(targetPath)) {
      problems.push(`${sourcePath} imports a missing or unapproved local module.`);
    }
  }
}

async function readPackageJson(problems, projectRoot = PROJECT_ROOT) {
  let packageJson;
  try {
    const packagePath = join(projectRoot, 'package.json');
    const details = await lstat(packagePath);
    if (details.isSymbolicLink() || !details.isFile()) {
      problems.push('package.json must be a regular project file.');
      return null;
    }
    packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  } catch {
    problems.push('package.json is missing or invalid JSON.');
    return null;
  }

  if (packageJson.private !== true) problems.push('package.json must set private to true.');
  if (packageJson.type !== 'module') problems.push('package.json must use type=module.');
  if (packageJson.engines?.node !== '>=24') problems.push('package.json must require Node >=24.');
  for (const [name, command] of Object.entries(EXPECTED_PACKAGE_SCRIPTS)) {
    if (packageJson.scripts?.[name] !== command) problems.push(`package.json script ${name} is missing or changed.`);
  }
  if (Object.keys(packageJson.dependencies ?? {}).length ||
      Object.keys(packageJson.devDependencies ?? {}).length) {
    problems.push('T00 must not add package dependencies.');
  }
  return packageJson;
}

function checkJavaScriptSyntax(relativeFiles, problems, projectRoot = PROJECT_ROOT) {
  for (const relativeFile of relativeFiles) {
    const result = spawnSync(process.execPath, ['--check', join(projectRoot, relativeFile)], {
      cwd: projectRoot,
      encoding: 'utf8',
      shell: false,
    });
    if (result.error || result.status !== 0) {
      problems.push(`JavaScript syntax check failed: ${relativeFile}`);
    }
  }
}

export async function validateProject({ projectRoot = PROJECT_ROOT } = {}) {
  projectRoot = resolve(projectRoot);
  const publicRoot = join(projectRoot, 'public');
  const problems = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 24) problems.push('Node.js 24 or newer is required.');

  await readPackageJson(problems, projectRoot);
  const publicFilesArray = await scanPublicDirectory(problems, projectRoot);
  const publicFiles = new Set(publicFilesArray);
  const scriptFiles = await scanFixedCodeDirectory(
    'scripts',
    (name) => ['serve.mjs', 'check.mjs', 'build.mjs', 'release.mjs', 'cloudflare.mjs'].includes(name),
    problems,
    projectRoot,
  );
  const testFiles = await scanFixedCodeDirectory(
    'test',
    (name) => name.endsWith('.test.mjs'),
    problems,
    projectRoot,
  );

  for (const requiredPath of REQUIRED_SCRIPT_FILES) {
    if (!scriptFiles.includes(requiredPath)) problems.push(`Missing ${requiredPath}.`);
  }
  for (const requiredPath of REQUIRED_TEST_FILES) {
    if (!testFiles.includes(requiredPath)) problems.push(`Missing ${requiredPath}.`);
  }

  // Do not read content through a rejected public root, symlink, or incomplete tree.
  if (problems.length) throw new Error(problems.join('\n'));

  for (const pagePath of PAGE_PATHS) {
    try {
      const html = await readFile(join(publicRoot, ...pagePath.split('/')), 'utf8');
      validateHtml(html, pagePath, publicFiles, problems);
    } catch {
      problems.push(`Unable to read public/${pagePath}.`);
    }
  }

  for (const publicPath of publicFilesArray) {
    if (publicPath.endsWith('.css')) {
      try {
        validateCss(await readFile(join(publicRoot, ...publicPath.split('/')), 'utf8'), publicPath, publicFiles, problems);
      } catch {
        problems.push(`Unable to read public/${publicPath}.`);
      }
    } else if (publicPath.endsWith('.mjs')) {
      try {
        validateBrowserModule(
          await readFile(join(publicRoot, ...publicPath.split('/')), 'utf8'),
          publicPath,
          publicFiles,
          problems,
        );
      } catch {
        problems.push(`Unable to read public/${publicPath}.`);
      }
    }
  }

  const javascriptFiles = [
    ...scriptFiles,
    ...testFiles,
    ...publicFilesArray.filter((path) => path.endsWith('.mjs')).map((path) => `public/${path}`),
  ];
  checkJavaScriptSyntax(javascriptFiles, problems, projectRoot);

  if (problems.length) throw new Error(problems.join('\n'));
  return { projectRoot, publicFiles: publicFilesArray, javascriptFiles };
}

function isWithinDirectory(basePath, candidatePath) {
  const pathFromBase = relative(basePath, candidatePath);
  return pathFromBase === '' || (
    pathFromBase !== '..' &&
    !pathFromBase.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromBase)
  );
}

function pathsEqual(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function resolveRegularDirectory(path) {
  try {
    const absolutePath = resolve(path);
    const details = await lstat(absolutePath);
    if (details.isSymbolicLink() || !details.isDirectory()) return null;
    const canonicalPath = await realpath(absolutePath);
    return pathsEqual(canonicalPath, absolutePath) ? canonicalPath : null;
  } catch {
    return null;
  }
}

async function readPublicSource(publicRoot, publicPath) {
  if (!isAllowedPublicPath(publicPath)) throw new Error(`Unapproved public source: ${publicPath}`);
  const sourcePath = resolve(publicRoot, ...publicPath.split('/'));
  if (!isWithinDirectory(publicRoot, sourcePath) || pathsEqual(sourcePath, publicRoot)) {
    throw new Error(`Invalid public source path: ${publicPath}`);
  }
  const details = await lstat(sourcePath);
  if (details.isSymbolicLink() || !details.isFile()) throw new Error(`Public source must be a regular file: ${publicPath}`);
  const canonicalPath = await realpath(sourcePath);
  if (!isWithinDirectory(publicRoot, canonicalPath) || !pathsEqual(canonicalPath, sourcePath)) {
    throw new Error(`Public source resolves outside public/: ${publicPath}`);
  }
  return readFile(canonicalPath);
}

async function collectReleaseFiles(root) {
  const files = new Map();
  const directories = new Set();
  async function visit(directoryPath, prefix = '') {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directoryPath, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const details = await lstat(path);
      if (details.isSymbolicLink() || entry.name.startsWith('.')) {
        throw new Error('Release paths must be regular, visible, and inside dist/.');
      }
      const canonicalPath = await realpath(path);
      if (!isWithinDirectory(root, canonicalPath) || pathsEqual(root, canonicalPath)) {
        throw new Error('Release paths must stay inside dist/.');
      }
      if (details.isDirectory()) {
        directories.add(relativePath);
        await visit(canonicalPath, relativePath);
      } else if (details.isFile()) {
        files.set(relativePath, canonicalPath);
      } else {
        throw new Error('Release output contains an unsupported filesystem entry.');
      }
    }
  }
  await visit(root);
  return { files, directories };
}

export async function checkReleaseOutput(outputPath, {
  projectRoot = PROJECT_ROOT,
  siteUrl,
  cloudflare = false,
  checkProject = validateProject,
  sourceCheck,
} = {}) {
  if (cloudflare !== true) throw new Error('Production output checks require the Cloudflare release policy.');
  const policy = releasePolicy(siteUrl);
  const hostingPolicy = cloudflarePolicy(siteUrl);
  const resolvedProject = await resolveRegularDirectory(projectRoot);
  if (!resolvedProject) throw new Error('The project root must be a regular directory.');
  const checkedSource = sourceCheck ?? await checkProject({ projectRoot: resolvedProject });
  const expectedDist = resolve(resolvedProject, 'dist');
  const resolvedOutput = resolve(outputPath);
  if (!pathsEqual(resolvedOutput, expectedDist) || relative(resolvedProject, resolvedOutput) !== 'dist') {
    throw new Error('Release output must be exactly the project dist directory.');
  }
  const canonicalDist = await resolveRegularDirectory(resolvedOutput);
  if (!canonicalDist || !isWithinDirectory(resolvedProject, canonicalDist) || pathsEqual(resolvedProject, canonicalDist)) {
    throw new Error('Release root must be a regular project directory.');
  }
  const publicRoot = await resolveRegularDirectory(join(resolvedProject, 'public'));
  if (!publicRoot || !isWithinDirectory(resolvedProject, publicRoot) || pathsEqual(resolvedProject, publicRoot)) {
    throw new Error('The public source must be a regular project directory.');
  }

  const expectedFiles = new Map();
  for (const publicPath of checkedSource.publicFiles) {
    const source = await readPublicSource(publicRoot, publicPath);
    if (PAGE_PATHS.includes(publicPath)) {
      const page = productionHtml(source.toString('utf8'), publicPath, policy);
      assertProductionHtml(page, publicPath, policy);
      expectedFiles.set(publicPath, Buffer.from(page, 'utf8'));
    } else {
      expectedFiles.set(publicPath, source);
    }
  }
  for (const [name, contents] of policy.files) expectedFiles.set(name, Buffer.from(contents, 'utf8'));
  for (const [name, contents] of hostingPolicy.files) expectedFiles.set(name, Buffer.from(contents, 'utf8'));

  const { files: actualFiles, directories: actualDirectories } = await collectReleaseFiles(canonicalDist);
  const expectedDirectories = new Set();
  for (const name of expectedFiles.keys()) {
    const segments = name.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      expectedDirectories.add(segments.slice(0, index).join('/'));
    }
    if (!actualFiles.has(name)) throw new Error(`Missing release file: ${name}`);
  }

  const failures = [];
  for (const [name, outputFile] of actualFiles) {
    if (!expectedFiles.has(name)) {
      failures.push(`${name}: unexpected release file`);
      continue;
    }
    const actual = await readFile(outputFile);
    if (!actual.equals(expectedFiles.get(name))) failures.push(`${name}: release bytes differ from approved source or policy`);
  }
  for (const directory of actualDirectories) {
    if (!expectedDirectories.has(directory)) failures.push(`${directory}: unexpected release directory`);
  }
  if (failures.length) throw new Error(`Release check failed:\n- ${failures.join('\n- ')}`);
  return { ok: true, checkedFiles: actualFiles.size };
}

if (isMainModule()) {
  try {
    const options = parseReleaseArgs(process.argv.slice(2));
    const sourceResult = await validateProject();
    if (options.production) {
      const releaseResult = await checkReleaseOutput(resolve(PROJECT_ROOT, 'dist'), { ...options, sourceCheck: sourceResult });
      process.stdout.write(`Checked ${sourceResult.publicFiles.length} public assets, ${sourceResult.javascriptFiles.length} JavaScript files, and ${releaseResult.checkedFiles} production files.\n`);
    } else {
      process.stdout.write(`Check passed: ${sourceResult.publicFiles.length} public files and ${sourceResult.javascriptFiles.length} JavaScript files.\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Check failed.'}\n`);
    process.exitCode = 1;
  }
}
