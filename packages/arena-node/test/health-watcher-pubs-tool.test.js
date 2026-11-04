// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE HEALTH WATCHER'S ROUND PUBLICATIONS (kanban #759, 2026-10-28: "make sure that all of our rounds always get confirmed", "public
// testnet4", "Also increase the fees for the unconfirmed transactions"): tools/health-watcher.mjs + health-watcher-pubs.mjs against two fake
// bitcoinds - our branch and the public chain. Today's case: the 3 emergency grids confirmed on our branch, on the public chain only in its
// mempool - alerted in the short format, bumped by CPFP (never RBF), rechecked; a tx a chain lacks is sent to it, parents first; one in our
// mempool and not on miner C's list is added; the public mining hook runs only with HW_PUBLIC_CONFIRM=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, pass } from '../tools/health-watcher.mjs';
import { pubSources, opsPublished, lookScript, parseLook, callsScript, parseCalls, esploraCalls, esploraErr, decodePayload, spanText } from '../tools/health-watcher-pubs.mjs';

const NOW = Date.UTC(2026, 9, 28, 11, 0, 0);
const T = (c) => c.repeat(64).slice(0, 64);
const UD = T('71eac027'), RPS = T('dd9a81ca'), NB = T('fde7abcc'), PARENT = T('4b0bcd53'), OLD = T('b03f56b7');
const ADDR = (t) => `tb1q${t.slice(0, 8)}`;
// a publication: an OP_RETURN and a change output of the posting wallet, 146-193 vB at 1 sat/vB
const tx = (txid, { vin = [], vsize = 150, fee = 150, change = 81738 } = {}) => ({ txid, hex: `02${txid}`, vsize, fee, vin, vout: [{ n: 0, sat: 0 }, { n: 1, sat: change, address: ADDR(txid), spk: `0014${txid.slice(0, 40)}` }] });

