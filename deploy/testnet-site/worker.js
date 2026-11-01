//: testnet.bitcoinarena.io serves the Pages project bitcoin-arena-site (its production branch, main). A Workers custom domain, so this
// Worker passes every request through unchanged, headers included (the .unityweb files keep Content-Encoding: br, so the browser still
// decompresses and compiles while it downloads). Moved 2026-10-25 off the old project, which is never used again.
const ORIGIN = 'https://bitcoin-arena-site.pages.dev';
// THE OLD DOMAIN (kanban #937): every (sub)domain of it sends to the same place on the new one, path and query kept
const OLD_DOMAIN = /(^|\.)bitcoin-arena\.io$/;
const moved = (url) => { if (!OLD_DOMAIN.test(url.hostname)) return null; const to = new URL(url); to.hostname = url.hostname.replace(/bitcoin-arena\.io$/, 'bitcoinarena.io'); return Response.redirect(to.toString(), 308); };
export default {
  async fetch(request) {
    const url = new URL(request.url);
  { const went = moved(url); if (went) return went; }
    return fetch(new Request(ORIGIN + url.pathname + url.search, request));
  },
};
