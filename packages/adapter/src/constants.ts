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