function chain(tip) { return { tip, blocks: new Map(), mem: new Set(), spent: new Set(), refuse: new Map(), sent: [], packages: [], kids: new Map() }; }
function makeWorld({ at = NOW } = {}) {
  const txs = new Map([[UD, tx(UD)], [RPS, tx(RPS, { vin: [PARENT], vsize: 193, fee: 193 })], [NB, tx(NB)], [PARENT, tx(PARENT)], [OLD, tx(OLD)]]);
  const w = { now: at, txs, ours: chain(157835), public: chain(157881), minerList: new Set(), adds: [], posts: [], runs: [],
    pending: { tip: 157835, txs: [], grids: [UD, RPS, NB].map((t, i) => ({ game: ['btc-updown-15m', 'rock-paper-scissors', 'nextblock'][i], firstWindowMs: String(NOW - 2 * 3600000), lastCloseMs: String(NOW + 12 * 3600000), publication: { txid: t } })) },
    duty: { days: [] }, ops: [], childN: 0 };
  const block = (c, h, ids) => { c.blocks.set(h, { hash: T(String(h % 10)).replace(/^./, 'a') + '', ids: new Set(ids) }); for (const t of ids) c.mem.delete(t); };
  w.block = block;
  // today: the 3 grids in our blocks 157832/157833 (4 and 3 deep), on the public chain only in its mempool; the parent confirmed on both
  block(w.ours, 157832, [UD, RPS, PARENT]); block(w.ours, 157833, [NB]); block(w.public, 157860, [PARENT]);
  for (const t of [UD, RPS, NB]) w.public.mem.add(t);
  const look = (c, { txids, from, back, max, verify }) => {
    const set = new Set(txids), start = from == null ? c.tip - back : from, end = Math.min(c.tip, start + max - 1), found = [];
    for (let h = start; h <= end; h++) { const b = c.blocks.get(h); if (b) for (const t of b.ids) if (set.has(t)) found.push({ txid: t, h, hash: b.hash }); }
    return { tip: c.tip, mem: [...c.mem].filter((t) => set.has(t)), found, stale: verify.filter(([h, hash]) => !(c.blocks.get(h) && c.blocks.get(h).hash === hash)).map(([h]) => h), scannedTo: end };
  };
  const byHex = (hex) => [...w.txs.values()].find((x) => x.hex === hex);
  const call = (name, c, args) => {
    const a = args.filter((x) => !String(x).startsWith('-rpcwallet='));
    const ok = (out) => ({ ok: true, out: typeof out === 'string' ? out : JSON.stringify(out) }), no = (err) => ({ ok: false, out: '', err: `error code: -26\nerror message:\n${err}` });
    switch (a[0]) {
      case 'getrawtransaction': { const x = w.txs.get(a[1]); return x && (c.mem.has(a[1]) || [...c.blocks.values()].some((b) => b.ids.has(a[1]))) ? ok({ hex: x.hex, vsize: x.vsize, fee: x.fee / 1e8, vin: x.vin.map((t) => ({ txid: t, vout: 1 })), vout: x.vout.map((o) => ({ n: o.n, value: o.sat / 1e8, scriptPubKey: { hex: o.spk, address: o.address } })) }) : no('No such mempool transaction'); }
      case 'sendrawtransaction': { const x = byHex(a[1]); c.sent.push(x.txid); if (c.refuse.has(x.txid)) return no(c.refuse.get(x.txid)); c.mem.add(x.txid); return ok(x.txid); }
      case 'submitpackage': { const hs = JSON.parse(a[1]); c.packages.push(hs.map((h) => byHex(h).txid)); for (const h of hs) c.mem.add(byHex(h).txid); return ok({ package_msg: 'success' }); }
      case 'getaddressinfo': return ok({ ismine: /^tb1q/.test(a[1]) });
      case 'gettxout': return w.ours.spent.has(`${a[1]}:${a[2]}`) ? ok('') : ok({ value: 0.0008, confirmations: 3 });
      case 'getmempoolentry': { const x = w.txs.get(a[1]); return c.mem.has(a[1]) ? ok({ ancestorsize: x.vsize, fees: { base: x.fee / 1e8, ancestor: x.fee / 1e8 } }) : no('Transaction not in mempool'); }
      case 'getmempooldescendants': return c.mem.has(a[1]) ? ok(c.kids.get(a[1]) || []) : no('Transaction not in mempool');
      case 'estimatesmartfee': return ok({ errors: ['Insufficient data or no feerate found'], blocks: 2 });
      case 'getmempoolinfo': return ok({ mempoolminfee: 0.000001 });
      case 'getrawchangeaddress': return ok('tb1qchild');
      case 'createrawtransaction': { const [inp] = JSON.parse(a[1]); const out = JSON.parse(a[2]); return ok(`raw:${inp.txid}:${Math.round(Object.values(out[0])[0] * 1e8)}`); }
      case 'signrawtransactionwithwallet': {
        const id = T(`c${++w.childN}`); const [, parent, value] = a[1].split(':');
        w.txs.set(id, { txid: id, hex: `02${id}`, vsize: 110, fee: w.txs.get(parent).vout[1].sat - Number(value), vin: [parent], vout: [{ n: 0, sat: Number(value), address: 'tb1qchild' }] });
        w.lastChild = { id, parent, fee: w.txs.get(parent).vout[1].sat - Number(value) };
        return ok({ hex: `02${id}`, complete: true });
      }
      default: return no(`unknown ${a[0]}`);
    }
  };
  w.io = {
    now: () => w.now, loadavg: async () => [1, 1, 1],
    identity: async () => ({ ok: true, key: T('5') }),
    get: async (base, path) => (path === '/rounds?next=8' ? { ok: true, body: { rounds: [] } } : path === '/duty' ? { ok: true, body: w.duty } : path === '/pending' ? { ok: true, body: w.pending }
      : path === '/expected' ? { ok: true, body: { expected: [] } } : { ok: false, why: 'HTTP 404' }),
    units: async () => ({}),
    minercCheck: async (ids) => ({ listed: ids.filter((t) => w.minerList.has(t)), missing: ids.filter((t) => !w.minerList.has(t)) }),
    minercAdd: async (ids) => { w.adds.push(ids); for (const t of ids) w.minerList.add(t); },
    post: async (text) => { w.posts.push(text); },
    opsPublished: async () => w.ops,
    chainLook: async (name, opts) => look(w[name], opts),
    chainCalls: async (name, calls) => calls.map((c) => call(name, w[name], c)),
    run: async (cmd, args) => { w.runs.push(args.join(' ')); return 'mined'; },
  };
  return w;
}
const CFG = (env = {}) => config({ HW_STATE: '/x/hw.json', HW_MAC_SEATS: ' ', HW_HOST_SEATS: 'http://127.0.0.1:31221', ...env }, []);
const go = async (w, st, cfg = CFG(), k = 1) => { let r; for (let i = 0; i < k; i++) { r = await pass(w.io, cfg, st); st = r.state; w.now += 180000; } return { r, st }; };
const pubAlerts = (w) => w.posts.filter((t) => /round publication not confirmed/.test(t));

