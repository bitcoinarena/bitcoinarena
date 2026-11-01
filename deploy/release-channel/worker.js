// The release channel and the owner page on the testnet site: two paths passed to the Pages project (the rest of the host is its own Worker).
export default {
  async fetch(request) {
    const url = new URL(request.url);
    // THE OLD DOMAIN (kanban #937): the owner page moves with the site. /release/ stays answered on both, an installed node reads it there
    if (url.hostname === 'testnet.bitcoin-arena.io' && !url.pathname.startsWith('/release/')) { const to = new URL(url); to.hostname = 'testnet.bitcoinarena.io'; return Response.redirect(to.toString(), 308); }
    if (url.pathname === "/owner") return Response.redirect(`${url.origin}/owner/${url.search}`, 301);
    if (!url.pathname.startsWith("/release/") && !url.pathname.startsWith("/owner/")) return new Response("not here", { status: 404 });
    const res = await fetch(`https://bitcoin-arena-site.pages.dev${url.pathname}${url.search}`, { method: request.method, headers: { accept: request.headers.get("accept") || "*/*" } });
    return new Response(res.body, { status: res.status, headers: res.headers });
  }
};
