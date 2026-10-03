// WHAT THIS NODE HOSTS (the owner 2026-10-03 22:50, plan accepted 2026-10-04): node 1 hosts gateway A and LND 1, node 2 gateway
// B and LND 2, nodes 3-7 neither. A node that hosts them shows them on its own /dashboard, read here - read-only, from this
// machine: the LND through lncli (getinfo, channelbalance, fwdinghistory, listpayments), the gateway over loopback HTTP
// (GET /v1/info and /v1/balances, POST /v1/payment_summary), its password from its file. Nothing here restarts, moves or
// configures either. The reading is refreshed every 60 s in the background, so a dashboard read never waits on Lightning,
// and the password and the macaroon never leave this file: the snapshot carries figures only.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DAY = 86400000;
const execFileJson = (bin, args, env) => new Promise((ok, no) => execFile(bin, args, { timeout: 20000, maxBuffer: 64 << 20, ...(env ? { env } : {}) },
  (e, out, err) => (e ? no(new Error(String(err || e.message).trim().slice(0, 200))) : ok(JSON.parse(out)))));

/**
 * `BLWP_HOSTS_LND` = "<lnddir>,<rpcserver>[,<network>[,<lncli>]]" and `BLWP_HOSTS_GATEWAY` = "<name>,<base>,<password file>",
 * or null when the environment names neither.
 */
export function hostsFromEnv(env = process.env) {
  const l = env.BLWP_HOSTS_LND ? env.BLWP_HOSTS_LND.split(',').map((s) => s.trim()) : null;
  const g = env.BLWP_HOSTS_GATEWAY ? env.BLWP_HOSTS_GATEWAY.split(',').map((s) => s.trim()) : null;
  if (!l && !g) return null;
  return {
    lnd: l ? { lnddir: l[0], rpcserver: l[1], network: l[2] || 'testnet4', lncli: l[3] || '/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta/lncli' } : null,
    gateway: g ? { name: g[0], base: g[1].replace(/\/+$/, ''), passwordFile: g[2] } : null,
  };
}

/** The figures of one LND, by lncli: who it is, its channels, its routing fees (30 d) and the fees its own payments paid. */
export async function readLnd({ lnddir, rpcserver, network, lncli }, { run = execFileJson, nowMs = Date.now() } = {}) {
  const a = [`--lnddir=${lnddir}`, `--rpcserver=${rpcserver}`, `--network=${network}`];
  // HOME IS THE LND'S OWN DIRECTORY (measured on seats 1 and 2, 2026-10-03 23:31Z: lncli under the node read
  // /root/.lncli/profiles.json, was refused, and read nothing): no lncli profile there, so the flags above are all it uses
  const env = { ...process.env, HOME: lnddir };
  const [info, bal, fwd, pays] = await Promise.all([
    run(lncli, [...a, 'getinfo'], env), run(lncli, [...a, 'channelbalance'], env),
    run(lncli, [...a, 'fwdinghistory', '--start_time=-30d', '--max_events=50000'], env),
    run(lncli, [...a, 'listpayments', '--max_payments=100000'], env),
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

/** The figures of one gateway, over its loopback HTTP: state, balances per federation, and its last 30 days of payments. */
export async function readGateway({ name, base, passwordFile }, { fetcher = fetch, readPassword = (f) => readFileSync(f, 'utf8').trim(), nowMs = Date.now() } = {}) {
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
  };
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
      cfg.gateway ? readGatewayWith(cfg.gateway, { nowMs: at }).catch((e) => ({ name: cfg.gateway.name, error: e.message, readAtMs: at })) : null,
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
