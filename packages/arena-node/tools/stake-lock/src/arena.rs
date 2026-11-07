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
//!   arena-lock          the arena-id fields with --expiry-delta BLOCKS instead of --expiration (and --stall-blocks N instead of
//!                       --fallback-after B, kanban #1281): funds one lock
//!   arena-status        --outpoint TXID:IDX
//!   arena-redeem        --outpoint TXID:IDX --signer-secret HEX (--witness refund | --witness cancel --signers I,.. --forfeit-sig HEX)
//!   arena-settle        --locks TXID:IDX:PREIMAGE[,...] --signers I,.. --nonce HEX16 --payouts ... [--signature HEX]
//! OFFLINE, ON STDIN (a proof's own bytes): arena-claim-read (the Arena-lock spends of signed sessions) and arena-body (the settlement body of
//! locks those sessions funded, as arena-settle builds it without signers)
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
/// The fallback height (spec §23.2, kanban #1281): `--fallback-after B` as given, or, with `--stall-blocks N`, the lock's
/// block count (`base`) plus N.
fn fallback_after(a: &Args, base: Option<u64>) -> anyhow::Result<u64> {
    if let Some(f) = a.get("fallback-after") { return Ok(f.parse()?); }
    let stall: u64 = need(a, "stall-blocks")?.parse()?;
    base.map(|b| b + stall).ok_or_else(|| anyhow!("--fallback-after B, or --stall-blocks N with --expiry-delta"))
}

pub fn contract(a: &Args, expiration: u64) -> anyhow::Result<ArenaLockContract> {
    contract_with(a, expiration, None)
}

