// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 on #1479's rule as #1597 left it, FREE ROUND (item 6 + item 5): #1597 made an earlier entry of a session key hold it in a free round
// only when it names the same PLAYER key ("the same player entering again"). But the player key is as public as the session key (GET /entry hands
// both to anyone) and nothing at the door is signed by it: the copier posts an entry naming the honest entry's player key AND session key, with a
// commitment of his own (made from the public key alone) and its handout dealt for that player key, to a seat the honest page has not reached.
// That seat refuses the honest entry and its resend for good; with fewer than the threshold of seats holding it, the honest entry is no member.
// Before #1479 both entries were taken. Safe behaviour: an entry naming someone else's public keys cannot shut the real one out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { lockPort } from './lock-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { encodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { entryProofDigest, ENTRY_PROOF_HEADER, ENTRY_PROOF_VERSION } from '../../arena-protocol/src/entry-proof.js';
import { entryId } from '../../arena-protocol/src/contracts.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND_OLD = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1;
const mk = (n) => ({ name: `p${n}`, key: b32(0xc0 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));

// THE RELAY'S OWN 700-1200 ms (entry-relay.js): seat-to-seat posts (x-arena-relayed) are held until the test lets them go, as the relay's wait does live
let hold = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const h = init && init.headers ? (init.headers['x-arena-relayed'] || (typeof init.headers.get === 'function' && init.headers.get('x-arena-relayed'))) : null;
  if (h && hold) await hold.p;
  return realFetch(url, init);
};
const holdRelay = () => { let r; hold = { p: new Promise((x) => { r = x; }), release: () => { const q = hold; hold = null; r(); return q; } }; };

const ROUND = { ...ROUND_OLD, protocolVersion: ENTRY_PROOF_VERSION };   // kanban #3824: the version that requires the entry proof
// a federation whose guardians run the Arena lock (LNv2 1.100), as a round of 27 or later asks of it
const newPort = () => { const p = lockPort(); p.moduleVersion = async () => ({ major: 1, minor: 100 }); return p; };
const proofOf = (eid, session) => toHex(ed25519.sign(entryProofDigest(eid), session));
const postEntry = (base, entry, proofHex, relayed = false) => (relayed ? realFetch : fetch)(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry),
  headers: { ...(proofHex ? { [ENTRY_PROOF_HEADER]: proofHex } : {}), ...(relayed ? { 'x-arena-relayed': '1' } : {}) } });

