// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CUSTODY AGENT (2026-10-18: "4. It should happen automatically"): on a custody node, what
// follows a founding without anyone at the keyboard. A user service of its own (the seat does not hold the wallet), every minute:
//
//   1. the node's guardian took part in a founding and its federation runs: fedimintd wrote <store>.guardian/invite-code. The node's
//      advertisement is updated (§5A.2) to name it in guardian_of[] with this guardian's own key - paid from the node's wallet - so the
//      census and the federation record see who guards it, and the cohort trigger stops counting these ten.
//   2. the node's gateway joins that federation by its invite code.
//   3. the peg-in the owner set aside in the wizard (custody.pegInSats) goes to the gateway's peg-in address for it, so the gateway
//      holds the e-cash it needs to pay out Lightning (spec: a deposit needs gateway e-cash in that federation).
// Each step once, each recorded in the node's state; a step waits for what it needs (confirmed coins, a running gateway).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { walletOf, payoutKeyOf, coinsOf, broadcast, addressScript } from './wallet.js';
import { advertFor, buildAdvertUpdate, buildSend, EMERGENCY_IN_ADVERT } from './bond.js';
import { emergencyOf } from './seed.js';
import { joinFederation, testGateway, depositAddress } from './gateway.js';
import { lndChannels, testLnd, lndFunds, lndPeers, lndConnect, lndOpenTo, lndClose } from './lnd.js';
import { pegInPastCap } from '../../arena-protocol/src/gateway-seats.js';
import { splitSignedRecord } from '../../arena-protocol/src/federation-record.js';
import { networkOf } from '../../arena-protocol/src/constants.js';

/** THE RING CHANNEL each custody node opens to the next node of its federation (sat), and what the deposit sets aside for it with fees. */
export const RING_SATS = 150000;
export const RING_RESERVE_SATS = RING_SATS + 3000;
/**
 * THE OUTSIDE CHANNEL (2026-10-18: "If the incoming channels are only connected between them with nothing outside it's no good"):
 * each gateway also opens one channel to a well-connected node outside its federation, so payers and payees on the wider Lightning
 * network reach it. Per network; testnet4: the the test host's LND C over Tor ("for Testnet you can take one of our test-host nodes"; its IP is
 * dynamic, so its permanent onion address). Mainnet: to be named before mainnet.
 */
export const OUTSIDE_SATS = 100000;
export const OUTSIDE_RESERVE_SATS = OUTSIDE_SATS + 3000;
export const LIGHTNING_HUBS = Object.freeze({
  testnet4: Object.freeze(['02bf834901a65ed21af3c45c9c02e03213f56034e9b2a514ece11e9b9e7b4c4859@boxy5rnx32ovj2qa2l2sw6p5nns3t2u2zephqe6x3fkbqbfoamdu6xad.onion:9735']),
  mainnet: Object.freeze([]),
});
import { signGatewayClaim } from '../../arena-protocol/src/gateway-claim.js';
import { LIQUIDITY_TERMS } from '../../arena-protocol/src/liquidity.js';
import { writeFileSync } from 'node:fs';
import { guardianSetupOf } from './state.js';
import { readInvite } from '../../arena-node/src/invite.js';
import { fromHex, sha256 } from '../../arena-protocol/src/hash.js';

