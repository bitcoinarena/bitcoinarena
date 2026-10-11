// THE ARBITRATION SET, AS A SERVICE (kanban #307, spec 5A.3B "From proof to transaction" steps 1-5). Disjoint from every
// round committee and from settlement: it touches bonds only, never a player stake, a round or a result.
//
// Until this the seats FILED slash proofs (verify.js fileSlashProofs) and said what one would owe (slash-owing.js), and
// arbitration-tx.js could BUILD a path B spend - and nothing ever signed or posted one. Here:
//   1. INTAKE: a filed proof, its evidence (the accused node's own signed result), the objection bundle that held against
//      that result, the entry and the round - read from a seat, believed for nothing.
//   2. THE ONE JUDGEMENT, MADE HERE: the bundle is checked and REPLAYED again with the round's core under the round's
//      beacon (checkObjectionBundle, the function a seat's objection door runs) - it must contradict exactly the result
//      the proof names - and the accused's signature over that result is verified. Then slashHolds' comparisons:
//      committee member, same round/player/transcript, the bond the node's own advertisement names.
//   3. slash_height: at or below the tip, at or above the round's census height (slashHeightIsValid); the distribution
//      from the census at that height (slashDistribution): players' escrow, nodes, developers.
//   4. THE TRANSACTION: path B of the bond, nLockTime = slash_height, OP_RETURN = H(proof) || slash_height || hint,
//      three outputs (arbitrationSpend). Each member signs the leaf's sighash on its own (BIP-342 CHECKSIGADD: k plain
//      BIP-340 signatures, no MuSig on this path).
//   5. Fewer than k signatures is never posted; k or more is checked by testmempoolaccept and only then broadcast.
// The nodes' and developers' outputs go to the arbitration escrow too (k-of-m), to be paid on by the same set: the spec
// names who is paid, not the script (arbitration-tx.js) - and the federation step (pegin) waits for the stake-lock tool.
import { schnorr } from '@noble/curves/secp256k1.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { slashHolds, slashProofId, slashHeightIsValid, slashDistribution, splitSlashEvidence, REPLAY_CONTRADICTS } from '../../arena-protocol/src/slash.js';
import { splitSignedResult, decodePlayerResult, resultId } from '../../arena-protocol/src/result.js';
import { arbitrationSpend, arbitrationSighash, arbitrationWitness, arbitrationTransaction, escrowOutput, escrowSpend } from '../../arena-protocol/src/arbitration-tx.js';
import { bondOutputKey, bondInternalKey, slashLeaf, tapLeafHash, controlBlockFor, bondMaturityOf } from '../../arena-protocol/src/bond-script.js';
import { decodeObjectionBundle } from '../../arena-protocol/src/objection.js';
import { transcriptHash, decodeTranscript } from '../../arena-protocol/src/transcript.js';
import { checkObjectionBundle } from './objection-check.js';
import { runId } from './verdict.js';
import { tweakPoint, combine } from './curve.js';
import { nonceGen, bondSigningContext, bondPartialSign, MusigError } from './musig2.js';
import { pluginForRound, hostedPlugins } from './plugins.js';

/** THE ROUND'S CORE, as a seat's verifier resolves it (verify.js #coreOf): its plugin's, with the round's world rule. */
export function coreForRound(contract, roundIdBytes, plugins) {
  const found = pluginForRound(contract, hostedPlugins(plugins));
  return found.ok ? { ...found.core, config: found.config, runTicks: found.runTicks,
    world: { configHash: contract.configHash, censusRoot: contract.censusRoot, roundId: new Uint8Array(roundIdBytes), sharedWorld: [...found.plugin.sharedWorld] } } : null;
}

/**
 * THE MEMBERS OF A TEST NETWORK'S ARBITRATION SET: on regtest and testnet4 the secrets are derivable by anyone, by design
 * (genesis-ids.js), so this service may hold all of them - each its own signer. Mainnet has no set: real keys held by
 * real people are a ruling, not a derivation, and this refuses rather than invents one.
 */
