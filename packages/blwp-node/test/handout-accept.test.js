// THE DOOR LETTER 29 EXISTS FOR.
//
// `shares.js` proves the rule and `handout.js` puts it on the wire. Neither is
// worth anything until a seat ASKS, which is the fault letter 28 opened with:
// a correct class nothing constructed, every test green, and nobody drawn on
// the page. So this drives the daemon: publish a handout, then join.
//
// 23.1 is the order - the shares are published, and the Entry Contract's
// `vss_shares_ref` points at them. A node that never accepted those shares
// refuses the entry that names them, because a seat which cannot check a
// handout has no business letting the round it gates begin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { feldmanGroup } from '../src/curve.js';
import { splitSecret } from '../../protocol/src/shares.js';
import { encodeHandout, handoutId, NO_SHARES } from '../../protocol/src/handout.js';
import { encodeRoundContract, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const coefficients = [1n, 2n, 3n, 4n].map((n) => n * 0x1234567890abcdefn + 7n);
const FUNDED = { funded: () => true,
  randomnessFor: () => ({ hash: b32(0xbe), height: 900005, timeMs: 900n }) };

const contractFor = (node) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  startTimeMs: 500n + MIN_ENTRY_WINDOW_MS, entryCloseMs: 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [node.round.pubkey, b32(9)],
});

const entryOn = (roundId, ref) => ({
  roundId, playerPubkey: b32(5), sessionPubkey: b32(6), stakeCommitment: b32(7),
  stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n, joinTick: 0,
  worldSecret: b32(0x5e), vssSharesRef: ref,
});

const handoutOf = (roundId, preimage, { crooked = 0 } = {}) => {
  const honest = splitSecret(preimage, { coefficients, curve: feldmanGroup });
  const other = splitSecret(new Uint8Array(randomBytes(32)),
    { coefficients: coefficients.map((x) => x + 99n), curve: feldmanGroup });
  const shares = honest.shares.map((s, i) =>
    (i >= 7 - crooked ? { seat: other.shares[i].seat, value: other.shares[i].value }
      : { seat: s.seat, value: s.value }));
  return { roundId, playerPubkey: b32(5), needed: 5,
    commitments: honest.commitments, shares };
};

/**
 * ONE READ OF THE BODY, and both of what it might be.
 *
 * A fetch Response's body can be consumed once. Asserting the status with
 * `await r.text()` as the message and then reading the bytes throws "Body is
 * unusable" - which is a test failing for its own reason and hiding whatever
 * the door actually said. So the bytes are taken once and the text is derived
 * from them.
 */
const post = async (port, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body });
  const raw = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, bytes: raw, text: new TextDecoder().decode(raw) };
};

test('an honest handout is accepted, and the entry that names it joins', async () => {
  const node = await serve(openStore(':memory:'), { port: 0, ...FUNDED });
  try {
    const contract = contractFor(node);
    const rid = (await post(node.port, '/round', encodeRoundContract(contract))).bytes;

    const handout = handoutOf(rid, sha256(b32(3)).slice(0, 32));
    const answer = await post(node.port, '/handout', encodeHandout(handout));
    assert.equal(answer.status, 201, answer.text);
    const id = answer.bytes;
    assert.equal(toHex(id), toHex(handoutId(handout)), 'the node named a different handout');

    const entry = entryOn(rid, id);
    const joined = await post(node.port, '/entry', encodeEntryContract(entry));
    assert.equal(joined.status, 201, joined.text);
    assert.equal(toHex(joined.bytes), toHex(entryId(entry)));

    // and it can be fetched back, because a seat that was not asked first
    // still has to be able to look at what it is being asked about
    const back = await fetch(`http://127.0.0.1:${node.port}/handout?id=${toHex(id)}`);
    assert.equal(back.status, 200);
    assert.deepEqual(new Uint8Array(await back.arrayBuffer()), encodeHandout(handout));
  } finally { await node.close(); }
});

test('a two-polynomial dealer is refused at the door, and so is the entry naming it', async () => {
  const node = await serve(openStore(':memory:'), { port: 0, ...FUNDED });
  try {
    const contract = contractFor(node);
    const rid = (await post(node.port, '/round', encodeRoundContract(contract))).bytes;

    const crooked = handoutOf(rid, sha256(b32(4)).slice(0, 32), { crooked: 3 });
    const refused = await post(node.port, '/handout', encodeHandout(crooked));
    assert.equal(refused.status, 409, refused.text);
    assert.match(refused.text, /3 of 7 seats refused their share/);
    assert.match(refused.text, /not on the polynomial the dealer published/);

    // AND THE ENTRY GOES NOWHERE. Nothing was stored, so the reference names
    // shares this node never accepted - which is the refusal that matters,
    // because it is the one a player cannot route around by not asking.
    const entry = entryOn(rid, handoutId(crooked));
    const joined = await post(node.port, '/entry', encodeEntryContract(entry));
    assert.notEqual(joined.status, 201, 'the entry naming a refused handout was accepted');
    assert.match(joined.text, /shares this node has not accepted/);
  } finally { await node.close(); }
});

test('an entry naming shares nobody published is refused, and one naming none joins', async () => {
  const node = await serve(openStore(':memory:'), { port: 0, ...FUNDED });
  try {
    const contract = contractFor(node);
    const rid = (await post(node.port, '/round', encodeRoundContract(contract))).bytes;

    const nobody = await post(node.port, '/entry',
      encodeEntryContract(entryOn(rid, b32(0xaa))));
    assert.notEqual(nobody.status, 201);
    assert.match(nobody.text, /shares this node has not accepted/);

    // M2's ordinary entry: no stake behind the preimage, so no shares. The
    // field is still in the signed bytes, which is why this is a different
    // entry id and not an entry that forgot it.
    const plain = entryOn(rid, NO_SHARES);
    const joined = await post(node.port, '/entry', encodeEntryContract(plain));
    assert.equal(joined.status, 201, joined.text);
  } finally { await node.close(); }
});

test('a handout published for another round does not let an entry in', async () => {
  const node = await serve(openStore(':memory:'), { port: 0, ...FUNDED });
  try {
    const one = contractFor(node);
    const two = { ...one, configHash: b32(0x44) };
    const ridOne = (await post(node.port, '/round', encodeRoundContract(one))).bytes;
    const ridTwo = (await post(node.port, '/round', encodeRoundContract(two))).bytes;
    assert.notEqual(toHex(ridOne), toHex(ridTwo));

    const handout = handoutOf(ridTwo, sha256(b32(5)).slice(0, 32));
    const accepted = await post(node.port, '/handout', encodeHandout(handout));
    assert.equal(accepted.status, 201, accepted.text);
    const id = accepted.bytes;

    const wrongRound = await post(node.port, '/entry',
      encodeEntryContract(entryOn(ridOne, id)));
    assert.notEqual(wrongRound.status, 201);
    assert.match(wrongRound.text, /published for another round/);
  } finally { await node.close(); }
});
