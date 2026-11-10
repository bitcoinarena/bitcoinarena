// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DEVNET'S PORTS AND ITS CHECK OF THEM (docs/PLATFORM-RESEARCH.md item 15): the pure half of
// tools/devnet.mjs, kept apart so a test reads it without starting anything.
//
// ONE BASE, EVERYTHING ELSE DERIVED FROM IT (DEVNET_BASE_PORT, default 24000). A developer moves a whole devnet by one
// number, and two devnets on one machine are two bases. The layout:
//   base + 1             bitcoind RPC (regtest, cookie auth)
//   base + 2             bitcoind P2P (named, never bound: the devnet's bitcoind runs with -listen=0)
//   base + 3             the page server, only when DEVNET_PAGE_DIR names a built page
//   base + 5             the runner's control door (GET /state, POST /open-free), 127.0.0.1 only
//   base + 6, + 7        bitcoind's ZMQ block and transaction feeds, for the lnds
//   base + 8             the LNURL door a proposal's payout asks for an invoice (devnet.mjs liquidity), 127.0.0.1 only
//   base + 10 .. 12      lnd A (rpc, p2p, rest), base + 20 .. 22 lnd B
//   base + 30 .. 32      gateway A on lnd A (api, iroh, metrics), base + 40 .. 42 gateway B on lnd B: the two gateways of
//                        different operators a paying round's federation must have live (§23.6, server.js POST /round)
//   base + 50 .. 52      lnd C (devnet.mjs liquidity): a payee no gateway runs on, so no payment is a gateway's self-payment
//   base + 100 + 10 k    the seven nodes, k = 0 .. 6
//   node + 1000 .. 4000  each node's guardian (src/guardian.js guardianPorts: api, p2p, ui, metrics)
// So base 24000 uses 24001-24052, 24100-24160 and 25100-28160.
//
// EVERY PORT BELOW 32768, outside the ephemeral range Linux and macOS hand to outbound sockets (an lnd once lost its listen
// port to one; docs in tools/tn4-tools-regtest.sh), and none of the ports the live stacks hold: signal-cli's 8080, OpenClaw's
// 18789, the seats and guardians of both testnet4 federations, the live bitcoinds, lnd-testnet4, the harness metrics and the
// macOS's gateway and arbiter. A base that would land on one is refused by name before anything starts.
export const NODE_COUNT = 7;

/** Ports and ranges a devnet may never bind: [from, to, whose]. */
export const FORBIDDEN = Object.freeze([
  [8080, 8080, 'signal-cli'],
  [18789, 18789, 'OpenClaw'],
  [6221, 6291, 'testnet4 federation B seats'],
  [7221, 7291, 'testnet4 federation B guardians'],
  [31221, 31291, 'testnet4 federation A seats'],
  [32221, 35281, 'testnet4 guardians'],
  [48332, 48332, 'the testnet4 bitcoind'],
  [48342, 48342, 'the test host testnet4 bitcoind'],
  [11009, 11009, 'lnd-testnet4'],
  [20241, 20241, 'the harness metrics'],
  [31290, 31295, 'the test host gateway and arbiter'],
]);

/** Whose port this is, when a devnet may not take it; null when it may. */
export function forbiddenWhy(port) {
  const hit = FORBIDDEN.find(([from, to]) => port >= from && port <= to);
  return hit ? hit[2] : null;
}

/**
 * Every port of a devnet on `base`, named. Throws when a port is not a private one (1024 .. 32767) or is one of the
 * forbidden ones above, naming each.
 */
export function devnetPorts(base = 24000) {
  const b = Number(base);
  if (!Number.isInteger(b)) throw new Error(`DEVNET_BASE_PORT must be a whole number, not ${base}`);
  const nodes = Array.from({ length: NODE_COUNT }, (_, k) => b + 100 + 10 * k);
  const guardians = nodes.map((p) => ({ api: p + 1000, p2p: p + 2000, ui: p + 3000, metrics: p + 4000 }));
  const lnd = (o) => ({ rpc: b + o, p2p: b + o + 1, rest: b + o + 2 });
  const gateway = (o) => ({ api: b + o, iroh: b + o + 1, metrics: b + o + 2 });
  // AUDIT-ONLY NODES (kanban #1412: the head-to-head audit measured with six auditors outside the seven): DEVNET_AUDITORS of them, from base + 300
  const auditors = Array.from({ length: Math.max(0, Math.min(9, Number(process.env.DEVNET_AUDITORS || 0))) }, (_, k) => b + 300 + 10 * k);
  const plan = { base: b, rpc: b + 1, p2p: b + 2, page: b + 3, control: b + 5, zmqBlock: b + 6, zmqTx: b + 7, lnurl: b + 8,
    lnd: { a: lnd(10), b: lnd(20), c: lnd(50) }, gateway: { a: gateway(30), b: gateway(40) }, nodes, guardians, auditors };
  const all = [
    { port: plan.rpc, what: 'bitcoind rpc' }, { port: plan.p2p, what: 'bitcoind p2p' },
    { port: plan.zmqBlock, what: 'bitcoind zmq blocks' }, { port: plan.zmqTx, what: 'bitcoind zmq transactions' },
    { port: plan.page, what: 'page' }, { port: plan.control, what: 'runner control' }, { port: plan.lnurl, what: 'lnurl door' },
    ...Object.entries(plan.lnd.c).map(([role, port]) => ({ port, what: `lnd c ${role}` })),
    ...['a', 'b'].flatMap((x) => [...Object.entries(plan.lnd[x]).map(([role, port]) => ({ port, what: `lnd ${x} ${role}` })),
      ...Object.entries(plan.gateway[x]).map(([role, port]) => ({ port, what: `gateway ${x} ${role}` }))]),
    ...auditors.map((p, k) => ({ port: p, what: `auditor ${k + 1}` })),
    ...nodes.flatMap((p, k) => [{ port: p, what: `node ${k + 1}` },
      ...Object.entries(guardians[k]).map(([role, port]) => ({ port, what: `node ${k + 1} guardian ${role}` }))]),
  ];
  const bad = all.map((x) => {
    if (x.port < 1024 || x.port > 32767) return `${x.what} would be ${x.port}, outside 1024 .. 32767`;
    const who = forbiddenWhy(x.port);
    return who ? `${x.what} would be ${x.port}, which ${who} holds` : null;
  }).filter(Boolean);
  if (bad.length) throw new Error(`DEVNET_BASE_PORT ${b} cannot be used: ${bad.slice(0, 4).join('; ')}${bad.length > 4 ? `; and ${bad.length - 4} more` : ''}`);
  return { ...plan, all };
}

