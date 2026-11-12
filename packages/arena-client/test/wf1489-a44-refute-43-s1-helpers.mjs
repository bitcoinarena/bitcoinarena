// shared setup for the a44-refute-43 variants (not a test file)
import { schnorr } from '@noble/curves/secp256k1.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord } from '../../arena-protocol/src/federation-record.js';
import { inviteForGuardians } from '../../arena-node/src/invite.js';
const hex = (b) => Buffer.from(b).toString('hex');
export const nodes = Array.from({ length: 7 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
export function setup(feds) {   // feds: [{ byte, status, height }]
  const census = nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(i), vout: 0, bondSats: 50000n,
    advert: { guardianOf: feds.map((f) => ({ federationId: new Uint8Array(32).fill(f.byte), guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(f.byte + i)]) })) } }));
  const good = new Set(); const out = {};
  for (const f of feds) {
    const FED = new Uint8Array(32).fill(f.byte);
    const invite = inviteForGuardians(FED, [{ url: 'wss://g.example/', peer: 0 }]);
    const r = buildFederationRecord({ federationId: FED, networkId: new Uint8Array(32).fill(0x10), invite, nominal: 7, height: f.height,
      guardians: census.map((e, i) => ({ peerKey: Uint8Array.from([2, ...new Uint8Array(32).fill(f.byte + i)]), nodePubkey: e.pubkey, operatorId: '', bondTxid: e.txid, bondVout: 0, endpoint: '', bondSats: 50000n })) });
    if (f.status != null) r.status = f.status;
    const body = encodeFederationRecord(r); const id = federationRecordId(r);
    const sigs = nodes.map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) }));
    sigs.forEach((s) => good.add(hex(s.signature)));
    let ctr = 0;
    out[f.byte] = { fid: hex(FED), record: r, honest: hex(joinSignedRecord(body, sigs)),
      forged: () => hex(joinSignedRecord(body, Array.from({ length: 32 }, (_, j) => { const s = new Uint8Array(64); new DataView(s.buffer).setUint32(0, ++ctr); s[62] = f.byte; s[63] = 0xee; return { nodePubkey: nodes[j % 7].pubkey, signature: s }; }))) };
  }
  return { census, good, feds: out };
}
