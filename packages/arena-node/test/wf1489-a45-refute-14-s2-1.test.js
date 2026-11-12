// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 a45 refute 14, skeptic 2 (fix #1823 + #2255, c15753bff): ONE PEER'S JUNK LOCK CAN STILL KEEP AN HONEST SEAT WAITING - THROUGH THE #2255 DOOR.
// #2255 counts a check that failed with "the federation could not be asked" as this seat's own trouble and waits for it while the answering peers
// plus this seat reach the threshold (2-of-2: 1 + 1 >= 2; a 3-drawn round: 1 + 1 >= 2). But takeStakeLock writes that very reason for ANY throw
// of port.contractId(fields) - and the fields are the PEER's. lockFieldsFromJson takes claimPk "" / refundPk "" (fromHex('') is fine), and the
// stock client (tools/stake-lock/src/main.rs: PublicKey::from_str(need(a, "claim-pk")?)?) exits non-zero on them, so stake-lock-port.js run()
// throws, and the peer's junk is read as this seat's own federation trouble: the seat waits on every pass until the result window ends.
// The port below models that stock behaviour (a contract id with a key that is no public key is an error, not an id).
// SAFE: one peer's lock fields with an empty key, for an entry nobody locked, do not keep an honest seat from signing the seated players.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1;
const mk = (n) => ({ name: `p${n}`, key: b32(0xe0 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reveal = async (w, played, move, s) => Promise.all(w.nodes.map(async (d) =>
  (await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) })).status));

// well-formed for lockFieldsFromJson, but its keys are empty: the stock client cannot hash such a contract
const EMPTY_KEY_LOCK = { paymentImage: { kind: 'point', bytes: '02'.padEnd(66, '0') }, amountMsat: '1000', claimPk: '', refundPk: '', expiration: 1200 };

async function play({ evil }) {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  const realFetch = globalThis.fetch;
  const port = w.slot.port, realId = port.contractId.bind(port);
  let threw = 0;
  // the stock client: a claim or refund key that is no 33-byte public key is an error (PublicKey::from_str), never an id
  port.contractId = async (f) => {
    if (!(f.claimPk instanceof Uint8Array) || f.claimPk.length !== 33 || !(f.refundPk instanceof Uint8Array) || f.refundPk.length !== 33) {
      threw++; throw new Error('arena-stake-lock: Error: malformed public key');
    }
    return realId(f);
  };
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // an abandoned join: its entry at every seat, no lock anywhere
    const c = await lockAndPlay(w, mk(3), { hidden: { move: ROCK, salt: salt() }, noMarks: true, only: [] });
    const sa = salt(), sb = salt();
    const a = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    const b = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: sb }, noMarks: true });
    const [honest, bad] = w.nodes;
    if (evil) {
      // seat b, toward its peers: a 200 with well-formed lock fields whose keys are empty, for the entry nobody locked
      globalThis.fetch = async (url, opts) => {
        const u = String(url);
        if (u.startsWith(`http://127.0.0.1:${bad.port}/order-locks?entry=${toHex(c.eid)}`))
          return new Response(JSON.stringify({ entry: toHex(c.eid), stake: EMPTY_KEY_LOCK, fee: null }), { status: 200, headers: { 'content-type': 'application/json' } });
        return realFetch(url, opts);
      };
    }
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, ROCK, sa); await reveal(w, b, PAPER, sb);
    await Promise.race([closeRound(w, { window: false }), sleep(15000)]);
    for (let i = 0; i < 40 && !(honest.round.hasResult(w.rid, a.eid, honest.round.pubkey) && honest.round.hasResult(w.rid, b.eid, honest.round.pubkey)); i++) await sleep(250);
    const signed = { a: honest.round.hasResult(w.rid, a.eid, honest.round.pubkey), b: honest.round.hasResult(w.rid, b.eid, honest.round.pubkey) };
    return { signed, threw, cVoid: !!honest.round.entryVoid(c.eid) };
  } finally { port.contractId = realId; globalThis.fetch = realFetch; await w.close(); }
}

test('#1489 a45-14 s2 control: with honest peers the seat signs both seated players', async () => {
  const got = await play({ evil: false });
  console.log('  FACTS (a45-14 s2 control):', JSON.stringify(got));
  assert.ok(got.signed.a && got.signed.b, `control: the honest seat did not sign: ${JSON.stringify(got)}`);
});

test('#1489 a45-14 s2: one peer\'s empty-key lock fields (the stock client throws on them) do not keep an honest seat waiting', async () => {
  const got = await play({ evil: true });
  console.log('  FACTS (a45-14 s2 attack):', JSON.stringify(got));
  assert.ok(got.threw > 0, 'the junk lock never reached the contract id');
  assert.ok(got.signed.a && got.signed.b, `the honest seat signed nothing for the two seated players: the peer's junk read as this seat's own federation trouble (#2255 wait): ${JSON.stringify(got)}`);
});
