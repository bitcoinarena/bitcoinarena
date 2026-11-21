// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT THIS NODE HOSTS (2026-10-03 22:50, plan accepted 2026-10-04): node 1 hosts gateway A and LND 1, node 2 gateway
// B and LND 2, nodes 3-7 neither. A node that hosts them shows them on its own /dashboard, read here - read-only, from this
// machine: the LND over its own loopback REST API with its READ-ONLY macaroon (getinfo, channel balance, forwarding
// history, payments - not lncli, which cannot run inside the seats' `unshare -r` namespace: measured 2026-10-03 23:31Z, it
// opens /root/.lncli/profiles.json whatever HOME or --profile say, and is refused), the gateway over loopback HTTP
// (GET /v1/info and /v1/balances, POST /v1/payment_summary), its password from its file. Nothing here restarts, moves or
// configures either. The reading is refreshed every 60 s in the background, so a dashboard read never waits on Lightning,
// and the password and the macaroon never leave this file: the snapshot carries figures only.
import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import { readPaymentLog, failuresOf, balanceCheck, gatewayWarning, WATCH_WINDOW_MS, DROP_MSAT } from './gateway-loss.js';

const DAY = 86400000;

/** One call to an LND's REST API: its own TLS certificate as the only CA, the macaroon in its header. */
export const lndRest = ({ rest, cert, macaroonHex }) => (path, body) => new Promise((ok, no) => {
  const u = new URL(path, rest);
  const req = request(u, { method: body ? 'POST' : 'GET', ca: cert, timeout: 20000,
    headers: { 'Grpc-Metadata-macaroon': macaroonHex, ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
    let b = ''; res.setEncoding('utf8'); res.on('data', (d) => { b += d; });
    res.on('end', () => { if (res.statusCode !== 200) return no(new Error(`${path} ${res.statusCode} ${b.slice(0, 120)}`)); try { ok(JSON.parse(b)); } catch (e) { no(e); } });
  });
  req.on('timeout', () => req.destroy(new Error(`${path} timed out`)));
  req.on('error', no);
  req.end(body ? JSON.stringify(body) : undefined);
});

/**
 * `ARENA_HOSTS_LND` = "<lnddir>,<REST base>[,<network>]" (the read-only macaroon and tls.cert are read from the lnddir) and
 * `ARENA_HOSTS_GATEWAY` = "<name>,<base>,<password file>[,<dead-notes file>]", or null when the environment names neither. The fourth
 * field (kanban #2773) is the JSON tools/gateway-dead-notes.mjs writes for this gateway: its dead notes join the warning.
 */
export function hostsFromEnv(env = process.env) {
  const l = env.ARENA_HOSTS_LND ? env.ARENA_HOSTS_LND.split(',').map((s) => s.trim()) : null;
  const g = env.ARENA_HOSTS_GATEWAY ? env.ARENA_HOSTS_GATEWAY.split(',').map((s) => s.trim()) : null;
  if (!l && !g) return null;
  return {
    lnd: l ? { lnddir: l[0], rest: l[1].replace(/\/+$/, ''), network: l[2] || 'testnet4' } : null,
    gateway: g ? { name: g[0], base: g[1].replace(/\/+$/, ''), passwordFile: g[2], ...(g[3] ? { deadFile: g[3] } : {}) } : null,
  };
}

/** The figures of one LND, over its REST API: who it is, its channels, its routing fees (30 d) and the fees its own payments paid. */
export async function readLnd({ lnddir, rest, network }, { call = null, readFile = readFileSync, nowMs = Date.now() } = {}) {
  const get = call || lndRest({ rest, cert: readFile(`${lnddir}/tls.cert`),
    macaroonHex: readFile(`${lnddir}/data/chain/bitcoin/${network}/readonly.macaroon`).toString('hex') });
  const [info, bal, fwd, pays] = await Promise.all([
    get('/v1/getinfo'), get('/v1/balance/channels'),
    get('/v1/switch', { start_time: String(Math.floor((nowMs - 30 * DAY) / 1000)), num_max_events: 50000 }),
    get('/v1/payments?max_payments=100000&include_incomplete=false'),
  ]);
  const msat = (b) => (b && b.msat !== undefined ? String(b.msat) : b && b.sat !== undefined ? String(BigInt(b.sat) * 1000n) : '0');
  const routing = (fwd.forwarding_events || []).reduce((t, e) => t + BigInt(e.fee_msat || 0), 0n);
  // THE FEES THIS LND PAID: its own payments that succeeded, each with when it was made - the dashboard's Lightning costs
  const paid = (pays.payments || []).filter((p) => p.status === 'SUCCEEDED' && BigInt(p.fee_msat || 0) > 0n)
    .map((p) => ({ atMs: Math.floor(Number(p.creation_time_ns || 0) / 1e6), feeMsat: String(p.fee_msat) }));
  return {
    alias: info.alias || '', pubkey: info.identity_pubkey || '', activeChannels: Number(info.num_active_channels || 0),
    synced: !!info.synced_to_chain, localMsat: msat(bal.local_balance), remoteMsat: msat(bal.remote_balance),
    routingFeesMsat30d: String(routing), forwards30d: (fwd.forwarding_events || []).length, paymentFees: paid, readAtMs: nowMs,
  };
}

/**
 * The figures of one gateway, over its loopback HTTP: state, balances per federation, and its last 30 days of payments. And (kanban
 * #2773) its money-loss watch: each federation's payment log of the last 24 h judged by gateway-loss.js - failed payments, "note
 * already spent" by name, the balance against what the payments explain since `prev` (the last reading), the dead notes of `deadFile` -
 * as `watch` and one `warning` line ('bad' is the owner's red card). A log that cannot be read leaves the watch saying so, by name.
 */
export async function readGateway({ name, base, passwordFile, deadFile = null }, { fetcher = fetch, readPassword = (f) => readFileSync(f, 'utf8').trim(), nowMs = Date.now(), prev = null, readFile = readFileSync } = {}) {
  const auth = { Authorization: `Bearer ${readPassword(passwordFile)}` };
  const get = async (p) => { const r = await fetcher(`${base}${p}`, { headers: auth }); if (!r.ok) throw new Error(`${p} ${r.status}`); return r.json(); };
  const [info, bal, sum] = await Promise.all([get('/v1/info'), get('/v1/balances'),
    fetcher(`${base}/v1/payment_summary`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ start_millis: nowMs - 30 * DAY, end_millis: nowMs }) }).then((r) => (r.ok ? r.json() : null))]);
  const side = (s) => (s ? { success: Number(s.total_success || 0), failure: Number(s.total_failure || 0), feesMsat: String(s.total_fees || 0) } : null);
  const ln = info.lightning_info && info.lightning_info.connected;
  return {
    name, state: info.gateway_state || '', lightningAlias: ln ? ln.alias || '' : '',
    federations: (info.federations || []).map((f) => ({ id: f.federation_id || '', name: f.federation_name || '', ecashMsat: String(f.balance_msat || 0) })),
    lightningMsat: String(bal.lightning_balance_msats || 0), inboundMsat: String(bal.inbound_lightning_liquidity_msats || 0),
    onchainSat: String(bal.onchain_balance_sats || 0),
    payments30d: sum ? { incoming: side(sum.incoming), outgoing: side(sum.outgoing) } : null, readAtMs: nowMs,
    ...(await watchGateway({ name, base, auth, fetcher, nowMs, federations: info.federations || [], prev, deadFile, readFile })),
  };
}

