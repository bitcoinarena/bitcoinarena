// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEATED GUARDIAN PUBLISHES ITS COPY OF A HALTED FEDERATION'S SPENT-NOTE SET (§23A.5 liquidation step 1): "The
// guardians still seated publish, signed, their copy of the federation's spent-note set (the nonces the consensus has already
// redeemed) as of the last session they hold."
//
// The node runs its guardian (§23A.2), so it asks it, as the guardian's admin, directly over the guardian's socket (`endpoint`;
// see produceSpentSet) or else through a fedimint-cli client, at the fork's admin endpoint
// `blwp_spent_nonces` of its MINTV2 module (tools/fedimint-spent-nonces.patch; our federations run mintv2, not mint) and the public `session_count` - both over a client of that federation:
//   fedimint-cli --data-dir <client> dev api blwp_spent_nonces null --module mintv2 --peer-id <own id> --password <admin password>
//   fedimint-cli --data-dir <client> dev api session_count null --peer-id <own id>
// The guardian's id is its config's `identity` (local.json), its password the `admin-password` beside it. The copy is signed with
// the node key (spent-set.js signSpentSet) and posted to every seat's POST /liquidations/spent-set, its own included.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { schnorr } from '@noble/curves/secp256k1.js';
import { encodeSpentSet, signSpentSet } from '../../arena-protocol/src/spent-set.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { wsGuardianCall } from './halts.js';

// the guardian's password never in a reason (an exec error's message is the whole command line, --password with it)
const runCli = (bin, args, env) => new Promise((done) => execFile(bin, args, { timeout: 120000, maxBuffer: 1 << 26, env },
  (err, out, errOut) => done({ ok: !err, out: String(out), err: String(errOut || (err && err.message) || '').replace(/(--password[ =])\S+/g, '$1<hidden>') })));

/** What `dev api` printed: the JSON value, or its `value` field where the CLI wraps it. */
const valueOf = (out) => { const j = JSON.parse(out); return j && typeof j === 'object' && !Array.isArray(j) && 'value' in j ? j.value : j; };

/**
 * THE COPY. `guardianDir` this node's guardian data dir; `clientDir` a fedimint-cli client of the federation; `federationId` hex;
 * `nodeSecret` 32 bytes. Answers { ok, copy: { spentSet hex, signature hex }, session, nonces } or why not.
 */
export async function produceSpentSet({ guardianDir, clientDir = null, endpoint = null, cli = 'fedimint-cli', federationId, nodeSecret, mintModule = 'mintv2', run = runCli, call = wsGuardianCall, env = process.env }) {
  let peer, password;
  try { peer = JSON.parse(readFileSync(join(guardianDir, 'local.json'), 'utf8')).identity; password = readFileSync(join(guardianDir, 'admin-password'), 'utf8').trim(); }
  catch (e) { return { ok: false, why: `this node's guardian config is not readable: ${e.message}` }; }
  if (!Number.isInteger(peer)) return { ok: false, why: 'the guardian config names no identity' };
  let nonces, sessions;
  if (endpoint) {
    // ITS OWN GUARDIAN, ASKED DIRECTLY over the guardian's socket (kanban #326, rehearsal 17, 2026-10-23 01:4xZ): a client of a halted
    // federation can no longer be joined - T2's config download failed on its two missing guardians - and a halted federation is the
    // only one a spent set is for. The mint module's instance id is read from the guardian's own client config.
    let id;
    try { const mods = JSON.parse(readFileSync(join(guardianDir, 'client.json'), 'utf8')).modules || {};
      id = Object.keys(mods).find((k) => String((mods[k] && (mods[k].kind || (mods[k].config && mods[k].config.kind))) || '') === mintModule); }
    catch (e) { return { ok: false, why: `this node's guardian client config is not readable: ${e.message}` }; }
    if (id === undefined) return { ok: false, why: `the guardian's federation has no ${mintModule} module` };
    try { nonces = await call(endpoint, `module_${id}_blwp_spent_nonces`, { auth: password }); }
    catch (e) { return { ok: false, why: `the guardian did not answer its spent nonces: ${String(e.message).slice(0, 200)}` }; }
    try { sessions = await call(endpoint, 'session_count'); }
    catch (e) { return { ok: false, why: `the guardian did not answer its session count: ${String(e.message).slice(0, 200)}` }; }
    try { nonces = nonces.map((h) => fromHex(String(h))); sessions = Number(sessions); }
    catch (e) { return { ok: false, why: `the guardian's answer did not read: ${e.message}` }; }
  } else {
    const base = ['--data-dir', clientDir, 'dev', 'api'];
    const n = await run(cli, [...base, 'blwp_spent_nonces', 'null', '--module', mintModule, '--peer-id', String(peer), '--password', password], env);
    if (!n.ok) return { ok: false, why: `the guardian did not answer its spent nonces: ${(n.err || n.out).trim().split('\n').pop().slice(0, 200)}` };
    const c = await run(cli, [...base, 'session_count', 'null', '--peer-id', String(peer)], env);
    if (!c.ok) return { ok: false, why: `the guardian did not answer its session count: ${(c.err || c.out).trim().split('\n').pop().slice(0, 200)}` };
    try { nonces = valueOf(n.out).map((h) => fromHex(String(h))); sessions = Number(valueOf(c.out)); }
    catch (e) { return { ok: false, why: `the guardian's answer did not read: ${e.message}` }; }
  }
  if (nonces.some((x) => x.length !== 33)) return { ok: false, why: 'a nonce the guardian named is not 33 bytes' };
  if (!Number.isInteger(sessions) || sessions < 1) return { ok: false, why: 'the guardian has finished no session' };
  // AS OF THE LAST SESSION IT HOLDS: the session count names the next one, so the last finished is one less
  const s = signSpentSet({ federationId: fromHex(federationId), session: sessions - 1, nonces, signer: schnorr.getPublicKey(nodeSecret) },
    (m) => schnorr.sign(m, nodeSecret));
  return { ok: true, session: s.session, nonces: s.nonces.length, copy: { spentSet: toHex(encodeSpentSet(s)), signature: toHex(s.signature) } };
}

/** Posts a copy to every seat (bases) - answers [{ seat, ok, why }]. */
export async function publishSpentSet(copy, seats, { fetcher = fetch } = {}) {
  return Promise.all((seats || []).map(async (u) => {
    try {
      const r = await fetcher(`${String(u).replace(/\/+$/, '')}/liquidations/spent-set`, { method: 'POST', body: JSON.stringify(copy), signal: AbortSignal.timeout(20000) });
      return { seat: u, ok: r.ok, why: r.ok ? null : (await r.text()).slice(0, 160) };
    } catch (e) { return { seat: u, ok: false, why: e.message }; }
  }));
}
