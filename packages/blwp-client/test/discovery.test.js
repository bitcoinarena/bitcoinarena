// WHERE THE CLIENT LEARNS TO TALK, AND WHO GETS TO DECIDE IT.
//
// Before this, the answer was `BLWP_NODE`: a global written into the page.
// Every stranger who loaded the page reached whatever address whoever shipped
// it had put there, and nothing in the client could tell a bonded node from
// any other server. Section 25.1 is normative about that exact failure - a
// client "MUST NOT take a census, a committee or an endpoint on the word of
// any API, including one operated by the same party that ships the client" -
// because it has no symptom: "same screens, same rounds, same results".
//
// So this drives the live door. A REAL node process on a real port, an
// advertisement committed to by a transaction, the transaction proven into a
// block header, and a decoy `BLWP_NODE` set to somewhere else for the whole
// file. If the page global were read anywhere, every test here would reach the
// decoy and fail.
//
// WHAT IS FIXTURE AND WHAT IS REAL. The node, the socket, the HTTP round trip
// and the round contract are real. The bond transaction and the header chain
// are built, because there is no BLWP bond on mainnet - the reading side is
// measured against real mainnet bytes in `protocol/test/tx.test.js` and
// `chain.test.js`. Where the headers come from is step 5c and is not here.
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { roundId } from '../../protocol/src/contracts.js';
import { decodeTranscript } from '../../protocol/src/transcript.js';
import { hash256, parseTransaction } from '../../protocol/src/tx.js';
import {
  blockHashOf, BITCOIN_MAINNET_GENESIS, BITCOIN_MAINNET_GENESIS_HEADER,
} from '../../protocol/src/chain.js';
import { advertId, encodeAdvert, joinSignedAdvert } from '../../protocol/src/advert.js';
import { toHex } from '../../protocol/src/hash.js';
import { bondTransaction, blockOf } from '../../protocol/tools/bond.js';
import { Client } from '../src/client.js';
import {
  reach, endpointFor, isSocketAddress, discover, PROVIDERS_NEEDED,
} from '../src/directory.js';

const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');

// THE DECOY. Set once, for the whole file, to a port nothing is listening on.
// It is the address the old client would have used.
const DECOY = 'http://127.0.0.1:1';
globalThis.BLWP_NODE = DECOY;

const session = ed25519.utils.randomSecretKey();
const sign = (id) => ed25519.sign(id, session);
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const b32 = (n) => new Uint8Array(32).fill(n);
const FUNDED = { funded: () => true };

const contract = (nodes) => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'THRESHOLD_LN', slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});

// REAL KEYS, because the advertisement's signature is now checked. `operator`
// is the node that will be on the committee; `stranger` is a node with a real
// bond and a real proof and no standing in this round at all.
const operator = ed25519.utils.randomSecretKey();
const operatorPubkey = schnorr.getPublicKey(operator);
const stranger = ed25519.utils.randomSecretKey();
const strangerPubkey = schnorr.getPublicKey(stranger);

const advertFor = (endpoint, nodePubkey = operatorPubkey) => ({
  nodePubkey, operatorId: 'somebody', protocolVersions: [1],
  roles: ['game', 'verify'], endpoint, region: 'eu-west', capacityClass: 2,
  softwareHash: b32(3), settlementCapabilities: 0, lightningCapabilities: 0,
  // All zero: the bond is an output of the transaction that carries this body,
  // which is the only value expressible when the txid is not knowable yet.
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(4), guardianOf: [], timestamp: 1788700000000n,
});

/** The bond transaction a node would post, with its body actually signed. */
const bondFor = (a, secret = operator) =>
  bondTransaction(a, { signature: schnorr.sign(advertId(a), secret) });

/**
 * A two-block chain with the bond transaction in the second.
 *
 * Two, not one, because the client checks the proof against every header of
 * the chain it accepted rather than a header it was pointed at - a header
 * handed over on its own is not a block, it is 80 bytes.
 */
