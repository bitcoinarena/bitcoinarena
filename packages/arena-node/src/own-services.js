// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY SERVICE, ON EVERY NODE (kanban #563, 2026-10-21: "563 must contain all services even if it's custom installed"): what the
// seat itself runs and reaches, each probed from here - the seat, the chain it reads, its guardian and guardian-next, the gateway it
// carries, its public address seen from outside, the guardians' P2P tunnel and the address announcements. A node set up by hand shows
// these; an installed node shows them beside the installer's services (node-services.js overview). Rows as the installer's:
// { id, title, running, pid, detail, inside, probe: { ok, says } }.
import { connect } from 'node:net';

const tcpAnswers = (port, host = '127.0.0.1', ms = 1500) => new Promise((resolve) => {
  const s = connect({ host, port });
  const done = (ok) => { s.destroy(); resolve(ok); };
  s.setTimeout(ms, () => done(false)); s.on('connect', () => done(true)); s.on('error', () => done(false));
});
const httpOf = (u) => String(u || '').replace(/^ws(s?):/i, 'http$1:').replace(/\/+$/, '');

export async function ownServices({ port, chainTip = null, guardian = null, guardianNext = null, gatewayPort = null, publicEndpoint = null,
  p2pTunnels = null, addressBook = null, ownKey = null, fetcher = fetch, tcp = tcpAnswers, nowMs = () => Date.now() }) {
  const rows = [{ id: 'node', title: 'The node (seat)', running: true, pid: process.pid, detail: `port ${port}`, inside: false, probe: { ok: true, says: 'answers (this page comes from it)' } }];
  // THE CHAIN it reads its census, bonds and rounds from
  let tip = null, why = null;
  try { tip = typeof chainTip === 'function' ? Number(await chainTip()) : null; } catch (e) { why = e.message; }
  rows.push({ id: 'chain', title: 'Bitcoin (the chain it reads)', running: Number.isInteger(tip) ? true : chainTip ? false : null, pid: null, detail: chainTip ? 'its Bitcoin node' : 'no chain configured',
    inside: false, probe: Number.isInteger(tip) ? { ok: true, says: `at block ${tip.toLocaleString('en-US')}` } : chainTip ? { ok: false, says: `does not answer${why ? `: ${why}` : ''}` } : null });
  for (const [id, title, g] of [['guardian', 'Guardian (custody)', guardian], ['guardian-next', 'Guardian (next federation)', guardianNext]]) {
    if (!g) { if (id === 'guardian') rows.push({ id, title, running: null, pid: null, detail: 'this node runs no guardian', inside: true, probe: null }); continue; }
    const up = g.apiPort ? await tcp(g.apiPort) : false;
    rows.push({ id, title, running: up, pid: g.pid || null, detail: g.setup ? 'in setup: waits to be drawn for a founding' : `API on 127.0.0.1:${g.apiPort}`, inside: true,
      probe: { ok: up, says: up ? `its API answers${g.endpoint ? ` (public ${g.endpoint})` : ''}` : `its API on 127.0.0.1:${g.apiPort} does not answer` } });
  }
  if (gatewayPort) {
    const up = await tcp(Number(gatewayPort));
    rows.push({ id: 'gateway', title: 'Lightning gateway', running: up, pid: null, detail: `carried at <public>/gateway/ from 127.0.0.1:${gatewayPort}`, inside: false,
      probe: { ok: up, says: up ? 'answers' : 'does not answer' } });
  }
  // ITS PUBLIC ADDRESS, from outside: GET <address>/identity must be this node
  if (publicEndpoint) {
    let ok = false, says = '';
    try {
      const r = await fetcher(`${httpOf(publicEndpoint)}/identity`, { signal: AbortSignal.timeout(10000) });
      ok = r.ok; says = r.ok ? `reached at ${publicEndpoint}` : `${publicEndpoint} answers ${r.status}`;
    } catch (e) { says = `${publicEndpoint} not reached: ${e.message}`; }
    rows.push({ id: 'address', title: 'Public address', running: ok, pid: null, detail: publicEndpoint, inside: false, probe: { ok, says } });
  } else rows.push({ id: 'address', title: 'Public address', running: null, pid: null, detail: 'none set (ARENA_WSS_<port>): other nodes cannot reach it', inside: false, probe: null });
  if (p2pTunnels) {
    const st = p2pTunnels.state();
    const up = st.filter((x) => x.state === 'listening' || x.state === 'shared').length;
    rows.push({ id: 'p2p-tunnel', title: 'Guardians\' P2P tunnel', running: st.length ? up > 0 : null, pid: null, detail: `${up} of ${st.length} guardian port(s) carried`, inside: true,
      probe: st.length ? { ok: up === st.length, says: up === st.length ? 'every guardian of the census is carried' : `${st.length - up} port(s) not open` } : null });
  }
  if (addressBook) {
    const all = addressBook.list();
    const mine = ownKey ? all.find((x) => x.node === String(ownKey).toLowerCase()) : null;
    const fresh = mine && publicEndpoint && mine.endpoint === publicEndpoint;
    rows.push({ id: 'announcements', title: 'Address announcements', running: true, pid: null, detail: `${all.length} node(s) known`, inside: true,
      probe: publicEndpoint ? { ok: !!fresh, says: fresh ? `this node's address announced ${Math.round((nowMs() - mine.atMs) / 60000)} min ago` : 'this node\'s address not announced yet' } : null });
  }
  return rows;
}