test('today: 3 grids confirmed on our branch, only in the public mempool - alerted short, bumped by CPFP once each, never RBF', async () => {
  const w = makeWorld();
  w.ops = [{ txid: UD, game: 'updownGrid', atMs: NOW - 30 * 60000 }];
  let { r, st } = await go(w, {});
  assert.equal(pubAlerts(w).length, 1);
  assert.equal(pubAlerts(w)[0], ['[health-watcher] #759 @owner PROBLEM: round publication not confirmed',
    '• Up/Down grid for 10-28 09:00-23:00Z, txid 71eac027: ours confirmed (4), public mempool, 30 min',
    '• RPS grid for 10-28 09:00-23:00Z, txid dd9a81ca: ours confirmed (4), public mempool, 0 min',
    '• Next Block grid for 10-28 09:00-23:00Z, txid fde7abcc: ours confirmed (3), public mempool, 0 min',
    'Tried: nothing yet', 'Needs: public mining (HW_PUBLIC_CONFIRM off), see #759'].join('\n'));
  // three children: each spends its publication's change, pays 2 sat/vB over parent + child (146-193 + 110 vB) minus the parent's fee
  const kids = r.did.filter((x) => x.kind === 'cpfp');
  assert.equal(kids.length, 3);
  assert.ok(kids.every((x) => x.ok), JSON.stringify(kids));
  assert.match(kids.find((x) => x.txid === RPS).why, /^dd9a81ca child [0-9a-f]{8} 413 sat at 2\.0 sat\/vB$/);   // 2 x (193 + 110) - 193
  assert.equal(w.public.sent.length, 3, 'each child sent to the public chain alone (its parent is in the public mempool)');
  assert.equal(w.ours.sent.length, 3, 'and to our branch, so the posting wallet never spends that change twice');
  assert.equal(w.public.packages.length, 0);
  assert.ok(Object.values(st.pubs).filter((p) => p.child).length === 3, 'the children tracked like the rest');
  // the recheck: no second bump within the hour; the alert not again within the hour
  for (const t of [UD, RPS, NB]) w.public.kids.set(t, [T('c1')]);
  ({ r, st } = await go(w, st, CFG(), 3));
  assert.equal(r.did.filter((x) => x.kind === 'cpfp').length, 0);
  assert.equal(pubAlerts(w).length, 1);
  // the public chain mines them (and the children): resolved after two passes
  w.public.tip = 157890; w.block(w.public, 157890, [...w.public.mem]);
  w.ours.tip = 157841; w.block(w.ours, 157841, [...w.ours.mem]);
  ({ st } = await go(w, st, CFG(), 2));
  assert.equal(w.posts.filter((t) => /RESOLVED: round publication not confirmed/.test(t)).length, 1);
});

test('a publication the public chain lacks is sent to it, parents first, once per 30 min; a refused one says why', async () => {
  const w = makeWorld();
  w.public.mem.clear(); w.public.blocks.clear();               // the public chain has neither the grids nor the parent
  w.public.refuse.set(NB, 'bad-txns-inputs-missingorspent');
  let { r, st } = await go(w, {}, CFG({ HW_CPFP: '0' }));
  // first pass: the 3 grids (the parent is learnt from the RPS grid's inputs, tracked from now on)
  assert.deepEqual(w.public.sent.slice().sort(), [UD, RPS, NB].sort());
  ({ r, st } = await go(w, st, CFG({ HW_CPFP: '0' })));
  assert.deepEqual(w.public.sent.slice(3), [PARENT], 'the parent next; the grids not again within 30 min');
  // (an alert's lines are read before the pass's fixes: the refusal shows from the next pass)
  const p = r.problems.find((x) => x.key === 'publications');
  assert.ok(p.lines.includes('Next Block grid for 10-28 09:00-23:00Z, txid fde7abcc: ours confirmed (3), public missing, 3 min; rebroadcast 11:00Z refused: bad-txns-inputs-missingorspent'), p.lines.join('\n'));
  assert.deepEqual(p.tried, ['rebroadcast']);
  assert.equal(st.pubs[UD].public.s, 'mempool');
  ({ st } = await go(w, st, CFG({ HW_CPFP: '0' }), 10));      // 30 min later: the refused one tried again
  assert.equal(w.public.sent.filter((t) => t === NB).length, 2);
});

test('our branch: a publication in our mempool joins miner C\'s list; listed and unmined past 2 of our blocks - alerted', async () => {
  const w = makeWorld();
  w.ours.blocks.delete(157833); w.ours.mem.add(NB); w.public.mem.delete(NB); w.public.blocks.set(157880, { hash: T('e'), ids: new Set([NB]) });
  let { st } = await go(w, {}, CFG({ HW_CPFP: '0' }));
  assert.deepEqual(w.adds, [[NB]], 'added to miner C at once (a publication does not wait 30 min)');
  w.ours.tip += 2;
  const { r } = await go(w, st, CFG({ HW_CPFP: '0' }));
  const lines = r.problems.find((x) => x.key === 'publications').lines;
  assert.ok(lines.some((l) => /^Next Block grid for 10-28 09:00-23:00Z, txid fde7abcc: ours mempool, public confirmed \(2\), 3 min$/.test(l)), lines.join('\n'));
});