/**
 * A CHAIN THAT STARTS WHERE BITCOIN STARTS. The first header is the real
 * genesis block - eighty bytes that have not changed since 2009, mined at the
 * difficulty of the day - and the bond's block is mined onto it. An honest
 * chain contains the block the client knows because it IS the block the client
 * knows, not because a fixture said so.
 */
function chainWith(transaction, committee = [operatorPubkey]) {
  const txid = parseTransaction(transaction).txid;
  const sibling = b32(0x99);
  const first = BITCOIN_MAINNET_GENESIS_HEADER;
  const { header } = blockOf(hash256, [txid, sibling], { previous: blockHashOf(first) });
  const chain = [first, header];
  return {
    chains: [chain], chain, transaction, branch: [sibling], position: 0, committee,
  };
}

/**
 * The verification layer's own view of the fixture: everything except the
 * chain, so a test can offer the chain the way it means to. `chain` beats
 * `chains` in `reach`, and leaving both in silently ignored the override.
 */
function layered(raw, extra) {
  const { chain, chains, ...rest } = raw;
  return { ...rest, ...extra };
}

/**
 * THE SAME FIXTURE, AS THE DOOR NOW TAKES IT: two functions that answer with
 * headers, one that answers with a bond and its proof, and the block this
 * client is anchored to. Nothing here is a ready-made chain.
 */
function asProviders(raw) {
  return {
    headers: [tagged('one.example', () => raw.chain), tagged('two.example', () => raw.chain)],
    bonds: [tagged('one.example', () => ({
      transaction: raw.transaction, branch: raw.branch, position: raw.position,
    }))],
    committee: raw.committee,
    signedAdvert: raw.signedAdvert,
  };
}

/** A provider that says which source it is, the way `httpProvider` does. */
function tagged(tag, get) {
  const f = (...a) => get(...a);
  f.tag = tag;
  return f;
}

test('a node is reached because a transaction says where it is', async () => {
  const node = await serve(openStore(), { port: 0, ...FUNDED });
  try {
    // The advertisement is written AFTER the node has a port, which is the only
    // fixture-shaped thing here: on mainnet the endpoint is fixed for the life
    // of the bond and the node is brought up to match it. `ws://` rather than
    // the `wss://` of 25.1 because a test node on loopback has no certificate.
    const endpoint = `ws://127.0.0.1:${node.port}`;
    const discovery = chainWith(bondFor(advertFor(endpoint)));
    const c = contract([operatorPubkey]);

    const seen = reach(discovery);
    assert.equal(seen.ok, true, seen.why);
    assert.equal(seen.endpoint, endpoint);

    const client = await Client.at(asProviders(discovery),
      { core, sign, verify, contract: c, roundIdGiven: roundId(c) });
    assert.equal(client.base, `http://127.0.0.1:${node.port}`);
    assert.notEqual(client.base, DECOY);

    // and it is a working address, not merely a string: a real round opens on it
    assert.deepEqual(await client.openRound(c), roundId(c));
  } finally { await node.close(); }
});

/**
 * THE ONE THIS SLICE EXISTS FOR, and it would have passed at 606f54d.
 *
 * A REAL bond, a REAL proof, a REAL signature - and a node with no standing in
 * this round. `Client.at` used to drop `nodePubkey` on the floor and the
 * committee was consulted only when a receipt came back, which is a round trip
 * too late: by then the entry contract and the opening batches are on the
 * stranger's disk, and section 11 makes publishing the client's duty, not
 * something it can take back.
 *
 * So the refusal is measured where it has to happen - before the round exists -
 * and it is measured by asking the stranger's own node what it has afterwards.
 */