/// The contract, its fallback height from `--fallback-after` or the lock's block count `base` plus `--stall-blocks`.
pub fn contract_with(a: &Args, expiration: u64, base: Option<u64>) -> anyhow::Result<ArenaLockContract> {
    let payment_image = match a.get("point") {
        Some(point) => PaymentImage::Point(PublicKey::from_str(point)?),
        None => PaymentImage::Hash(sha256::Hash::from_str(need(a, "hash")?)?),
    };
    Ok(ArenaLockContract {
        payment_image,
        amount: Amount::from_msats(need(a, "amount-msat")?.parse()?),
        expiration,
        fallback_after: fallback_after(a, base)?,
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
        "fallback_after": c.fallback_after,
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
    let c = contract_with(a, count + delta, Some(count))?;
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
        // the fallback claim's signers are written as the empty list too (kanban #1281): seats commit before its S is known
        Some(LightningInput::ArenaLock(op, ArenaLockWitness::Fallback { .. })) =>
            LightningInput::ArenaLock(*op, ArenaLockWitness::Fallback { signers: vec![] }).into_dyn(lnv2),
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

/// A lock as --locks and arena-body name it: TXID:IDX:PREIMAGE.
fn lock_spec(spec: &str) -> anyhow::Result<(OutPoint, [u8; 32])> {
    let parts: Vec<&str> = spec.split(':').collect();
    let [txid, idx, preimage] = parts[..] else { bail!("a lock is TXID:IDX:PREIMAGE") };
    Ok((outpoint(&format!("{txid}:{idx}"))?, bytes32(preimage, "a preimage")?))
}

/// What a settlement body is built from and what it is: the claims, the locks they open, the payout contracts (Z where the plan puts the
/// signer set's key), the body id, and the report arena-settle and arena-body print.
pub struct Body {
    pub claims: Vec<(OutPoint, [u8; 32])>,
    pub locks: Vec<(OutPoint, ArenaLockContract)>,
    pub contracts: Vec<OutgoingContract>,
    pub body: [u8; 32],
    pub report: serde_json::Value,
    /// The fallback claim (spec §23.2, kanban #1281): every lock in as Fallback naming t - 1 seats, no preimage.
    pub fallback: bool,
}

/// How a settlement spends its locks: the claim (each with its preimage), or the fallback claim (spec §23.2, kanban #1281) - no preimage,
/// t - 1 named seats, from each lock's fallback_after; `count` the guardians' block count when read (arena-settle), None offline.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Path { Claim, Fallback { count: Option<u64> } }

/// The inputs and outputs of a settlement: every lock in as Claim naming `set`, every payout out, Z written as `swap.1` where `swap` is given.
fn settlement_parts(claims: &[(OutPoint, [u8; 32])], contracts: &[OutgoingContract], set: &[u8], swap: Option<(PublicKey, PublicKey)>, lnv2: ModuleInstanceId)
    -> (Vec<fedimint_core::core::DynInput>, Vec<fedimint_core::core::DynOutput>) {
    settlement_parts_as(claims, contracts, set, swap, lnv2, false)
}

/// The same, every lock in as Fallback naming `set` when `fallback` (kanban #1281).
fn settlement_parts_as(claims: &[(OutPoint, [u8; 32])], contracts: &[OutgoingContract], set: &[u8], swap: Option<(PublicKey, PublicKey)>, lnv2: ModuleInstanceId,
    fallback: bool) -> (Vec<fedimint_core::core::DynInput>, Vec<fedimint_core::core::DynOutput>) {
    let ins = claims.iter().map(|(op, pre)| LightningInput::ArenaLock(*op, if fallback { ArenaLockWitness::Fallback { signers: set.to_vec() } }
        else { ArenaLockWitness::Claim { preimage: *pre, signers: set.to_vec() } }).into_dyn(lnv2)).collect();
    let outs = contracts.iter().map(|c| {
        let o = LightningOutput::V0(LightningOutputV0::Outgoing(c.clone()));
        match swap { Some((z, k)) => swap_output(&o, &z, &k), None => o }.into_dyn(lnv2)
    }).collect();
    (ins, outs)
}

/// THE SETTLEMENT BODY FROM LOCKS ALREADY IN HAND (ruling #1135 1): `given` each claimed lock's outpoint, preimage and contract - read from the guardians
/// (arena-settle) or from the signed sessions that funded it (arena-body, offline). The same checks either way: every preimage opens its lock, one
/// signer set, and the payouts and their fees within what the locks pay; so both modes answer the same body id for the same claims, payouts and nonce.
pub fn settlement_body(given: Vec<(OutPoint, [u8; 32], ArenaLockContract)>, payout_list: &str, nonce: [u8; 8], fee: &fedimint_lnv2_common::config::FeeConsensus,
    lnv2: ModuleInstanceId) -> anyhow::Result<Body> {
    settlement_body_as(given, payout_list, nonce, fee, lnv2, Path::Claim)
}

/// The body by `path`: a claim checks every preimage; the fallback (kanban #1281) checks no preimage and, with the guardians' count, that every
/// lock's fallback_after has passed and its expiration has not.
pub fn settlement_body_as(given: Vec<(OutPoint, [u8; 32], ArenaLockContract)>, payout_list: &str, nonce: [u8; 8], fee: &fedimint_lnv2_common::config::FeeConsensus,
    lnv2: ModuleInstanceId, path: Path) -> anyhow::Result<Body> {
    let mut claims = Vec::new();
    let mut locks: Vec<(OutPoint, ArenaLockContract)> = Vec::new();
    let (mut input_msats, mut input_fee_msats) = (0u64, 0u64);
    for (op, preimage, c) in given {
        match path {
            Path::Claim => if !c.verify_preimage(&preimage) { bail!("that preimage does not open the lock at {}:{}", op.txid, op.out_idx) },
            Path::Fallback { count } => if let Some(n) = count {
                if n < c.fallback_after { bail!("the lock at {}:{} opens its fallback at {}, the guardians count {n}", op.txid, op.out_idx, c.fallback_after) }
                if n >= c.expiration { bail!("the lock at {}:{} has expired (at {}): only its refund is left", op.txid, op.out_idx, c.expiration) }
            },
        }
        if let Some((_, first)) = locks.first() {
            if first.claim_keys != c.claim_keys || first.threshold != c.threshold { bail!("the locks name different claim keys or thresholds: one transaction is one signer set") }
        }
        input_msats += c.amount.msats;
        input_fee_msats += fee.fee(c.amount).msats;
        claims.push((op, preimage));
        locks.push((op, c));
    }
    if locks.is_empty() { bail!("a settlement claims at least one lock") }
    let z = z_key();
    let contracts = payouts(&payout_list.replace(":Z:", &format!(":{z}:")).split(',').map(|p| if p.starts_with("Z:") { p.replacen('Z', &z.to_string(), 1) } else { p.to_owned() }).collect::<Vec<_>>().join(","))?;
    let spendable = input_msats - input_fee_msats;
    let out: u64 = contracts.iter().map(|c| c.amount.msats).sum();
    let out_fee: u64 = contracts.iter().map(|c| fee.fee(c.amount).msats).sum();
    if out + out_fee > spendable {
        bail!("the payouts ({out} msat, {out_fee} msat in fees) are more than the locks pay for ({spendable} msat after their own fees)");
    }
    let fallback = matches!(path, Path::Fallback { .. });
    let (ins, outs) = settlement_parts_as(&claims, &contracts, &[], None, lnv2, fallback);
    let body = body_id(&ins, &outs, nonce, lnv2, None);
    let z_slots = contracts.iter().enumerate().filter(|(_, c)| c.claim_pk == z || c.refund_pk == z || c.ephemeral_pk == z).map(|(i, _)| i).collect::<Vec<_>>();
    let report = serde_json::json!({
        "mode": "arena-settle", "fallback": fallback, "body_id": hex(&body), "z_key": z.to_string(), "z_slots": z_slots,
        "inputs": locks.iter().map(|(o, c)| serde_json::json!({ "outpoint": format!("{}:{}", o.txid, o.out_idx),
            "contract_id": c.contract_id().0.to_string(), "round_id": hex(&c.round_id), "msat": c.amount.msats })).collect::<Vec<_>>(),
        "input_msat": input_msats, "input_fees_msat": input_fee_msats, "payout_msat": out, "output_fee_msat": out_fee,
        "unspent_msat": spendable - out - out_fee,
    });
    Ok(Body { claims, locks, contracts, body, report, fallback })
}

/// `arena-settle`: the settlement's one transaction, as ruling #1135 orders it. Every given Arena lock in as Claim, the payouts out; a payout key
/// written `Z` is the signer set's key. Without --signers: THE BODY (empty signer lists, Z in place) and its id - what the seats ack and commit
/// over. With --signers (S, the t lowest committed seats): the real transaction (S in every claim, KeyAgg(S) for every Z), its txid - the MuSig2
/// message - and its body id again, which must be the same. With --signature: checked under KeyAgg(S) and submitted. All locks must name the same
/// keys and threshold: one transaction, one S, one signature listed per input.
pub async fn settle(a: &Args, client: &ClientHandle, lnv2: ModuleInstanceId, api: &DynModuleApi) -> anyhow::Result<()> {
    require_module(api).await?;
    let nonce: [u8; 8] = hex_bytes(need(a, "nonce")?)?.try_into().map_err(|_| anyhow!("--nonce is 8 bytes"))?;
    let fee = fee_rule(&client.config().await, lnv2)?;
    let mut given = Vec::new();
    // THE FALLBACK CLAIM (spec §23.2, kanban #1281): --fallback 1 - the locks named TXID:IDX (no preimage), t - 1 signers, each lock past its fallback_after
    let fallback = a.get("fallback").is_some_and(|v| v == "1");
    for spec in need(a, "locks")?.split(',') {
        let (op, preimage) = if fallback { (outpoint(spec)?, [0u8; 32]) } else { lock_spec(spec)? };
        let Some((c, _)) = stored(api, op).await? else { bail!("the guardians hold no Arena lock at {}:{}", op.txid, op.out_idx) };
        given.push((op, preimage, c));
    }
    let path = if fallback { Path::Fallback { count: Some(block_count(api).await?) } } else { Path::Claim };
    let Body { claims, locks, contracts, body, mut report, .. } = settlement_body_as(given, need(a, "payouts")?, nonce, &fee, lnv2, path)?;
    let (_, first) = locks.first().cloned().context("a settlement claims at least one lock")?;
    let z = z_key();
    let build = |set: &[u8], agg: Option<PublicKey>| settlement_parts_as(&claims, &contracts, set, agg.map(|k| (z, k)), lnv2, fallback);
    let Some(set) = a.get("signers") else { println!("{report}"); return Ok(()) };
    let set: Vec<u8> = set.split(',').map(|i| Ok(i.parse()?)).collect::<anyhow::Result<_>>()?;
    let key = if fallback { first.fallback_key(&set) } else { first.signer_key(&set) }.map_err(|e| anyhow!("{e}"))?;
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

/// The nonce of a send's presigned refund (c) (ruled #1136): the first 8 bytes of BIP-340 tagged_hash("ARENA/v1/SendRefundNonce", the real txid
/// (32 bytes, consensus order) || the send's output index as u32 big-endian), so every seat rebuilds the same transaction. An index above
/// u32::MAX is refused, never clamped: two sends must never share a nonce.
pub fn send_refund_nonce(txid: &fedimint_core::TransactionId, idx: u64) -> anyhow::Result<[u8; 8]> {
    let i = u32::try_from(idx).map_err(|_| anyhow!("a send's output index {idx} is above u32::MAX: no refund nonce"))?;
    let mut m = txid[..].to_vec();
    m.extend_from_slice(&i.to_be_bytes());
    Ok(tagged(b"ARENA/v1/SendRefundNonce", &m)[..8].try_into().expect("8 bytes"))
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
    let nonce = send_refund_nonce(&op.txid, op.out_idx)?;
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
    let (mut spends, mut unverified, mut fundings) = (Vec::new(), Vec::new(), Vec::new());
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
                        // WHERE EACH ARENA LOCK WAS FUNDED (ruling #1139 B): a seat verifying a lock reads back to this session and keeps it as its bound
                        fundings.push(serde_json::json!({ "session": idx, "outpoint": format!("{txid}:{o}"), "round_id": hex(&c.round_id) }));
                        let mut j = contract_json(c); j["out_idx"] = o.into(); j["kind"] = "arena-lock".into(); j
                    }
                    _ => serde_json::json!({ "out_idx": o, "kind": "lnv2-other" }),
                }
            }).collect();
            // PROOF (a), ruling #1135 2: S read from the transaction's claims (all must name the same S), KeyAgg(S) from the lock's keys, the body id
            let named: Vec<(Vec<u8>, Option<ArenaLockContract>)> = tx.inputs.iter().filter(|i| i.module_instance_id() == lnv2).filter_map(|i| match i.as_any().downcast_ref::<LightningInput>() {
                Some(LightningInput::ArenaLock(op, ArenaLockWitness::Claim { signers, .. })) => Some((signers.clone(), funded.get(&format!("{}:{}", op.txid, op.out_idx)).cloned())),
                // a fallback claim names its t - 1 signers the same way, and they answer for its table as a claim's do (spec §23.2, kanban #1281)
                Some(LightningInput::ArenaLock(op, ArenaLockWitness::Fallback { signers })) => Some((signers.clone(), funded.get(&format!("{}:{}", op.txid, op.out_idx)).cloned())),
                _ => None }).collect();
            let one_set = named.windows(2).all(|w| w[0].0 == w[1].0);
            let fallback_tx = tx.inputs.iter().any(|i| matches!(i.as_any().downcast_ref::<LightningInput>(), Some(LightningInput::ArenaLock(_, ArenaLockWitness::Fallback { .. }))));
            let agg = named.first().and_then(|(set, c)| c.as_ref().and_then(|c| if fallback_tx { c.fallback_key(set).ok() } else { c.signer_key(set).ok() }));
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
                    ArenaLockWitness::Fallback { signers } => ("fallback", signers.clone(), None, None),
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
        "first_session": first, "sessions": sessions.len(), "unverified": unverified, "spends": spends, "fundings": fundings }))
}