export function arbitrationMembers(network) {
  const chain = { regtest: 'bitcoin-regtest', testnet4: 'bitcoin-testnet4' }[network];
  if (!chain) throw new Error(`${network} has no arbitration set this service may hold`);
  const g = genesisFor(network);
  const members = [];
  for (let i = 0; i < g.arbitrationM; i++) {
    const secret = taggedHash('BLWP/v1/TestArbitration', new TextEncoder().encode(`${chain}:${i}`));
    members.push({ index: i, secret, key: schnorr.getPublicKey(secret) });
  }
  const want = g.arbitrationKeys.map(toHex).sort().join(',');
  if (members.map((m) => toHex(m.key)).sort().join(',') !== want) throw new Error(`the derived keys are not ${network}'s arbitration set`);
  return { members, keys: g.arbitrationKeys, k: g.arbitrationK, network };
}

/**
 * THE JUDGEMENT. `evidence` is a seat's slash-proof record (proof || the accused's signed result); `bundle` the objection
 * that held against that result; `entry` its signed entry contract (decoded), `contract` the round's, `committee` its
 * signer nodes, `advert` the accused's census advertisement with `bond` its census outpoint, `core` the round's core,
 * `roundRandomness` the beacon hash. Answers { slashed, offence, bond, proof, proofId, playerPubkey, why }.
 */
export async function judgeProof({ evidence, bundle, entry, entryId, contract, committee, advert, bondOutpoint, core, roundRandomness, replayRun }) {
  const no = (why) => ({ slashed: false, why });
  let proof, signedResult;
  try { ({ proof, signedResult } = splitSlashEvidence(evidence)); } catch (e) { return no(`not a slash proof record: ${e.message}`); }
  // THE ACCUSED'S OWN SIGNATURE over the result the proof names: evidence anybody could have written is no evidence
  let body;
  try {
    const s = splitSignedResult(signedResult);
    body = decodePlayerResult(s.body);
    if (!schnorr.verify(s.signature, resultId(body), body.nodePubkey)) return no('the result attached is not signed by the node it names');
  } catch (e) { return no(`the result attached does not read: ${e.message}`); }
  // THE REPLAY, AGAIN, HERE: the objection that held against exactly this result
  if (!(bundle instanceof Uint8Array) || !bundle.length) return no('no objection bundle to replay');
  // THE RUN, NOT THE SIGNER'S RECORD: an objection names the committee's run (a result with no signer), and the accused is
  // slashed for having signed THAT run - so its own result must be the run the objection contradicts
  let objected;
  try { objected = decodeObjectionBundle(bundle).objection.signedResultId; } catch (e) { return no(`that is not an objection bundle: ${e.message}`); }
  if (toHex(runId(body)) !== toHex(objected)) return no('the accused signed another run than the one the objection contradicts');
  const checked = await checkObjectionBundle({ bundle, roundId: proof.roundId, entryId, entry, contract, committee,
    signedResultId: objected, core, roundRandomness,
    verify: (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } },
    ...(replayRun ? { replayRun } : {}) });
  if (!checked.holds) return no(`the replay does not contradict that result: ${checked.why}`);
  let canonical;
  try { canonical = transcriptHash(decodeTranscript(decodeObjectionBundle(bundle).transcript)); } catch { canonical = null; }
  const held = slashHolds({ proof, signedResult, committee, canonicalTranscriptHash: canonical, replayDiffers: true,
    advert: advert ? { ...advert, bondTxid: bondOutpoint.txid, bondVout: bondOutpoint.vout } : null });
  if (!held.slashed) return no(held.why);
  return { slashed: true, offence: held.offence, bond: held.bond, proof, proofId: slashProofId(proof), playerPubkey: proof.playerPubkey, why: held.why };
}

/**
 * THE SLASHING TRANSACTION FOR A JUDGED PROOF, unsigned: its sighash and what its witness needs.
 * `bond` is { txid (internal order), vout, value (BigInt sat), script } as the chain holds it; `advert` the accused's
 * (its template and maturity rebuild the bond's tree); `censusNodes` the census keys at `slashHeight`; `seats` the round's.
 */
