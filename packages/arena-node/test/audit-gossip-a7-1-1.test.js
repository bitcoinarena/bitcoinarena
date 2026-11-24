// audit 2026-11-24 gossip r1-1 (kanban #3566): ONE SEAT'S UNSIGNED `staked: true` ON GET /lock-namer BRINGS #3320 BACK (gap in the #3369 fix).
// #3320: a stranger's LOWER entry under a head-to-head player's public key (no player signature on an entry or a handout) with its own lock
// made every seat let the honest player's stake go (round.yieldEntryLocks). The fix made a stake seen in a round with no receipts "built on"
// (round.stakePlayedOn). #3369 then re-opened the yield whenever ANOTHER SEAT OF THE ROUND answers GET /lock-namer with `staked: true` for the
// lower entry (stake-lock-signer-node.js stakedAtPeer -> peerStakedLower) - one peer's unsigned JSON flag, believed as it is said. So one
// colluding committee seat (role b) that answers `staked: true` for the stranger's lower entry turned every honest seat: each let the honest
// player's stake and fee lock go and seated the stranger's copy, whose session key, move and payout address the attacker holds.
// Invariant (#3320): an honest seat does not let a staked head-to-head entry go on fewer seats' word than can be faulty, plus one.
// Run on a 7-seat committee (5 of 7, as live) with one colluding seat. A 2-seat committee tolerates no faulty seat (2 of 2; #2680 likewise),
// so the audit's 2-seat run is outside the fault model there. The second test keeps #3369 at 7 seats: when f + 1 seats took the lower entry
// first, the seats that hold the higher one still let it go for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
// seven seats take longer than the fixture's 1.5 s from committee time to the entry close: the close at 30 s (the start stays at 60.5 s)
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE, entryCloseMs: 30000n };
const ROCK = 0, PAPER = 1;
const mk = (n) => ({ name: `p${n}`, key: b32(0x50 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const feeFieldsOf = (p) => ({ paymentImage: { kind: 'hash', bytes: sha256(p.entry.feePreimage) }, amountMsat: p.entry.feeMsat,
  claimPk: p.fields.claimPk, refundPk: p.fields.refundPk, expiration: p.fields.expiration });
const base = (d) => `http://127.0.0.1:${d.port}`;
const lower = (x, y) => Buffer.compare(Buffer.from(x.eid), Buffer.from(y.eid)) < 0;

// the colluding seat: the seat as it is, but its GET /lock-namer says `staked: true` for every entry it names (one door patched by its operator)
function colludingFront(target) {
  const said = [];
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
    try {
      const r = await fetch(`${target}${req.url}`, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body });
      let out = Buffer.from(await r.arrayBuffer());
      if (req.url.startsWith('/lock-namer') && r.status === 200) {
        const j = JSON.parse(out.toString('utf8')); j.staked = true; out = Buffer.from(JSON.stringify(j)); said.push(j.entry.slice(0, 16));
      }
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream' });
      res.end(out);
    } catch (e) { res.writeHead(502); res.end(String(e.message)); }
  });
  return new Promise((go) => srv.listen(0, '127.0.0.1', () => go({ url: `http://127.0.0.1:${srv.address().port}`, said, close: () => new Promise((d) => srv.close(d)) })));
}

async function hand(d, p) {
  const l = await fetch(`${base(d)}/lock?entry=${toHex(p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(p.fields)) });
  const lw = [l.status, (await l.text()).slice(0, 90)];
  const f = await fetch(`${base(d)}/fee-lock?entry=${toHex(p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFieldsOf(p))) });
  return { lock: lw, fee: [f.status, (await f.text()).slice(0, 90)] };
}

