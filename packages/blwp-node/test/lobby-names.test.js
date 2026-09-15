// A JOINED PLAYER'S NAME, AS A SIGNER NODE KEEPS AND SERVES IT (M3.3-34).
//
// The other players of a round are shown the name each player chose. A signer node
// keeps the record only from a player it joined in that round and only under
// that player's own signature; it serves the records beside its lobby listing
// and at /names. A newer record replaces an older one, never the reverse.
//
// MEASURED BEFORE (TASKBOOK, M3.3-34): POST /name and GET /names were 404, and
// a /rounds row carried the signer node counts and no name - the other page had
// nothing to show but a count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { assumeAssigned } from './assignment.js';
import { b32, rand, contractFor } from './window-fixture.js';
import { encodeRoundContract, roundId, encodeEntryContract } from '../../protocol/src/contracts.js';
import { encodeLobbyName, decodeLobbyName, lobbyNameId } from '../../protocol/src/lobby-name.js';
import { Writer } from '../../protocol/src/encode.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

test('a signer node keeps the name its joined player signed, serves it beside the listing and at /names, and keeps nothing that player did not sign', async () => {
  const d = await serve(openStore(':memory:'), { port: 0, funded: () => true });
  const base = `http://127.0.0.1:${d.port}`;
  try {
    const now = BigInt(Date.now());
    const c = { ...contractFor([d.round.pubkey, b32(0x33)], 3000n, [base]),
      committeeTimeMs: now - 1000n, startTimeMs: now + 59000n, entryCloseMs: now + 179000n, stakeMsat: 0n };
    assert.equal((await fetch(`${base}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
    const rid = roundId(c);
    assumeAssigned(d.round, rid, c.nodes);
    const player = schnorr.utils.randomSecretKey();
    const entry = {
      roundId: rid, playerPubkey: schnorr.getPublicKey(player),
      sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
      stakeCommitment: rand(32), stakeMsat: 0n, feeMsat: 0n, donationMsat: 0n,
      joinTick: 0, worldSecret: rand(32), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33),
      feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
      feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
    };
    const joined = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(joined.status, 201, await joined.text());

    const identity = b32(7);
    const rec = (name, atMs, extra = {}) => ({ roundId: rid, playerPubkey: entry.playerPubkey, identityPubkey: identity, name, atMs, ...extra });
    const signedBy = (secret, r) => ({ record: toHex(encodeLobbyName(r)), sig: toHex(schnorr.sign(lobbyNameId(r), secret)) });
    const post = async (body) => (await fetch(`${base}/name`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })).status;
    const served = async () => (await (await fetch(`${base}/names?round=${toHex(rid)}`)).json()).names
      .map((n) => decodeLobbyName(fromHex(n.record)).name);
    const listed = async () => (await (await fetch(`${base}/rounds`)).json()).rounds.find((x) => x.id === toHex(rid)).names
      .map((n) => ({ name: decodeLobbyName(fromHex(n.record)).name,
        verifies: schnorr.verify(fromHex(n.sig), lobbyNameId(decodeLobbyName(fromHex(n.record))), entry.playerPubkey) }));
    const stranger = schnorr.utils.randomSecretKey();
    const bad = new Writer();
    bad.bytes32(rid); bad.bytes32(entry.playerPubkey); bad.bytes32(identity); bad.u64(1n); bad.str('<b>x</b>');

    const facts = {
      named: await post(signedBy(player, rec('Road Owl 42', 2000n))),
      // the player's key named, a stranger's signature
      forged: await post(signedBy(stranger, rec('Mallory', 3000n))),
      // a stranger's own record, but nobody joined under that key here
      notJoined: await post(signedBy(stranger, rec('Mallory', 3000n, { playerPubkey: schnorr.getPublicKey(stranger) }))),
      // the player's own record for a round this signer node does not hold
      otherRound: await post(signedBy(player, rec('Road Owl 42', 4000n, { roundId: b32(0x99) }))),
      badName: await post({ record: toHex(bad.finish()), sig: toHex(schnorr.sign(new Uint8Array(32), player)) }),
      notJson: await post('not json'),
      older: await post(signedBy(player, rec('Old Name', 1000n))),
      served: await served(),
      listed: await listed(),
    };
    facts.renamed = await post(signedBy(player, rec('Night Hauler 7', 5000n)));
    facts.servedAfter = await served();
    facts.listedAfter = (await listed()).map((x) => x.name);
    console.log('  FACTS (signer node names):', JSON.stringify(facts));
    assert.deepEqual(facts, {
      named: 201, forged: 400, notJoined: 409, otherRound: 404, badName: 400, notJson: 400, older: 200,
      served: ['Road Owl 42'], listed: [{ name: 'Road Owl 42', verifies: true }],
      renamed: 201, servedAfter: ['Night Hauler 7'], listedAfter: ['Night Hauler 7'],
    });
    assert.equal((await fetch(`${base}/names?round=zz`)).status, 400);
  } finally { await d.close(); }
});
