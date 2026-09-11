// A ROUND THAT TAKES A STAKE MUST NAME A PUBLICATION RELAY, OR IT TAKES NO STAKE.
//
// Since P2 (v4.6.2 §13A) no result is FINAL until the round's settlement seats
// have posted its transcript to the contract's `publication_relays[]` - and a
// contract that names none can never be posted to, so none of its results can
// ever be final and no stake in it can ever settle.
//
// MEASURED BEFORE (TASKBOOK, e76cc61): two daemons opened such a round (201,
// 201), seated, quoted and held both players' stakes on both seats, and 4.5 s
// after the close every stake was still HELD and every result provisional,
// with 0 Lightning acts. Now the round is refused where it is opened, and a
// stake is refused where it would be seated - before any hold is issued.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { assumeSeated } from './seating.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId } from '../../protocol/src/contracts.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { b32, STAKE, WINDOW_MS, paidPort, contractFor, opts } from './window-fixture.js';

const open = (d, c) => fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) });

/** A port that counts the holds it is asked to issue. */
const countingPort = () => {
  const p = paidPort();
  p.asked = 0;
  const create = p.createHeld.bind(p);
  p.createHeld = async (x) => { p.asked++; return create(x); };
  return p;
};

test('a paying round naming no relay is refused where it is opened by a node that holds stakes, and nothing is stored; a node that holds none takes no stake and opens it', async () => {
  const port = countingPort();
  const withLn = await serve(openStore(':memory:'), { port: 0, ...opts, lightning: port });
  const without = await serve(openStore(':memory:'), { port: 0, ...opts });
  try {
    const c = contractFor([withLn.round.pubkey, without.round.pubkey], BigInt(WINDOW_MS), []);
    assert.equal(c.stakeMsat, STAKE);
    const r = await open(withLn, c);
    const why = await r.text();
    assert.equal(r.status, 409, `a node that holds stakes opened a paying round naming no relay (${r.status} ${why})`);
    assert.match(why, /takes a stake and names no publication relay/);
    assert.equal(withLn.round.get(roundId(c)), null, 'it stored the round it refused');
    assert.equal(port.asked, 0);
    // A NODE WITH NO LIGHTNING issues no hold, so it takes no stake to strand.
    assert.equal((await open(without, c)).status, 201);
  } finally { await withLn.close(); await without.close(); }
});

test('a stake is not seated in a stored paying round that names no relay: refused before the entry is kept and before any hold', async () => {
  const port = countingPort();
  const d = await serve(openStore(':memory:'), { port: 0, ...opts, lightning: port });
  try {
    // STORED WITHOUT THE DOOR, as a round kept before this rule would be.
    const c = contractFor([d.round.pubkey, b32(0x33)], BigInt(WINDOW_MS), []);
    const rid = d.round.open(c);
    assumeSeated(d.round, rid, c.nodes);
    const entry = {
      roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
      stakeCommitment: b32(7), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
      joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    };
    const r = await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    const why = await r.text();
    const facts = { status: r.status, kept: !!d.round.entry(entryId(entry)), holdsAsked: port.asked, hold: d.round.hold(entryId(entry)) || null };
    console.log('  FACTS (entry into a paying round naming no relay):', JSON.stringify(facts), '|', why);
    assert.deepEqual(facts, { status: 409, kept: false, holdsAsked: 0, hold: null });
    assert.match(why, /seats no stake in that round: that round takes a stake and names no publication relay/);
  } finally { await d.close(); }
});

test('the same paying round naming a relay opens, and a free round naming none opens', async () => {
  const d = await serve(openStore(':memory:'), { port: 0, ...opts, lightning: countingPort() });
  try {
    const paying = contractFor([d.round.pubkey, b32(0x33)], BigInt(WINDOW_MS), [`http://127.0.0.1:${d.port}`]);
    assert.equal((await open(d, paying)).status, 201, 'a paying round naming a relay was refused');
    const free = { ...contractFor([d.round.pubkey, b32(0x33)], BigInt(WINDOW_MS), []), stakeMsat: 0n };
    const r = await open(d, free);
    assert.equal(r.status, 201, `a free round naming no relay was refused: ${await r.text()}`);
  } finally { await d.close(); }
});
