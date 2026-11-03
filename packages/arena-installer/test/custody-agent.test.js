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
import { pegInPastCap } from '../../arena-protocol/src/gateway-seats.js';
import { emergencyOf } from '../src/seed.js';
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
  // the federation's load as the node's seat says it (kanban #1093 part 6): at its cap on mainnet first, then below
  let fedLoad = { reserveSats: 1000n, exposureCapSats: 1000n, network: 'mainnet', load: 1 };
  const agent = createCustodyAgent({ state, release: home, chainKit, gw, nowMs: () => clock, hubs: [`${hub}@hubhubhub.onion:9735`], federationLoad: async () => fedLoad,
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
  assert.equal(toHex(read.advert.emergencyPubkey || new Uint8Array(0)), emergencyOf(fromHex('11'.repeat(32))).pubkey, 'the emergency key kept: the census reads the newest advertisement');
  assert.deepEqual([read.advert.guardianCapable, read.advert.bondMaturityHeight], [false, 157057], 'no custody binaries in this test release: capable only with them; the bond\'s maturity kept');

  coins = [{ txid: '6b'.repeat(32), vout: 2, sats: 55000 }];   // the update's change, confirmed
  assert.equal((await agent.tick()).did, 'join');
  assert.deepEqual(calls[0], ['join', invite]);
  const capped = await agent.tick();
  assert.match(capped.why, /load 1, at or past its cap - a gateway that pegs in past it loses its seat/, 'no peg-in at load >= 1 (kanban #1093 part 6)');
  assert.equal(calls.filter((c) => c[0] === 'address').length, 0, 'not even a deposit address asked');
  fedLoad = { ...fedLoad, network: 'testnet4' };
  assert.equal(pegInPastCap(fedLoad), false, 'a test network shows the load and warns, as the client does');
  fedLoad = { reserveSats: 400n, exposureCapSats: 1000n, network: 'mainnet', load: 0.4 };
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

test('a quick tunnel\'s new name is followed, the seat restarted on it - and no advertisement update is posted for an address (kanban #562, 2026-10-21: "no needed updates")', async () => {
  const home = mkdtempSync(join(tmpdir(), 'custody-addr-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)'); db.prepare('INSERT INTO identity VALUES (0, ?)').run(new Uint8Array(32).fill(7)); db.close();
  state.save({ roles: ['verify', 'custody'], chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, reach: { mode: 'quick', url: 'https://keeps-ahead-employ-thomas.trycloudflare.com', port: 8471 },
    bond: { txid: '78'.repeat(32), vout: 0, sats: '50000', maturity: 157441 } });
  const sent = [];
  const chainKit = { coinsOf: async () => ({ tip: 157190, coins: [{ txid: '5b'.repeat(32), vout: 1, sats: 20000 }] }), broadcast: async (_c, hex) => { sent.push(hex); return 'aa'.repeat(32); } };
  let renamed = 'https://cottage-usually-pete-path.trycloudflare.com';
  const followTunnel = async () => { const r = renamed ? { url: renamed, restarted: ['gateway', 'node'] } : { url: null, restarted: [] }; renamed = null; return r; };
  const agent = createCustodyAgent({ state, release: home, chainKit, followTunnel,
    gw: { joinFederation: async () => ({ ok: false }), testGateway: async () => ({ ok: false }), depositAddress: async () => ({ ok: false }) },
    channels: async () => ({ ok: true, open: [], pending: [] }), lndInfo: async () => ({ ok: false }), ringMembers: async () => [] });
  const first = await agent.tick();
  assert.deepEqual([first.did, first.url, first.restarted], ['tunnel-name', 'https://cottage-usually-pete-path.trycloudflare.com', ['gateway', 'node']]);
  assert.match((await agent.tick()).idle, /waits to be drawn/, 'then on with its other steps');
  assert.equal(sent.length, 0, 'no transaction for an address: the seat announces it off chain');
});

test('a custody and liquidity node whose liquidity deposit cannot be paid yet still publishes its guardian seat (kanban #495, node 4003758b)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'custody-liq-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  const nodeSecret = new Uint8Array(32).fill(6);
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)'); db.prepare('INSERT INTO identity VALUES (0, ?)').run(nodeSecret); db.close();
  state.save({ roles: ['verify', 'custody', 'liquidity'], chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, reach: { mode: 'permanent', url: 'https://node.example.com' },
    bond: { txid: '77'.repeat(32), vout: 0, sats: '50000', maturity: 157057 }, custody: { pegInSats: 50000 }, lightning: { pubkey: '02' + '99'.repeat(32) } });
  const sent = [];
  // 312,380 sat in the wallet, as on the live node: enough for the update, not for the 500,000 sat deposit
  const chainKit = { coinsOf: async () => ({ tip: 157000, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 312380 }] }),
    broadcast: async (_c, hex) => { sent.push(hex); return toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()); } };
  const logs = [];
  const agent = createCustodyAgent({ state, release: home, chainKit, log: (m) => logs.push(m), nowMs: () => 1_800_000_000_000,
    lnd: { funds: async () => ({ ok: true, address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', onchainSats: 0 }) } });
  assert.match((await agent.tick()).idle, /waits to be drawn/, 'no federation yet: custody waits, the deposit said in the log');
  assert.match(logs.join('\n'), /the liquidity deposit waits until the gateway's peg-in is sent - custody goes on/, 'kanban #567: the peg-in first');
  const dir = join(home, 'node.db.guardian'); mkdirSync(dir);
  writeFileSync(join(dir, 'invite-code'), `"${inviteForGuardians(fromHex('ee'.repeat(32)), [{ url: 'wss://node.example.com/guardian', peer: 2 }])}"\n`);
  writeFileSync(join(dir, 'local.json'), JSON.stringify({ identity: 2 }));
  writeFileSync(join(dir, 'consensus.json'), JSON.stringify({ broadcast_public_keys: { 2: '03' + 'cd'.repeat(32) } }));
  const r = await agent.tick();
  assert.equal(r.did, 'guardian_of', r.why);
  const read = readAdvertUpdate(fromHex(sent[1]), { network: 'testnet4' });
  assert.equal(toHex(read.advert.guardianOf[0].federationId), 'ee'.repeat(32));
});

test('a custody node that became a provider sends no deposit before its peg-in, even with the coins for it (kanban #567)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'custody-liq2-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)'); db.prepare('INSERT INTO identity VALUES (0, ?)').run(new Uint8Array(32).fill(6)); db.close();
  state.save({ roles: ['verify', 'custody', 'liquidity'], chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, reach: { mode: 'permanent', url: 'https://node.example.com' },
    bond: { txid: '77'.repeat(32), vout: 0, sats: '50000', maturity: 157057 }, custody: { pegInSats: 50000 }, lightning: { pubkey: '02' + '99'.repeat(32) } });
  const sent = [];
  const chainKit = { coinsOf: async () => ({ tip: 157000, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 900000 }] }), broadcast: async (_c, hex) => { sent.push(hex); return 'aa'.repeat(32); } };
  const funds = async () => ({ ok: true, address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', onchainSats: 0 });
  const agent = createCustodyAgent({ state, release: home, chainKit, log: () => {}, nowMs: () => 1_800_000_000_000, lnd: { funds } });
  assert.match((await agent.tick()).idle, /waits to be drawn/);
  assert.equal(sent.length, 0, 'no deposit while the peg-in is still to come');
  state.save({ custody: { ...state.read().custody, pegIn: { txid: 'bb'.repeat(32) } } });
  const r = await createCustodyAgent({ state, release: home, chainKit, log: () => {}, nowMs: () => 1_800_000_000_000, lnd: { funds } }).tick();
  assert.deepEqual([r.did, sent.length], ['liquidity-fund', 1], 'the peg-in sent: the deposit goes');
});

test('a gateway\'s new address is claimed at once, not at the next hour (2026-10-30)', () => {
  const src = readFileSync(new URL('../src/custody-agent.js', import.meta.url), 'utf8');
  assert.match(src, /nowMs\(\) - last >= 3600000 \|\| \(claimedUrl && claimedUrl !== s\.gateway\.publicUrl\)/);
});
