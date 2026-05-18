import { load } from './base.mjs';

if (!/(?:^|;\\s)__vercel_toolbar=1(?:;|$)/.test(document.cookie)) {
  // Don't load the toolbar.
} else {
  load(true, true);
}