test('CPFP guards: a change spent on our branch, a child already in the public mempool, a fee over the cap - no child; HW_CPFP=0 none', async () => {
  const w = makeWorld();
  w.ours.spent.add(`${UD}:1`); w.public.kids.set(RPS, [T('9')]);
  let { r, st } = await go(w, {}, CFG({ HW_CPFP_MAX_SAT: '420' }));
  const by = Object.fromEntries(r.did.filter((x) => x.kind === 'cpfp').map((x) => [x.txid.slice(0, 8), x]));
  assert.match(by['71eac027'].why, /its change is spent already/);
  assert.match(by.dd9a81ca.why, /has a child in the public mempool already \(99999999\)/);
  assert.match(by.fde7abcc.why, /^fde7abcc child/, 'under the cap: 2 x (150 + 110) - 150 = 370 sat');
  assert.equal(w.ours.sent.length, 1);
  assert.equal(st.pubs[UD].bumps.length, 1, 'a bump that cannot be made counts as the try: once per hour');
  ({ r, st } = await go(w, st, CFG({ HW_CPFP_MAX_SAT: '420' })));
  assert.match(r.problems.find((x) => x.key === 'publications').lines[0], /^Up\/Down grid for 10-28 09:00-23:00Z, txid 71eac027: .*, \d+ min; CPFP 11:00Z refused: its change is spent already \(bump the spender\)$/);
  assert.equal(r.did.filter((x) => x.kind === 'cpfp').length, 0);
  const w2 = makeWorld(); w2.public.mem.delete(UD);
  const capped = await go(w2, {}, CFG({ HW_CPFP_MAX_SAT: '100' }));
  assert.ok(capped.r.did.filter((x) => x.kind === 'cpfp').every((x) => /cap 100/.test(x.why) || /not known/.test(x.why)), JSON.stringify(capped.r.did));
  const w3 = makeWorld();
  assert.equal((await go(w3, {}, CFG({ HW_CPFP: '0' }))).r.did.filter((x) => x.kind === 'cpfp').length, 0);
});

test('a parent not in the public mempool: the child goes with it as a package; --dry only plans', async () => {
  const w = makeWorld(); w.public.mem.delete(NB);
  w.public.refuse.set(NB, 'min relay fee not met');
  const { r } = await go(w, {}, CFG({ HW_CPFP_RATE: '2' }));
  assert.ok(w.public.packages.some((p) => p[0] === NB), JSON.stringify(w.public.packages));
  const d = makeWorld();
  const dry = await go(d, {}, CFG({ HW_DRY: '1' }));
  assert.deepEqual([d.ours.sent.length, d.public.sent.length, d.public.packages.length, d.posts.length], [0, 0, 0, 0]);
  assert.match(dry.r.did.find((x) => x.kind === 'cpfp' && x.txid === RPS).why, /dd9a81ca: would add a child of 413 sat \(2\.0 sat\/vB over 303 vB, change 81738 sat, parent in the public mempool\)/);
  assert.ok(r);
});

test('the public mining step runs only with HW_PUBLIC_CONFIRM=1 and a command, with the txids, once per 30 min', async () => {
  const w = makeWorld();
  await go(w, {}, CFG({ HW_CPFP: '0' }));
  assert.equal(w.runs.length, 0);
  const w2 = makeWorld();
  const { st } = await go(w2, {}, CFG({ HW_CPFP: '0', HW_PUBLIC_CONFIRM: '1', HW_PUBLIC_MINE_CMD: '/home/arena/x/mine-public.sh' }));
  assert.equal(w2.runs.length, 1);
  assert.match(w2.runs[0], new RegExp(`^-c /home/arena/x/mine-public\\.sh .*${UD}`));
  await go(w2, st, CFG({ HW_CPFP: '0', HW_PUBLIC_CONFIRM: '1', HW_PUBLIC_MINE_CMD: '/home/arena/x/mine-public.sh' }));
  assert.equal(w2.runs.length, 1);
});

