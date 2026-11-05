//! THE ARENA LOCK (kanban #1044 B1, ruling #1131): a stake or fee lock whose claim and forfeit NAME THEIR SIGNERS.
//! It is the fork's LNv2 variant `ArenaLockContract` (fedimint-lnv2-common arena_lock.rs), not a stock
//! `OutgoingContract`: the round's settlement seats' node keys in seat order (`claim_keys`, at most 7), a threshold `t`,
//! the round id, and the player's refund key. A claim names exactly `t` seats by index; the guardians hand core, as the
//! input's key, the BIP-327 MuSig2 aggregate of exactly those keys, and core checks the transaction's one signature per
//! input under it. So the accepted claim names its signers and binds them to its outputs.
//!
//! OFFLINE (no client, no federation): arena-id, and the two MuSig2 rounds on byte strings - the same code the fork's
//! module and the wasm lock client run (arena_lock::musig):
//!   arena-id            --amount-msat N (--point HEX | --hash HEX) --expiration B --round-id HEX32
//!                       --claim-keys X,X,.. --threshold T --refund-pk HEX
//!   musig-keyagg        --claim-keys X,X,.. --threshold T --signers I,I,..         -> the named set's x-only key
//!   musig-nonce         ... --secret HEX --message HEX32 [--seed HEX32]          -> secnonce (keep, use once), pubnonce
//!   musig-aggnonce      --pubnonces HEX,HEX,..                                    -> aggnonce
//!   musig-partial       ... --secret HEX --secnonce HEX --aggnonce HEX --message HEX32   -> partial
//!   musig-verify-partial ... --signer I --partial HEX --pubnonce HEX --aggnonce HEX --message HEX32
//!   musig-aggregate     ... --aggnonce HEX --partials HEX,HEX,.. --message HEX32  -> the BIP-340 signature
//! ONLINE (the client at --data-dir):
//!   arena-version       the federation's LNv2 module consensus version; the Arena lock needs 1.100
//!   arena-lock          the arena-id fields with --expiry-delta BLOCKS instead of --expiration: funds one lock
//!   arena-status        --outpoint TXID:IDX
//!   arena-redeem        --outpoint TXID:IDX --signer-secret HEX (--witness refund | --witness cancel --signers I,.. --forfeit-sig HEX)
//!   arena-settle        --locks TXID:IDX:PREIMAGE[,...] --signers I,.. --nonce HEX16 --payouts ... [--signature HEX]
use std::str::FromStr;
use std::time::Duration;

use anyhow::{Context, anyhow, bail};
use fedimint_api_client::api::{DynModuleApi, FederationApiExt};
use fedimint_client::ClientHandle;
use fedimint_client::transaction::{
    ClientInput, ClientInputBundle, ClientOutput, ClientOutputBundle, TransactionBuilder,
};
use fedimint_core::bitcoin::hashes::{Hash, sha256};
use fedimint_core::core::{IntoDynInstance, ModuleInstanceId, OperationId};
use fedimint_core::module::{Amounts, ApiRequestErased, ModuleConsensusVersion};
use fedimint_core::secp256k1::schnorr::Signature;
use fedimint_core::secp256k1::{Message, PublicKey, SECP256K1, SecretKey, XOnlyPublicKey};
use fedimint_core::transaction::{Transaction, TransactionSignature};
use fedimint_core::{Amount, OutPoint};
use fedimint_lnv2_common::arena_lock::{self, ArenaLockContract, ArenaLockWitness, musig};
use fedimint_lnv2_common::config::LightningClientConfig;
use fedimint_lnv2_common::contracts::{OutgoingContract, PaymentImage};
use fedimint_lnv2_common::endpoint_constants::{ARENA_LOCK_CONTRACT_ENDPOINT, MODULE_CONSENSUS_VERSION_ENDPOINT};
use fedimint_lnv2_common::{ARENA_LOCK_CONSENSUS_VERSION, LightningInput, LightningOutput, LightningOutputV0};

use crate::{Args, block_count, hex, hex_bytes, need, outpoint};

fn bytes32(s: &str, what: &str) -> anyhow::Result<[u8; 32]> {
    hex_bytes(s)?.try_into().map_err(|_| anyhow!("{what} is 32 bytes"))
}

fn claim_keys(a: &Args) -> anyhow::Result<Vec<XOnlyPublicKey>> {
    need(a, "claim-keys")?
        .split(',')
        .map(|k| XOnlyPublicKey::from_str(k).with_context(|| format!("{k} is no x-only key")))
        .collect()
}

fn threshold(a: &Args) -> anyhow::Result<u8> {
    Ok(need(a, "threshold")?.parse()?)
}

fn signers(a: &Args) -> anyhow::Result<Vec<u8>> {
    need(a, "signers")?.split(',').map(|i| Ok(i.parse()?)).collect()
}

/// The lock's fields, as `arena-id` and `arena-lock` name them.
pub fn contract(a: &Args, expiration: u64) -> anyhow::Result<ArenaLockContract> {
    let payment_image = match a.get("point") {
        Some(point) => PaymentImage::Point(PublicKey::from_str(point)?),
        None => PaymentImage::Hash(sha256::Hash::from_str(need(a, "hash")?)?),
    };
    Ok(ArenaLockContract {
        payment_image,
        amount: Amount::from_msats(need(a, "amount-msat")?.parse()?),
        expiration,
        round_id: bytes32(need(a, "round-id")?, "--round-id")?,
        claim_keys: claim_keys(a)?,
        threshold: threshold(a)?,
        refund_pk: PublicKey::from_str(need(a, "refund-pk")?)?,
    })
}