/** kanban #2773: the watch part of readGateway - { watch: { failures, drops, dead, error? }, warning }. */
async function watchGateway({ name, base, auth, fetcher, nowMs, federations, prev, deadFile, readFile }) {
  const post = async (p, body) => { const r = await fetcher(`${base}${p}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${p} ${r.status}`); return r.json(); };
  const sinceMs = nowMs - WATCH_WINDOW_MS;
  const failures = { failed: 0, alreadySpent: 0, rejectedReceives: 0, failedMsat: '0', lastAtMs: null, lastError: null };
  // the drops seen before stay for the window: a loss is one interval long, the card must not vanish a minute later
  const drops = ((prev && prev.watch && prev.watch.drops) || []).filter((d) => d.toMs >= sinceMs);
  // kanban #2773: and the rises nothing explains (e-cash received from another of our gateways), for health-watcher netMoves
  const rises = ((prev && prev.watch && prev.watch.rises) || []).filter((d) => d.toMs >= sinceMs);
  let error = null;
  for (const f of federations) {
    const id = f.federation_id || '';
    let evs;
    try { evs = await readPaymentLog(post, id, { sinceMs }); } catch (e) { error = `payment log of ${id.slice(0, 8)}: ${e.message}`; continue; }
    const one = failuresOf(evs, { nowMs });
    failures.failed += one.failed; failures.alreadySpent += one.alreadySpent; failures.rejectedReceives += one.rejectedReceives;
    failures.failedMsat = String(BigInt(failures.failedMsat) + BigInt(one.failedMsat));
    if (one.lastAtMs !== null && (failures.lastAtMs === null || one.lastAtMs > failures.lastAtMs)) { failures.lastAtMs = one.lastAtMs; failures.lastError = one.lastError; }
    const was = prev && !prev.error && (prev.federations || []).find((x) => x.id === id);
    if (was && prev.readAtMs) {
      const d = balanceCheck({ atMs: prev.readAtMs, ecashMsat: was.ecashMsat }, { atMs: nowMs, ecashMsat: String(f.balance_msat || 0) }, evs);
      if (d.over) drops.push({ federation: id, unexplainedMsat: d.unexplainedMsat, over: true, fromMs: d.fromMs, toMs: d.toMs });
      // kanban #2865: e-cash that comes back nets the drops of this federation still held for the window, oldest first - an
      // out-and-back (the 11-15 gw-c cleanup: whole balance spent and received again) no longer stays red for 24 h
      let back = BigInt(d.returnedMsat || '0');
      for (const x of drops) {
        if (back <= 0n || x.federation !== id || x.moved) continue;
        const left = BigInt(x.unexplainedMsat), take = back < left ? back : left;
        x.unexplainedMsat = String(left - take); x.nettedMsat = String(BigInt(x.nettedMsat || '0') + take); back -= take;
        x.over = BigInt(x.unexplainedMsat) > BigInt(DROP_MSAT);
      }
      // kanban #2773: what is left of it is a rise nothing explains - kept for the window, a drop on another gateway may be its other end
      if (back > BigInt(DROP_MSAT)) rises.push({ federation: id, msat: String(back), fromMs: d.fromMs, toMs: d.toMs });
    }
  }
  let dead = null;
  if (deadFile) { try { dead = JSON.parse(readFile(deadFile, 'utf8')); } catch { dead = null; } }
  const warning = gatewayWarning(name, { failures, drops, dead });
  if (error && warning.level === 'ok') { warning.level = 'warn'; warning.text = `${name}: the payment log was not read (${error})`; }
  return { watch: { failures, drops, rises, dead, ...(error ? { error } : {}) }, warning };
}

/**
 * THE READER A NODE IS HANDED (main.js, only when its environment names a host): `snapshot()` is the last reading, never a
 * wait; `refresh()` reads both again; `start()` refreshes now and every `everyMs`. A part that fails keeps its error, by name.
 */
export function hostsReader(cfg, { readLndWith = readLnd, readGatewayWith = readGateway, everyMs = 60000, now = Date.now } = {}) {
  let last = { lnd: null, gateway: null };
  let timer = null;
  const refresh = async () => {
    const at = now();
    const [l, g] = await Promise.all([
      cfg.lnd ? readLndWith(cfg.lnd, { nowMs: at }).catch((e) => ({ error: e.message, readAtMs: at })) : null,
      cfg.gateway ? readGatewayWith(cfg.gateway, { nowMs: at, prev: last.gateway }).catch((e) => ({ name: cfg.gateway.name, error: e.message, readAtMs: at })) : null,
    ]);
    last = { lnd: l, gateway: g };
    return last;
  };
  return {
    snapshot: () => last,
    refresh,
    start() { refresh().catch(() => {}); timer = setInterval(() => refresh().catch(() => {}), everyMs); if (timer.unref) timer.unref(); return this; },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}
