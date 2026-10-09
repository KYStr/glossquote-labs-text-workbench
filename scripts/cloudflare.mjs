export const CLOUDFLARE_SITE_URL = 'https://text.glossquote.com/';

const HEADER_FILE = [
  '/*',
  "  Content-Security-Policy: default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self'; img-src 'self'; font-src 'self'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'",
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: no-referrer',
  '',
  '/js/*.mjs',
  '  Content-Type: text/javascript; charset=utf-8',
  '',
].join('\n');

const REDIRECTS_FILE = [
  '/ /index.html 301',
  '/en /en/index.html 301',
  '/en/ /en/index.html 301',
  '',
].join('\n');

export function cloudflarePolicy(siteUrl) {
  if (siteUrl !== CLOUDFLARE_SITE_URL) {
    throw new Error(`Cloudflare production requires --site-url ${CLOUDFLARE_SITE_URL}`);
  }

  return {
    files: new Map([
      ['_headers', HEADER_FILE],
      ['_redirects', REDIRECTS_FILE],
    ]),
  };
}