test('sources, the ops log, the chain scripts\' answers', () => {
  const duty = { days: [{ covers: '2026-10-28', apps: [{ app: 'rps', role: 'primary', postings: [{ txid: OLD }, { txid: T('4608a420'), emergency: true }] }] }] };
  const s = pubSources({ duty: [duty], pending: [{ grids: [{ game: 'nextblock', lastCloseMs: String(NOW - 1), publication: { txid: T('dead') } }] }], ops: [{ txid: UD, game: 'updownGrid', atMs: NOW - 3600000 }], nowMs: NOW });
  assert.deepEqual(s.map((x) => [x.txid.slice(0, 8), x.game, x.source]), [['b03f56b7', 'RPS', 'duty 10-28 primary'], ['4608a420', 'RPS', 'duty 10-28 primary emergency'], ['71eac027', 'Up/Down', 'ops grid']]);
  assert.deepEqual(opsPublished(`x\n{"at":"2026-10-28T10:30:58.805Z","updownGrid":"published","txid":"${UD}","rounds":43}\n{"rpsGrid":"dry"}`), [{ txid: UD, game: 'updownGrid', atMs: Date.parse('2026-10-28T10:30:58.805Z') }]);
  const sc = lookScript('$HOME/bin/bitcoin-cli -testnet4', { txids: [UD, 'bad;rm'], from: null, back: 150, max: 200, verify: [[157700, T('a')], [1, 'x']] });
  assert.match(sc, /FROM=\$\(\(TIP-150\)\)/);
  assert.ok(!sc.includes('bad;rm') && sc.includes(`157700:${T('a')}`) && !sc.includes('1:x'));
  assert.deepEqual(parseLook(`tip 157881\nmem ${RPS}\nfound 157878 ${T('b')} ${UD}\nscanned 157881\nstale 157700\n`),
    { tip: 157881, mem: [RPS], found: [{ txid: UD, h: 157878, hash: T('b') }], stale: [157700], scannedTo: 157881 });
  assert.match(callsScript('cli', [['submitpackage', '["aa","bb"]']]), /\$C 'submitpackage' '\["aa","bb"\]' 2>&1/);
  assert.deepEqual(parseCalls('@@begin 0\nabc\n@@rc 0 0\n@@begin 1\nerror code: -26\nerror message:\nmin relay fee not met\n@@rc 1 26\n', 3),
    [{ ok: true, out: 'abc' }, { ok: false, out: '', err: 'error code: -26\nerror message:\nmin relay fee not met' }, { ok: false, out: '', err: 'no answer' }]);
});