// kanban #3824 (RULED 2026-11-28): on a round of ENTRY_PROOF_VERSION the copy - the honest PUBLIC session key, no secret, so no valid proof -
// is refused 400 at seat 1; the honest entry with its proof and its resend are taken, and the relay hands its copy on with the proof
test('#3824 new-version round: a copy naming the honest session key without its proof is refused; the honest entry and its resend are taken', async () => {
  holdRelay();
  const w = await lockRound({ stakeMsat: 0n, port: newPort(), serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 60000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const [s0, s1] = w.nodes.map((d) => `http://127.0.0.1:${d.port}`);
    const honest = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: salt() }, noMarks: true, only: [], feeLock: false, unreached: [1] });
    const seen = await fetch(`${s0}/entry?id=${toHex(honest.eid)}`);
    assert.equal(seen.status, 200);
    // the entry id is byte-identical with and without the proof: the bytes GET /entry answers hash to the same id, the proof beside them in the header
    const seenBytes = new Uint8Array(await seen.arrayBuffer());
    assert.equal(toHex(sha256(seenBytes)).length, 64);
    assert.deepEqual(toHex(entryId(honest.entry)), toHex(honest.eid));
    assert.equal(toHex(seenBytes), toHex(encodeEntryContract(honest.entry)));
    assert.equal(seen.headers.get(ENTRY_PROOF_HEADER), proofOf(honest.eid, honest.session));
    // the copier: the honest PUBLIC session key, a proof by his own key (he has no other) - and none at all
    const copier = ed25519.utils.randomSecretKey();
    let copy;
    try { await lockAndPlay(w, mk(1), { sessionPub: ed25519.getPublicKey(honest.session), hidden: { move: PAPER, salt: salt() }, noMarks: true, only: [], feeLock: false, unreached: [0], proof: ed25519.sign(entryProofDigest(honest.eid), copier) }); copy = 'taken'; }
    catch (e) { copy = String(e.message).split('\n')[0].slice(0, 200); }
    let bare;
    try { await lockAndPlay(w, mk(1), { sessionPub: ed25519.getPublicKey(honest.session), hidden: { move: PAPER, salt: salt() }, noMarks: true, only: [], feeLock: false, unreached: [0], proof: null }); bare = 'taken'; }
    catch (e) { bare = String(e.message).split('\n')[0].slice(0, 200); }
    const h = await fetch(`${s0}/handout?id=${toHex(honest.entry.vssSharesRef)}`);
    const hb = new Uint8Array(await h.arrayBuffer());
    const ph = await fetch(`${s1}/handout`, { method: 'POST', body: hb });
    // a proof over another entry id, and a relayed copy with no proof: refused by the receiving seat
    const otherId = await postEntry(s1, honest.entry, proofOf(new Uint8Array(32).fill(7), honest.session));
    const relayedBare = await postEntry(s1, honest.entry, null, true);
    const answers = [];
    for (let i = 0; i < 2; i++) { const r = await postEntry(s1, honest.entry, proofOf(honest.eid, honest.session)); answers.push(`${r.status} ${(await r.text()).slice(0, 120)}`); }
    hold.release();
    await new Promise((r) => setTimeout(r, 1500));
    const held = !!w.nodes[1].round.entry(honest.eid);
    const keptProof = w.nodes[1].round.entryProof(honest.eid);
    console.log('  FACTS (#3824 new version):', JSON.stringify({ copy, bare, handout: ph.status, otherId: otherId.status, relayedBare: relayedBare.status, answers, heldAtSeat1: held }));
    assert.match(copy, /^400|entry proof/, 'a copy with a proof by another key is refused');
    assert.match(bare, /^400|entry proof/, 'a copy with no proof is refused');
    assert.equal(otherId.status, 400, 'a proof over another entry id is refused');
    assert.equal(relayedBare.status, 400, 'a relayed entry without its proof is refused by the receiving seat');
    assert.ok(held && answers.every((a) => a.startsWith('201')), `the honest entry and its resend: ${JSON.stringify(answers)}`);
    assert.equal(toHex(keptProof), proofOf(honest.eid, honest.session), 'the seat keeps the proof with the entry');
  } finally { await w.close(); }
});

// AN OLD-VERSION ROUND AS TODAY (kanban #3824 gate): no proof asked; the copy is taken, as #1597 left it
test('#3824 old-version round: no proof is asked - the copy without one is taken and the honest entry refused, as before', async () => {
  holdRelay();
  const w = await lockRound({ stakeMsat: 0n, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND_OLD, minScore: 2, endMs: testNow() + SPAN_MS + 60000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const [s0, s1] = w.nodes.map((d) => `http://127.0.0.1:${d.port}`);
    const honest = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: salt() }, noMarks: true, only: [], feeLock: false, unreached: [1], proof: null });
    let copy;
    try { await lockAndPlay(w, mk(1), { sessionPub: ed25519.getPublicKey(honest.session), hidden: { move: PAPER, salt: salt() }, noMarks: true, only: [], feeLock: false, unreached: [0], proof: null }); copy = 'taken'; }
    catch (e) { copy = String(e.message).split('\n')[0].slice(0, 160); }
    const h = await fetch(`${s0}/handout?id=${toHex(honest.entry.vssSharesRef)}`);
    await fetch(`${s1}/handout`, { method: 'POST', body: new Uint8Array(await h.arrayBuffer()) });
    const r = await postEntry(s1, honest.entry, null);
    const said = `${r.status} ${(await r.text()).slice(0, 120)}`;
    hold.release();
    console.log('  FACTS (#3824 old version):', JSON.stringify({ copy, said }));
    assert.equal(copy, 'taken');
    assert.match(said, /^400 that session key already has an entry/);
  } finally { await w.close(); }
});
