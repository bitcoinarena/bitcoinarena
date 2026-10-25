//: testnet.bitcoin-arena.io serves the Pages project bitcoin-arena-site (its production branch, main). A Workers custom domain, so this
// Worker passes every request through unchanged, headers included (the .unityweb files keep Content-Encoding: br, so the browser still
// decompresses and compiles while it downloads). Moved 2026-10-25 off the old project, which is never used again.
const ORIGIN = 'https://bitcoin-arena-site.pages.dev';
export default {
  async fetch(request) {
    const url = new URL(request.url);
    return fetch(new Request(ORIGIN + url.pathname + url.search, request));
  },
};
