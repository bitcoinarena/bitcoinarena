// THE SITE IS OPEN (kanban #611, 2026-10-24: "Remove the password from the website so everything works as expected"): it was
// behind a password form (SITE_PASSWORD, cookie ba_gate) since 2026-10-08, and the games screen's "Docs" link opened that form. Every
// page is served as it is. A link from the gated days still works: /__login and ?password=... land on the page they named, without a form.

export default { async fetch(request, env) {

  const url = new URL(request.url);
  // THE DOCS LIVE AT docs.bitcoin-arena.io: the old name sends every path there, with path and query
  if (url.hostname === 'doc.bitcoin-arena.io') return Response.redirect('https://docs.bitcoin-arena.io' + url.pathname + url.search + url.hash, 301);
  if (url.pathname === '/robots.txt') return new Response('User-agent: *\nAllow: /\n', { headers: { 'Content-Type': 'text/plain' } });
  // THE OLD LOGIN LINKS (the gate's form posted to /__login; ?password=... logged in from a link): to the page they named
  if (url.pathname === '/__login') return Response.redirect(url.origin + '/', 303);
  if (url.searchParams.has('password')) { url.searchParams.delete('password'); return Response.redirect(url.toString(), 301); }
  return env.ASSETS.fetch(request);
}
};