pub fn contract_json(c: &ArenaLockContract) -> serde_json::Value {
    serde_json::json!({
        "contract_id": c.contract_id().0.to_string(),
        "amount_msat": c.amount.msats,
        "expiration": c.expiration,
        "round_id": hex(&c.round_id),
        "claim_keys": c.claim_keys.iter().map(|k| k.to_string()).collect::<Vec<_>>(),
        "threshold": c.threshold,
        "refund_pk": c.refund_pk.to_string(),
        "payment_image": match &c.payment_image { PaymentImage::Hash(h) => serde_json::json!({ "hash": h.to_string() }),
            PaymentImage::Point(p) => serde_json::json!({ "point": p.to_string() }) },
    })
}

/// `arena-id`: the contract id and forfeit message of a lock's fields, and whether the module would take it as an output.
pub fn id(a: &Args) -> anyhow::Result<serde_json::Value> {
    let c = contract(a, need(a, "expiration")?.parse()?)?;
    let mut out = contract_json(&c);
    out["mode"] = "arena-id".into();
    out["forfeit_message"] = hex(&c.contract_id().0.to_byte_array()).into();
    out["valid"] = c.validate().map_or_else(|e| serde_json::Value::String(e.to_string()), |()| true.into());
    Ok(out)
}

fn named_ctx(a: &Args) -> anyhow::Result<(Vec<XOnlyPublicKey>, Vec<u8>, arena_lock::musig2::KeyAggContext)> {
    let keys = claim_keys(a)?;
    let set = signers(a)?;
    let points = arena_lock::signer_points(&keys, threshold(a)?, &set).map_err(|e| anyhow!("{e}"))?;
    let ctx = arena_lock::key_agg_context(&points).map_err(|e| anyhow!("{e}"))?;
    Ok((keys, set, ctx))
}

fn arr<const N: usize>(s: &str, what: &str) -> anyhow::Result<[u8; N]> {
    hex_bytes(s)?.try_into().map_err(|_| anyhow!("{what} is {N} bytes"))
}

/// The offline MuSig2 modes; None for any other mode.
pub fn musig_mode(mode: &str, a: &Args) -> Option<anyhow::Result<serde_json::Value>> {
    let run = || -> anyhow::Result<serde_json::Value> {
        if mode == "musig-aggnonce" {
            let nonces = need(a, "pubnonces")?.split(',').map(|n| arr::<66>(n, "a public nonce")).collect::<Result<Vec<_>, _>>()?;
            return Ok(serde_json::json!({ "mode": mode, "aggnonce": hex(&musig::aggregate_nonces(&nonces)?) }));
        }
        let (keys, set, ctx) = named_ctx(a)?;
        let agg: arena_lock::musig2::secp::Point = ctx.aggregated_pubkey();
        let agg_x = hex(&agg.serialize_xonly());
        let message = || bytes32(need(a, "message")?, "--message");
        let secret = || -> anyhow::Result<SecretKey> { Ok(SecretKey::from_slice(&hex_bytes(need(a, "secret")?)?)?) };
        Ok(match mode {
            "musig-keyagg" => serde_json::json!({ "mode": mode, "signers": set, "agg_key": agg_x, "agg_point": hex(&agg.serialize()) }),
            "musig-nonce" => {
                // 32 fresh random bytes unless given; BIP-327 mixes in the key, the aggregate and the message
                let seed = match a.get("seed") { Some(s) => bytes32(s, "--seed")?, None => {
                    let mut b = [0u8; 32];
                    std::io::Read::read_exact(&mut std::fs::File::open("/dev/urandom")?, &mut b)?;
                    b
                } };
                let (sec, public) = musig::nonce_gen(seed, &secret()?, &ctx, &message()?)?;
                serde_json::json!({ "mode": mode, "agg_key": agg_x, "secnonce": hex(&sec), "pubnonce": hex(&public) })
            }
            "musig-partial" => {
                let partial = musig::partial_sign(&ctx, &secret()?, arr::<97>(need(a, "secnonce")?, "--secnonce")?,
                    &arr::<66>(need(a, "aggnonce")?, "--aggnonce")?, &message()?)?;
                serde_json::json!({ "mode": mode, "partial": hex(&partial) })
            }
            "musig-verify-partial" => {
                let i: usize = need(a, "signer")?.parse()?;
                if !set.contains(&(i as u8)) { bail!("seat {i} is not one of the named signers") }
                let ok = musig::partial_verify(&ctx, &arr::<32>(need(a, "partial")?, "--partial")?,
                    &arr::<66>(need(a, "aggnonce")?, "--aggnonce")?, &keys[i], &arr::<66>(need(a, "pubnonce")?, "--pubnonce")?, &message()?).is_ok();
                serde_json::json!({ "mode": mode, "verifies": ok })
            }
            "musig-aggregate" => {
                let partials = need(a, "partials")?.split(',').map(|p| arr::<32>(p, "a partial")).collect::<Result<Vec<_>, _>>()?;
                let sig = musig::aggregate(&ctx, &arr::<66>(need(a, "aggnonce")?, "--aggnonce")?, &partials, &message()?)?;
                let key = XOnlyPublicKey::from_slice(&agg.serialize_xonly())?;
                let verifies = SECP256K1.verify_schnorr(&sig, &Message::from_digest(message()?), &key).is_ok();
                serde_json::json!({ "mode": mode, "signature": hex(&sig.serialize()), "agg_key": agg_x, "verifies": verifies })
            }
            other => bail!("no mode {other}"),
        })
    };
    mode.starts_with("musig-").then(run)
}