export function buildSlash({ verdict, bond, advert, contract, roundId, slashHeight, tipHeight, censusNodes, seats, set, feeSats = 2000n, hint = new TextEncoder().encode('arena') }) {
  const h = slashHeightIsValid({ slashHeight, censusHeight: contract.censusHeight, tipHeight });
  if (!h.ok) return { ok: false, why: h.why };
  // AS slash-owing.js PAYS IT: the accused out of the census it would be paid from, the round's seats out by the rule
  const accused = toHex(verdict.proof.nodePubkey);
  let distribution;
  try {
    distribution = slashDistribution({ bondSats: bond.value, roundId, contract, affectedPlayers: [verdict.playerPubkey],
      censusNodes: censusNodes.filter((k) => toHex(k) !== accused), seats });
  } catch (e) { return { ok: false, why: e.message }; }
  const maturity = bondMaturityOf(advert, { genesisMaturity: genesisFor(set.network).bondMaturity, network: set.network });
  if (!maturity.ok) return { ok: false, why: maturity.why };
  const nodeKey = advert.nodePubkey;
  const internalKey = bondInternalKey({ nodeKey, arbitrationKeys: set.keys }, { combine }).internalKey;
  const tree = bondOutputKey({ nodeKey, arbitrationKeys: set.keys, arbitrationK: set.k, bondMaturity: maturity.maturity, internalKey }, { tweakPoint, combine });
  if (!tree.ok) return { ok: false, why: tree.why };
  if (toHex(bond.script.subarray(2, 34)) !== toHex(tree.outputKey)) return { ok: false, why: 'that output is not the bond this node\'s advertisement builds' };
  const escrow = escrowOutput({ arbitrationKeys: set.keys, k: set.k }, { tweakPoint, combine });
  const built = arbitrationSpend({ bond, proofId: verdict.proofId, slashHeight, hint, distribution, feeSats,
    escrowScript: escrow.script, nodesScript: escrow.script, developersScript: escrow.script });
  if (!built.ok) return built;
  const leaf = tapLeafHash(slashLeaf(set.keys, set.k));
  return { ok: true, built, leaf, sighash: arbitrationSighash(built, leaf), controlBlock: controlBlockFor('slash', tree).controlBlock, distribution };
}

/**
 * THE ESCROW INTO THE FEDERATION (§5A.3B, kanban #307): the set's spend of a players' escrow output (`escrow`: { txid
 * (internal order), vout, value }) to the peg-in script `toScript`. The escrow must be the set's own escrowOutput; answers
 * the same shape as buildSlash, so memberSign and assemble take it as they take path B.
 */
export function buildEscrowPegin({ escrow, set, toScript, feeSats = 1000n }) {
  const out = escrowOutput({ arbitrationKeys: set.keys, k: set.k }, { tweakPoint, combine });
  if (escrow.script && toHex(escrow.script) !== toHex(out.script)) return { ok: false, why: 'that output is not this arbitration set\'s escrow' };
  const built = escrowSpend({ escrow: { ...escrow, script: out.script }, toScript, feeSats });
  if (!built.ok) return built;
  return { ok: true, built, leaf: out.leaf, sighash: arbitrationSighash(built, out.leaf), controlBlock: out.controlBlock, escrow: out };
}

/** One member's signature: its own key over the spend's sighash, nothing else. */
export const memberSign = (member, sighash) => schnorr.sign(sighash, member.secret);

/**
 * THE SIGNED TRANSACTION, ONLY FROM k VERIFIED SIGNATURES. `signatures` is [{ key, sig }]; each is checked against its
 * key and the sighash, and a key outside the set counts for nothing. Fewer than k: refused, nothing to post.
 */
export function assemble({ slash, signatures, set }) {
  const byKey = new Map();
  const members = new Set(set.keys.map(toHex));
  for (const { key, sig } of signatures) {
    const k = toHex(key);
    if (!members.has(k)) continue;
    let good = false; try { good = schnorr.verify(sig, slash.sighash, key); } catch { good = false; }
    if (good) byKey.set(k, sig);
  }
  if (byKey.size < set.k) return { ok: false, why: `${byKey.size} valid arbitration signatures, and path B needs ${set.k}: nothing is posted` };
  const w = arbitrationWitness({ arbitrationKeys: set.keys, k: set.k, signatures: byKey, controlBlock: slash.controlBlock });
  if (!w.ok) return w;
  const bytes = arbitrationTransaction(slash.built, w.witness);
  return { ok: true, hex: toHex(bytes), signers: byKey.size };
}

/** TESTMEMPOOLACCEPT, THEN BROADCAST - never the other way: `rpc(method, params)` is the arbiter's own bitcoind. */
export async function post(rpc, hex) {
  const [r] = await rpc('testmempoolaccept', [[hex]]);
  if (!r || !r.allowed) return { ok: false, why: `the mempool refuses it: ${r && r['reject-reason']}`, tested: r };
  const txid = await rpc('sendrawtransaction', [hex]);
  return { ok: true, txid, tested: r };
}

