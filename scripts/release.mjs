import { cloudflarePolicy, CLOUDFLARE_SITE_URL } from './cloudflare.mjs';

export const PAGE_PATHS = Object.freeze(['index.html', 'en/index.html']);

export function previewSeoTags(page) {
  if (!PAGE_PATHS.includes(page)) throw new Error('Unknown language page.');
  const alternateLinks = page === 'index.html'
    ? [
      '<link rel="alternate" hreflang="en" href="./en/index.html">',
      '<link rel="alternate" hreflang="zh-Hant" href="./index.html">',
    ]
    : [
      '<link rel="alternate" hreflang="zh-Hant" href="../index.html">',
      '<link rel="alternate" hreflang="en" href="./index.html">',
    ];
  return ['<meta name="robots" content="noindex, nofollow">', ...alternateLinks];
}

export function releasePolicy(siteUrl) {
  if (typeof siteUrl !== 'string' || !/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-zA-Z0-9_/-]*)?$/.test(siteUrl)) {
    throw new Error('site-url must be an explicit HTTPS base URL with a plain path and no credentials, query, or fragment.');
  }
  if (siteUrl !== CLOUDFLARE_SITE_URL) {
    throw new Error(`Production requires --site-url ${CLOUDFLARE_SITE_URL}`);
  }

  const url = new URL(siteUrl);
  if (!url.hostname.includes('.') || url.hostname.startsWith('.') || url.hostname.endsWith('.')) {
    throw new Error('site-url must contain a host and an unambiguous deployment directory.');
  }
  const base = url.href;
  const urls = PAGE_PATHS.map((path) => new URL(path, base).href);
  const links = (page) => {
    const pageIndex = PAGE_PATHS.indexOf(page);
    if (pageIndex === -1) throw new Error('Unknown language page.');
    return [
      `<link rel="canonical" href="${urls[pageIndex]}">`,
      `<link rel="alternate" hreflang="zh-Hant" href="${urls[0]}">`,
      `<link rel="alternate" hreflang="en" href="${urls[1]}">`,
    ];
  };
  const files = new Map([
    ['robots.txt', `User-agent: *\nAllow: /\nSitemap: ${base}sitemap.xml\n`],
    ['sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.map((entry) => `  <url><loc>${entry}</loc></url>`).join('\n') + '\n</urlset>\n'],
  ]);
  return { base, urls, links, files };
}

export function parseReleaseArgs(args) {
  if (!Array.isArray(args)) throw new Error('Release arguments must be an array.');
  if (args.length === 0) return { production: false };
  let production = false;
  let cloudflare = false;
  let siteUrl;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--production') {
      if (production) throw new Error('Duplicate --production flag.');
      production = true;
    } else if (argument === '--cloudflare') {
      if (cloudflare) throw new Error('Duplicate --cloudflare flag.');
      cloudflare = true;
    } else if (argument === '--site-url') {
      if (siteUrl !== undefined || index + 1 >= args.length) {
        throw new Error('--site-url requires one URL value.');
      }
      siteUrl = args[index + 1];
      index += 1;
    } else {
      throw new Error('Unknown release argument.');
    }
  }

  if (!production || !cloudflare || siteUrl === undefined) {
    throw new Error('Production requires --production, --cloudflare, and --site-url.');
  }
  releasePolicy(siteUrl);
  cloudflarePolicy(siteUrl);
  return { production, cloudflare, siteUrl };
}

function activeMarkup(html) {
  const blank = (text) => ' '.repeat(text.length);
  const uncommented = html.replace(/<!--[\s\S]*?(?:-->|$)/g, blank);
  const head = uncommented.match(/<head\b[^>]*>[\s\S]*?<\/head\s*>/i)?.[0] ?? '';
  if (/<(?:template|noscript|textarea|xmp|iframe|noembed|noframes|plaintext)\b/i.test(head)) {
    throw new Error('Unsupported parsing context in release head.');
  }
  return uncommented.replace(/<(script|style|title|textarea|template|noscript|xmp|iframe|noembed|noframes|plaintext)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, blank);
}

function seoTags(html) {
  return [...activeMarkup(html).matchAll(/<(?:meta|link)\b[^>]*>/gi)].filter(([tag]) =>
    /\b(?:rel|name)\s*=\s*["']?(?:canonical|alternate|robots)\b/i.test(tag));
}

function assertHead(html, tags) {
  const active = activeMarkup(html);
  const heads = [...active.matchAll(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi)];
  if (heads.length !== 1 || tags.some((tag) => tag.index <= heads[0].index ||
      tag.index >= heads[0].index + heads[0][0].length)) {
    throw new Error('SEO metadata must occur once in the document head.');
  }
}

function assertExactTags(html, tags, expected, message) {
  assertHead(html, tags);
  if (tags.length !== expected.length || expected.some((tag) => tags.filter(([actual]) => actual === tag).length !== 1)) {
    throw new Error(message);
  }
}

export function assertPreviewHtml(html, page) {
  const tags = seoTags(html);
  assertExactTags(html, tags, previewSeoTags(page), 'Unexpected preview SEO metadata; production transformation refused.');
}

export function productionHtml(html, page, policy) {
  const sourceTags = previewSeoTags(page);
  const tags = seoTags(html);
  assertExactTags(html, tags, sourceTags, 'Unexpected preview SEO metadata; production transformation refused.');
  const replacement = [
    '<meta name="robots" content="index, follow">',
    ...policy.links(page),
  ].join('\n  ');
  let output = html;
  for (const tag of [...tags].sort((left, right) => right.index - left.index)) {
    output = `${output.slice(0, tag.index)}${output.slice(tag.index + tag[0].length)}`;
  }
  const headOpening = /<head\b[^>]*>/i.exec(activeMarkup(html));
  if (!headOpening) throw new Error('SEO metadata must occur once in the document head.');
  const insertionPoint = headOpening.index + headOpening[0].length;
  output = `${output.slice(0, insertionPoint)}\n  ${replacement}${output.slice(insertionPoint)}`;
  assertProductionHtml(output, page, policy);
  return output;
}

export function assertProductionHtml(html, page, policy) {
  if (!PAGE_PATHS.includes(page)) throw new Error('Unknown production HTML page.');
  const tags = seoTags(html);
  assertExactTags(html, tags, [
    '<meta name="robots" content="index, follow">',
    ...policy.links(page),
  ], 'Production SEO metadata differs from the exact language URL policy.');
}
