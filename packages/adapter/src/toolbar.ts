export function generateToolbarScript(
  isProduction: boolean,
  optIn: boolean,
  deploymentIdExpr: string
) {
  let cookieCheck = 'true';
  let applyOptInAttr = '';
  if (isProduction) {
    // Reading `document.cookie` throws in a sandboxed iframe (one without
    // `allow-same-origin`). Treat a failed read as "not opted in" so the error
    // doesn't escape into the embedding page.
    cookieCheck =
      '(function(){try{return /(?:^|;\\s)__vercel_toolbar=1(?:;|$)/.test(document.cookie)}catch(e){return false}})()';
    applyOptInAttr =
      's.setAttribute("data-explicit-opt-in","true");s.setAttribute("data-cookie-opt-in","true");';
  } else if (optIn) {
    applyOptInAttr = 's.setAttribute("data-explicit-opt-in","true");';
  }

  applyOptInAttr += `s.setAttribute("data-deployment-id",${deploymentIdExpr});`;

  // our injection script
  return `
if(${cookieCheck}){
    var s=document.createElement('script');
    s.src='https://vercel.live/_next-live/feedback/feedback.js';
    ${applyOptInAttr}
    ((document.head||document.documentElement).appendChild(s))
}`;
}