/// `arena-body` (offline; stdin { config, firstSession, sessions: [hex, ...], locks: "TXID:IDX:PREIMAGE,...", payouts: as --payouts, nonce: HEX16 }):
/// THE CORRECT SETTLEMENT BODY OF A LEVEL-1 PROOF (a), REBUILT WITHOUT THE GUARDIANS (kanban #1044 B1). A proof exists only once its claim spent the
/// round's locks, so the guardians no longer hold them; their contracts are read from the sessions that funded them instead - every session verified
/// against the config's broadcast keys, as arena-claim-read does - and the body is built as arena-settle builds it (settlement_body), the fee rule
/// from the same config. A lock funded in no given session, a session that does not verify, or a body the checks refuse is answered
/// { ok: false, why }: the proof's own bytes do not rebuild it. Otherwise { ok: true, body_id, z_slots, ... }.
pub fn body_offline() -> anyhow::Result<serde_json::Value> {
    use fedimint_core::config::ClientConfig;
    use fedimint_core::encoding::Decodable;
    use fedimint_core::epoch::ConsensusItem;
    use fedimint_core::module::registry::ModuleDecoderRegistry;
    use fedimint_core::session_outcome::SignedSessionOutcome;
    use std::collections::BTreeMap;
    let mut raw = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut raw)?;
    let input: serde_json::Value = serde_json::from_str(&raw).context("stdin is no JSON object")?;
    let refuse = |why: String| Ok(serde_json::json!({ "mode": "arena-body", "ok": false, "why": why }));
    let config_bytes = hex_bytes(input.get("config").and_then(|v| v.as_str()).context("no config")?)?;
    let raw_config = ClientConfig::consensus_decode_whole(&config_bytes, &ModuleDecoderRegistry::default().with_fallback())?;
    let kinds: BTreeMap<_, String> = raw_config.modules.iter().map(|(id, m)| (*id, m.kind.to_string())).collect();
    let lnv2 = kinds.iter().find(|(_, k)| k.as_str() == "lnv2").map(|(id, _)| *id).context("the federation has no lnv2 module")?;
    let decoders = crate::audit::offline_decoders(&kinds);
    // DECODED AGAIN WITH THE MODULES' OWN DECODERS, so the lnv2 config (its fee rule) is read and not kept as raw bytes
    let config = ClientConfig::consensus_decode_whole(&config_bytes, &decoders)?;
    let fee = fee_rule(&config, lnv2)?;
    let keys = config.global.broadcast_public_keys.clone().context("the config names no broadcast keys")?;
    let first = input.get("firstSession").and_then(serde_json::Value::as_u64).context("no firstSession")?;
    let sessions = input.get("sessions").and_then(|v| v.as_array()).context("no sessions")?;
    let nonce: [u8; 8] = hex_bytes(input.get("nonce").and_then(|v| v.as_str()).context("no nonce")?)?.try_into().map_err(|_| anyhow!("the nonce is 8 bytes"))?;
    let payout_list = input.get("payouts").and_then(|v| v.as_str()).context("no payouts")?;
    let lock_list = input.get("locks").and_then(|v| v.as_str()).context("no locks")?;
    let mut funded: BTreeMap<String, (u64, ArenaLockContract)> = BTreeMap::new();
    for (i, h) in sessions.iter().enumerate() {
        let idx = first + i as u64;
        let Some(sso) = h.as_str().and_then(|h| hex_bytes(h).ok()).and_then(|b| SignedSessionOutcome::consensus_decode_whole(&b, &decoders).ok()).filter(|s| s.verify(&keys, idx))
        else { return refuse(format!("session {idx} does not verify against the federation's broadcast keys")) };
        for item in &sso.session_outcome.items {
            let ConsensusItem::Transaction(tx) = &item.item else { continue };
            let txid = tx.tx_hash();
            for (o, out) in tx.outputs.iter().enumerate() {
                if out.module_instance_id() != lnv2 { continue }
                if let Some(LightningOutput::ArenaLock(c)) = out.as_any().downcast_ref::<LightningOutput>() {
                    funded.insert(format!("{txid}:{o}"), (idx, c.clone()));
                }
            }
        }
    }
    let mut given = Vec::new();
    let mut found = Vec::new();
    for spec in lock_list.split(',') {
        let (op, preimage) = lock_spec(spec)?;
        let key = format!("{}:{}", op.txid, op.out_idx);
        let Some((session, c)) = funded.get(&key) else { return refuse(format!("no given session funds an Arena lock at {key}")) };
        found.push(serde_json::json!({ "outpoint": key, "session": session }));
        given.push((op, preimage, c.clone()));
    }
    let built = match settlement_body(given, payout_list, nonce, &fee, lnv2) { Ok(b) => b, Err(e) => return refuse(e.to_string()) };
    let mut report = built.report;
    let o = report.as_object_mut().expect("an object");
    o.insert("mode".into(), "arena-body".into());
    o.insert("ok".into(), true.into());
    o.insert("federation_id".into(), config.calculate_federation_id().to_string().into());
    o.insert("funded_in".into(), found.into());
    Ok(report)
}

