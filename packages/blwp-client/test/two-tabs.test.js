// TWO TABS, TWO IDENTITIES, ONE ROUND THE DAEMONS AGREED ON.
//
// This is the page's own path, in `node --test`: the URL an operator prints,
// parsed the way `index.html` parses it, handed to `Client.at` the way
// `blwp.jslib` hands it - the whole discovery, so the chain is asked for from
// two providers, the bond is proven into it, the advertisement's signature is
// checked, and the node's address is READ OFF that bond rather than taken from
// the query. Then two players join, one drives, and the other is shown a
// picture of them.
//
// What it does not do is look at a screen. The drawn pose is measured in
// PlayMode against this same capture, at delta zero; what is measured here is
// everything up to the renderer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { standUpRound } from '../../blwp-node/tools/round-2of2.mjs';
import { Client } from '../src/client.js';
import { joinFromQuery, tabIdentity, entryFor } from '../src/join.js';
import { feldmanGroup } from '../../blwp-node/src/curve.js';
import { watchGhosts } from '../src/ghost-field.js';
import { roundId } from '../../protocol/src/contracts.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { init as coreInit, step as coreStep } from '../../core/src/sim.js';
import { O_TRUCK, T_X, T_Z, T_HEADING } from '../../core/src/state.js';
import { toHex } from '../../protocol/src/hash.js';
import { BITCOIN_MAINNET_GENESIS_HEADER, blockHashOf } from '../../protocol/src/chain.js';
import { hash256 } from '../../protocol/src/tx.js';
import { blockOf } from '../../protocol/tools/bond.js';
import { toHex as hex } from '../../protocol/src/hash.js';

const require = createRequire(import.meta.url);
const core = require('../../core/dist/blwp-core.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const storage = () => {
  const held = new Map();
  return { getItem: (k) => held.get(k) ?? null, setItem: (k, v) => held.set(k, v) };
};
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
// The beacon the daemons were stood up with, so the seed is derivable here.
const BEACON = new Uint8Array(32).fill(0xbe);
const fromHexHere = (hex) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
};

/**
 * A BITCOIND, WITHOUT A BITCOIND.
 *
 * The 2-of-2 tool used to answer every beacon question with a constant, and a
 * committee drawn on a constant is a committee its operator chose. That is
 * gone, so these nodes need a chain - and a suite that needs a daemon is a
 * suite nobody runs. This is the same fake node `chain-rpc.test.js` uses: a
 * real mined chain, served over the RPC calls the reader makes, with its
 * timestamps straddling now so the round's own committee_time has a block
 * after it.
 */
function chainNode({ blocks = 40, spacing = 600 } = {}) {
  const b32 = (n) => new Uint8Array(32).fill(n);
  const now = Math.floor(Date.now() / 1000);
  const headers = [];
  let previous = new Uint8Array(32);
  for (let i = 0; i < blocks; i++) {
    // Half the chain before now and half after, so a block whose MEDIAN is
    // after committee_time exists with depth to spare. The median lags the tip
    // by five blocks, which is why the crossing point is not the middle.
    const time = now + (i - 20) * spacing;
    const { header } = blockOf(hash256, [b32(i + 1)], { previous, time });
    headers.push(header);
    previous = blockHashOf(header);
  }
  const firstHeight = 0;            // a regtest starts at genesis, and so does this
  return async (method, params = []) => {
    if (method === 'getblockcount') return firstHeight + headers.length - 1;
    if (method === 'getblockhash') return hex(blockHashOf(headers[params[0] - firstHeight]));
    if (method === 'getblockheader') {
      const at = headers.findIndex((h) => hex(blockHashOf(h)) === params[0]);
      return hex(headers[at]);
    }
    throw new Error('this fake node was asked ' + method);
  };
}

