// HOW A SIGNER NODE IS REACHED (the owner 2026-09-26 13:44): one config parameter, three values, nothing else -
//   direct         the node is reachable from outside on its own address; no tunnel
//   trycloudflare  a Trycloudflare quick tunnel
//   tailscale      a Tailscale tunnel (Funnel)
// Every public address the node gives out - the socket its advert and bond name, the http doors the lobby link names,
// and the base a copied replay link names - is the one its mode produces. No hostname is written into the code: a
// quick tunnel's name is the one its tunnel logged (the keeper writes it to BLWP_WSS_<port>), a Tailscale name and path
// are read from Tailscale itself. A quick tunnel's name changes on every start, so a link copied in that mode lives only
// as long as that name; the other two do not change.
import { execFileSync } from 'node:child_process';

export const REACH_MODES = Object.freeze(['direct', 'trycloudflare', 'tailscale']);

/** Tailscale's own view: this machine's DNS name, and its public (Funnel) handlers - `tailscale ... --json`. */
export function readTailscale(bin = process.env.BLWP_TAILSCALE_BIN || 'tailscale') {
  const json = (...a) => JSON.parse(execFileSync(bin, a, { encoding: 'utf8', timeout: 10000 }));
  return { status: json('status', '--json'), funnel: json('funnel', 'status', '--json') };
}

/**
 * The address a node on `host:port` is reached at under `mode`: `{ ws, https }` - the socket URL (ws or wss) and the
 * origin-and-path its http doors and replay answer under (http or https). Throws, by name, when the mode cannot produce
 * one: a node that names a mode and has no address in it must not fall back to another mode's.
 */
export function reachFor({ mode, host, port, env = process.env, tailscale = readTailscale } = {}) {
  const trim = (s) => String(s).replace(/\/+$/, '');
  if (mode === 'direct') return { ws: `ws://${host}:${port}`, https: `http://${host}:${port}` };
  if (mode === 'trycloudflare') {
    const wss = env[`BLWP_WSS_${port}`];
    let u = null;
    try { u = new URL(wss); } catch { /* below */ }
    if (!u || u.protocol !== 'wss:' || !/\.trycloudflare\.com$/.test(u.hostname))
      throw new Error(`reach trycloudflare: BLWP_WSS_${port} names no quick tunnel (${wss || 'unset'})`);
    return { ws: `wss://${u.host}${trim(u.pathname)}`, https: `https://${u.host}${trim(u.pathname)}` };
  }
  if (mode === 'tailscale') {
    const { status, funnel } = tailscale();
    const self = String((status && status.Self && status.Self.DNSName) || '').replace(/\.$/, '');
    const open = (funnel && funnel.AllowFunnel) || {};
    for (const [hostPort, web] of Object.entries((funnel && funnel.Web) || {})) {
      const [h, p] = hostPort.split(':');
      if (h !== self || !open[hostPort]) continue;           // this machine's name, and public through Funnel
      for (const [path, handler] of Object.entries((web && web.Handlers) || {})) {
        let target = null;
        try { target = new URL(handler.Proxy); } catch { continue; }
        if (Number(target.port) !== Number(port)) continue;
        const origin = `${h}${p && p !== '443' ? `:${p}` : ''}${trim(path === '/' ? '' : path)}`;
        return { ws: `wss://${origin}`, https: `https://${origin}` };
      }
    }
    throw new Error(`reach tailscale: no Funnel path on ${self || 'this machine'} proxies to port ${port}`);
  }
  throw new Error(`reach: BLWP_REACH is ${mode === undefined ? 'unset' : `"${mode}"`} - one of ${REACH_MODES.join(', ')}`);
}