#[cfg(test)]
mod tests {
    use fedimint_core::TransactionId;
    use fedimint_core::bitcoin::hashes::Hash as _;

    use super::{send_refund_nonce, z_key};

    fn lock(preimage: [u8; 32], amount: u64, keys: &[u8]) -> fedimint_lnv2_common::arena_lock::ArenaLockContract {
        use fedimint_core::secp256k1::{SECP256K1, SecretKey};
        fedimint_lnv2_common::arena_lock::ArenaLockContract {
            payment_image: fedimint_lnv2_common::contracts::PaymentImage::Hash(fedimint_core::bitcoin::hashes::sha256::Hash::hash(&preimage)),
            amount: fedimint_core::Amount::from_msats(amount), expiration: 1000, fallback_after: 900, round_id: [9; 32],
            claim_keys: keys.iter().map(|&k| SecretKey::from_slice(&[k; 32]).expect("a key").x_only_public_key(SECP256K1).0).collect(),
            threshold: 2, refund_pk: SecretKey::from_slice(&[0x77; 32]).expect("a key").public_key(SECP256K1),
        }
    }

    fn op(i: u8, idx: u64) -> fedimint_core::OutPoint { fedimint_core::OutPoint { txid: TransactionId::from_byte_array([i; 32]), out_idx: idx } }