test('audit gossip r1-1 (#3566): one seat\'s unsigned staked:true on GET /lock-namer does not unstake an honest head-to-head player at an honest seat (7 seats)', { timeout: 240000 }, async () => {
  const w = await lockRound({ n: 7, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 60000 });
  const front = await colludingFront(base(w.nodes[1]));
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // the honest player: handout, entry with its committed move, stake and fee lock and claim at every seat
    const honest = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: salt() }, noMarks: true });
    assert.ok(w.nodes.every((d) => d.round.stakeSeen(honest.eid)), 'precondition: the honest player is staked at every seat');
    // the stranger (with seat 1): an entry under the honest player's PUBLIC key, a fresh session key per try until its id is the lower
    let copy = null;
    for (let i = 0; i < 16 && !copy; i++) {
      const p = await lockAndPlay(w, { ...mk(9), name: `stranger-${i}`, key: mk(1).key }, { hidden: { move: PAPER, salt: salt() }, noMarks: true, only: [] });
      if (lower(p, honest)) copy = p;
    }
    assert.ok(copy, 'no lower entry id in 16 tries');
    // seat 0 (honest) reaches seat 1 through the colluding seat's own door, the other five seats as they are
    w.a.verifier.peers = w.nodes.slice(1).map((d, i) => (i === 0 ? front.url : base(d)));
    // the stranger's own lock (refunding to the player's refund key) handed to the honest seat's ordinary lock doors, before the close
    const handed = await hand(w.a, copy);
    for (let i = 0; i < 10; i++) await wait(10);
    const d = w.a;
    const at = { honestSeen: !!d.round.stakeSeen(honest.eid), honestLock: !!d.round.stakeLock(honest.eid), copySeen: !!d.round.stakeSeen(copy.eid),
      seated: d.round.seatedEntriesOf(w.rid, w.c.stakeMsat).map(({ entryId }) => toHex(entryId).slice(0, 16)) };
    console.log('  FACTS gossip r1-1:', JSON.stringify({ honest: toHex(honest.eid).slice(0, 16), copy: toHex(copy.eid).slice(0, 16),
      handed, colluderSaidStaked: front.said, seat0: at }));
    assert.ok(front.said.length > 0, 'precondition: the colluding seat was asked and said staked:true');
    assert.equal(at.honestSeen, true, `the honest seat let go the honest head-to-head player's stake on one peer's unsigned staked:true for a stranger's lower copy (stake lock kept: ${at.honestLock}; copy staked: ${at.copySeen}; seated: ${at.seated.join(',')})`);
    assert.equal(at.copySeen, false, 'the stranger\'s copy was staked at the honest seat');
  } finally { await front.close(); await w.close(); }
});

test('#3369 at 7 seats (#3566 control): crossed locks where f + 1 seats took the lower entry first meet on the lower entry at every seat', { timeout: 240000 }, async () => {
  const w = await lockRound({ n: 7, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 60000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // one player key, two entries (a reload mid-join), both at every seat, no lock yet
    const one = await lockAndPlay(w, { ...mk(1), name: 'tab-1' }, { hidden: { move: ROCK, salt: salt() }, noMarks: true, only: [] });
    const two = await lockAndPlay(w, { ...mk(1), name: 'tab-2' }, { hidden: { move: ROCK, salt: salt() }, noMarks: true, only: [] });
    const [lo, hi] = lower(one, two) ? [one, two] : [two, one];
    // the lower entry's locks land first at seats 0-2 (f + 1 = 3 of 7), the higher's at seats 3-6 ...
    const first = await Promise.all(w.nodes.map((d, i) => hand(d, i < 3 ? lo : hi)));
    // each seat holds its first entry staked ...
    for (let i = 0; i < 300 && !w.nodes.every((d, j) => d.round.stakeSeen((j < 3 ? lo : hi).eid)); i++) await wait(10);
    // and GET /lock-namer answers from its door cache (kanban #2901, 500 ms): the late locks come after it, as a crossed lock's second arrival does
    await new Promise((go) => setTimeout(go, 1500));
    // ... then each reaches the other seats too
    const late = [];
    for (const [i, d] of w.nodes.entries()) late.push(await hand(d, i < 3 ? hi : lo));
    for (let i = 0; i < 20; i++) await wait(10);
    const at = w.nodes.map((d) => ({ lo: !!d.round.stakeSeen(lo.eid), hi: !!d.round.stakeSeen(hi.eid) }));
    console.log('  FACTS #3369 x7:', JSON.stringify({ lo: toHex(lo.eid).slice(0, 16), hi: toHex(hi.eid).slice(0, 16),
      first: first.map((x) => [x.lock[0], x.fee[0]]), late: late.map((x) => [x.lock[0], x.lock[1].slice(0, 60), x.fee[0]]), at }));
    assert.deepEqual(at, w.nodes.map(() => ({ lo: true, hi: false })), 'the seats of the round did not all stake the lower entry of the player key');
  } finally { await w.close(); }
});
