export function generateToolbarScript(
  isProduction: boolean,
  optIn: boolean,
  deploymentIdExpr: string
) {
  let enabledAssignment = '';
  let applyOptInAttr = '';
  if (isProduction) {
    // Reading `document.cookie` throws in a sandboxed iframe (one without
    // `allow-same-origin`). Treat a failed read as "not opted in" so the error
    // doesn't escape into the embedding page.
    enabledAssignment = `
      try {
        enabled = /(?:^|;\\s)__vercel_toolbar=1(?:;|$)/.test(document.cookie);
      } catch (e) {
        enabled = false;
      }`;
    applyOptInAttr =
      's.setAttribute("data-explicit-opt-in","true");s.setAttribute("data-cookie-opt-in","true");';
  } else if (optIn) {
    applyOptInAttr = 's.setAttribute("data-explicit-opt-in","true");';
  }

  // our injection script
  return `
let enabled = true;
${enabledAssignment}

if(enabled){
    var s=document.createElement('script');
    s.src='https://vercel.live/_next-live/feedback/feedback.js';
    ${applyOptInAttr}
    s.setAttribute("data-deployment-id",${deploymentIdExpr});
    ((document.head||document.documentElement).appendChild(s))
}`;
}