    const PAYOUT: &str = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798:400000,Z:500000";

    #[test]
    fn the_offline_body_is_the_body_every_signer_set_strips_to() {
        let lnv2 = 1;
        let fee = fedimint_lnv2_common::config::FeeConsensus::new(0).expect("a fee rule");
        let given = vec![(op(1, 0), [1; 32], lock([1; 32], 600_000, &[11, 12, 13])), (op(2, 3), [2; 32], lock([2; 32], 400_000, &[11, 12, 13]))];
        let built = super::settlement_body(given.clone(), PAYOUT, [5; 8], &fee, lnv2).expect("a body");
        assert_eq!(built.report["z_slots"], serde_json::json!([1]));
        // the real transaction of any S: S in every claim, KeyAgg(S) where the body has Z - stripped back, the same id
        for set in [vec![0u8, 1], vec![1, 2]] {
            let key = built.locks[0].1.signer_key(&set).expect("a key");
            let (ins, outs) = super::settlement_parts(&built.claims, &built.contracts, &set, Some((z_key(), key)), lnv2);
            assert_eq!(super::body_id(&ins, &outs, [5; 8], lnv2, Some(key)), built.body);
        }
        // another nonce, another payout or one lock less: another body
        assert_ne!(super::settlement_body(given.clone(), PAYOUT, [6; 8], &fee, lnv2).expect("a body").body, built.body);
        assert_ne!(super::settlement_body(given.clone(), &PAYOUT.replace("400000", "399999"), [5; 8], &fee, lnv2).expect("a body").body, built.body);
        assert_ne!(super::settlement_body(given[..1].to_vec(), "Z:500000", [5; 8], &fee, lnv2).expect("a body").body, built.body);
    }