/** A founded guardian's entry for guardian_of[]: its federation (invite-code) and its own peer's broadcast key. Null before the founding. */
export function guardianOfEntry(dir) {
  const inviteFile = join(dir, 'invite-code');
  if (!existsSync(inviteFile)) return null;
  const invite = readFileSync(inviteFile, 'utf8').replace(/["\s]/g, '');
  const federationId = readInvite(invite).federationId;
  const peer = JSON.parse(readFileSync(join(dir, 'local.json'), 'utf8')).identity;
  const guardianKey = JSON.parse(readFileSync(join(dir, 'consensus.json'), 'utf8')).broadcast_public_keys[String(peer)];
  if (!/^[0-9a-f]{66}$/.test(guardianKey || '')) throw new Error(`${dir}: no broadcast key for its own peer ${peer}`);
  return { invite, federationId, guardianKey };
}

export function createCustodyAgent({ state, release, chainKit = { coinsOf, broadcast }, gw = { joinFederation, testGateway, depositAddress }, channels = lndChannels, lndInfo = testLnd, hubs = LIGHTNING_HUBS.testnet4,
  lnd = { funds: lndFunds, peers: lndPeers, connect: lndConnect, openTo: lndOpenTo, close: lndClose }, ringMembers = null, log = () => {}, nowMs = () => Date.now(),
  restartGateway = async () => (await import('./node-services.js')).control('restart', 'gateway', { home: state.home }),
  followTunnel = async () => (await import('./node-services.js')).followTunnelNow({ home: state.home }),
  reviveTunnel = async () => (await import('./node-services.js')).reviveDeadTunnel({ home: state.home }),
  // THE FEDERATION'S LOAD, from this node's own seat (GET /federations): { reserveSats, exposureCapSats, network } of its newest record, or null
  federationLoad = null }) {
  const loadOf = federationLoad || (async (s, fid) => {
    const port = (s.reach && s.reach.port) || (s.service && s.service.port);
    try { const r = await fetch(`http://127.0.0.1:${port}/federations`, { signal: AbortSignal.timeout(10000) }); const v = await r.json();
      const f = ((v && v.federations) || []).find((x) => String(x.federation).toLowerCase() === String(fid).toLowerCase());
      if (!f || f.exposureCapSats === undefined) return null;
      const split = f.record ? splitSignedRecord(Uint8Array.from(Buffer.from(f.record, 'hex'))) : null;
      return { reserveSats: BigInt(f.reserveSats), exposureCapSats: BigInt(f.exposureCapSats), network: split && split.record ? networkOf(split.record.networkId) : null, load: f.load };
    } catch { return null; }
  });
  // the federation's custody nodes with their Lightning key and address, from this node's own seat (GET /gateway-seats: the claims it
  // gathered as a guardian, its own among them)
  const membersOf = ringMembers || (async (s) => {
    const port = (s.reach && s.reach.port) || (s.service && s.service.port);
    try { const r = await fetch(`http://127.0.0.1:${port}/gateway-seats`, { signal: AbortSignal.timeout(10000) }); const v = await r.json();
      return Object.entries((v && v.gateways) || {}).map(([node, g]) => ({ node, lightningPubkey: g.lightningPubkey, lightningAddr: g.lightningAddr || '', outboundSats: Number(g.outboundSats || 0) })); } catch { return []; }
  });
  // where this node's LND takes peer connections: the address LND announces (its uris, e.g. after NAT traversal), else the node's own
  // public address when it is reached directly; empty behind a tunnel - then only its ring neighbour dials out to it
  const lightningAddrOf = async (s) => {
    const i = await lndInfo(s.lightning).catch(() => ({ ok: false }));
    const u = i && i.ok && (i.uris || []).map((x) => String(x).split('@')[1]).find(Boolean);
    if (u) return u;
    return s.reach && s.reach.mode === 'direct' && s.direct && s.direct.address ? `${s.direct.address.includes(':') ? `[${s.direct.address}]` : s.direct.address}:9735` : '';
  };
  const nodeSecretOf = () => {
    const db = new DatabaseSync(state.path('node.db'), { readOnly: true });
    try { return new Uint8Array(db.prepare('SELECT secret FROM identity WHERE one = 0').get().secret); } finally { db.close(); }
  };
  const commitOf = () => { try { return sha256(readFileSync(join(release, 'COMMIT'))); } catch { return new Uint8Array(32); } };
  // THE GATEWAY BROUGHT BACK TO ITS LND (measured on the test host, node A rc.25 -> 2026.1.0, 2026-10-19): started in the same moment as LND,
  // before LND's wallet was unlocked, gatewayd stayed "Disconnected" with LND synced beside it, and only a restart joined them. Two ticks
  // in a row of a Disconnected gateway while LND answers: the gateway is restarted (a reboot starts every service at once as well).
  let disconnected = 0;
  async function gatewayWatch(s) {
    if (!s.gateway || !s.lightning || typeof gw.testGateway !== 'function') return null;
    const t = await gw.testGateway(s.gateway).catch(() => ({ ok: false }));
    if (t.ok || t.state !== 'Disconnected') { disconnected = 0; return null; }
    const l = await lndInfo(s.lightning).catch(() => ({ ok: false }));
    if (!l || !l.ok) { disconnected = 0; return null; }   // LND itself is not up yet: the gateway waits for it, nothing to restart
    if (++disconnected < 2) return null;
    disconnected = 0;
    const r = await restartGateway().catch((e) => ({ ok: false, why: e.message }));
    log(r.ok ? 'the gateway was Disconnected while LND answers: restarted' : `the gateway was Disconnected while LND answers; the restart failed: ${r.why}`);
    return r.ok ? { ok: true, did: 'gateway-restart' } : { ok: false, why: `the gateway restart failed: ${r.why}` };
  }
  async function tick() {
    const s = state.read();
    const watched = await gatewayWatch(s);
    if (watched) return watched;
    // A QUICK TUNNEL'S NEW NAME, followed first (kanban #562): the seat then answers at it and announces it itself, off chain
    // (address-book.js; 2026-10-21 "1 default, 2 for updates so no needed updates" - no advertisement update for an address)
    if (s.reach && s.reach.mode === 'quick') {
      // A DEAD ONE IS RESTARTED FIRST (kanban #1120): its new name is followed on the next pass
      const d = await reviveTunnel().catch((e) => ({ dead: false, why: e.message }));
      if (d && d.dead) { log(d.restarted ? 'the quick tunnel was dead (Tunnel not found): restarted for a new name' : `the quick tunnel is dead (Tunnel not found); the restart failed: ${d.why}`); return d.restarted ? { ok: true, did: 'tunnel-revive' } : { ok: false, why: `the dead tunnel's restart failed: ${d.why}` }; }
      const t = await followTunnel().catch((e) => ({ url: null, restarted: [], why: e.message }));
      if (t && t.restarted && t.restarted.length) { log(`the quick tunnel came back as ${t.url}: ${t.restarted.join(', ')} restarted`); return { ok: true, did: 'tunnel-name', url: t.url, restarted: t.restarted }; }
    }
    // A LIQUIDITY PROVIDER'S DEPOSIT (§23A.10): 5 x L on testnet4 from the node's wallet into LND's, once - the provider
    // service (bin/liquidity-provider.mjs) opens channels from it
    // A DEPOSIT THAT CANNOT BE PAID YET DOES NOT HOLD UP CUSTODY (kanban #495, measured 2026-10-21 09:32Z on installer node 4003758b, a
    // custody and liquidity node drawn into founding e8741283: "the wallet holds 312380 sat: sending 500000 sat needs 500232 sat" returned
    // on every tick, before guardian_of - its guardian seat would never have been published, its gateway never joined)
    const custodyToo = (s.roles || []).includes('custody');
    if ((s.roles || []).includes('liquidity') && s.lightning && s.lightning.pubkey && !(s.custody || {}).liquidityFund) {
      let waits = null;
      const f = await lnd.funds(s.lightning);
      if (!f.ok) waits = `the liquidity deposit waits for LND: ${f.why}`;
      // a custody node's peg-in comes first (kanban #567: a node that becomes a provider from its owner page while it waits for its federation)
      else if (custodyToo && (s.custody || {}).pegInSats && !(s.custody || {}).pegIn) waits = 'the liquidity deposit waits until the gateway\'s peg-in is sent';
      else {
        const deposit = Number(LIQUIDITY_TERMS.testnet4.depositSats);
        const w0 = walletOf(fromHex(state.readSecret('seed.hex')));
        const { coins } = await chainKit.coinsOf(s.chain, w0.spk);
        let tx = null;
        try { tx = buildSend({ wallet: w0, coins, script: addressScript(f.address), sats: deposit }); }
        catch (e) { waits = `the liquidity deposit is not sent yet: ${e.message}`; }
        if (tx) {
          const txid = await chainKit.broadcast(s.chain, tx.hex);
          state.merge('custody', { liquidityFund: { address: f.address, sats: deposit, txid, atMs: nowMs() } });
          log(`liquidity deposit: ${deposit} sat to LND (${txid})`);
          return { ok: true, did: 'liquidity-fund', txid };
        }
      }
      if (!custodyToo) return { ok: false, why: waits };
      log(`${waits} - custody goes on`);
    }
    if (!(s.roles || []).includes('custody')) return { ok: true, idle: (s.roles || []).includes('liquidity') ? 'liquidity provider: deposit sent; the provider service opens the channels' : 'no custody role' };
    const g = guardianOfEntry(state.path('node.db.guardian'));
    if (!g) return { ok: true, idle: 'the guardian waits to be drawn (no federation founded yet)' };
    const c = s.custody || {};
    const seed = fromHex(state.readSecret('seed.hex'));
    const w = walletOf(seed);
    // 1. guardian_of[] in the node's advertisement
    if (!c.guardianOf || c.guardianOf.federationId !== g.federationId) {
      if (!s.bond || !s.bond.txid) return { ok: false, why: 'the node has no bond to update' };
      const { coins } = await chainKit.coinsOf(s.chain, w.spk);
      const nodeSecret = nodeSecretOf();
      const { schnorr } = await import('@noble/curves/secp256k1.js');
      const advert = { ...advertFor({ hostedGames: s.hostedGames, hostGroup: s.hostGroup, nodeKey: schnorr.getPublicKey(nodeSecret), operatorId: `op-${s.owner.pubkey.slice(0, 12)}`, roles: s.roles, endpoint: s.reach.url,
        payoutPubkey: payoutKeyOf(seed), maturity: s.bond.maturity, softwareHash: commitOf(), guardianEndpoint: (guardianSetupOf(s, { release }) || {}).endpoint || null,
        ...(s.bond.censusKey ? { censusKey: fromHex(s.bond.censusKey) } : {}),
        // THE EMERGENCY KEY KEPT (§23A.5a): the census reads a node's newest advertisement, and an update without the key left a guardian
        // unable to leave by its emergency code ("that node's advertisement names no emergency key") - the guardians it exists for
        emergencyPubkey: EMERGENCY_IN_ADVERT ? fromHex(emergencyOf(seed).pubkey) : null }),
        guardianOf: [{ federationId: fromHex(g.federationId), guardianKey: fromHex(g.guardianKey) }] };
      let u;
      try { u = buildAdvertUpdate({ wallet: w, nodeSecret, coins, bond: { txid: s.bond.txid, vout: s.bond.vout || 0 }, advert }); }
      catch (e) { return { ok: false, why: `guardian_of not published yet: ${e.message}` }; }
      await chainKit.broadcast(s.chain, u.funding.hex);
      const txid = await chainKit.broadcast(s.chain, u.update.hex);
      state.save({ custody: { ...c, guardianOf: { federationId: g.federationId, txid, advertId: u.advertId, atMs: Date.now() } } });
      log(`guardian_of ${g.federationId.slice(0, 16)} published: ${txid}`);
      return { ok: true, did: 'guardian_of', txid };
    }
    // 2. the gateway joins its own federation
    if (s.gateway && !(s.gateway.federations || []).some((f) => f.federationId === g.federationId)) {
      const j = await gw.joinFederation({ ...s.gateway, invite: g.invite });
      if (!j.ok) return { ok: false, why: `the gateway did not join yet: ${j.why}` };
      const t = await gw.testGateway(s.gateway);
      state.merge('gateway', { federations: t.ok ? t.federations : [{ federationId: g.federationId }] });
      log(`gateway joined ${g.federationId.slice(0, 16)}`);
      return { ok: true, did: 'join' };
    }
    // 3. the peg-in set aside for the gateway's e-cash
    // per federation (kanban #577): a node whose federation was retired founds the next, whose gateway needs its own peg-in
    if (s.gateway && c.pegInSats && (!c.pegIn || c.pegIn.federationId !== g.federationId)) {
      // GATEWAYS KEEP THE CAP TOO (kanban #1093 part 6): no peg-in into a federation at load >= 1, as a client refuses a deposit; a seated
      // gateway that pegs in past it is unseated. Unknown load: wait, never guess
      const l = await loadOf(s, g.federationId);
      if (!l) return { ok: false, why: 'the peg-in waits: this node\'s seat does not say the federation\'s load yet' };
      if (pegInPastCap(l)) return { ok: false, why: `the peg-in waits: the federation is at load ${l.load ?? '>= 1'}, at or past its cap - a gateway that pegs in past it loses its seat` };
      const a = await gw.depositAddress({ ...s.gateway, federationId: g.federationId });
      if (!a.ok) return { ok: false, why: a.why };
      const { coins } = await chainKit.coinsOf(s.chain, w.spk);
      let tx;
      try { tx = buildSend({ wallet: w, coins, script: addressScript(a.address), sats: c.pegInSats }); }
      catch (e) { return { ok: false, why: `peg-in not sent yet: ${e.message}` }; }
      const txid = await chainKit.broadcast(s.chain, tx.hex);
      state.merge('custody', { pegIn: { federationId: g.federationId, address: a.address, sats: c.pegInSats, txid, atMs: Date.now() } });
      log(`peg-in of ${c.pegInSats} sat to ${a.address}: ${txid}`);
      return { ok: true, did: 'peg-in', txid };
    }
    // 4. the gateway seat (§23A.9): the node stands for one with a claim its seat serves (GET /gateway-claim) - its gateway's public address,
    // its Lightning key, its public channel capacity and its peg-in - signed by the node key, renewed every hour
    if (s.gateway && s.gateway.publicUrl && /^https?:\/\/\S+\/$/.test(s.gateway.publicUrl) && c.pegIn && s.lightning && s.lightning.pubkey) {
      const claimFile = state.path('gateway-claim.json');
      const last = (state.read().custody || {}).claimAtMs || 0;
      // AT ONCE WHEN ITS ADDRESS MOVED (2026-10-30, a quick tunnel's new name: "das darf nicht auftreten"): a claim naming the old host points
      // every player at a gateway that is gone, for up to the hour otherwise
      let claimedUrl = null; try { claimedUrl = JSON.parse(readFileSync(claimFile, 'utf8')).gatewayUrl; } catch { claimedUrl = null; }
      if (nowMs() - last >= 3600000 || (claimedUrl && claimedUrl !== s.gateway.publicUrl)) {
        const ch = await channels(s.lightning);
        // inbound from OUTSIDE the federation is what takes deposits from the wider network; the ring's channels do not count for it
        const inside = new Set(((await membersOf(s)) || []).map((m) => m.lightningPubkey));
        const outsideIn = ch.ok ? ch.open.filter((x) => x.public && x.active && !inside.has(x.peer)).reduce((a, x) => a + (x.remoteSats || 0), 0) : 0;
        const { schnorr } = await import('@noble/curves/secp256k1.js');
        const nodeSecret = nodeSecretOf();
        const claim = signGatewayClaim({ node: Buffer.from(schnorr.getPublicKey(nodeSecret)).toString('hex'), federationId: g.federationId, gatewayUrl: s.gateway.publicUrl,
          lightningPubkey: s.lightning.pubkey, capacitySats: ch.ok ? ch.publicCapacitySats : 0, pegInSats: c.pegIn.sats, atMs: nowMs(),
          inboundSats: ch.ok ? ch.inboundSats || 0 : 0, outboundSats: ch.ok ? ch.outboundSats || 0 : 0, outsideInboundSats: outsideIn, lightningAddr: await lightningAddrOf(s) }, (h) => schnorr.sign(h, nodeSecret));
        writeFileSync(claimFile, JSON.stringify(claim, null, 2) + '\n');
        state.merge('custody', { claimAtMs: nowMs() });
        log(`gateway seat claimed: inbound ${claim.inboundSats} sat (${claim.outsideInboundSats} from outside the federation), outbound ${claim.outboundSats} sat, peg-in ${claim.pegInSats} sat`);
        return { ok: true, did: 'gateway-claim' };
      }
    }
    // 5. THE OUTSIDE CHANNEL: one channel to a hub outside the federation (LIGHTNING_HUBS), dialled at its address (an onion: over Tor)
    if (s.gateway && s.lightning && s.lightning.pubkey && c.pegIn && hubs.length) {
      const ch0 = await channels(s.lightning);
      const hubKeys = hubs.map((u) => u.split('@')[0]);
      const toHub = ch0.ok && [...ch0.open, ...ch0.pending].some((x) => hubKeys.includes(x.peer));
      if (!toHub) {
        const f = await lnd.funds(s.lightning);
        if (!f.ok) return { ok: false, why: `the outside channel waits for LND: ${f.why}` };
        if (f.onchainSats < OUTSIDE_SATS + 1000) {
          if (c.outsideFund) return { ok: true, idle: `the outside channel's ${OUTSIDE_RESERVE_SATS} sat are on their way to LND (${c.outsideFund.txid})` };
          const { coins } = await chainKit.coinsOf(s.chain, w.spk);
          let tx;
          try { tx = buildSend({ wallet: w, coins, script: addressScript(f.address), sats: OUTSIDE_RESERVE_SATS }); }
          catch (e) { return { ok: false, why: `the outside channel is not funded yet: ${e.message}` }; }
          const txid = await chainKit.broadcast(s.chain, tx.hex);
          state.merge('custody', { outsideFund: { address: f.address, sats: OUTSIDE_RESERVE_SATS, txid, atMs: nowMs() } });
          log(`outside channel funds: ${OUTSIDE_RESERVE_SATS} sat to LND (${txid})`);
          return { ok: true, did: 'outside-fund', txid };
        }
        const [pubkey, host] = hubs[0].split('@');
        const k = await lnd.connect(s.lightning, { pubkey, host });
        if (!k.ok) return { ok: false, why: `the outside hub did not answer at ${host}: ${k.why}` };
        const o = await lnd.openTo(s.lightning, { pubkey, sats: OUTSIDE_SATS });
        if (!o.ok) return o;
        state.merge('custody', { outside: { pubkey, sats: OUTSIDE_SATS, fundingTxid: o.fundingTxid, atMs: nowMs() } });
        log(`outside channel of ${OUTSIDE_SATS} sat to ${pubkey.slice(0, 12)}…: ${o.fundingTxid}`);
        return { ok: true, did: 'outside-channel', txid: o.fundingTxid };
      }
    }
    // 6. THE CHANNEL RING (2026-10-18, "1 and 2": the installer's LND had no inbound liquidity, so its gateway could take no deposit):
    // the federation's custody nodes in node-key order, each opens one channel of RING_SATS to the next - every gateway then has one
    // channel out (payouts) and one in (deposits), made by the federation's own nodes. The opener dials the next one's announced address;
    // a node nobody can dial (behind a tunnel) dials its previous neighbour instead, and that one opens over the connection it made.
    if (s.gateway && s.lightning && s.lightning.pubkey && c.pegIn) {
      const members = ((await membersOf(s)) || []).filter((m) => /^0[23][0-9a-f]{64}$/.test(m.lightningPubkey || '')).sort((a, b) => (a.node < b.node ? -1 : 1));
      const me = members.findIndex((m) => m.lightningPubkey === s.lightning.pubkey);
      if (me < 0 || members.length < 2) return { ok: true, idle: `the channel ring waits for the federation's other gateways (${members.length} known)` };
      const next = members[(me + 1) % members.length], prev = members[(me - 1 + members.length) % members.length];
      const ch = await channels(s.lightning);
      const has = (pk) => ch.ok && [...ch.open, ...ch.pending].some((x) => x.peer === pk);
      const peers = await lnd.peers(s.lightning);
      // to the previous neighbour: dial it (once connected, it stays), so it can open its ring channel to us even when nobody can dial this node
      if (!has(prev.lightningPubkey) && prev.lightningAddr && peers.ok && !peers.peers.includes(prev.lightningPubkey) && prev.lightningPubkey !== next.lightningPubkey)
        await lnd.connect(s.lightning, { pubkey: prev.lightningPubkey, host: prev.lightningAddr });
      // THE RING REPAIRED WHEN A NODE JOINS OR LEAVES (2026-10-18: "When a node joins an existing federation it needs incoming
      // liquidity too"): this node's ring channel goes to a node that is no longer its next. When X joins between A and B, X opens to B
      // with its own coins; once X shows that outbound, A closes its old channel to B and opens to X with the same coins - everyone
      // again has one channel in and one out, and the joiner pays only its own. A channel to a node that left is closed at once.
      const old = c.ring && c.ring.lightningPubkey !== next.lightningPubkey ? (ch.ok ? ch.open : []).find((x) => x.peer === c.ring.lightningPubkey) : null;
      if (old && !has(next.lightningPubkey)) {
        const stillMember = members.some((m) => m.lightningPubkey === c.ring.lightningPubkey);
        const settled = Number(next.outboundSats || 0) >= RING_SATS * 0.9;
        if (stillMember && !settled) return { ok: true, idle: `the ring waits for the new member ${next.node.slice(0, 12)}… to open its own channel before this one moves to it` };
        const k = await lnd.close(s.lightning, { channelPoint: old.channelPoint });
        if (!k.ok) return { ok: false, why: `the old ring channel did not close: ${k.why}` };
        state.merge('custody', { ring: { ...c.ring, closing: old.channelPoint, closingAtMs: nowMs() } });
        log(`ring moves to ${next.node.slice(0, 12)}…: closing the channel to ${c.ring.next.slice(0, 12)}… (${old.channelPoint})`);
        return { ok: true, did: 'ring-close', channelPoint: old.channelPoint };
      }
      if (!has(next.lightningPubkey)) {
        const f = await lnd.funds(s.lightning);
        if (!f.ok) return { ok: false, why: `the ring waits for LND: ${f.why}` };
        if (f.onchainSats < RING_SATS + 1000) {
          if (c.ringFund) return { ok: true, idle: c.ring ? `the ring channel's coins are on their way back to LND (the old channel closing)` : `the ring channel's ${RING_RESERVE_SATS} sat are on their way to LND (${c.ringFund.txid})` };
          const { coins } = await chainKit.coinsOf(s.chain, w.spk);
          let tx;
          try { tx = buildSend({ wallet: w, coins, script: addressScript(f.address), sats: RING_RESERVE_SATS }); }
          catch (e) { return { ok: false, why: `the ring channel is not funded yet: ${e.message}` }; }
          const txid = await chainKit.broadcast(s.chain, tx.hex);
          state.merge('custody', { ringFund: { address: f.address, sats: RING_RESERVE_SATS, txid, atMs: nowMs() } });
          log(`ring channel funds: ${RING_RESERVE_SATS} sat to LND (${txid})`);
          return { ok: true, did: 'ring-fund', txid };
        }
        const connected = peers.ok && peers.peers.includes(next.lightningPubkey);
        if (!connected) {
          if (!next.lightningAddr) return { ok: true, idle: `the ring waits for ${next.node.slice(0, 12)}… to connect (its LND takes no connections)` };
          const k = await lnd.connect(s.lightning, { pubkey: next.lightningPubkey, host: next.lightningAddr });
          if (!k.ok) return { ok: false, why: `the ring's next node did not answer at ${next.lightningAddr}: ${k.why}` };
        }
        const o = await lnd.openTo(s.lightning, { pubkey: next.lightningPubkey, sats: RING_SATS });
        if (!o.ok) return o;
        state.merge('custody', { ring: { next: next.node, lightningPubkey: next.lightningPubkey, sats: RING_SATS, fundingTxid: o.fundingTxid, atMs: nowMs() } });
        log(`ring channel of ${RING_SATS} sat to ${next.node.slice(0, 12)}…: ${o.fundingTxid}`);
        return { ok: true, did: 'ring-channel', txid: o.fundingTxid };
      }
    }
    return { ok: true, idle: 'custody is set up: guardian_of published, the gateway serves the federation, the peg-in sent, the gateway seat claimed, the outside and the ring channel open' };
  }
  return { tick };
}
