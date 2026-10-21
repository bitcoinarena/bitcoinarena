// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CUSTODY AGENT (custody-agent.js; 2026-10-18: "It should happen automatically"): nothing before a
// founding; once fedimintd wrote the invite, guardian_of[] is published in an advertisement update of the node's bond (signed by its key,
// paid from its wallet), then the gateway joins the federation, then the peg-in goes to the gateway's address - each once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { checkGatewayClaim } from '../../arena-protocol/src/gateway-claim.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createCustodyAgent, guardianOfEntry } from '../src/custody-agent.js';
import { nodeState } from '../src/state.js';
import { readAdvertUpdate, checkAgainstBond } from '../../arena-protocol/src/advert-update.js';
import { inviteForGuardians } from '../../arena-node/src/invite.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

test('the custody agent: waits for the founding, then guardian_of, the gateway\'s federation, the peg-in - each once', async () => {
  const home = mkdtempSync(join(tmpdir(), 'custody-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  const nodeSecret = new Uint8Array(32).fill(6);
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)'); db.prepare('INSERT INTO identity VALUES (0, ?)').run(nodeSecret); db.close();
  const bondTxid = '77'.repeat(32);
  state.save({ roles: ['verify', 'custody'], chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, reach: { mode: 'permanent', url: 'https://node.example.com' },
    bond: { txid: bondTxid, vout: 0, sats: '50000', maturity: 157057 }, custody: { pegInSats: 50000 },
    gateway: { apiUrl: 'http://127.0.0.1:8476', passwordFile: join(home, 'pw'), federations: [] } });
  const sent = [];
  let coins = [{ txid: '5a'.repeat(32), vout: 1, sats: 57000 }];
  const chainKit = { coinsOf: async () => ({ tip: 157000, coins }), broadcast: async (_c, hex) => { sent.push(hex); return toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()); } };
  const fid = 'ee'.repeat(32);
  const calls = [];
  const gw = { joinFederation: async (o) => { calls.push(['join', o.invite]); return { ok: true, federationId: fid }; },
    testGateway: async () => ({ ok: true, federations: [{ federationId: fid, name: 'arena' }] }),
    depositAddress: async (o) => { calls.push(['address', o.federationId]); return { ok: true, address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' }; } };
  let clock = 1_800_000_000_000;
  // LND: one channel out so far (no inbound), announcing an address; the ring's other members from the seat; peers and channels faked
  let open = [{ peer: '03' + '77'.repeat(32), capacitySats: 250000, public: true, active: true, remoteSats: 40000 }];
  const hub = '02' + '44'.repeat(32);
  let lndOnchain = 0; const lndCalls = []; const connected = new Set();
  const ring = [{ node: '00'.repeat(32), lightningPubkey: '02' + '11'.repeat(32), lightningAddr: '198.51.100.1:9735' },
    { node: 'ff'.repeat(32), lightningPubkey: '03' + '22'.repeat(32), lightningAddr: '' }];
  const agent = createCustodyAgent({ state, release: home, chainKit, gw, nowMs: () => clock, hubs: [`${hub}@hubhubhub.onion:9735`],
    channels: async () => ({ ok: true, open, pending: [], publicCapacitySats: 250000, inboundSats: 0, outboundSats: 250000 }),
    lndInfo: async () => ({ ok: true, uris: ['02' + '99'.repeat(32) + '@203.0.113.9:9735'] }),
    ringMembers: async () => [...ring, { node: toHex(schnorr.getPublicKey(nodeSecret)), lightningPubkey: '02' + '99'.repeat(32), lightningAddr: '203.0.113.9:9735' }],
    lnd: { funds: async () => ({ ok: true, address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', onchainSats: lndOnchain }),
      peers: async () => ({ ok: true, peers: [...connected] }),
      connect: async (_c, o) => { lndCalls.push(['connect', o.pubkey, o.host]); connected.add(o.pubkey); return { ok: true }; },
      close: async () => ({ ok: true }),
      openTo: async (_c, o) => { lndCalls.push(['open', o.pubkey, o.sats]); open = [...open, { peer: o.pubkey, capacitySats: o.sats, public: true, active: false }]; return { ok: true, fundingTxid: 'ab'.repeat(32) }; } } });

  assert.match((await agent.tick()).idle, /waits to be drawn/);
  const dir = join(home, 'node.db.guardian'); mkdirSync(dir);
  const invite = inviteForGuardians(fromHex(fid), [{ url: 'wss://node.example.com/guardian', peer: 2 }]);
  writeFileSync(join(dir, 'invite-code'), `"${invite}"\n`);
  writeFileSync(join(dir, 'local.json'), JSON.stringify({ identity: 2 }));
  writeFileSync(join(dir, 'consensus.json'), JSON.stringify({ broadcast_public_keys: { 2: '03' + 'cd'.repeat(32) } }));
  assert.deepEqual(guardianOfEntry(dir).federationId, fid);

  const one = await agent.tick();
  assert.equal(one.did, 'guardian_of');
  assert.equal(sent.length, 2, 'the funding and the update');
  const read = readAdvertUpdate(fromHex(sent[1]), { network: 'testnet4' });
  const ok = await checkAgainstBond(read, { txid: fromHex(bondTxid).reverse(), vout: 0, nodePubkey: schnorr.getPublicKey(nodeSecret) }, (s, m, k) => schnorr.verify(s, m, k));
  assert.equal(ok.ok, true, ok.why);
  assert.deepEqual([toHex(read.advert.guardianOf[0].federationId), toHex(read.advert.guardianOf[0].guardianKey)], [fid, '03' + 'cd'.repeat(32)]);
  assert.deepEqual([read.advert.guardianCapable, read.advert.bondMaturityHeight], [false, 157057], 'no custody binaries in this test release: capable only with them; the bond\'s maturity kept');

  coins = [{ txid: '6b'.repeat(32), vout: 2, sats: 55000 }];   // the update's change, confirmed
  assert.equal((await agent.tick()).did, 'join');
  assert.deepEqual(calls[0], ['join', invite]);
  const peg = await agent.tick();
  assert.equal(peg.did, 'peg-in');
  const pegTx = parseTransaction(fromHex(sent[2]));
  assert.equal(pegTx.outputs[0].value, 50000n);
  assert.equal(toHex(pegTx.outputs[0].script), '0014751e76e8199196d454941c45d1b3a323f1433bd6');
  assert.match((await agent.tick()).idle, /custody is set up/, 'no public gateway address and no tested LND: no claim');
  state.save({ gateway: { ...state.read().gateway, publicUrl: 'https://node.example.com/gateway/' }, lightning: { pubkey: '02' + '99'.repeat(32) } });
  assert.equal((await agent.tick()).did, 'gateway-claim');
  const claim = JSON.parse(readFileSync(join(home, 'gateway-claim.json'), 'utf8'));
  assert.equal(checkGatewayClaim(claim, (s, m, k) => schnorr.verify(s, m, k)).ok, true, 'signed by the node key');
  assert.deepEqual([claim.node, claim.federationId, claim.gatewayUrl, claim.capacitySats, claim.pegInSats], [toHex(schnorr.getPublicKey(nodeSecret)), fid, 'https://node.example.com/gateway/', '250000', '50000']);
  assert.deepEqual([claim.inboundSats, claim.outboundSats, claim.outsideInboundSats, claim.lightningAddr], ['0', '250000', '40000', '203.0.113.9:9735'], 'inbound and outbound apart, the inbound from outside the federation, and where LND takes peers');
  // THE OUTSIDE CHANNEL first: to the hub (an onion address, dialled over Tor), funded into LND's wallet once
  coins = [{ txid: '7c'.repeat(32), vout: 1, sats: 400000 }];
  assert.equal((await agent.tick()).did, 'outside-fund');
  assert.equal(parseTransaction(fromHex(sent[3])).outputs[0].value, 103000n);
  assert.match((await agent.tick()).idle, /outside channel's 103000 sat are on their way/);
  lndOnchain = 104000;
  assert.equal((await agent.tick()).did, 'outside-channel');
  assert.deepEqual(lndCalls.slice(-2), [['connect', hub, 'hubhubhub.onion:9735'], ['open', hub, 100000]]);
  lndOnchain = 0; lndCalls.length = 0; connected.clear();
  // THE RING: members in node-key order (00.., this node, ff..); the next one after this node is ff.. (it takes no connections)
  const fund = await agent.tick();
  assert.equal(fund.did, 'ring-fund', 'LND\'s wallet is empty: the ring channel\'s funds go to it first');
  assert.equal(parseTransaction(fromHex(sent[4])).outputs[0].value, 153000n);
  assert.match((await agent.tick()).idle, /on their way to LND/, 'once');
  lndOnchain = 160000;
  assert.match((await agent.tick()).idle, /waits for ffffffffffff… to connect/, 'the next node takes no connections and has not dialled in');
  assert.deepEqual(lndCalls, [['connect', '02' + '11'.repeat(32), '198.51.100.1:9735']], 'this node dialled its previous neighbour, so that one can open to it');
  ring[1].lightningAddr = '192.0.2.7:9735';
  assert.equal((await agent.tick()).did, 'ring-channel');
  assert.deepEqual(lndCalls.slice(-2), [['connect', '03' + '22'.repeat(32), '192.0.2.7:9735'], ['open', '03' + '22'.repeat(32), 150000]]);
  assert.match((await agent.tick()).idle, /custody is set up.*ring channel open/, 'one ring channel, once');
  // A NODE JOINS between this node and its next (the owner: "When a node joins an existing federation it needs incoming liquidity too"):
  // this node's channel moves to the newcomer - only after the newcomer opened its own channel (its outbound), so ff.. is never without inbound
  open = open.map((x) => (x.peer === '03' + '22'.repeat(32) ? { ...x, active: true, channelPoint: 'ab'.repeat(32) + ':0' } : x));
  const joiner = { node: 'fe'.repeat(32), lightningPubkey: '02' + '33'.repeat(32), lightningAddr: '192.0.2.9:9735', outboundSats: 0 };
  ring.splice(1, 0, joiner);
  const me = toHex(schnorr.getPublicKey(nodeSecret));
  assert.ok(me < joiner.node, 'the joiner sorts right after this node');
  assert.match((await agent.tick()).idle, /waits for the new member fefefefefefe… to open its own channel/);
  joiner.outboundSats = 150000;
  const closing = await agent.tick();
  assert.equal(closing.did, 'ring-close');
  assert.equal(closing.channelPoint, 'ab'.repeat(32) + ':0', 'the old ring channel (to ff..) closes, cooperatively');
  open = open.filter((x) => x.peer !== '03' + '22'.repeat(32));   // closed; its coins back in LND's wallet
  assert.equal((await agent.tick()).did, 'ring-channel');
  assert.deepEqual(lndCalls.slice(-2), [['connect', '02' + '33'.repeat(32), '192.0.2.9:9735'], ['open', '02' + '33'.repeat(32), 150000]], 'the same coins, now to the newcomer');
  clock += 3_600_000;
  assert.equal((await agent.tick()).did, 'gateway-claim');
  assert.equal(sent.length, 5, 'each payment once');
  state.save({ roles: ['verify'] });
  assert.match((await agent.tick()).idle, /no custody role/);
});

test('the gateway Disconnected while LND answers: restarted on the second tick in a row, not while LND itself is down (macOS node A after its update)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'custody-gw-watch-'));
  const state = nodeState(home);
  state.save({ roles: ['verify'], gateway: { apiUrl: 'http://127.0.0.1:1', passwordFile: '/x' }, lightning: { restUrl: 'https://127.0.0.1:10080' } });
  let gwState = 'Disconnected', lndUp = true; const restarts = [];
  const agent = createCustodyAgent({ state, release: home,
    gw: { testGateway: async () => (gwState === 'Running' ? { ok: true, state: 'Running', federations: [] } : { ok: false, why: 'no Lightning node yet', state: gwState }) },
    lndInfo: async () => (lndUp ? { ok: true, uris: [] } : { ok: false, why: 'connection refused' }),
    restartGateway: async () => { restarts.push(1); gwState = 'Running'; return { ok: true }; } });
  lndUp = false;
  assert.equal((await agent.tick()).did, undefined); assert.equal((await agent.tick()).did, undefined);
  assert.equal(restarts.length, 0, 'LND down: the gateway waits for it');
  lndUp = true;
  assert.equal((await agent.tick()).did, undefined, 'one tick may be the start-up');
  assert.equal((await agent.tick()).did, 'gateway-restart');
  assert.equal(restarts.length, 1);
  assert.equal((await agent.tick()).did, undefined, 'Running again: nothing more');
  assert.equal(restarts.length, 1);
});

test('the address changed (a quick tunnel\'s new name): one advertisement update names it, signed against the bond; then it waits for it to confirm (kanban #562 2A)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'custody-addr-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  const nodeSecret = new Uint8Array(32).fill(7);
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)'); db.prepare('INSERT INTO identity VALUES (0, ?)').run(nodeSecret); db.close();
  const bondTxid = '78'.repeat(32);
  state.save({ roles: ['verify', 'custody'], chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, reach: { mode: 'quick', url: 'https://cottage-usually-pete-path.trycloudflare.com', port: 8471 },
    bond: { txid: bondTxid, vout: 0, sats: '50000', maturity: 157441 } });
  const sent = [];
  const chainKit = { coinsOf: async () => ({ tip: 157190, coins: [{ txid: '5b'.repeat(32), vout: 1, sats: 20000 }] }),
    broadcast: async (_c, hex) => { sent.push(hex); return toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()); } };
  let address = { advertised: 'https://keeps-ahead-employ-thomas.trycloudflare.com', serving: 'https://cottage-usually-pete-path.trycloudflare.com' };
  let clock = 1_800_000_000_000;
  let renamed = 'https://cottage-usually-pete-path.trycloudflare.com';
  const followTunnel = async () => { const r = renamed ? { url: renamed, restarted: ['gateway', 'node'] } : { url: null, restarted: [] }; renamed = null; return r; };
  const agent = createCustodyAgent({ state, release: home, chainKit, nowMs: () => clock, addressRead: async () => address, followTunnel,
    gw: { joinFederation: async () => ({ ok: false }), testGateway: async () => ({ ok: false }), depositAddress: async () => ({ ok: false }) },
    channels: async () => ({ ok: true, open: [], pending: [] }), lndInfo: async () => ({ ok: false }), ringMembers: async () => [] });

  const first = await agent.tick();
  assert.deepEqual([first.did, first.restarted], ['tunnel-name', ['gateway', 'node']], 'the tunnel\'s new name followed first, the seat restarted on it');
  assert.equal(sent.length, 0);
  const one = await agent.tick();
  assert.equal(one.did, 'address');
  assert.equal(sent.length, 2, 'the funding and the update');
  const read = readAdvertUpdate(fromHex(sent[1]), { network: 'testnet4' });
  const ok = await checkAgainstBond(read, { txid: fromHex(bondTxid).reverse(), vout: 0, nodePubkey: schnorr.getPublicKey(nodeSecret) }, (s, m, k) => schnorr.verify(s, m, k));
  assert.equal(ok.ok, true, ok.why);
  assert.equal(read.advert.endpoint, 'https://cottage-usually-pete-path.trycloudflare.com', 'the address it answers at');
  assert.equal(read.advert.bondMaturityHeight, 157441, 'the bond\'s maturity kept');
  assert.deepEqual([state.read().advertised.endpoint, state.read().advertised.was], [address.serving, address.advertised]);

  assert.match((await agent.tick()).idle, /confirming/, 'the census still names the old one: no second update');
  assert.equal(sent.length, 2);
  clock += 6 * 3600 * 1000 + 1;
  assert.equal((await agent.tick()).did, 'address', 'not in the census after 6 h: posted again');
  assert.equal(sent.length, 4);

  address = { advertised: address.serving, serving: address.serving };   // confirmed: the census names it
  assert.match((await agent.tick()).idle, /waits to be drawn/, 'nothing to update: the agent goes on with its other steps');
  assert.equal(sent.length, 4);
});