// ---------------------------------------------------------------- kanban #1124: the public chain by Esplora, replaced publications, when
// THE THREE REAL CASES of 2026-11-04 (scripts from the live watcher state and from public testnet4): each publication's input was spent on
// the public chain by another tx carrying the SAME OP_RETURN scripts (outputs in another order), confirmed - the round's payload landed;
// the watcher alerted "not confirmed" for hours. Now: replaced, resolved, the new txid tracked.
const NOV4 = Date.UTC(2026, 10, 4, 17, 20, 0);
const SER = (id) => `6a2441524e53${id}`, DAY = (x) => `6a0c41524e44${x}`;
const CASES = [
  { txid: '9e022f7c770865657884a34d30b4c5b892122e91757393cc5e7659afb2a1483b', game: 'RPS', source: 'grid', input: ['c34af59c513153d5e722ee583ea1a61372fbc7f212dc9300762c3db92d93996c', 0],
    payload: [SER('ba68579a119743102b2675c1634aabb36390d5239583a5ede9db3de7bdb45762'), SER('0b94d74f172b8171f0fee3038c01af237f7db40d943b5913195c81efc7b6c7a1'), DAY('00005118c831a73a')],
    by: 'ce44eecb6589923da0941bf40e99b46916018b37dc217e4b6c75ae5ff9a95db8', h: 158940, change: '00144858e47b0627b3dc3ee4803c8cb19c00dd9e3f21', sendErr: 'bad-txns-inputs-missingorspent' },
  { txid: '9773c4f6a50678180b82318c9623f3394ace2e6402da449db3c6599bcb4a32ce', game: 'Next Block', source: 'duty 11-04 primary emergency', input: ['01692505a020ed6ca5d0431a6f5e9a95a6404895a8431c4434b4d025bde8fe9b', 2],
    payload: [SER('5e36750a826524f97bb0b1ba9a38ab0b88239db6ecf2a4ca1da914edeee122a1'), DAY('000051188dca9d1c')],
    by: 'cfdb5d0bfd3a237350d4013132ccb6cf6c7a861cf13ca5b8c1607cf25be00bc5', h: 158797, change: '00148f08973815aad318f7a1eb470d8fad625ee894f4', sendErr: 'insufficient fee, rejecting replacement 9773c4f6a50678180b82' },
  { txid: '3078d4d268ebf99f75ed5111fc6db5ab97f9a1b26b62e2863bfde1f99d1a6d72', game: 'RPS', source: 'duty 11-04 primary emergency', input: ['432ad496efd7aeb3fccc43e990a9f0a18e3c9485fa1654867594b541828cc917', 2],
    payload: [SER('3d3dd78dc8d3987beb399b5d7830e4a81ef0d500ccf81e9e3365385790bed391'), SER('7221d139edbb086a9164558005df14bb39ad01f1ab8cd36736c29bd9c7411d87'), DAY('00005118c831a73a')],
    by: '5c2f6dbaca5d775dd2790b279a8cc9c498acf6c0a7680bf9bf57420a07a5e304', h: 158797, change: '0014f6e957973c0d83f8fbba7e745697342b6cbf68fc', sendErr: 'insufficient fee, rejecting replacement 3078d4d268ebf99f75ed' },
];
/** A public chain behind a fake Esplora (the same paths and answers as mempool.space), our branch behind a fake bitcoin-cli. */
function esploraWorld({ cases = CASES, spenderPayload = null, down = false } = {}) {
  const w = { now: NOV4, posts: [], http: [], sent: [], tip: 158998, txs: new Map(), outspend: new Map(), mem: new Set(), conf: new Map(), oursConf: new Map() };
  for (const c of cases) {
    // the replacement: its change first, then the payload (the real ones' order) - or another payload
    const vout = [{ scriptpubkey: c.change, value: 1000 }, ...(spenderPayload || c.payload).map((x) => ({ scriptpubkey: x, value: 0 }))];
    w.txs.set(c.by, { txid: c.by, weight: 905, fee: 227, vin: [{ txid: c.input[0], vout: c.input[1] }], vout, hex: `02${c.by}` });
    w.conf.set(c.by, [c.h, T('b')]); w.conf.set(c.input[0], [158700, T('a')]);
    w.outspend.set(`${c.input[0]}:${c.input[1]}`, c.by);
    w.oursConf.set(c.by, c.h);
  }
  const status = (t) => (w.conf.has(t) ? { confirmed: true, block_height: w.conf.get(t)[0], block_hash: w.conf.get(t)[1] } : { confirmed: false });
  w.httpFn = async (method, path, body) => {
    w.http.push(`${method} ${path}`);
    if (down) return { ok: false, status: 0, text: 'no answer in 8 s' };
    const r = (status, text) => ({ ok: status === 200, status, text: typeof text === 'string' ? text : JSON.stringify(text) });
    let m;
    if (path === '/blocks/tip/height') return r(200, String(w.tip));
    if ((m = /^\/tx\/([0-9a-f]{64})\/status$/.exec(path))) return w.conf.has(m[1]) || w.mem.has(m[1]) ? r(200, status(m[1])) : r(404, 'Transaction not found');
    if ((m = /^\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/.exec(path))) { const by = w.outspend.get(`${m[1]}:${m[2]}`); return r(200, by ? { spent: true, txid: by, vin: 0, status: status(by) } : { spent: false }); }
    if ((m = /^\/tx\/([0-9a-f]{64})\/hex$/.exec(path))) return w.txs.has(m[1]) ? r(200, w.txs.get(m[1]).hex) : r(404, 'Transaction not found');
    if ((m = /^\/tx\/([0-9a-f]{64})$/.exec(path))) { const x = w.txs.get(m[1]); return x ? r(200, { ...x, status: status(m[1]) }) : r(404, 'Transaction not found'); }
    if (method === 'POST' && path === '/tx') { w.sent.push(body); return r(400, 'sendrawtransaction RPC error: {"code":-25,"message":"bad-txns-inputs-missingorspent"}'); }
    return r(404, 'not found');
  };
  const byHex = new Map(cases.map((c) => [`02${c.txid}`, c]));
  w.io = {
    now: () => w.now, loadavg: async () => [1, 1, 1], identity: async () => ({ ok: true, key: T('5') }), units: async () => ({}),
    get: async (base, path) => (path === '/series' ? { ok: true, body: { series: [{ series: 'ba68579a119743102b2675c1634aabb36390d5239583a5ede9db3de7bdb45762', startTimeMs: String(Date.UTC(2026, 10, 4, 16, 10, 56)), horizonMs: '10800000' }] } }
      : path === '/duty' ? { ok: true, body: { days: [] } } : path === '/pending' ? { ok: true, body: { txs: [], grids: [] } } : path === '/expected' ? { ok: true, body: { expected: [] } } : { ok: false, why: 'HTTP 404' }),
    minercCheck: async (ids) => ({ listed: ids, missing: [] }), minercAdd: async () => {}, post: async (text) => { w.posts.push(text); }, opsPublished: async () => [],
    // our branch: the replacements in its blocks (the same blocks), the replaced ones in none
    chainLook: async (name, { txids }) => ({ tip: 158998, mem: [], found: txids.filter((t) => w.oursConf.has(t)).map((t) => ({ txid: t, h: w.oursConf.get(t), hash: T('b') })), stale: [], scannedTo: 158998 }),
    chainCalls: async (name, calls) => (name === 'public' ? esploraCalls(w.httpFn, calls) : calls.map((c) => (c[0] === 'decoderawtransaction' && byHex.has(c[1])
      ? { ok: true, out: JSON.stringify({ vin: [{ txid: byHex.get(c[1]).input[0], vout: byHex.get(c[1]).input[1] }] }) } : { ok: false, out: '', err: 'error message:\nno' }))),
    publicHttp: w.httpFn,
  };
  // the watcher's state at 17:10Z: the three kept from earlier passes (no prevouts kept before #1124), missing on both chains, alerted
  const pubs = {};
  for (const c of cases) pubs[c.txid] = { game: c.game, source: c.source, firstMs: NOV4 - 6 * 3600000, live: NOV4 - 60000, hex: `02${c.txid}`, vsize: 227, fee: null, vin: [c.input[0]],
    vout: [...c.payload.map((x, n) => ({ n, sat: 0, spk: x })), { n: c.payload.length, sat: 1000, spk: c.change, address: 'tb1qx' }],
    ours: { s: 'missing' }, public: { s: 'missing' }, sent: { ours: { atMs: NOV4 - 6 * 3600000, ok: false }, public: { atMs: NOV4 - 10 * 60000, ok: false } },
    sendErr: { ours: c.sendErr, public: c.sendErr }, dead: { ours: c.sendErr } };
  w.state = { pubs, scan: {}, fixes: {}, alerts: { publications: { firstMs: NOV4 - 6 * 3600000, lastMs: NOV4 - 30 * 60000, title: 'round publication not confirmed', ticket: '759', absent: 0 } } };
  return w;
}
const CFGE = (env = {}) => CFG({ HW_PUBLIC_SSH: '0', HW_PUBLIC_MIN: '30', ...env });