/// The federation's LNv2 module consensus version in force; an error from a federation on stock LNv2, which has no such
/// endpoint.
pub async fn version(api: &DynModuleApi) -> anyhow::Result<ModuleConsensusVersion> {
    api.request_current_consensus(MODULE_CONSENSUS_VERSION_ENDPOINT.to_string(), ApiRequestErased::new(()))
        .await
        .map_err(|e| anyhow!("this federation does not answer the Arena lock's module version (stock LNv2?): {e}"))
}

async fn require_module(api: &DynModuleApi) -> anyhow::Result<ModuleConsensusVersion> {
    let v = version(api).await?;
    if v < ARENA_LOCK_CONSENSUS_VERSION {
        bail!("this federation runs LNv2 {}.{}, the Arena lock needs {}.{}", v.major, v.minor,
            ARENA_LOCK_CONSENSUS_VERSION.major, ARENA_LOCK_CONSENSUS_VERSION.minor);
    }
    Ok(v)
}

async fn stored(api: &DynModuleApi, outpoint: OutPoint) -> anyhow::Result<Option<(ArenaLockContract, u64)>> {
    Ok(api.request_current_consensus(ARENA_LOCK_CONTRACT_ENDPOINT.to_string(), ApiRequestErased::new(outpoint)).await?)
}

fn stored_json(s: &Option<(ArenaLockContract, u64)>) -> serde_json::Value {
    match s {
        Some((c, left)) => { let mut j = contract_json(c); j["blocks_left"] = (*left).into(); j }
        None => serde_json::Value::Null,
    }
}

pub async fn status(a: &Args, api: &DynModuleApi) -> anyhow::Result<serde_json::Value> {
    let op = outpoint(need(a, "outpoint")?)?;
    let count = block_count(api).await?;
    Ok(serde_json::json!({ "mode": "arena-status", "block_count": count, "stored": stored_json(&stored(api, op).await?) }))
}

fn fee_rule(config: &fedimint_core::config::ClientConfig, lnv2: ModuleInstanceId) -> anyhow::Result<fedimint_lnv2_common::config::FeeConsensus> {
    Ok(config.modules.get(&lnv2).context("no lnv2 config")?.cast::<LightningClientConfig>()?.fee_consensus.clone())
}

/// `arena-lock`: one Arena lock funded from this client's own e-cash, and what the guardians stored, read back.
pub async fn lock(a: &Args, client: &ClientHandle, lnv2: ModuleInstanceId, api: &DynModuleApi) -> anyhow::Result<()> {
    let version = require_module(api).await?;
    let delta: u64 = need(a, "expiry-delta")?.parse()?;
    let count = block_count(api).await?;
    let c = contract(a, count + delta)?;
    c.validate().map_err(|e| anyhow!("the guardians would refuse this lock: {e}"))?;
    let bundle = ClientOutputBundle::new_no_sm(vec![ClientOutput {
        output: LightningOutput::ArenaLock(c.clone()),
        amounts: Amounts::new_bitcoin(c.amount),
    }])
    .into_dyn(lnv2);
    let operation = OperationId::new_random();
    let change = client
        .finalize_and_submit_transaction(operation, "arena-lock", |_| (), TransactionBuilder::new().with_outputs(bundle))
        .await?;
    let txid = change.txid();
    client.transaction_updates(operation).await.await_tx_accepted(txid).await
        .map_err(|e| anyhow!("the guardians did not accept the lock transaction: {e}"))?;
    // the builder places the change, so the lock's index is read, not assumed
    for out_idx in 0..16u64 {
        let op = OutPoint { txid, out_idx };
        if let Some((held, left)) = stored(api, op).await? {
            if held.contract_id() == c.contract_id() {
                let mut out = contract_json(&held);
                out["mode"] = "arena-lock".into();
                out["txid"] = txid.to_string().into();
                out["out_idx"] = out_idx.into();
                out["block_count_at_lock"] = count.into();
                out["blocks_left"] = left.into();
                out["ids_match"] = true.into();
                out["module_version"] = format!("{}.{}", version.major, version.minor).into();
                println!("{out}");
                return Ok(());
            }
        }
    }
    bail!("the lock transaction {txid} was accepted but no outpoint of it holds this Arena lock")
}