    #[test]
    fn the_offline_body_refuses_what_arena_settle_refuses() {
        let fee = fedimint_lnv2_common::config::FeeConsensus::new(0).expect("a fee rule");
        let wrong = super::settlement_body(vec![(op(1, 0), [2; 32], lock([1; 32], 600_000, &[11, 12, 13]))], "Z:500000", [5; 8], &fee, 1);
        assert!(wrong.err().expect("refused").to_string().contains("does not open"));
        let two_sets = super::settlement_body(vec![(op(1, 0), [1; 32], lock([1; 32], 600_000, &[11, 12, 13])), (op(2, 0), [2; 32], lock([2; 32], 600_000, &[11, 12, 14]))], "Z:500000", [5; 8], &fee, 1);
        assert!(two_sets.err().expect("refused").to_string().contains("one signer set"));
        let over = super::settlement_body(vec![(op(1, 0), [1; 32], lock([1; 32], 600_000, &[11, 12, 13]))], "Z:600001", [5; 8], &fee, 1);
        assert!(over.err().expect("refused").to_string().contains("more than the locks pay for"));
        assert!(super::settlement_body(vec![], "Z:1", [5; 8], &fee, 1).is_err());
    }

    /// The fallback claim's body (spec §23.2, kanban #1281): no preimage, t - 1 signers, written empty in the body as a claim's are.
    #[test]
    fn the_fallback_body_needs_no_preimage_and_every_t_minus_one_set_strips_to_it() {
        let lnv2 = 1;
        let fee = fedimint_lnv2_common::config::FeeConsensus::new(0).expect("a fee rule");
        // no preimage: the zero bytes stand in, and are not checked
        let given = vec![(op(1, 0), [0; 32], lock([1; 32], 600_000, &[11, 12, 13])), (op(2, 3), [0; 32], lock([2; 32], 400_000, &[11, 12, 13]))];
        let fb = |count| super::settlement_body_as(given.clone(), PAYOUT, [5; 8], &fee, lnv2, super::Path::Fallback { count });
        let built = fb(Some(950)).expect("a fallback body");
        assert!(built.fallback);
        assert_eq!(built.report["fallback"], serde_json::json!(true));
        for set in [vec![0u8], vec![2]] {
            let key = built.locks[0].1.fallback_key(&set).expect("t - 1 = one named seat");
            let (ins, outs) = super::settlement_parts_as(&built.claims, &built.contracts, &set, Some((z_key(), key)), lnv2, true);
            assert_eq!(super::body_id(&ins, &outs, [5; 8], lnv2, Some(key)), built.body);
        }
        assert!(built.locks[0].1.fallback_key(&[0, 1]).is_err(), "t names are the claim's, not the fallback's");
        // offline (no count) it builds the same body; the claim of the same locks is another body
        assert_eq!(fb(None).expect("offline").body, built.body);
        let with_preimages = vec![(op(1, 0), [1; 32], lock([1; 32], 600_000, &[11, 12, 13])), (op(2, 3), [2; 32], lock([2; 32], 400_000, &[11, 12, 13]))];
        assert_ne!(super::settlement_body(with_preimages, PAYOUT, [5; 8], &fee, lnv2).expect("a claim body").body, built.body);
        // before fallback_after (900), and from the expiration (1000): refused by name
        assert!(fb(Some(899)).err().expect("too early").to_string().contains("opens its fallback at 900"));
        assert!(fb(Some(1000)).err().expect("expired").to_string().contains("has expired"));
    }

    #[test]
    fn send_refund_nonce_is_the_ruled_hash_and_refuses_an_index_past_u32() {
        let txid = TransactionId::from_byte_array([7; 32]);
        // tagged_hash("ARENA/v1/SendRefundNonce", [7; 32] || 00000003)[..8], computed outside Rust
        assert_eq!(super::hex(&send_refund_nonce(&txid, 3).expect("index 3")), "ff96429f578a02c6");
        assert!(send_refund_nonce(&txid, u64::from(u32::MAX)).is_ok());
        assert!(send_refund_nonce(&txid, u64::from(u32::MAX) + 1).is_err());
        assert_ne!(send_refund_nonce(&txid, 0).expect("0"), send_refund_nonce(&txid, 1).expect("1"));
    }

    #[test]
    fn z_is_the_first_signer_set_tag_on_the_curve() {
        assert_eq!(z_key().to_string(), "02b3f7cd89f2ce17f8e075d67398c8e65f9952b877c2eae657d8236af11ca82f9d");
    }
}