test('#1124 the three real replaced publications: payload landed in another tx - resolved, not alerted; the new txid tracked', async () => {
  const w = esploraWorld();
  let { r, st } = await go(w, w.state, CFGE());
  assert.equal(r.problems.find((p) => p.key === 'publications'), undefined, r.problems.map((p) => `${p.key}: ${(p.lines || []).join(' | ')}`).join('\n'));
  const landed = r.problems.find((p) => p.key === 'publications-replaced');
  assert.equal(landed.alert, false);
  assert.deepEqual(landed.lines, [
    'RPS series ba68579a +1 for 11-04 16:10-19:10Z, txid 9e022f7c: replaced by ce44eecb with the same payload, confirmed at 158940',
    'Next Block series 5e36750a, txid 9773c4f6: replaced by cfdb5d0b with the same payload, confirmed at 158797',
    'RPS series 3d3dd78d +1, txid 3078d4d2: replaced by 5c2f6dba with the same payload, confirmed at 158797',
  ]);
  for (const c of CASES) {
    assert.equal(st.pubs[c.txid], undefined, `${c.txid.slice(0, 8)} no longer tracked`);
    assert.equal(st.replaced[c.txid].by, c.by);
    assert.equal(st.pubs[c.by].replaces, c.txid);
    assert.ok(w.http.includes(`GET /tx/${c.input[0]}/outspend/${c.input[1]}`));
  }
  assert.equal(w.sent.length, 0, 'nothing rebroadcast: the payload is on the chain');
  // the next passes: the replacements read on the public chain, 59 and 202 deep there and confirmed on ours - done with; the old alert
  // RESOLVED; the replaced txids not tracked again
  ({ r, st } = await go(w, st, CFGE(), 2));
  for (const c of CASES) { assert.ok(w.http.includes(`GET /tx/${c.by}/status`)); assert.equal(st.pubs[c.by], undefined); assert.equal(st.pubs[c.txid], undefined); }
  assert.equal(w.posts.filter((t) => /RESOLVED: round publication not confirmed/.test(t)).length, 1, w.posts.join('\n'));
  assert.equal(w.posts.filter((t) => /PROBLEM|STILL/.test(t)).length, 0);
});

