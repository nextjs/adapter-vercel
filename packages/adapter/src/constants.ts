export const MAX_AGE_ONE_YEAR = 31536000;

// Edge function size limit (1MB gzipped)
export const EDGE_FUNCTION_SIZE_LIMIT = 1024 * 1024;

// Pretty bytes utility
export { prettyBytes } from './pretty-bytes';

export const INTERNAL_PAGES = ['_app', '_error', '_document'];

// `Sec-Fetch-Dest` values for subresource requests that can never render an
// HTML response (excludes `document`/`iframe` and `empty`, which covers
// fetch()/XHR including RSC requests). Same list as
// packages/next/src/server/lib/is-non-html-sec-fetch-dest.ts in vercel/next.js;
// if the two drift apart nothing breaks, this route just stops matching the
// missed cases and they fall back to the normal not-found output.
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