/// `arena-redeem`: the player takes a lock back - by the named seats' forfeit (any time) or by the refund (from
/// expiration) - signed with the player's own key, into the player's e-cash.
pub async fn redeem(a: &Args, client: &ClientHandle, lnv2: ModuleInstanceId, api: &DynModuleApi) -> anyhow::Result<()> {
    let op = outpoint(need(a, "outpoint")?)?;
    let before = stored(api, op).await?;
    let Some((c, _)) = before.clone() else { bail!("the guardians hold no Arena lock at {}:{}", op.txid, op.out_idx) };
    let mut secret = SecretKey::from_slice(&hex_bytes(need(a, "signer-secret")?)?)?;
    if secret.public_key(SECP256K1) != c.refund_pk { secret = secret.negate(); }
    if secret.public_key(SECP256K1) != c.refund_pk { bail!("that key is not the lock's refund key"); }
    let kind = a.get("witness").map_or("cancel", String::as_str).to_owned();
    let (witness, forfeit_verifies) = match kind.as_str() {
        "cancel" => {
            let set = signers(a)?;
            let signature = Signature::from_slice(&hex_bytes(need(a, "forfeit-sig")?)?)?;
            let ok = c.verify_forfeit_signature(&set, &signature);
            (ArenaLockWitness::Cancel { signers: set, signature }, Some(ok))
        }
        "refund" => (ArenaLockWitness::Refund, None),
        other => bail!("no witness {other}: cancel or refund"),
    };
    let count = block_count(api).await?;
    let balance_before = client.get_balance_for_btc().await?;
    let bundle = ClientInputBundle::new_no_sm(vec![ClientInput {
        input: LightningInput::ArenaLock(op, witness),
        keys: vec![secret.keypair(SECP256K1)],
        amounts: Amounts::new_bitcoin(c.amount),
    }])
    .into_dyn(lnv2);
    let operation = OperationId::new_random();
    let (accepted, txid, error) = match client
        .finalize_and_submit_transaction(operation, "arena-lock-redeem", |_| (), TransactionBuilder::new().with_inputs(bundle))
        .await
    {
        Err(e) => (false, None, Some(format!("not submitted: {e}"))),
        Ok(change) => {
            let t = change.txid();
            match client.transaction_updates(operation).await.await_tx_accepted(t).await {
                Ok(()) => (true, Some(t), None),
                Err(e) => (false, Some(t), Some(e)),
            }
        }
    };
    let after = stored(api, op).await?;
    println!("{}", serde_json::json!({
        "mode": "arena-redeem", "witness": kind, "outpoint": format!("{}:{}", op.txid, op.out_idx),
        "contract_id": c.contract_id().0.to_string(), "forfeit_verifies": forfeit_verifies,
        "block_count_at_redeem": count, "expiration": c.expiration, "accepted": accepted,
        "txid": txid.map(|t| t.to_string()), "error": error, "balance_before_msat": balance_before.msats,
        "stored_before": stored_json(&before), "stored_after": stored_json(&after),
    }));
    Ok(())
}

/// The payouts of a settlement, as --mode settle names them: `PK:MSAT` (a pre-expired contract only PK moves) or
/// `invoice:HASH:GATEWAY_PK:REFUND_PK:EXPIRATION:MSAT` (winnings sent through a gateway), in the order given.
fn payouts(list: &str) -> anyhow::Result<Vec<OutgoingContract>> {
    list.split(',').map(|spec| {
        if let Some(rest) = spec.strip_prefix("invoice:") {
            let p: Vec<&str> = rest.split(':').collect();
            let [hash, gateway, refund, expiration, msat] = p[..] else {
                bail!("an invoice payout is invoice:HASH:GATEWAY_PK:REFUND_PK:EXPIRATION:MSAT")
            };
            let refund_pk = PublicKey::from_str(refund)?;
            return Ok(OutgoingContract { payment_image: PaymentImage::Hash(sha256::Hash::from_str(hash)?),
                amount: Amount::from_msats(msat.parse()?), expiration: expiration.parse()?,
                claim_pk: PublicKey::from_str(gateway)?, refund_pk, ephemeral_pk: refund_pk });
        }
        let (pk, msat) = spec.split_once(':').context("a payout is PK:MSAT")?;
        let pk = PublicKey::from_str(pk)?;
        Ok(OutgoingContract { payment_image: PaymentImage::Hash(sha256::Hash::from_byte_array([0u8; 32])),
            amount: Amount::from_msats(msat.parse()?), expiration: 0, claim_pk: pk, refund_pk: pk, ephemeral_pk: pk })
    }).collect()
}

/// THE SIGNER SET'S PLACEHOLDER KEY Z (ruling #1135 1): 02 || x for the first tagged_hash("ARENA/v1/SignerSetKey", u32 i, big-endian) that is a
/// curve point's x. Nobody holds its key. A settlement body writes it wherever the plan puts KeyAgg(claim_keys[S]).
pub fn z_key() -> PublicKey {
    for i in 0u32.. {
        let mut b = [0u8; 33];
        b[0] = 0x02;
        b[1..].copy_from_slice(&tagged(b"ARENA/v1/SignerSetKey", &i.to_be_bytes()));
        if let Ok(k) = PublicKey::from_slice(&b) { return k }
    }
    unreachable!("some x is on the curve")
}

fn tagged(tag: &[u8], msg: &[u8]) -> [u8; 32] {
    let t = sha256::Hash::hash(tag);
    let mut e = sha256::Hash::engine();
    fedimint_core::bitcoin::hashes::HashEngine::input(&mut e, t.as_ref());
    fedimint_core::bitcoin::hashes::HashEngine::input(&mut e, t.as_ref());
    fedimint_core::bitcoin::hashes::HashEngine::input(&mut e, msg);
    sha256::Hash::from_engine(e).to_byte_array()
}

fn swap_key(k: &mut PublicKey, from: &PublicKey, to: &PublicKey) { if k == from { *k = *to } }