/** The pay request the devnet's LNURL door answers (LUD-06): one metadata, every amount a payout could ask. */
export const LNURL_METADATA = JSON.stringify([['text/plain', 'a devnet funding payout']]);
export const lnurlPayRequest = (port) => ({ tag: 'payRequest', callback: `http://127.0.0.1:${port}/invoice`, metadata: LNURL_METADATA,
  minSendable: 1000, maxSendable: 100000000000 });

/**
 * THE HEIGHTS OF A FUNDING PAYOUT ON A DEVNET (spec §27A.9.3, tools/funding-regtest.mjs). A seat counts a node active when it served in 3 of the 4 weeks before the
 * signal's end, each week read on the chain's clock, so what counts is the block a round's FINAL fell behind - and opening a round on this chain mines up to about
 * 75 blocks of its own (its publication and its beacon, measured 14 to 73). So the heights come from where the last FINAL really fell: the next round is mined up to a
 * week after it, which leaves each FINAL 108 to 183 blocks after the one before, and the signal ends 12 blocks after the last. The weeks back from there then hold
 * the last FINAL, the one before, and the first (in the third week or the fourth).
 */
export const nextRoundHeight = (lastFinalTip, schedule) => lastFinalTip + schedule.week;
export function firstRoundHeight({ tip, lastBond, schedule: S }) {
  // every bond a season old at the publication, which comes at least two rounds later, and the signal's end past the active window a seat reads back
  return Math.max(tip + 1, lastBond + S.season + 12 - 2 * S.week, S.activeWindow - 2 * S.week);
}
export function signalHeights(lastFinalTip, schedule) {
  const E = lastFinalTip + 12;
  return { E, P: E - schedule.signal };
}
/** The week before `E` a FINAL behind block `tip` falls in: 0 is the newest, 3 the oldest a seat counts; null when older. */
export function weekOf(tip, E, schedule) {
  const k = Math.floor((E - 1 - tip) / schedule.week);
  return k >= 0 && k < 4 ? k : null;
}

/**
 * The TCP ports some process listens on, read from `ss -ltnH` (Linux) or `lsof -nP -iTCP -sTCP:LISTEN` (macOS) output.
 * An address of either shape: `127.0.0.1:24101`, `*:8080`, `[::1]:24001`; the peer column (`0.0.0.0:*`) names no port.
 */
export function parseListening(text) {
  const out = new Set();
  for (const line of String(text || '').split('\n')) {
    const lsof = line.match(/:(\d+)\s+\(LISTEN\)/);
    if (lsof) { out.add(Number(lsof[1])); continue; }
    for (const tok of line.trim().split(/\s+/)) {
      const m = tok.match(/^(?:\S*):(\d+)$/);
      if (m) { out.add(Number(m[1])); break; }
    }
  }
  return out;
}

/** The ports of `plan` something else already listens on: `listening` minus the ports the devnet's own running parts hold. */
export function clashes(plan, listening, ours = new Set()) {
  return plan.all.filter((x) => listening.has(x.port) && !ours.has(x.port));
}

/** The ports one devnet part holds, so a part that already runs is not its own clash: 'bitcoind', 'lnd-a', 'gateway-b',
 * 'node-<k>', 'runner', 'page', 'lnurl'. */
export function portsOfPart(plan, name) {
  if (name === 'bitcoind') return [plan.rpc, plan.p2p, plan.zmqBlock, plan.zmqTx];
  if (name === 'lnd-a' || name === 'lnd-b' || name === 'lnd-c') return Object.values(plan.lnd[name.slice(-1)]);
  if (name === 'gateway-a' || name === 'gateway-b') return Object.values(plan.gateway[name.slice(-1)]);
  if (name === 'runner') return [plan.control];
  if (name === 'page') return [plan.page];
  if (name === 'lnurl') return [plan.lnurl];
  // the audit-only nodes (kanban #1412): a running one's port is this devnet's, so `up` on it again starts only what is down
  const au = /^auditor-(\d)$/.exec(name);
  if (au) return plan.auditors && plan.auditors[Number(au[1]) - 1] ? [plan.auditors[Number(au[1]) - 1]] : [];
  const k = /^node-(\d)$/.exec(name);
  if (k && Number(k[1]) >= 1 && Number(k[1]) <= NODE_COUNT) {
    const i = Number(k[1]) - 1;
    return [plan.nodes[i], ...Object.values(plan.guardians[i])];
  }
  return [];
}
