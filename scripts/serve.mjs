import { createServer } from 'node:http';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIRECTORY = resolve(PROJECT_ROOT, 'public');
const HOST = '127.0.0.1';
const PORT = 4173;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; worker-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
]);

function isWithinDirectory(basePath, candidatePath) {
  const pathFromBase = relative(basePath, candidatePath);
  return pathFromBase === '' || (
    pathFromBase !== '..' &&
    !pathFromBase.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromBase)
  );
}

function isManagedPublicPath(publicPath) {
  return publicPath === 'index.html' ||
    publicPath === 'en/index.html' ||
    publicPath === 'styles/tokens.css' ||
    publicPath === 'styles/app.css' ||
    publicPath === 'js/app.mjs' ||
    publicPath === 'js/i18n.mjs' ||
    publicPath === 'js/worker.mjs' ||
    /^js\/core\/[^/]+\.mjs$/.test(publicPath);
}

function commonHeaders(contentType) {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': CSP,
    'Content-Type': contentType,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}

function sendText(response, status, message, method) {
  const body = Buffer.from(message, 'utf8');
  response.writeHead(status, {
    ...commonHeaders('text/plain; charset=utf-8'),
    'Content-Length': body.length,
  });
  response.end(method === 'HEAD' ? undefined : body);
}

async function resolvePublicFile(publicRoot, rawTarget) {
  if (typeof rawTarget !== 'string' || !rawTarget.startsWith('/') || rawTarget.startsWith('//')) {
    return { status: 400 };
  }

  const queryStart = rawTarget.indexOf('?');
  const rawPath = queryStart === -1 ? rawTarget : rawTarget.slice(0, queryStart);
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return { status: 400 };
  }

  if (decodedPath.includes('\0') || decodedPath.includes('\\') || decodedPath.startsWith('//')) {
    return { status: 400 };
  }
  if (decodedPath === '/en' || decodedPath === '/en/') {
    return { redirect: '/en/index.html' };
  }

  let relativePath = decodedPath.slice(1);
  if (relativePath === '') relativePath = 'index.html';
  if (relativePath.endsWith('/')) return { status: 404 };

  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    return { status: 403 };
  }
  if (segments.some((segment) => segment.includes(':'))) return { status: 403 };

  relativePath = segments.join('/');
  if (!isManagedPublicPath(relativePath)) return { status: 404 };

  const targetPath = resolve(publicRoot, ...segments);
  if (!isWithinDirectory(publicRoot, targetPath) || targetPath === publicRoot) {
    return { status: 403 };
  }

  let currentPath = publicRoot;
  for (let index = 0; index < segments.length; index += 1) {
    currentPath = resolve(currentPath, segments[index]);
    let details;
    try {
      details = await lstat(currentPath);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { status: 404 };
      return { status: 500 };
    }

    if (details.isSymbolicLink()) return { status: 403 };
    if (index < segments.length - 1 && !details.isDirectory()) return { status: 404 };
    if (index === segments.length - 1 && !details.isFile()) return { status: 404 };
  }

  try {
    const realTarget = await realpath(targetPath);
    if (!isWithinDirectory(publicRoot, realTarget)) return { status: 403 };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { status: 404 };
    return { status: 500 };
  }

  return { filePath: targetPath, relativePath };
}

async function handleRequest(publicRoot, request, response) {
  const method = request.method ?? '';
  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(405, {
      ...commonHeaders('text/plain; charset=utf-8'),
      Allow: 'GET, HEAD',
      'Content-Length': Buffer.byteLength('Method not allowed.\n'),
    });
    response.end('Method not allowed.\n');
    return;
  }

  const resolved = await resolvePublicFile(publicRoot, request.url);
  if (resolved.redirect) {
    response.writeHead(301, {
      ...commonHeaders('text/plain; charset=utf-8'),
      Location: resolved.redirect,
      'Content-Length': 0,
    });
    response.end();
    return;
  }
  if (!resolved.filePath) {
    const status = resolved.status ?? 500;
    const message = status === 400
      ? 'Invalid request path.\n'
      : status === 403
        ? 'Request path is not allowed.\n'
        : status === 404
          ? 'Not found.\n'
          : 'Preview request failed.\n';
    sendText(response, status, message, method);
    return;
  }

  const extension = resolved.relativePath.slice(resolved.relativePath.lastIndexOf('.')).toLowerCase();
  const contentType = MIME_TYPES.get(extension);
  if (!contentType) {
    sendText(response, 404, 'Not found.\n', method);
    return;
  }

  try {
    const content = await readFile(resolved.filePath);
    response.writeHead(200, {
      ...commonHeaders(contentType),
      'Content-Length': content.length,
    });
    response.end(method === 'HEAD' ? undefined : content);
  } catch (error) {
    const status = error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 404 : 500;
    const message = status === 404 ? 'Not found.\n' : 'Preview request failed.\n';
    sendText(response, status, message, method);
  }
}

export async function createPreviewServer({ publicDirectory = PUBLIC_DIRECTORY } = {}) {
  const absolutePublicDirectory = resolve(publicDirectory);
  const directoryDetails = await lstat(absolutePublicDirectory);
  if (directoryDetails.isSymbolicLink() || !directoryDetails.isDirectory()) {
    throw new Error('The public directory must be a regular project directory.');
  }

  const publicRoot = await realpath(absolutePublicDirectory);
  return createServer((request, response) => {
    void handleRequest(publicRoot, request, response).catch(() => {
      if (!response.headersSent) {
        sendText(response, 500, 'Preview request failed.\n', request.method ?? '');
      } else {
        response.destroy();
      }
    });
  });
}

function isMainModule() {
  return process.argv[1] !== undefined &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

async function startPreview() {
  try {
    const server = await createPreviewServer();
    server.on('error', (error) => {
      if (error?.code === 'EADDRINUSE') {
        process.stderr.write('Preview server could not start: 127.0.0.1:4173 is already in use.\n');
      } else {
        process.stderr.write('Preview server stopped after an unexpected error.\n');
      }
      process.exitCode = 1;
    });
    server.listen(PORT, HOST, () => {
      process.stdout.write('Local preview: http://127.0.0.1:4173/\n');
    });

    const stop = () => server.close(() => {
      process.exitCode = 0;
    });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch {
    process.stderr.write('Preview server could not start.\n');
    process.exitCode = 1;
  }
}

if (isMainModule()) await startPreview();