test('a person opens the printed URL twice and the two tabs are on one round', async () => {
  // NO HEADER SOURCE HANDED IN. The tool builds one chain that carries the
  // bonds and names the beacon; a separate header source would be a census on
  // one chain and a seed on another, which is what letter 32 closed.
  const round = await standUpRound({ host: "127.0.0.1", portA: 18080, portB: 18081 });
  const tabs = [];
  try {
    // WHAT THE PAGE DOES WITH ITS OWN ADDRESS BAR, on the URL the operator
    // printed - not a hand-built object.
    const search = new URL(round.url).search;
    const named = await joinFromQuery(search);
    assert.ok(named, 'the printed URL named no round');
    assert.equal(toHex(roundId(named.round)), round.id,
      'the page joined a round that is not the one the URL named');

    for (const which of ['one', 'two']) {
      const secret = ed25519.utils.randomSecretKey();
      const sessionPubkey = ed25519.getPublicKey(secret);
      const player = tabIdentity({ storage: storage(), random, curve: feldmanGroup });
      const seat = entryFor(named.round, { playerPubkey: player.pubkey, random });

      // EXACTLY WHAT THE JSLIB HANDS OVER, including the round id the player
      // was given - the door refuses a contract that does not hash to it.
      const client = await Client.at({
        headers: named.chain.headers, bonds: named.chain.bonds,
        signedAdvert: fromHexHere(named.advert.signedAdvert),
        committee: named.round.nodes,
      }, {
        core: { hash: (st) => core.hash(st) },
        sign: (id) => ed25519.sign(id, secret),
        verify,
        contract: named.round,
        roundIdGiven: fromHexHere(round.id),
      });

      const rid = await client.openRound(named.round);
      assert.equal(toHex(rid), round.id, which + ': the node named a different round');
      const entry = { ...seat, roundId: rid, sessionPubkey };
      const eid = await client.join(entry);
      await client.connect();
      client.setRound({ roundId: rid, entryId: eid, blockTicks: named.round.blockTicks | 0 });
      tabs.push({ which, client, eid, entry });
    }

    assert.equal(tabs.length, 2);
    assert.notEqual(toHex(tabs[0].eid), toHex(tabs[1].eid),
      'the two tabs are one player, so neither would ever see the other');

    // TAB ONE DRIVES FIRST. A player with no published inputs is nobody to
    // draw - the interest set is over runs the node can replay, not over
    // sockets that happen to be open - so the driving comes before the asking,
    // which is also the order a person arrives in.
    for (let t = 0; t < 90; t++) tabs[0].client.record([45875, 0, 0, 0, 0]);
    await tabs[0].client.drain();

    // TAB TWO ASKS TO BE SHOWN THE OTHER TRUCKS and is shown one - tab one's
    // entry and nobody else's, never a picture of itself.
    const field = watchGhosts(tabs[1].client, { roundId: tabs[1].entry.roundId, entryId: tabs[1].eid });
    assert.equal(await field.watching, 'watching 1', 'the page was shown nobody');

    for (let t = 0; t < 30; t++) tabs[1].client.record([45875, 0, 0, 0, 0]);
    await tabs[1].client.drain();
    await wait(150);

    const seen = field.latest();
    assert.ok(seen.length >= 1, 'the second tab was never shown the first tab\'s truck');
    assert.equal(toHex(seen[0].entryId), toHex(tabs[0].eid),
      'the picture is of the wrong player');
    // AND THE POSE IS TAB ONE'S OWN RUN, driven here rather than taken on
    // trust: the same core, the same inputs, the same seed - which comes from
    // that player's entry and the round's beacon, so nobody else can compute
    // it for them.
    const st = coreInit(seedWordForEntry(tabs[0].entry, BEACON));
    for (let t = 0; t <= seen[0].tick; t++) coreStep(st, 45875, 0, 0, 0, 0);
    const was = {
      x: st.i32[O_TRUCK + T_X], z: st.i32[O_TRUCK + T_Z],
      heading: st.i32[O_TRUCK + T_HEADING],
    };
    console.log(`  tab two was shown tab one at tick ${seen[0].tick}: `
      + `x ${seen[0].x} z ${seen[0].z} heading ${seen[0].heading}`);
    console.log(`  tab one's own transcript at that tick: `
      + `x ${was.x} z ${was.z} heading ${was.heading}  -> delta `
      + `${seen[0].x - was.x} ${seen[0].z - was.z} ${seen[0].heading - was.heading}`);
    assert.equal(seen[0].x, was.x, 'the page has the truck somewhere the core never put it');
    assert.equal(seen[0].z, was.z);
    assert.equal(seen[0].heading, was.heading);
    assert.notEqual(seen[0].x, 0, 'the truck is drawn at the origin, which is not a run');
  } finally {
    for (const t of tabs) { try { t.client.close(); } catch { /* already gone */ } }
    await round.close();
  }
});

test('two daemons whose chains disagree stop the join by name', async () => {
  const round = await standUpRound({ host: '127.0.0.1', portA: 18082, portB: 18083 });
  try {
    const named = await joinFromQuery(new URL(round.url).search);

    // ONE PROVIDER IS SWAPPED FOR A DIFFERENT CHAIN. Not a broken one - a
    // well-formed set of headers that is simply not the chain the other
    // provider is on, which is the case `agreedChain` exists for: two
    // providers who fork are two providers of whom at least one is lying or
    // broken, and picking the heavier one would be guessing which.
    const other = blockOf(hash256, [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)],
      { previous: blockHashOf(BITCOIN_MAINNET_GENESIS_HEADER) });
    const forked = new Uint8Array(160);
    forked.set(BITCOIN_MAINNET_GENESIS_HEADER, 0);
    forked.set(other.header, 80);
    const liar = () => Promise.resolve([BITCOIN_MAINNET_GENESIS_HEADER, other.header]);
    liar.tag = 'http://forked.test';

    const secret = ed25519.utils.randomSecretKey();
    await assert.rejects(Client.at({
      headers: [named.chain.headers[0], liar], bonds: named.chain.bonds,
      signedAdvert: fromHexHere(named.advert.signedAdvert),
      committee: named.round.nodes,
    }, {
      core: { hash: (st) => core.hash(st) },
      sign: (id) => ed25519.sign(id, secret),
      verify, contract: named.round, roundIdGiven: fromHexHere(round.id),
    }), (e) => {
      console.log('  refused: ' + e.message);
      assert.match(e.message, /no proven endpoint|chain/i);
      return true;
    });
  } finally { await round.close(); }
});
