export const MAX_AGE_ONE_YEAR = 31536000;

// Edge function size limit (1MB gzipped)
export const EDGE_FUNCTION_SIZE_LIMIT = 1024 * 1024;

// Pretty bytes utility
export { prettyBytes } from './pretty-bytes';

export const INTERNAL_PAGES = ['_app', '_error', '_document'];

// Headers for the plain text 404 served from `_next/static/not-found.txt`.
// The dest is a static asset, which would otherwise get a public, cacheable
// Cache-Control header from the CDN. Override it to match the header
// Next.js itself sets for this response (see router-server.ts in
// vercel/next.js).
export const NOT_FOUND_TXT_HEADERS = {
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate',
};

// `Sec-Fetch-Dest` values for subresource requests that can never render an
// HTML response (excludes `document`/`iframe` and `empty`, which covers
// fetch()/XHR including RSC requests). Keep in sync with
// packages/next/src/server/lib/is-non-html-sec-fetch-dest.ts in vercel/next.js.
export const NON_HTML_SEC_FETCH_DESTS = [
  'audio',
  'audioworklet',
  'font',
  'image',
  'json',
  'manifest',
  'paintworklet',
  'report',
  'script',
  'serviceworker',
  'sharedworker',
  'style',
  'track',
  'video',
  'webidentity',
  'worker',
  'xslt',
];
