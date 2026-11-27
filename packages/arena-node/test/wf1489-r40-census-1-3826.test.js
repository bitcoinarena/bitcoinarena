// kanban #1489 audit r40 census-1: the peer pull of GET /proposals reads only the first 256 records of a peer's listing, and a seat lists
// newest publication first. One bonded node that publishes 256 cheap config proposals (one small deposit each, nothing else needed)
// after an honest proposal pushes the honest one out of every honest seat's pull window for good: a seat that was not posted to never
// learns of it, and no seat learns another seat's sightings of it (#2432 / #2700), so it never reaches the census-weight majority and
// FAILS at every seat. No per-proposer limit on config proposals exists.
// SAFE: a seat pulling an honest peer's listing takes the honest proposal it lacks, whatever the number of newer proposals listed before it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, CLASS, SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, depositCommitmentScript, BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (outs, salt) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(7), ...le(salt, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const keyOf = (n) => { const secret = new Uint8Array(32); secret[31] = n; secret[0] = 3; return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const HONEST = keyOf(1), ATTACKER = keyOf(2), SEAT_H = keyOf(3), SEAT_B = keyOf(4);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 6000, label: 'a' }, { recipientPk: pk(3), shareBps: 4000, label: 'b' }];
const NET = new Uint8Array(32).fill(0x4e);
const CENSUS = [HONEST, ATTACKER, SEAT_H, SEAT_B].map((k, i) => ({ pubkey: k.pubkey, outpoint: `b${i}:0`, bondSats: 25000000n }));
const BLOCK = 'dd'.repeat(32);

// one config proposal with its own committed deposit, confirmed at `height`
function proposalOf(key, height, n) {
  const want = depositOutputsExpected(1000, SET);
  const config = Uint8Array.of(9, n & 0xff, (n >> 8) & 0xff);
  const body0 = { networkId: NET, parent: BALLOT_GENESIS.configHash, configHash: configHashOf(config), config, class: CLASS.DESIGN, activationHeight: height + 8, proposer: key.pubkey };
  const raw = tx([...want.outputs.map((o) => ({ sats: o.sats, script: o.script })), { sats: 0, script: depositCommitmentScript(body0) }], n);
  const p = { ...body0, depositTxid: Uint8Array.from(parseTransaction(raw).txid) };
  const signature = schnorr.sign(proposalBodyId(p), key.secret);
  return { raw, height, txid: toHex(Uint8Array.from(p.depositTxid).reverse()), hex: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), id: toHex(proposalId({ ...p, signature })) };
}

function seat(deposits, signer, tipRef) {
  return createProposals({ bindHeightFor: () => 0,
    confirmedTx: async (t, b) => { const d = deposits.get(t); return d && b === BLOCK ? { raw: d.raw, height: d.height } : null; },
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest,
    censusAt: async () => CENSUS, store: { read: () => [], write: () => {} },
    tipHeight: async () => tipRef.tip, seenSigner: { pubkey: signer.pubkey, sign: (m) => schnorr.sign(m, signer.secret) } });
}

test('256 newer proposals of one bonded node do not hide an honest proposal from the peer pull', async () => {
  const honest = proposalOf(HONEST, 200, 0);
  const spam = Array.from({ length: 256 }, (_, i) => proposalOf(ATTACKER, 201, i + 1));
  const deposits = new Map([honest, ...spam].map((d) => [d.txid, d]));
  const tip = { tip: 201 };
  // seat H was posted the honest proposal in time, then the attacker's 256 (each one deposit of 1,000 sat, the cap)
  const h = seat(deposits, SEAT_H, tip);
  assert.equal((await h.add({ proposal: honest.hex, blockHash: BLOCK })).status, 201);
  let taken = 0;
  for (const s of spam) if ((await h.add({ proposal: s.hex, blockHash: BLOCK })).status === 201) taken++;
  assert.equal(taken, 256, 'every one of the attacker\'s proposals is kept (no per-proposer limit)');
  const listing = h.list();     // what H's GET /proposals serves: newest publication first
  console.log('  H lists', listing.length, 'proposals; the honest one at index', listing.findIndex((r) => r.id === honest.id));
  // seat B was not posted it: it learns it from H's listing (the peer pull)
  const b = seat(deposits, SEAT_B, tip);
  await b.pull(JSON.parse(JSON.stringify(listing)));
  const got = b.list().find((r) => r.id === honest.id);
  console.log('  seat B holds', b.list().length, 'proposals after the pull; the honest one:', got ? 'held' : 'MISSING');
  assert.ok(got, 'the honest proposal H holds must reach B through the pull');
});
