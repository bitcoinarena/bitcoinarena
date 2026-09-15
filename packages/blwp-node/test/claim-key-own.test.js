// THE ROUND'S CLAIM KEY IS MADE BY ITS OWN SIGNER NODES - the shipping path, nothing
// injected (v4.6.2 §23.1 step 0; W5 step 1).
//
// "Once selected, the settlement signer nodes run a dealerless DKG for this round's
// threshold key claim_pk and each signer node signs (round_id, claim_pk)." Every lock
// test before this handed the signer nodes a key (`claimKeyFor`) - a harness. This
// one is the Daily's own 2-of-2 (`standUpRound`: bonded signer nodes, a census, a
// published round) with no key handed and no peers wired by hand.
//
// MEASURED BEFORE (TASKBOOK, W5 step 1): neither signer node held a group key,
// /claim-key 409 on both ("this signer node holds no claim key for that round yet"),
// and a key generation run by hand found no peer.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { standUpRound } from '../tools/round-2of2.mjs';
import { decodeClaimKeyAttestation } from '../../protocol/src/claim-key.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';
import { attestedClaimKey } from '../../blwp-client/src/join.js';
import { pageCurve } from '../../blwp-client/src/page-curve.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a Daily 2-of-2 assigned from its census makes its own claim key: both signer nodes hold one group key, /claim-key serves it, and the page counts 2 of 2', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18521, portB: 18522 });
  try {
    const signerNodes = [round.a, round.b];
    const nodes = round.contract.nodes;
    const t0 = Date.now();
    while (Date.now() - t0 < 20000 && !signerNodes.every((d) => d.dkg.signerNodeFor(nodes).ok)) await wait(100);
    const madeMs = Date.now() - t0;
    const held = signerNodes.map((d) => d.dkg.signerNodeFor(nodes));
    const groupKeys = held.map((h) => (h.ok ? toHex(h.pool.groupPublicKey) : null));
    const served = [];
    for (const d of signerNodes) {
      const r = await fetch(`http://127.0.0.1:${d.port}/claim-key?round=${round.id}`);
      const body = new Uint8Array(await r.arrayBuffer());
      served.push({ status: r.status, key: r.ok ? toHex(decodeClaimKeyAttestation(body.subarray(0, body.length - 64)).claimPk) : null });
    }
    const page = await attestedClaimKey({ round: { ...round.contract, id: fromHex(round.id) }, signerNodes: nodes,
      nodes: round.nodes, curve: pageCurve });
    const facts = {
      bothHoldAKey: groupKeys.every(Boolean), sameGroupKey: groupKeys[0] !== null && groupKeys[0] === groupKeys[1],
      keyBytes: groupKeys[0] ? groupKeys[0].length / 2 : null,
      door: served.map((s) => s.status), servedIsTheGroupKey: served.map((s, i) => s.key === groupKeys[i]),
      pageOk: page.ok, pageAttested: page.attested, pageNeeded: page.needed,
      pageKeyIsTheGroupKey: page.ok && toHex(page.claimPk) === groupKeys[0],
    };
    console.log(`  FACTS (own claim key, made in ${madeMs} ms):`, JSON.stringify(facts), groupKeys[0] && groupKeys[0].slice(0, 16));
    assert.deepEqual(facts, {
      bothHoldAKey: true, sameGroupKey: true, keyBytes: 33, door: [200, 200], servedIsTheGroupKey: [true, true],
      pageOk: true, pageAttested: 2, pageNeeded: 2, pageKeyIsTheGroupKey: true,
    });
  } finally { await round.close(); }
});