test('a proven node that is not on this round s committee is refused at the door', async () => {
  const theirs = await serve(openStore(), { port: 0, ...FUNDED });
  try {
    const a = advertFor(`ws://127.0.0.1:${theirs.port}`, strangerPubkey);
    const discovery = chainWith(bondFor(a, stranger), [strangerPubkey]);

    // the advertisement itself is beyond reproach: proven, committed, signed
    assert.equal(reach(discovery).ok, true);

    // and this round's committee is somebody else
    const c = contract([operatorPubkey]);
    await assert.rejects(
      Client.at({ ...asProviders(discovery), committee: undefined },
        { core, sign, verify, contract: c, roundIdGiven: roundId(c) }),
      new RegExp(`${toHex(strangerPubkey)}, which is not on this round's committee`));

    // NOTHING REACHED THEM. Not a round, not an entry, not a tick - the node
    // is ASKED rather than trusted, and it has never heard of this round. The
    // transcript door answers 200 to anybody, so the number that matters is
    // `x-ticks`: section 11 input published to a stranger, and it is zero.
    const r = await fetch(`http://127.0.0.1:${theirs.port}/round?id=${toHex(roundId(c))}`);
    assert.equal(r.status, 404);
    const t = await fetch(`http://127.0.0.1:${theirs.port}/transcript`
      + `?round=${toHex(roundId(c))}&entry=${toHex(b32(5))}`);
    assert.equal(t.headers.get('x-ticks'), '0');
    const held = decodeTranscript(new Uint8Array(await t.arrayBuffer()));
    assert.deepEqual(held.batches, []);
  } finally { await theirs.close(); }
});

test('an advertisement not signed by the node it names is refused', async () => {
  const endpoint = 'ws://127.0.0.1:9999';
  const a = advertFor(endpoint);
  const c = contract([operatorPubkey]);

  // signed by somebody else, and by the operator over a different body
  for (const bad of [
    bondTransaction(a, { signature: schnorr.sign(advertId(a), stranger) }),
    bondTransaction(a, { signature: schnorr.sign(advertId(advertFor('ws://127.0.0.1:1')), operator) }),
    bondTransaction(a),                                    // 64 zero bytes
  ]) {
    await assert.rejects(
      Client.at(asProviders(chainWith(bad)),
        { core, sign, verify, contract: c, roundIdGiven: roundId(c) }),
      /is not signed by the node it names/);
  }

  // and the honest one, for contrast, resolves
  const good = await Client.at(asProviders(chainWith(bondFor(a))),
    { core, sign, verify, contract: c, roundIdGiven: roundId(c) });
  assert.equal(good.base, 'http://127.0.0.1:9999');
});

/**
 * THE ENDPOINT IS A STRING SOMEBODY COMMITTED TO, NOT A URL. Committing to it
 * on chain makes it theirs; it does not make it an address. Without this the
 * client would `replace(/^ws/, 'http')` whatever was there and dial it.
 */
test('an endpoint that is not a secure socket address never becomes the base', async () => {
  const c = contract([operatorPubkey]);
  for (const endpoint of [
    'http://node.example',                  // the scheme 25.1 does not use
    'https://node.example',
    'node.example:443',                     // a bare host
    'wss:/node.example',                    // one slash short
    'ws://node.example:443',                // plaintext to another host
    'javascript:alert(1)',
    '',
  ]) {
    assert.equal(isSocketAddress(endpoint), false, endpoint);
    const a = advertFor(endpoint);
    await assert.rejects(
      Client.at(asProviders(chainWith(bondFor(a))),
        { core, sign, verify, contract: c, roundIdGiven: roundId(c) }),
      /is not a secure socket address/, endpoint);
  }

  // wss anywhere, ws only on loopback
  assert.equal(isSocketAddress('wss://node.example:443'), true);
  assert.equal(isSocketAddress('wss://node.example/play'), true);
  assert.equal(isSocketAddress('ws://127.0.0.1:8080'), true);
  assert.equal(isSocketAddress('ws://localhost:8080'), true);

  const fine = await Client.at(asProviders(chainWith(bondFor(advertFor('wss://node.example:443')))),
    { core, sign, verify, contract: c, roundIdGiven: roundId(c) });
  assert.equal(fine.base, 'https://node.example:443');
});

