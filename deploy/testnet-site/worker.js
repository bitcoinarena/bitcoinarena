//: testnet.bitcoin-arena.io serves the always-current core build - the Pages project btc-logistics-core's
// `arena` branch (deploy-arena-only: the production branch stays the old page). A Pages custom domain can only serve the
// production branch, so this Worker passes every request through to the arena alias unchanged, headers included (the
// .unityweb files keep Content-Encoding: br, so the browser still decompresses and compiles while it downloads). Deploys
// stay `wrangler pages deploy --branch arena`; nothing here changes with them.
const ORIGIN = 'https://arena.btc-logistics-core.pages.dev';
export default {
  async fetch(request) {
    const url = new URL(request.url);
    return fetch(new Request(ORIGIN + url.pathname + url.search, request));
  },
};
