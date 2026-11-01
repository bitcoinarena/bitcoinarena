// THE SITE IS OPEN (kanban #611, 2026-10-24: "Remove the password from the website so everything works as expected"): it was
// behind a password form (SITE_PASSWORD, cookie ba_gate) since 2026-10-08, and the games screen's "Docs" link opened that form. Every
// page is served as it is. A link from the gated days still works: /__login and ?password=... land on the page they named, without a form.

// THE OLD DOMAIN (kanban #937): every (sub)domain of it sends to the same place on the new one, path and query kept
const OLD_DOMAIN = /(^|\.)bitcoin-arena\.io$/;
const moved = (url) => { if (!OLD_DOMAIN.test(url.hostname)) return null; const to = new URL(url); to.hostname = url.hostname.replace(/bitcoin-arena\.io$/, 'bitcoinarena.io'); return Response.redirect(to.toString(), 308); };
export default { async fetch(request, env) {

  const url = new URL(request.url);
  { const went = moved(url); if (went) return went; }
  // THE DOCS LIVE AT docs.bitcoinarena.io: the old name sends every path there, with path and query
  if (url.hostname === 'doc.bitcoinarena.io') return Response.redirect('https://docs.bitcoinarena.io' + url.pathname + url.search + url.hash, 301);
  if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\n', { headers: { 'Content-Type': 'text/plain' } });
  // THE OLD LOGIN LINKS (the gate's form posted to /__login; ?password=... logged in from a link): to the page they named
  if (url.pathname === '/__login') return Response.redirect(url.origin + '/', 303);
  if (url.searchParams.has('password')) { url.searchParams.delete('password'); return Response.redirect(url.toString(), 301); }
  return env.ASSETS.fetch(request);
}
};
