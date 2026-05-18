/**
 * @param {boolean} explicitOptIn
 * @param {boolean} cookieOptIn
 */
export function load(explicitOptIn, cookieOptIn) {
  var s = document.createElement('script');
  s.src = 'https://vercel.live/_next-live/feedback/feedback.js';
  if (explicitOptIn) {
    s.setAttribute('data-explicit-opt-in', 'true');
  }
  if (cookieOptIn) {
    s.setAttribute('data-cookie-opt-in', 'true');
  }
  s.setAttribute(
    'data-deployment-id',
    // This is always set by Next.js
    // TODO what about disabled skew protection?
    /** @type {string} */
    (process.env.NEXT_DEPLOYMENT_ID)
  );
  (document.head || document.documentElement).appendChild(s);
}