test('#1124 a spent input whose spender lacks the payload: alerted "republish needed" with app, series and time, what was tried', async () => {
  const w = esploraWorld({ cases: [CASES[0]], spenderPayload: ['6a0c41524e44000051180000beef'] });
  const { r, st } = await go(w, w.state, CFGE());
  const p = r.problems.find((x) => x.key === 'publications');
  assert.ok(p && p.alert, r.problems.map((x) => x.key).join(','));
  assert.equal(p.lines[0], 'RPS series ba68579a +1 for 11-04 16:10-19:10Z, txid 9e022f7c: ours missing, public missing, 360 min; rebroadcast 17:10Z refused: bad-txns-inputs-missingorspent'
    + '; input c34af59c:0 spent by ce44eecb (confirmed at 158940) without this payload: republish needed');
  assert.match(p.needs, /^republish needed/);
  assert.ok(st.pubs[CASES[0].txid], 'still tracked');
  assert.equal(st.pubs[CASES[0].by], undefined, 'the other tx is not ours to track');
});

test('#1124 Esplora: a publication the public chain lacks is rebroadcast there, the refusal named; no base answering - the chain unread, alerted', async () => {
  const w = esploraWorld({ cases: [] });
  const fresh = T('f00d');
  w.state = { pubs: { [fresh]: { game: 'Up/Down', source: 'grid', firstMs: NOV4 - 3600000, live: NOV4, hex: `02${fresh}`, vin: [], prev: [], vout: [{ n: 0, sat: 0, spk: SER('ba68579a119743102b2675c1634aabb36390d5239583a5ede9db3de7bdb45762') }] } }, scan: {}, fixes: {}, alerts: {} };
  let { r, st } = await go(w, w.state, CFGE());
  assert.deepEqual(w.sent, [`02${fresh}`]);
  assert.equal(st.pubs[fresh].sendErr.public, 'bad-txns-inputs-missingorspent');
  ({ r } = await go(w, st, CFGE()));
  assert.equal(r.problems.find((x) => x.key === 'publications').lines[0],
    'Up/Down series ba68579a for 11-04 16:10-19:10Z, txid f00df00d: ours missing, public missing, 63 min; rebroadcast 17:20Z refused: bad-txns-inputs-missingorspent');
  const d = esploraWorld({ cases: [], down: true });
  ({ r } = await go(d, { pubs: { [fresh]: { game: 'RPS', source: 'grid', firstMs: NOV4, hex: 'aa' } } }, CFGE()));
  assert.match(r.problems.find((x) => x.key === 'chain-unread:public').lines[0], /^esplora: no tip/);
});

test('#1124 the Esplora call adapter, payload decoding, time spans', async () => {
  const replies = { 'POST /v1/txs/package': { ok: false, status: 400, text: '{"error":"submitpackage RPC error: {\\"code\\":-1}"}' }, 'POST /tx': { ok: true, status: 200, text: T('ab') },
    'GET /fee-estimates': { ok: true, status: 200, text: '{"1":3.5,"2":2.1,"144":1}' }, 'GET /v1/fees/recommended': { ok: true, status: 200, text: '{"minimumFee":1}' } };
  const http = async (m, p) => replies[`${m} ${p}`] || { ok: false, status: 404, text: 'not found' };
  const [pkg, est, info, none] = await esploraCalls(http, [['submitpackage', '["aa","bb"]'], ['estimatesmartfee', '2'], ['getmempoolinfo'], ['getmempoolentry', T('9')]]);
  assert.deepEqual(pkg, { ok: true, out: T('ab') }, 'the package endpoint refused: each tx alone, parents first');
  assert.equal(JSON.parse(est.out).feerate, 2.1 / 1e5);
  assert.equal(JSON.parse(info.out).mempoolminfee, 1e-5);
  assert.equal(none.err, 'Transaction not in mempool');
  await assert.rejects(esploraCalls(async () => ({ ok: false, status: 0, text: 'timeout' }), [['sendrawtransaction', 'aa']]), /no Esplora base answered/);
  assert.equal(esploraErr('sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met, 0 < 110"}'), 'min relay fee not met, 0 < 110');
  assert.equal(esploraErr('sendrawtransaction RPC error -25: bad-txns-inputs-missingorspent'), 'bad-txns-inputs-missingorspent');
  assert.deepEqual(decodePayload(CASES[0].payload), { series: ['ba68579a119743102b2675c1634aabb36390d5239583a5ede9db3de7bdb45762', '0b94d74f172b8171f0fee3038c01af237f7db40d943b5913195c81efc7b6c7a1'], rounds: [], days: [Date.UTC(2026, 10, 4)] });
  assert.equal(spanText(Date.UTC(2026, 10, 5), Date.UTC(2026, 10, 6)), '11-05 00:00-24:00Z');
  assert.equal(spanText(Date.UTC(2026, 10, 4, 10, 41), Date.UTC(2026, 10, 5, 22)), '11-04 10:41Z-11-05 22:00Z');
});