// ---- the arbitration set's half of a cooperative key-path spend (POST /musig/nonce, /musig/partial) ----

/**
 * THE MEMBERS AS ONE MUSIG2 PARTY for a bond's key path (kanban #307, spec 5A.3B key path). A session is opened by a
 * coordinator with the bond's node key, its tree's tweak and the 32-byte sighash; each member draws its nonce pair here
 * and keeps its secret nonce, and signs once, only for the message the session was opened with. `allow(session)` is the
 * set's policy - which spends it agrees to (a release with no open proof against the node, a judged slash).
 */
export function musigParty({ set, allow = () => ({ ok: false, why: 'no spend is agreed to' }) }) {
  const sessions = new Map();
  return {
    nonce({ sessionId, nodeKey, tweak, msg, spend }) {
      if (sessions.has(sessionId)) return { ok: false, why: 'that session is open already' };
      const may = allow({ nodeKey, msg, spend });
      if (!may.ok) return may;
      const bctx = bondSigningContext({ nodeKey, arbitrationKeys: set.keys, tweak });
      const drawn = set.members.map((m) => ({ m, ...nonceGen({ pk: Uint8Array.from([2, ...m.key]), sk: m.secret, msg }) }));
      sessions.set(sessionId, { bctx, msg, drawn, used: false });
      return { ok: true, outputKey: toHex(bctx.outputKey), pubnonces: drawn.map((d) => ({ member: toHex(d.m.key), pubnonce: toHex(d.pubnonce) })) };
    },
    partial({ sessionId, aggnonce }) {
      const s = sessions.get(sessionId);
      if (!s) return { ok: false, why: 'no such session' };
      if (s.used) return { ok: false, why: 'that session signed already: a nonce is used once' };
      s.used = true;
      try {
        const psigs = s.drawn.map((d) => ({ member: toHex(d.m.key), psig: toHex(bondPartialSign(s.bctx, {
          who: s.bctx.inner.pks.findIndex((p) => toHex(p) === toHex(d.m.key)), sk: d.m.secret, secnonce: d.secnonce, aggnonce: fromHex(aggnonce), msg: s.msg })) }));
        return { ok: true, psigs };
      } catch (e) { return { ok: false, why: e instanceof MusigError ? e.message : String(e.message || e) }; } finally { sessions.delete(sessionId); }
    },
  };
}

export { REPLAY_CONTRADICTS };

/**
 * THE ARBITER'S DOORS (kanban #307): POST /musig/nonce { sessionId, nodeKey, tweak, msg, spend } -> the 7 members'
 * pubnonces; POST /musig/partial { sessionId, aggnonce } -> their partial signatures (each nonce used once); GET /status
 * -> the set and what it posted. `posted` is the arbiter loop's record of path B spends it broadcast.
 */
export async function serveArbiter({ set, allow, port = 0, host = '127.0.0.1', posted = [] }) {
  const { createServer } = await import('node:http');
  const party = musigParty({ set, allow });
  const server = createServer(async (req, res) => {
    const answer = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/status')
      return answer(200, { network: set.network, k: set.k, members: set.members.map((m) => toHex(m.key)), posted });
    if (req.method !== 'POST' || !['/musig/nonce', '/musig/partial'].includes(url.pathname)) return answer(404, { ok: false, why: 'no such door' });
    let body; try { body = JSON.parse(await new Promise((r) => { let s = ''; req.on('data', (d) => { s += d; }); req.on('end', () => r(s)); })); } catch { return answer(400, { ok: false, why: 'a JSON body' }); }
    if (url.pathname === '/musig/nonce') {
      const ok32 = (h) => /^[0-9a-f]{64}$/.test(String(h));
      if (!body.sessionId || !ok32(body.nodeKey) || !ok32(body.tweak) || !ok32(body.msg)) return answer(400, { ok: false, why: 'a session id, a node key, a tweak and a message (32 bytes each, hex)' });
      const r = party.nonce({ sessionId: String(body.sessionId), nodeKey: fromHex(body.nodeKey), tweak: fromHex(body.tweak), msg: fromHex(body.msg), spend: body.spend || null });
      return answer(r.ok ? 200 : 409, r);
    }
    const r = party.partial({ sessionId: String(body.sessionId), aggnonce: String(body.aggnonce || '') });
    return answer(r.ok ? 200 : 409, r);
  });
  await new Promise((r) => server.listen(port, host, r));
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}
