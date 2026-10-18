// THE CUSTODY AGENT (kanban #471 slice 5 part 4; the owner 2026-10-18: "4. It should happen automatically"): on a custody node, what
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
import { advertFor, buildAdvertUpdate, buildSend } from './bond.js';
import { joinFederation, testGateway, depositAddress } from './gateway.js';
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

export function createCustodyAgent({ state, release, chainKit = { coinsOf, broadcast }, gw = { joinFederation, testGateway, depositAddress }, log = () => {} }) {
  const nodeSecretOf = () => {
    const db = new DatabaseSync(state.path('node.db'), { readOnly: true });
    try { return new Uint8Array(db.prepare('SELECT secret FROM identity WHERE one = 0').get().secret); } finally { db.close(); }
  };
  const commitOf = () => { try { return sha256(readFileSync(join(release, 'COMMIT'))); } catch { return new Uint8Array(32); } };
  async function tick() {
    const s = state.read();
    if (!(s.roles || []).includes('custody')) return { ok: true, idle: 'no custody role' };
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
      const advert = { ...advertFor({ nodeKey: schnorr.getPublicKey(nodeSecret), operatorId: `op-${s.owner.pubkey.slice(0, 12)}`, roles: s.roles, endpoint: s.reach.url,
        payoutPubkey: payoutKeyOf(seed), maturity: s.bond.maturity, softwareHash: commitOf(), guardianEndpoint: (guardianSetupOf(s, { release }) || {}).endpoint || null }),
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
      state.save({ gateway: { ...state.read().gateway, federations: t.ok ? t.federations : [{ federationId: g.federationId }] } });
      log(`gateway joined ${g.federationId.slice(0, 16)}`);
      return { ok: true, did: 'join' };
    }
    // 3. the peg-in set aside for the gateway's e-cash
    if (s.gateway && c.pegInSats && !c.pegIn) {
      const a = await gw.depositAddress({ ...s.gateway, federationId: g.federationId });
      if (!a.ok) return { ok: false, why: a.why };
      const { coins } = await chainKit.coinsOf(s.chain, w.spk);
      let tx;
      try { tx = buildSend({ wallet: w, coins, script: addressScript(a.address), sats: c.pegInSats }); }
      catch (e) { return { ok: false, why: `peg-in not sent yet: ${e.message}` }; }
      const txid = await chainKit.broadcast(s.chain, tx.hex);
      state.save({ custody: { ...state.read().custody, pegIn: { federationId: g.federationId, address: a.address, sats: c.pegInSats, txid, atMs: Date.now() } } });
      log(`peg-in of ${c.pegInSats} sat to ${a.address}: ${txid}`);
      return { ok: true, did: 'peg-in', txid };
    }
    return { ok: true, idle: 'custody is set up: guardian_of published, the gateway serves the federation, the peg-in sent' };
  }
  return { tick };
}