test('a page that swaps the endpoint is refused by name and reaches nothing', async () => {
  const honest = advertFor('ws://127.0.0.1:9999');
  const c = contract([operatorPubkey]);
  // The transaction carries no body, so the page offers one - and offers the
  // decoy in it. This is the whole attack: real bond, real block, its address.
  const transaction = bondTransaction(honest, { body: new Uint8Array(0) });
  const discovery = chainWith(transaction);
  const courier = (a) => joinSignedAdvert(encodeAdvert(a), schnorr.sign(advertId(a), operator));

  const swapped = { ...honest, endpoint: 'ws://127.0.0.1:1' };
  const no = reach({ ...discovery, signedAdvert: courier(swapped) });
  assert.equal(no.ok, false);
  assert.match(no.why, /commits to a different advertisement/);

  await assert.rejects(
    Client.at({ ...asProviders(discovery), signedAdvert: courier(swapped) },
      { core, sign, verify, contract: c, roundIdGiven: roundId(c) }),
    /no proven endpoint: the bond output commits to a different advertisement/);

  // the honest body, carried by the same page, is taken
  assert.equal(reach({ ...discovery, signedAdvert: courier(honest) }).endpoint,
    'ws://127.0.0.1:9999');
});

test('a header that is not in the chain proves nothing', () => {
  const transaction = bondFor(advertFor('ws://127.0.0.1:9999'));
  const real = chainWith(transaction);

  // the same proof, offered against a chain that does not contain that block
  const strangers = blockOf(hash256, [b32(0x02)]).header;
  const no = reach(layered(real, { chains: [[strangers]] }));
  assert.equal(no.ok, false);
  assert.match(no.why, /not in any block of that chain/);

  // and headers that do not link are not a chain at all, however many
  const broken = [real.chain[1], real.chain[0]];
  assert.equal(reach(layered(real, { chains: [broken] })).ok, false);
  assert.equal(reach(layered(real, { chains: [] })).ok, false);
  assert.match(reach(layered(real, { chains: [] })).why, /no chain of headers/);

  // and a committee is required, not optional: an absent one is a refusal
  assert.match(reach({ ...real, committee: [] }).why, /no committee to check/);
  assert.match(reach({ ...real, committee: undefined }).why, /no committee to check/);
});

test('there is no fallback: without a proof there is no address', () => {
  const transaction = bondFor(advertFor('ws://127.0.0.1:9999'));
  // The decoy is set, the client is asked for an endpoint, and the honest
  // answer is a refusal rather than the page's address.
  assert.equal(globalThis.BLWP_NODE, DECOY);
  assert.throws(() => endpointFor(layered(chainWith(transaction), { chains: [] })),
    /no proven endpoint/);
});

/**
 * WHICH ROUND, AND WHO SAYS SO.
 *
 * The committee check is circular without this. The page writes the contract,
 * so the page writes `nodes`, so the page picks the committee that its own
 * advertisement then satisfies - and it satisfies it honestly, with a real
 * bond, a real merkle proof and a real signature. Every check in this file
 * passes. What does not pass is the arithmetic: change one node in that list
 * and the contract hashes to a different round than the one the player was
 * sent to.
 *
 * Section 25.1 step 1 is "a link, QR, copied round_id - carries nothing", and
 * carrying nothing is exactly why it is enough: every id here is the tagged
 * hash OF the object it names.
 */
