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
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../../blwp-node/src/store.js';
import { serve } from '../../blwp-node/src/server.js';
import { roundId } from '../../protocol/src/contracts.js';
import { decodeTranscript } from '../../protocol/src/transcript.js';
import { hash256, parseTransaction } from '../../protocol/src/tx.js';
import { blockHashOf } from '../../protocol/src/chain.js';
import { advertId, encodeAdvert, joinSignedAdvert } from '../../protocol/src/advert.js';
import { toHex } from '../../protocol/src/hash.js';
import { bondTransaction, blockOf } from '../../protocol/tools/bond.js';
import { Client } from '../src/client.js';
import { reach, endpointFor, isSocketAddress } from '../src/directory.js';

const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');

// THE DECOY. Set once, for the whole file, to a port nothing is listening on.
// It is the address the old client would have used.
const DECOY = 'http://127.0.0.1:1';
globalThis.BLWP_NODE = DECOY;

const session = ed25519.utils.randomSecretKey();
const sign = (id) => ed25519.sign(id, session);
const verify = (sig, msg, key) => { try { return ed25519.verify(sig, msg, key); } catch { return false; } };
const b32 = (n) => new Uint8Array(32).fill(n);
const FUNDED = { funded: () => true };

const contract = (nodes) => ({
  simCoreHash: b32(1), startTimeMs: 1000n, entryCloseMs: 2000n,
  censusHeight: 900000, censusRoot: b32(2), committeeSeed: b32(3),
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});

// REAL KEYS, because the advertisement's signature is now checked. `operator`
// is the node that will be on the committee; `stranger` is a node with a real
// bond and a real proof and no standing in this round at all.
const operator = ed25519.utils.randomSecretKey();
const operatorPubkey = ed25519.getPublicKey(operator);
const stranger = ed25519.utils.randomSecretKey();
const strangerPubkey = ed25519.getPublicKey(stranger);

const advertFor = (endpoint, nodePubkey = operatorPubkey) => ({
  nodePubkey, operatorId: 'somebody', protocolVersions: [1],
  roles: ['game', 'verify'], endpoint, region: 'eu-west', capacityClass: 2,
  softwareHash: b32(3), settlementCapabilities: 0, lightningCapabilities: 0,
  // All zero: the bond is an output of the transaction that carries this body,
  // which is the only value expressible when the txid is not knowable yet.
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(4), timestamp: 1788700000000n,
});

/** The bond transaction a node would post, with its body actually signed. */
const bondFor = (a, secret = operator) =>
  bondTransaction(a, { signature: ed25519.sign(advertId(a), secret) });

/**
 * A two-block chain with the bond transaction in the second.
 *
 * Two, not one, because the client checks the proof against every header of
 * the chain it accepted rather than a header it was pointed at - a header
 * handed over on its own is not a block, it is 80 bytes.
 */
function chainWith(transaction, committee = [operatorPubkey]) {
  const txid = parseTransaction(transaction).txid;
  const sibling = b32(0x99);
  const first = blockOf(hash256, [b32(0x01)]).header;
  const { header } = blockOf(hash256, [txid, sibling], { previous: blockHashOf(first) });
  return {
    chains: [[first, header]], transaction, branch: [sibling], position: 0, committee,
  };
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

    const client = await Client.at(discovery, { core, sign, verify, contract: c });
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
      Client.at({ ...discovery, committee: undefined }, { core, sign, verify, contract: c }),
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
    bondTransaction(a, { signature: ed25519.sign(advertId(a), stranger) }),
    bondTransaction(a, { signature: ed25519.sign(advertId(advertFor('ws://127.0.0.1:1')), operator) }),
    bondTransaction(a),                                    // 64 zero bytes
  ]) {
    await assert.rejects(
      Client.at(chainWith(bad), { core, sign, verify, contract: c }),
      /is not signed by the node it names/);
  }

  // and the honest one, for contrast, resolves
  const good = await Client.at(chainWith(bondFor(a)), { core, sign, verify, contract: c });
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
      Client.at(chainWith(bondFor(a)), { core, sign, verify, contract: c }),
      /is not a secure socket address/, endpoint);
  }

  // wss anywhere, ws only on loopback
  assert.equal(isSocketAddress('wss://node.example:443'), true);
  assert.equal(isSocketAddress('wss://node.example/play'), true);
  assert.equal(isSocketAddress('ws://127.0.0.1:8080'), true);
  assert.equal(isSocketAddress('ws://localhost:8080'), true);

  const fine = await Client.at(chainWith(bondFor(advertFor('wss://node.example:443'))),
    { core, sign, verify, contract: c });
  assert.equal(fine.base, 'https://node.example:443');
});

test('a page that swaps the endpoint is refused by name and reaches nothing', async () => {
  const honest = advertFor('ws://127.0.0.1:9999');
  const c = contract([operatorPubkey]);
  // The transaction carries no body, so the page offers one - and offers the
  // decoy in it. This is the whole attack: real bond, real block, its address.
  const transaction = bondTransaction(honest, { body: new Uint8Array(0) });
  const discovery = chainWith(transaction);
  const courier = (a) => joinSignedAdvert(encodeAdvert(a), ed25519.sign(advertId(a), operator));

  const swapped = { ...honest, endpoint: 'ws://127.0.0.1:1' };
  const no = reach({ ...discovery, signedAdvert: courier(swapped) });
  assert.equal(no.ok, false);
  assert.match(no.why, /commits to a different advertisement/);

  await assert.rejects(
    Client.at({ ...discovery, signedAdvert: courier(swapped) }, { core, sign, verify, contract: c }),
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
  const no = reach({ ...real, chains: [[strangers]] });
  assert.equal(no.ok, false);
  assert.match(no.why, /not in any block of that chain/);

  // and headers that do not link are not a chain at all, however many
  const broken = [real.chains[0][1], real.chains[0][0]];
  assert.equal(reach({ ...real, chains: [broken] }).ok, false);
  assert.equal(reach({ ...real, chains: [] }).ok, false);
  assert.match(reach({ ...real, chains: [] }).why, /no chain of headers/);

  // and a committee is required, not optional: an absent one is a refusal
  assert.match(reach({ ...real, committee: [] }).why, /no committee to check/);
  assert.match(reach({ ...real, committee: undefined }).why, /no committee to check/);
});

test('there is no fallback: without a proof there is no address', () => {
  const transaction = bondFor(advertFor('ws://127.0.0.1:9999'));
  // The decoy is set, the client is asked for an endpoint, and the honest
  // answer is a refusal rather than the page's address.
  assert.equal(globalThis.BLWP_NODE, DECOY);
  assert.throws(() => endpointFor({ ...chainWith(transaction), chains: [] }),
    /no proven endpoint/);
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
