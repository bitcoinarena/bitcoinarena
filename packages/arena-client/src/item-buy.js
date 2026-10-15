// AN IN-GAME ITEM, BOUGHT FROM THE PAGE (kanban #365 step 5; #369's larger truck the first): the player's wallet pays the item's split
// in one federation transaction, the player signs the record, and the seats keep it as the player's for good.
//
//   1. WHO SERVED: every seat's signed FINALs of the 24 h before now (GET /served?finals=1), merged by round and each FINAL checked
//      here (served-nodes.js) - the same list every seat rebuilds when it checks the purchase.
//   2. THE SPLIT: purchaseOutputs over the item's price, those nodes and the two donation sets (purchase.js).
//   3. THE PAYMENT: the lock client's paySubmit (one transaction of pre-expired payout contracts, the buyer's key as their image),
//      its acceptance read back output by output (lockAccepted).
//   4. THE RECORD: the game, the item, the price, the buyer, the federation, the transaction, every output and the served list,
//      signed with the player's key, handed to a seat (POST /item-purchase), which hands it on to every other.
// No float touches an amount; every step that fails says which, and nothing is paid before the list and the split stand.
import { servedNodes, mergeServedRounds, SERVED_WINDOW_MS } from '../../arena-protocol/src/served-nodes.js';
import { purchaseOutputs, purchaseId, encodePurchase } from '../../arena-protocol/src/purchase.js';
import { itemOf } from '../../arena-protocol/src/items.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

/** The served list of the 24 h before `toMs`, from every seat that answers. Answers { ok, served, seats } or { ok: false, why }. */
export async function servedFromSeats({ seats, toMs, fetch, verify, timeoutMs = 15000 }) {
  const fromMs = BigInt(toMs) - BigInt(SERVED_WINDOW_MS);
  const held = [];
  await Promise.all((seats || []).map(async (s) => {
    try {
      const r = await fetch(`${String(s).replace(/\/$/, '')}/served?to=${toMs}&finals=1`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return;
      const a = await r.json();
      held.push((a.held || []).map((x) => ({ roundId: fromHex(x.roundId), committee: x.committee.map(fromHex), finals: x.finals.map(fromHex) })));
    } catch { /* a seat that does not answer adds nothing */ }
  }));
  if (!held.length) return { ok: false, why: 'no seat answered who served a round in the last 24 hours' };
  const served = servedNodes({ rounds: mergeServedRounds(held).rounds, fromMs, toMs: BigInt(toMs), verify });
  if (!served.nodes.length) return { ok: false, why: 'no node served a round in the last 24 hours: the nodes\' half has nobody to go to' };
  return { ok: true, served, seats: held.length };
}

/**
 * BUY ONE ITEM. `manifest` the game's (it sells `itemId`); `networkSet` / `gameSet` the donation sets (paying keys); `wallet` the
 * player's lock client in the federation `federationId` (hex); `player` { pubkey (32 bytes), sign(digest) -> 64-byte BIP340 };
 * `seats` the game's seats; `verify` BIP340. Answers { ok, purchaseId, txid, priceSat, outputs, keptBy } or { ok: false, step, why }.
 */
export async function buyItem({ manifest, itemId, networkSet, gameSet, wallet, federationId, player, seats, fetch, verify, nowMs = () => Date.now() }) {
  const no = (step, why) => ({ ok: false, step, why });
  const item = itemOf(manifest, itemId);
  if (!item) return no('item', `"${manifest && manifest.gameName}" sells no item "${itemId}"`);
  const toMs = BigInt(nowMs() - 60000);                     // a minute back: the newest FINALs have reached every seat
  const got = await servedFromSeats({ seats, toMs, fetch, verify });
  if (!got.ok) return no('served', got.why);
  let built;
  try { built = purchaseOutputs({ priceSat: item.priceSat, servedKeys: got.served.nodes.map((n) => n.key), networkSet, gameSet }); }
  catch (e) { return no('split', e.message); }
  let submitted, accepted;
  try {
    submitted = JSON.parse(await wallet.paySubmit(JSON.stringify(built.outputs.map((o) => ({ pk: toHex(o.pk), msat: String(o.msat), image: toHex(player.pubkey) })))));
    accepted = JSON.parse(await wallet.lockAccepted(JSON.stringify(submitted)));
  } catch (e) { return no('payment', String(e && e.message || e)); }
  const outs = accepted.donations || [];
  if (outs.length !== built.outputs.length || !outs.every((d) => d.ids_match)) return no('payment', 'the federation does not hold the outputs as they were built');
  const record = { gameDevPubkey: manifest.gameDevPubkey, gameName: manifest.gameName, itemId, priceSat: item.priceSat, playerPubkey: player.pubkey,
    federationId: fromHex(federationId), txid: fromHex(submitted.txid), servedFromMs: got.served.fromMs, servedToMs: got.served.toMs, servedRoot: fromHex(got.served.root),
    outputs: outs.map((d) => ({ outIdx: Number(d.out_idx), pk: fromHex(d.recipient_pk), msat: BigInt(d.amount_msat) })), boughtAtMs: BigInt(nowMs()) };
  const signature = player.sign(purchaseId(record));
  const body = JSON.stringify({ purchase: toHex(encodePurchase(record)), signature: toHex(signature) });
  // HANDED TO THE FIRST SEAT THAT KEEPS IT: it checks the record and the federation, then hands it on to every other seat
  let keptBy = null, last = 'no seat to hand it to';
  for (const s of seats || []) {
    try {
      const r = await fetch(`${String(s).replace(/\/$/, '')}/item-purchase`, { method: 'POST', body, signal: AbortSignal.timeout(60000) });
      if (r.ok) { keptBy = s; break; }
      last = `${s}: ${r.status} ${(await r.text()).trim().slice(0, 200)}`;
    } catch (e) { last = `${s}: ${e.message}`; }
  }
  if (!keptBy) return { ok: false, step: 'record', why: `paid (transaction ${submitted.txid}), but no seat kept the record yet: ${last}`, purchaseId: toHex(purchaseId(record)), txid: submitted.txid,
    retry: body };
  return { ok: true, purchaseId: toHex(purchaseId(record)), txid: submitted.txid, priceSat: item.priceSat, outputs: outs.length, keptBy };
}

/** THE ITEMS A PLAYER OWNS, from the first seat that answers (GET /items): [{ id, gameName, itemId, ... }]. */
export async function ownedItems({ seats, player, gameName = null, fetch }) {
  for (const s of seats || []) {
    try {
      const r = await fetch(`${String(s).replace(/\/$/, '')}/items?player=${toHex(player)}${gameName ? `&game=${encodeURIComponent(gameName)}` : ''}`, { signal: AbortSignal.timeout(15000) });
      if (r.ok) return (await r.json()).items || [];
    } catch { /* the next seat */ }
  }
  return [];
}