test('a contract that is not the round the player was given is refused', async () => {
  // The round the player was invited to: a committee that is not the page's.
  const honest = contract([b32(0x0e), b32(0x0f)]);
  const invited = roundId(honest);

  // The page writes its own round instead, naming its own node - which has a
  // real bond, a real proof and a real signature, and would otherwise pass.
  const theirs = await serve(openStore(), { port: 0, ...FUNDED });
  try {
    const forged = contract([operatorPubkey]);
    const discovery = chainWith(bondFor(advertFor(`ws://127.0.0.1:${theirs.port}`)));

    // the advertisement is beyond reproach against the page's own contract
    assert.equal(reach(discovery).ok, true);

    await assert.rejects(
      Client.at(asProviders(discovery),
        { core, sign, verify, contract: forged, roundIdGiven: invited }),
      new RegExp(`the page offered round ${toHex(roundId(forged))}, `
        + `which is not the round ${toHex(invited)} you were given`));

    // NOTHING RAN. No openRound, no socket - the node is asked about both
    // rounds and has never heard of either.
    for (const id of [roundId(forged), invited]) {
      const r = await fetch(`http://127.0.0.1:${theirs.port}/round?id=${toHex(id)}`);
      assert.equal(r.status, 404);
    }
    const t = await fetch(`http://127.0.0.1:${theirs.port}/transcript`
      + `?round=${toHex(roundId(forged))}&entry=${toHex(b32(5))}`);
    assert.equal(t.headers.get('x-ticks'), '0');
    assert.deepEqual(decodeTranscript(new Uint8Array(await t.arrayBuffer())).batches, []);
  } finally { await theirs.close(); }
});