/// An output with every key equal to `from` written as `to` (a stock contract's claim, refund and ephemeral keys; an Arena lock's refund key).
fn swap_output(o: &LightningOutput, from: &PublicKey, to: &PublicKey) -> LightningOutput {
    match o {
        LightningOutput::V0(LightningOutputV0::Outgoing(c)) => {
            let mut c = c.clone();
            swap_key(&mut c.claim_pk, from, to); swap_key(&mut c.refund_pk, from, to); swap_key(&mut c.ephemeral_pk, from, to);
            LightningOutput::V0(LightningOutputV0::Outgoing(c))
        }
        LightningOutput::ArenaLock(c) => { let mut c = c.clone(); swap_key(&mut c.refund_pk, from, to); LightningOutput::ArenaLock(c) }
        other => other.clone(),
    }
}

/// THE SETTLEMENT BODY ID (ruling #1135 1): tagged_hash("ARENA/v1/SettlementBody", the bytes the txid hashes - inputs, outputs, nonce - with every
/// Arena-lock Claim's signers written as the empty list and every lnv2 output key equal to `agg` (KeyAgg(S)) written as Z). Other modules' items as
/// they are. `agg` None: a body already written with Z.
pub fn body_id(inputs: &[fedimint_core::core::DynInput], outputs: &[fedimint_core::core::DynOutput], nonce: [u8; 8], lnv2: ModuleInstanceId, agg: Option<PublicKey>) -> [u8; 32] {
    use fedimint_core::encoding::Encodable as _;
    let z = z_key();
    let ins: Vec<_> = inputs.iter().map(|i| match (i.module_instance_id() == lnv2).then(|| i.as_any().downcast_ref::<LightningInput>()).flatten() {
        Some(LightningInput::ArenaLock(op, ArenaLockWitness::Claim { preimage, .. })) =>
            LightningInput::ArenaLock(*op, ArenaLockWitness::Claim { preimage: *preimage, signers: vec![] }).into_dyn(lnv2),
        _ => i.clone(),
    }).collect();
    let outs: Vec<_> = outputs.iter().map(|o| match ((i_is(o.module_instance_id(), lnv2)).then(|| o.as_any().downcast_ref::<LightningOutput>()).flatten(), agg) {
        (Some(l), Some(agg)) => swap_output(l, &agg, &z).into_dyn(lnv2),
        _ => o.clone(),
    }).collect();
    let mut bytes = Vec::new();
    ins.consensus_encode(&mut bytes).expect("vec write");
    outs.consensus_encode(&mut bytes).expect("vec write");
    nonce.consensus_encode(&mut bytes).expect("vec write");
    tagged(b"ARENA/v1/SettlementBody", &bytes)
}
fn i_is(a: ModuleInstanceId, b: ModuleInstanceId) -> bool { a == b }

