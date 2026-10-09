import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReleaseOutput, isAllowedPublicPath, validateProject } from './check.mjs';
import { cloudflarePolicy } from './cloudflare.mjs';
import { PAGE_PATHS, parseReleaseArgs, productionHtml, releasePolicy } from './release.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

async function rejectLinkedOutput(outputDirectory, projectRoot) {
  const details = await lstat(outputDirectory);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error('dist must be a regular directory before it can be replaced.');
  }

  async function walk(directoryPath) {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(directoryPath, entry.name);
      const entryDetails = await lstat(entryPath);
      if (entryDetails.isSymbolicLink()) {
        throw new Error('dist contains a symbolic link or junction; it was left untouched.');
      }
      if (entryDetails.isDirectory()) await walk(entryPath);
      else if (!entryDetails.isFile()) throw new Error('dist contains an unsupported filesystem entry.');
    }
  }

  await walk(outputDirectory);
  const resolvedOutput = await realpath(outputDirectory);
  if (!isWithinDirectory(projectRoot, resolvedOutput) ||
      !pathsEqual(dirname(resolvedOutput), projectRoot) ||
      !pathsEqual(resolvedOutput, outputDirectory)) {
    throw new Error('dist resolves outside the project output directory; it was left untouched.');
  }
}

async function assertSourceFile(publicRoot, publicPath) {
  const sourcePath = resolve(publicRoot, ...publicPath.split('/'));
  if (!isWithinDirectory(publicRoot, sourcePath) || sourcePath === publicRoot) {
    throw new Error(`Invalid public asset path: ${publicPath}`);
  }

  let details;
  try {
    details = await lstat(sourcePath);
  } catch {
    throw new Error(`Missing public asset: ${publicPath}`);
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`Public asset must be a regular file: ${publicPath}`);
  }

  const resolvedSource = await realpath(sourcePath);
  if (!isWithinDirectory(publicRoot, resolvedSource)) {
    throw new Error(`Public asset resolves outside public/: ${publicPath}`);
  }
  return sourcePath;
}

export async function buildSite({
  projectPath = PROJECT_ROOT,
  checkProject = validateProject,
  production = false,
  cloudflare = false,
  siteUrl,
} = {}) {
  if (typeof production !== 'boolean' || typeof cloudflare !== 'boolean' ||
      (!production && (cloudflare || siteUrl !== undefined))) {
    throw new Error('Production and Cloudflare options require explicit production mode.');
  }
  if (production && !cloudflare) throw new Error('Production output requires the Cloudflare release policy.');
  const release = production ? releasePolicy(siteUrl) : null;
  const hosting = cloudflare ? cloudflarePolicy(siteUrl) : null;
  const projectRoot = await realpath(resolve(projectPath));
  const sourceCheck = await checkProject({ projectRoot });
  const outputDirectory = resolve(projectRoot, 'dist');
  if (!isWithinDirectory(projectRoot, outputDirectory) ||
      !pathsEqual(relative(projectRoot, outputDirectory), 'dist')) {
    throw new Error('Build output must be the project dist directory.');
  }

  const publicRoot = resolve(projectRoot, 'public');
  const generatedFiles = new Map();
  const outputFiles = new Map();
  for (const publicPath of sourceCheck.publicFiles) {
    if (!isAllowedPublicPath(publicPath)) throw new Error(`Unapproved public asset: ${publicPath}`);
    const sourcePath = await assertSourceFile(publicRoot, publicPath);
    const sourceBytes = await readFile(sourcePath);
    if (release && PAGE_PATHS.includes(publicPath)) {
      const page = productionHtml(sourceBytes.toString('utf8'), publicPath, release);
      outputFiles.set(publicPath, Buffer.from(page, 'utf8'));
    } else {
      outputFiles.set(publicPath, sourceBytes);
    }
  }
  if (release) {
    for (const [name, contents] of release.files) generatedFiles.set(name, Buffer.from(contents, 'utf8'));
  }
  for (const [name, contents] of hosting?.files ?? []) generatedFiles.set(name, Buffer.from(contents, 'utf8'));
  for (const [name, contents] of generatedFiles) {
    if (outputFiles.has(name)) throw new Error(`Generated release file collides with public asset: ${name}`);
    outputFiles.set(name, contents);
  }
  for (const relativePath of outputFiles.keys()) {
    if (relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) {
      throw new Error(`Invalid build asset path: ${relativePath}`);
    }
    const destination = resolve(outputDirectory, ...relativePath.split('/'));
    if (!isWithinDirectory(outputDirectory, destination) || pathsEqual(destination, outputDirectory)) {
      throw new Error(`Invalid build asset path: ${relativePath}`);
    }
  }

  let outputExists = false;
  try {
    await lstat(outputDirectory);
    outputExists = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('Unable to inspect dist before building.');
  }

  if (outputExists) {
    await rejectLinkedOutput(outputDirectory, projectRoot);
    await rm(outputDirectory, { recursive: true });
  }

  await mkdir(outputDirectory);
  for (const [relativePath, contents] of outputFiles) {
    const outputPath = resolve(outputDirectory, ...relativePath.split('/'));
    if (!isWithinDirectory(outputDirectory, outputPath) || outputPath === outputDirectory) {
      throw new Error(`Invalid build asset path: ${relativePath}`);
    }
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, contents);
  }

  if (production) {
    await checkReleaseOutput(outputDirectory, {
      projectRoot,
      siteUrl,
      cloudflare,
      checkProject,
      sourceCheck,
    });
  }

  return { outputDirectory, fileCount: outputFiles.size };
}

function isMainModule() {
  return process.argv[1] !== undefined &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    const options = parseReleaseArgs(process.argv.slice(2));
    const result = await buildSite(options);
    process.stdout.write(`Build passed: wrote ${result.fileCount} allowlisted static files to dist/.\n`);
  } catch (error) {
    process.stderr.write(`Build failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