test('a player who arrived with no round id has nothing to check, and is refused', async () => {
  const c = contract([operatorPubkey]);
  const discovery = chainWith(bondFor(advertFor('wss://node.example:443')));
  for (const given of [undefined, null, b32(7).slice(0, 31), toHex(roundId(c))]) {
    await assert.rejects(
      Client.at(asProviders(discovery), { core, sign, verify, contract: c, roundIdGiven: given }),
      /nothing to check the page's contract against/, String(given));
  }

  // AND THE WRONG ROUND IS THE ANSWER GIVEN, even when the discovery is broken
  // too. Not an ordering claim about the resolution - `reach` is pure, sends
  // nothing, and moving it either side of this is unobservable - but about
  // which refusal reaches the player: "you are not on the round you were sent
  // to" is the one they can act on, and a chain complaint would bury it.
  await assert.rejects(
    Client.at({ ...asProviders(discovery), headers: [] },
      { core, sign, verify, contract: c, roundIdGiven: roundId(contract([b32(0x0e)])) }),
    /which is not the round/);
});

/**
 * THE DOOR ASKS; IT DOES NOT ACCEPT.
 *
 * Everything the chain source measures was, until now, a library nothing used.
 * `reach` verified whatever chain it was handed - which proves that a chain and
 * a proof agree with each other and nothing whatever about Bitcoin, because a
 * page that wrote both wrote a consistent pair. Section 25.1 is normative about
 * what a CLIENT does, so the door has to do the asking.
 */
test('a chain handed to the door is refused, however consistent it is', async () => {
  const transaction = bondFor(advertFor('wss://node.example:443'));
  const raw = chainWith(transaction);
  const c = contract([operatorPubkey]);
  const door = { core, sign, verify, contract: c, roundIdGiven: roundId(c) };

  // This bundle is perfect: mined headers that link, a real proof into one of
  // them, a bond committing to a signed advertisement for a committee member.
  // The verification layer accepts it, and says so here so the refusal below
  // cannot be mistaken for the bundle being bad.
  assert.equal(reach(raw).ok, true);

  for (const handed of ['chain', 'chains', 'transaction', 'branch', 'position']) {
    const offered = { ...asProviders(raw), [handed]: raw[handed] };
    await assert.rejects(Client.at(offered, door),
      new RegExp(`the ${handed} must come from a provider, not from whoever opened the page`));
  }

  // and asked for through providers, the very same bytes open the round
  const client = await Client.at(asProviders(raw), door);
  assert.equal(client.base, 'https://node.example:443');
});

/**
 * AND THE CHAIN RULES ARE THE DOOR'S RULES NOW, not a library's. One provider
 * is not enough, the anchor is not optional, and the bond is asked for rather
 * than supplied - measured through `Client.at`, not through `agreedChain`.
 */
test('the door will not open on one provider, or without an anchor', async () => {
  const transaction = bondFor(advertFor('wss://node.example:443'));
  const raw = chainWith(transaction);
  const c = contract([operatorPubkey]);
  const door = { core, sign, verify, contract: c, roundIdGiven: roundId(c) };
  const asked = asProviders(raw);

  await assert.rejects(Client.at({ ...asked, headers: [asked.headers[0]] }, door),
    /no chain: 1 providers is fewer than the 2 it takes/);
  await assert.rejects(Client.at({ ...asked, anchor: b32(0x5a) }, door),
    /the anchor is the client's own and may not be supplied/);
  await assert.rejects(Client.at({ ...asked, bonds: [] }, door),
    /no bond: no providers to ask for the bond/);

  // AND provenBond runs on this path: a provider offering a proof that lands
  // in no block of the agreed chain is refused, by that name.
  await assert.rejects(
    Client.at({ ...asked,
      bonds: [tagged('liar.example', () => ({ transaction, branch: [b32(0x55)], position: 0 }))],
    }, door),
    /no bond: no provider proved that bond into the chain/);
});

/**
 * AN INTERNALLY CONSISTENT BUNDLE IS NOT ENOUGH, and this is the whole point of
 * the cut. The attacker mines his own little chain, puts his own bond in it,
 * signs his own advertisement, and serves all of it from two providers that
 * agree with each other completely. Every check inside the client passes except
 * the one that asks whether this is Bitcoin.
 */
test('a self-consistent world of the attackers own making is refused', async () => {
  const his = bondFor(advertFor('wss://the-attackers-node:443'));
  const c = contract([operatorPubkey]);
  const door = { core, sign, verify, contract: c, roundIdGiven: roundId(c) };

  // HIS WHOLE WORLD. He mines his own first block rather than starting where
  // Bitcoin starts, puts his bond in the next one, signs his own
  // advertisement for a node on this round's committee, and serves all of it
  // from two providers that agree with each other completely.
  const txid = parseTransaction(his).txid;
  const sibling = b32(0x99);
  const root = blockOf(hash256, [b32(0xf0)]).header;
  const { header } = blockOf(hash256, [txid, sibling], { previous: blockHashOf(root) });
  const mine = [root, header];
  const asked = {
    headers: [tagged('his-one.example', () => mine), tagged('his-two.example', () => mine)],
    bonds: [tagged('his-one.example', () => ({ transaction: his, branch: [sibling], position: 0 }))],
    committee: [operatorPubkey],
  };

  // every check inside the client passes except the one that asks whether this
  // is Bitcoin - the library, handed his chain, accepts it
  assert.equal(reach({
    chain: mine, transaction: his, branch: [sibling], position: 0,
    committee: [operatorPubkey],
  }).ok, true);

  // and the door does not, because his chain does not contain genesis
  await assert.rejects(Client.at(asked, door),
    /no chain: only 0 of 2 providers gave a chain/);

  // nor when he offers the block he would rather be anchored to
  await assert.rejects(
    Client.at({ ...asked, anchor: blockHashOf(root) }, door),
    /the anchor is the client's own and may not be supplied/);
});

/**
 * THE RULES ARE THE CLIENT'S, AND THE PAGE ONLY SAYS WHERE TO ASK.
 *
 * The anchor was one of these and was fixed first; `least` is the same fault
 * with a smaller word. Measured through `Client.at` before it was refused: a
 * page passing `least: 1` opened a round on a single provider it had also
 * supplied, and "several independent sources, most work wins" was one source.
 * A short chain and a chain with a block hidden are the same bytes, so one
 * source cannot be weighed at all - which is why two is a property and not a
 * setting.
 */
test('a page cannot lower the two-provider floor, or set the client s patience', async () => {
  const transaction = bondFor(advertFor('wss://node.example:443'));
  const raw = chainWith(transaction);
  const c = contract([operatorPubkey]);
  const door = { core, sign, verify, contract: c, roundIdGiven: roundId(c) };
  const asked = asProviders(raw);
  const one = { ...asked, headers: [asked.headers[0]] };

  // one provider is refused already, and stays refused
  await assert.rejects(Client.at(one, door),
    /no chain: 1 providers is fewer than the 2 it takes/);

  // and asking for a lower floor is refused by name rather than obeyed
  await assert.rejects(Client.at({ ...one, least: 1 }, door),
    /least is the client's own and may not be supplied/);
  await assert.rejects(Client.at({ ...asked, least: 1 }, door),
    /least is the client's own and may not be supplied/);
  await assert.rejects(Client.at({ ...asked, least: 5 }, door),
    /least is the client's own and may not be supplied/);

  // how long to wait is the client's patience, not the page's: zero would
  // refuse every honest provider, enormous would hang the run on one the page
  // controls
  for (const timeoutMs of [0, 1, 60000, 999999999]) {
    await assert.rejects(Client.at({ ...asked, timeoutMs }, door),
      /timeoutMs is the client's own and may not be supplied/, String(timeoutMs));
  }

  // the floor is two, and it is named rather than buried in a call
  assert.equal(PROVIDERS_NEEDED, 2);

  // and with nothing of the client's supplied, the same two providers open it
  const client = await Client.at(asked, door);
  assert.equal(client.base, 'https://node.example:443');
});

/**
 * `ask` STAYS THE PAGE'S. It names which range of chain to fetch, and a lie
 * about it can only omit - which is the one lie a second provider answers.
 */
test('the page still says which part of the chain to ask for', async () => {
  const transaction = bondFor(advertFor('wss://node.example:443'));
  const raw = chainWith(transaction);
  const c = contract([operatorPubkey]);
  const seen = [];
  const client = await Client.at({
    headers: [tagged('a.example', (q) => { seen.push(q); return raw.chain; }),
      tagged('b.example', (q) => { seen.push(q); return raw.chain; })],
    bonds: [tagged('a.example', (q) => { seen.push(q); return { transaction, branch: raw.branch, position: raw.position }; })],
    committee: raw.committee,
    ask: { from: 0, count: 2 },
  }, { core, sign, verify, contract: c, roundIdGiven: roundId(c) });
  assert.equal(client.base, 'https://node.example:443');
  assert.deepEqual(seen, [{ from: 0, count: 2 }, { from: 0, count: 2 }, { from: 0, count: 2 }]);
});

/**
 * TWO PROVIDERS MEANS TWO SOURCES, NOT TWO CALLS.
 *
 * The origin tag existed and only `httpProvider` set it, so it never fired
 * where it matters: on this path the PAGE writes the functions, and two of them
 * closing over one address counted as two. Same shape as `least` - a rule that
 * held in the library and not at the door.
 *
 * A tag is a declaration, not a proof, and the limit is measured below rather
 * than assumed away.
 */
test('the same origin twice is not two providers, however the page passes it', async () => {
  const transaction = bondFor(advertFor('wss://node.example:443'));
  const raw = chainWith(transaction);
  const c = contract([operatorPubkey]);
  const door = { core, sign, verify, contract: c, roundIdGiven: roundId(c) };
  const chain = () => raw.chain;
  const bond = () => ({
    transaction, branch: raw.branch, position: raw.position,
  });
  const bonds = [tagged('one.example', bond)];

  // two raw functions, the way a page wrote them before this
  await assert.rejects(Client.at({ headers: [chain, chain], bonds, committee: raw.committee }, door),
    /header provider 0 does not say which source it is/);

  // one that says who it is and one that does not
  await assert.rejects(Client.at({
    headers: [tagged('one.example', chain), chain], bonds, committee: raw.committee,
  }, door), /header provider 1 does not say which source it is/);

  // two that say the same thing: one server listed twice
  await assert.rejects(Client.at({
    headers: [tagged('one.example', chain), tagged('one.example', chain)],
    bonds,
    committee: raw.committee,
  }, door), /header providers 0 and 1 are the same source, one.example: one server listed twice is not two/);

  // a bond provider with no tag is refused the same way - one class of
  // provider, one rule
  await assert.rejects(Client.at({
    headers: [tagged('one.example', chain), tagged('two.example', chain)],
    bonds: [bond],
    committee: raw.committee,
  }, door), /bond provider 0 does not say which source it is/);

  // and two that name different sources are two providers, and it opens
  const client = await Client.at({
    headers: [tagged('one.example', chain), tagged('two.example', chain)],
    bonds,
    committee: raw.committee,
  }, door);
  assert.equal(client.base, 'https://node.example:443');
});

/**
 * THE LIMIT, MEASURED RATHER THAN ASSUMED AWAY. A page that puts two different
 * tags on one machine is believed. There is nothing to read: two honest
 * providers on the same chain return the same bytes, so agreement is exactly
 * what an honest pair looks like, and the client has no network identity to
 * check a name against. What the tag buys is that the obvious case is refused
 * and a lie has to be written down as one.
 */
test('two tags on one server cannot be caught from inside the client', async () => {
  const transaction = bondFor(advertFor('wss://node.example:443'));
  const raw = chainWith(transaction);
  const c = contract([operatorPubkey]);
  const door = { core, sign, verify, contract: c, roundIdGiven: roundId(c) };

  // ONE server behind both names, and it is counted
  let calls = 0;
  const server = () => { calls++; return raw.chain; };
  const client = await Client.at({
    headers: [tagged('pretending-one.example', server), tagged('pretending-two.example', server)],
    bonds: [tagged('pretending-one.example', () => ({
      transaction, branch: raw.branch, position: raw.position,
    }))],
    committee: raw.committee,
  }, door);

  assert.equal(client.base, 'https://node.example:443');
  assert.equal(calls, 2, 'one server answered twice and the client could not tell');
});

/**
 * THE BLOCK THE CLIENT KNOWS, and the only reason to believe it is a
 * measurement: these eighty bytes hash to the block id everybody knows mainnet
 * by. Nothing here is taken on trust, including the constant this whole slice
 * rests on.
 */
test('the anchor the client brings is Bitcoin s first block', async () => {
  assert.equal(toHex(blockHashOf(BITCOIN_MAINNET_GENESIS_HEADER).reverse()),
    '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
  assert.equal(toHex(blockHashOf(BITCOIN_MAINNET_GENESIS_HEADER)),
    toHex(BITCOIN_MAINNET_GENESIS));
  assert.equal(BITCOIN_MAINNET_GENESIS_HEADER.length, 80);

  // and an honest chain that really contains it opens the round
  const transaction = bondFor(advertFor('wss://node.example:443'));
  const raw = chainWith(transaction);
  assert.equal(toHex(blockHashOf(raw.chain[0])), toHex(BITCOIN_MAINNET_GENESIS));
  const c = contract([operatorPubkey]);
  const client = await Client.at(asProviders(raw),
    { core, sign, verify, contract: c, roundIdGiven: roundId(c) });
  assert.equal(client.base, 'https://node.example:443');
});

/**
 * THE SOURCE GUARD. The behaviour above can only be measured where a test
 * thought to look; this is the part that cannot quietly come back somewhere
 * else. `blwp-node/src` is checked the same way for reaching into the core.
 */
test('no file in the client reads an address off the page', () => {
  const dir = new URL('../src/', import.meta.url).pathname;
  const guilty = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    const text = readFileSync(dir + file, 'utf8')
      .replace(/\/\/[^\n]*/g, '')                    // comments name it on purpose
      .replace(/\/\*[\s\S]*?\*\//g, '');
    for (const bad of [/BLWP_NODE/, /window\s*\./, /globalThis\s*\./, /location\s*\./]) {
      if (bad.test(text)) guilty.push(`${file}: ${bad}`);
    }
  }
  assert.deepEqual(guilty, []);
});