/// `arena-settle`: the settlement's one transaction, as ruling #1135 orders it. Every given Arena lock in as Claim, the payouts out; a payout key
/// written `Z` is the signer set's key. Without --signers: THE BODY (empty signer lists, Z in place) and its id - what the seats ack and commit
/// over. With --signers (S, the t lowest committed seats): the real transaction (S in every claim, KeyAgg(S) for every Z), its txid - the MuSig2
/// message - and its body id again, which must be the same. With --signature: checked under KeyAgg(S) and submitted. All locks must name the same
/// keys and threshold: one transaction, one S, one signature listed per input.
pub async fn settle(a: &Args, client: &ClientHandle, lnv2: ModuleInstanceId, api: &DynModuleApi) -> anyhow::Result<()> {
    require_module(api).await?;
    let nonce: [u8; 8] = hex_bytes(need(a, "nonce")?)?.try_into().map_err(|_| anyhow!("--nonce is 8 bytes"))?;
    let fee = fee_rule(&client.config().await, lnv2)?;
    let mut claims = Vec::new();
    let mut locks: Vec<(OutPoint, ArenaLockContract)> = Vec::new();
    let (mut input_msats, mut input_fee_msats) = (0u64, 0u64);
    for spec in need(a, "locks")?.split(',') {
        let parts: Vec<&str> = spec.split(':').collect();
        let [txid, idx, preimage] = parts[..] else { bail!("a lock is TXID:IDX:PREIMAGE") };
        let op = outpoint(&format!("{txid}:{idx}"))?;
        let Some((c, _)) = stored(api, op).await? else { bail!("the guardians hold no Arena lock at {txid}:{idx}") };
        let preimage = bytes32(preimage, "a preimage")?;
        if !c.verify_preimage(&preimage) { bail!("that preimage does not open the lock at {txid}:{idx}") }
        if let Some((_, first)) = locks.first() {
            if first.claim_keys != c.claim_keys || first.threshold != c.threshold { bail!("the locks name different claim keys or thresholds: one transaction is one signer set") }
        }
        input_msats += c.amount.msats;
        input_fee_msats += fee.fee(c.amount).msats;
        claims.push((op, preimage));
        locks.push((op, c));
    }
    let (_, first) = locks.first().cloned().context("a settlement claims at least one lock")?;
    let z = z_key();
    let contracts = payouts(&need(a, "payouts")?.replace(":Z:", &format!(":{z}:")).split(',').map(|p| if p.starts_with("Z:") { p.replacen('Z', &z.to_string(), 1) } else { p.to_owned() }).collect::<Vec<_>>().join(","))?;
    let spendable = input_msats - input_fee_msats;
    let out: u64 = contracts.iter().map(|c| c.amount.msats).sum();
    let out_fee: u64 = contracts.iter().map(|c| fee.fee(c.amount).msats).sum();
    if out + out_fee > spendable {
        bail!("the payouts ({out} msat, {out_fee} msat in fees) are more than the locks pay for ({spendable} msat after their own fees)");
    }
    let build = |set: &[u8], agg: Option<PublicKey>| {
        let ins: Vec<_> = claims.iter().map(|(op, pre)| LightningInput::ArenaLock(*op, ArenaLockWitness::Claim { preimage: *pre, signers: set.to_vec() }).into_dyn(lnv2)).collect();
        let outs: Vec<_> = contracts.iter().map(|c| {
            let o = LightningOutput::V0(LightningOutputV0::Outgoing(c.clone()));
            match agg { Some(k) => swap_output(&o, &z, &k), None => o }.into_dyn(lnv2)
        }).collect();
        (ins, outs)
    };
    let (body_ins, body_outs) = build(&[], None);
    let body = body_id(&body_ins, &body_outs, nonce, lnv2, None);
    let z_slots = contracts.iter().enumerate().filter(|(_, c)| c.claim_pk == z || c.refund_pk == z || c.ephemeral_pk == z).map(|(i, _)| i).collect::<Vec<_>>();
    let mut report = serde_json::json!({
        "mode": "arena-settle", "body_id": hex(&body), "z_key": z.to_string(), "z_slots": z_slots,
        "inputs": locks.iter().map(|(o, c)| serde_json::json!({ "outpoint": format!("{}:{}", o.txid, o.out_idx),
            "contract_id": c.contract_id().0.to_string(), "round_id": hex(&c.round_id), "msat": c.amount.msats })).collect::<Vec<_>>(),
        "input_msat": input_msats, "input_fees_msat": input_fee_msats, "payout_msat": out, "output_fee_msat": out_fee,
        "unspent_msat": spendable - out - out_fee,
    });
    let Some(set) = a.get("signers") else { println!("{report}"); return Ok(()) };
    let set: Vec<u8> = set.split(',').map(|i| Ok(i.parse()?)).collect::<anyhow::Result<_>>()?;
    let key = first.signer_key(&set).map_err(|e| anyhow!("{e}"))?;
    let (inputs, outputs) = build(&set, Some(key));
    let txid = Transaction::tx_hash_from_parts(&inputs, &outputs, nonce);
    let again = body_id(&inputs, &outputs, nonce, lnv2, Some(key));
    if again != body { bail!("the real transaction strips to another body than the one built: the signers' key stands where the body has no Z") }
    let o = report.as_object_mut().expect("an object");
    o.insert("signers".into(), serde_json::json!(set));
    o.insert("agg_key".into(), key.x_only_public_key().0.to_string().into());
    o.insert("txid".into(), txid.to_string().into());
    o.insert("message_hex".into(), hex(&txid[..]).into());
    o.insert("payouts".into(), outputs.iter().enumerate().map(|(i, d)| match d.as_any().downcast_ref::<LightningOutput>() {
        Some(LightningOutput::V0(LightningOutputV0::Outgoing(c))) => serde_json::json!({ "out_idx": i, "refund_pk": c.refund_pk.to_string(),
            "claim_pk": c.claim_pk.to_string(), "msat": c.amount.msats, "expiration": c.expiration, "contract_id": c.contract_id().0.to_string() }),
        _ => serde_json::Value::Null }).collect::<Vec<_>>().into());
    let Some(sig_hex) = a.get("signature") else { println!("{report}"); return Ok(()) };
    let signature = Signature::from_slice(&hex_bytes(sig_hex)?)?;
    let verifies = SECP256K1.verify_schnorr(&signature, &Message::from_digest_slice(&txid[..])?, &key.x_only_public_key().0).is_ok();
    let tx = Transaction { inputs, outputs, nonce, signatures: TransactionSignature::NaiveMultisig(vec![signature; locks.len()]) };
    let outcome = client.api().submit_transaction(tx).await.try_into_inner(client.decoders())
        .map_err(|e| anyhow!("the guardians' answer did not decode: {e}"))?;
    let (accepted, error) = match outcome.0 { Ok(_) => (true, None), Err(e) => (false, Some(e.to_string())) };
    let started = std::time::Instant::now();
    let mut spent = false;
    while accepted && started.elapsed() < Duration::from_secs(60) {
        if stored(api, locks[0].0).await?.is_none() { spent = true; break; }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let o = report.as_object_mut().expect("an object");
    o.insert("signature_verifies_under_agg_key".into(), verifies.into());
    o.insert("signatures_listed".into(), locks.len().into());
    o.insert("accepted".into(), accepted.into());
    o.insert("error".into(), error.into());
    o.insert("locks_spent".into(), spent.into());
    println!("{report}");
    Ok(())
}

/// The nonce of a send's presigned refund (c): the first 8 bytes of tagged_hash("ARENA/v1/SendRefundNonce", real txid || u32 index), so every
/// seat rebuilds the same transaction.
fn send_refund_nonce(txid: &fedimint_core::TransactionId, idx: u64) -> [u8; 8] {
    let mut m = txid[..].to_vec();
    m.extend_from_slice(&u32::try_from(idx).unwrap_or(u32::MAX).to_be_bytes());
    tagged(b"ARENA/v1/SendRefundNonce", &m)[..8].try_into().expect("8 bytes")
}

/// `arena-send-refund` (ruling #1134 2, #1135 2): THE PRESIGNED REFUND (c) of a gateway send - built from the real settlement transaction and the
/// table, never acked: the send contract at (real txid, index) spent by Refund, into one pre-expired payout to the qualifier's key, of the send
/// less the federation's fee on the input and the output. --send TXID:IDX --amount-msat (the send's) --refund-pk (KeyAgg(S), 33 bytes)
/// --qualifier-pk HEX. Without --signature: the txid S signs; with it (anyone, from the send's expiration): checked under the refund key and
/// submitted.
pub async fn send_refund(a: &Args, client: &ClientHandle, lnv2: ModuleInstanceId) -> anyhow::Result<()> {
    let op = outpoint(need(a, "send")?)?;
    let amount = Amount::from_msats(need(a, "amount-msat")?.parse()?);
    let refund_pk = PublicKey::from_str(need(a, "refund-pk")?)?;
    let qualifier = PublicKey::from_str(need(a, "qualifier-pk")?)?;
    let fee = fee_rule(&client.config().await, lnv2)?;
    let spendable = amount.msats.saturating_sub(fee.fee(amount).msats);
    let mut out = spendable;
    while out > 0 && out + fee.fee(Amount::from_msats(out)).msats > spendable { out -= 1; }
    let payout = OutgoingContract { payment_image: PaymentImage::Hash(sha256::Hash::from_byte_array([0u8; 32])), amount: Amount::from_msats(out),
        expiration: 0, claim_pk: qualifier, refund_pk: qualifier, ephemeral_pk: qualifier };
    let nonce = send_refund_nonce(&op.txid, op.out_idx);
    let inputs = vec![LightningInput::V0(fedimint_lnv2_common::LightningInputV0::Outgoing(op, fedimint_lnv2_common::OutgoingWitness::Refund)).into_dyn(lnv2)];
    let outputs = vec![LightningOutput::V0(LightningOutputV0::Outgoing(payout.clone())).into_dyn(lnv2)];
    let txid = Transaction::tx_hash_from_parts(&inputs, &outputs, nonce);
    let mut report = serde_json::json!({ "mode": "arena-send-refund", "send": format!("{}:{}", op.txid, op.out_idx), "txid": txid.to_string(),
        "message_hex": hex(&txid[..]), "nonce": hex(&nonce), "payout_msat": out, "payout_contract_id": payout.contract_id().0.to_string(),
        "qualifier_pk": qualifier.to_string() });
    let Some(sig_hex) = a.get("signature") else { println!("{report}"); return Ok(()) };
    let signature = Signature::from_slice(&hex_bytes(sig_hex)?)?;
    let verifies = SECP256K1.verify_schnorr(&signature, &Message::from_digest_slice(&txid[..])?, &refund_pk.x_only_public_key().0).is_ok();
    let tx = Transaction { inputs, outputs, nonce, signatures: TransactionSignature::NaiveMultisig(vec![signature]) };
    let outcome = client.api().submit_transaction(tx).await.try_into_inner(client.decoders())
        .map_err(|e| anyhow!("the guardians' answer did not decode: {e}"))?;
    report["signature_verifies"] = verifies.into();
    match outcome.0 { Ok(_) => report["accepted"] = true.into(), Err(e) => { report["accepted"] = false.into(); report["error"] = e.to_string().into(); } }
    println!("{report}");
    Ok(())
}

/// `arena-claim-read` (offline; stdin { config, firstSession, sessions: [hex, ...], roundId? }): THE PROOF READER OF OFFENCE ROWS (a) AND (b)
/// (ruling #1131 4). Every session is checked against the federation's broadcast keys from the given config (consensus bytes) - a session
/// that does not verify is named and read no further - and every Arena-lock input of every accepted transaction is listed: its session,
/// the transaction, the outpoint, Claim (with its preimage) or Cancel or Refund, the named signers, and the transaction's outputs as the
/// table row reads them (each stock payout contract's fields, each Arena lock's id). With `roundId`, only locks funded in these sessions
/// with that round id are listed (a lock funded earlier is listed with `round_id: null` unless its funding session is included).
pub fn claim_read() -> anyhow::Result<serde_json::Value> {
    use fedimint_core::config::ClientConfig;
    use fedimint_core::encoding::{Decodable, Encodable as _};
    use fedimint_core::epoch::ConsensusItem;
    use fedimint_core::module::registry::ModuleDecoderRegistry;
    use fedimint_core::session_outcome::SignedSessionOutcome;
    use std::collections::BTreeMap;
    let mut raw = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut raw)?;
    let input: serde_json::Value = serde_json::from_str(&raw).context("stdin is no JSON object")?;
    let config = ClientConfig::consensus_decode_whole(&hex_bytes(input.get("config").and_then(|v| v.as_str()).context("no config")?)?,
        &ModuleDecoderRegistry::default().with_fallback())?;
    let keys = config.global.broadcast_public_keys.clone().context("the config names no broadcast keys")?;
    let kinds: BTreeMap<_, String> = config.modules.iter().map(|(id, m)| (*id, m.kind.to_string())).collect();
    let lnv2 = kinds.iter().find(|(_, k)| k.as_str() == "lnv2").map(|(id, _)| *id).context("the federation has no lnv2 module")?;
    let decoders = crate::audit::offline_decoders(&kinds);
    let first = input.get("firstSession").and_then(serde_json::Value::as_u64).context("no firstSession")?;
    let only_round = input.get("roundId").and_then(|v| v.as_str()).map(|s| s.to_lowercase());
    let sessions = input.get("sessions").and_then(|v| v.as_array()).context("no sessions")?;
    let mut funded: BTreeMap<String, ArenaLockContract> = BTreeMap::new();
    let (mut spends, mut unverified) = (Vec::new(), Vec::new());
    for (i, h) in sessions.iter().enumerate() {
        let idx = first + i as u64;
        let sso = match h.as_str().and_then(|h| hex_bytes(h).ok()).and_then(|b| SignedSessionOutcome::consensus_decode_whole(&b, &decoders).ok()) {
            Some(s) if s.verify(&keys, idx) => s,
            _ => { unverified.push(idx); continue; }
        };
        for item in &sso.session_outcome.items {
            let ConsensusItem::Transaction(tx) = &item.item else { continue };
            let txid = tx.tx_hash();
            let outputs: Vec<serde_json::Value> = tx.outputs.iter().enumerate().map(|(o, out)| {
                if out.module_instance_id() != lnv2 { return serde_json::json!({ "out_idx": o, "module": kinds.get(&out.module_instance_id()) }) }
                match out.as_any().downcast_ref::<LightningOutput>() {
                    Some(LightningOutput::V0(LightningOutputV0::Outgoing(c))) => serde_json::json!({ "out_idx": o, "kind": "outgoing",
                        "contract_id": c.contract_id().0.to_string(), "amount_msat": c.amount.msats, "expiration": c.expiration,
                        "claim_pk": c.claim_pk.to_string(), "refund_pk": c.refund_pk.to_string(),
                        "payment_image": match &c.payment_image { PaymentImage::Hash(h) => h.to_string(), PaymentImage::Point(p) => p.to_string() } }),
                    Some(LightningOutput::ArenaLock(c)) => {
                        funded.insert(format!("{txid}:{o}"), c.clone());
                        let mut j = contract_json(c); j["out_idx"] = o.into(); j["kind"] = "arena-lock".into(); j
                    }
                    _ => serde_json::json!({ "out_idx": o, "kind": "lnv2-other" }),
                }
            }).collect();
            // PROOF (a), ruling #1135 2: S read from the transaction's claims (all must name the same S), KeyAgg(S) from the lock's keys, the body id
            let named: Vec<(Vec<u8>, Option<ArenaLockContract>)> = tx.inputs.iter().filter(|i| i.module_instance_id() == lnv2).filter_map(|i| match i.as_any().downcast_ref::<LightningInput>() {
                Some(LightningInput::ArenaLock(op, ArenaLockWitness::Claim { signers, .. })) => Some((signers.clone(), funded.get(&format!("{}:{}", op.txid, op.out_idx)).cloned())),
                _ => None }).collect();
            let one_set = named.windows(2).all(|w| w[0].0 == w[1].0);
            let agg = named.first().and_then(|(set, c)| c.as_ref().and_then(|c| c.signer_key(set).ok()));
            let tx_body = (!named.is_empty() && one_set).then(|| agg.map(|k| hex(&body_id(&tx.inputs, &tx.outputs, tx.nonce, lnv2, Some(k))))).flatten();
            for input in &tx.inputs {
                if input.module_instance_id() != lnv2 { continue }
                let Some(LightningInput::ArenaLock(op, w)) = input.as_any().downcast_ref::<LightningInput>() else { continue };
                let lock = funded.get(&format!("{}:{}", op.txid, op.out_idx));
                if let (Some(r), Some(c)) = (&only_round, lock) { if &hex(&c.round_id) != r { continue } }
                let (kind, signers, preimage, signature) = match w {
                    ArenaLockWitness::Claim { preimage, signers } => ("claim", signers.clone(), Some(hex(preimage)), None),
                    ArenaLockWitness::Cancel { signers, signature } => ("cancel", signers.clone(), None, Some(hex(&signature.serialize()))),
                    ArenaLockWitness::Refund => ("refund", vec![], None, None),
                };
                spends.push(serde_json::json!({
                    "session": idx, "txid": txid.to_string(), "outpoint": format!("{}:{}", op.txid, op.out_idx), "kind": kind,
                    "signers": signers, "named_keys": lock.map(|c| signers.iter().filter_map(|&s| c.claim_keys.get(usize::from(s)).map(|k| k.to_string())).collect::<Vec<_>>()),
                    "preimage": preimage, "forfeit_signature": signature,
                    "lock": lock.map(contract_json), "outputs": outputs,
                    "body_id": tx_body, "one_signer_set": one_set, "agg_key": agg.map(|k| k.x_only_public_key().0.to_string()),
                    "tx_bytes": hex(&tx.consensus_encode_to_vec()),
                }));
            }
        }
    }
    Ok(serde_json::json!({ "mode": "arena-claim-read", "federation_id": config.calculate_federation_id().to_string(),
        "first_session": first, "sessions": sessions.len(), "unverified": unverified, "spends": spends }))
}
