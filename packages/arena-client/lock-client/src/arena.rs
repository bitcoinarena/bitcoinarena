//! THE ARENA LOCK IN THE PLAYER'S CLIENT (kanban #1044 B1, ruling #1131): the stake or fee lock whose claim and forfeit
//! name their signers - the fork's LNv2 variant `ArenaLockContract`, not a stock `OutgoingContract`. The player funds it
//! to the round's settlement seats' node keys (`claim_keys`, seat order, at most 7) and threshold, and takes it back by
//! the named seats' forfeit or, from expiration, by the refund. Claiming is the seats' (tools/stake-lock arena-settle).
//!
//!   arenaLockContractId(fields)              the contract id (hex), no federation
//!   arenaModuleVersion()                     the federation's LNv2 module version; the lock needs 1.100
//!   arenaLock(fields, expiry_delta)          one Arena lock funded from this ecash, and what the guardians stored
//!   arenaLockSubmit(stake, fee, expiry_delta, donations)
//!                                            the stake lock, the fee lock (fee "" for none) and the donation outputs in ONE
//!                                            transaction, answered on submission (lockSubmit's shape, "arena": true)
//!   arenaLockAccepted(submitted)             its acceptance, every output read where it was built (lockAccepted's shape)
//!   arenaLockStatus(txid, out_idx)           the block count and the lock held there, if any
//!   arenaRedeem(txid, out_idx, witness, player_secret)
//!                                            witness {"kind":"cancel","signers":[..],"signature":HEX} or {"kind":"refund"}
//!
//! `fields`: { paymentImage: {kind: "point"|"hash", bytes}, amountMsat, expiration?, roundId (32-byte hex),
//! claimKeys: [x-only hex, ...], threshold, refundPk }.
use std::str::FromStr;

use fedimint_api_client::api::{DynModuleApi, FederationApiExt};
use fedimint_client::transaction::{
    ClientInput, ClientInputBundle, ClientOutput, ClientOutputBundle, TransactionBuilder,
};
use fedimint_core::bitcoin::hashes::sha256;
use fedimint_core::core::{IntoDynInstance, OperationId};
use fedimint_core::module::{Amounts, ApiRequestErased, ModuleConsensusVersion};
use fedimint_core::secp256k1::schnorr::Signature;
use fedimint_core::secp256k1::{PublicKey, SECP256K1, SecretKey, XOnlyPublicKey};
use fedimint_core::{Amount, OutPoint, TransactionId};
use fedimint_lnv2_common::arena_lock::{ArenaLockContract, ArenaLockWitness};
use fedimint_lnv2_common::contracts::{OutgoingContract, PaymentImage};
use fedimint_lnv2_common::endpoint_constants::{ARENA_LOCK_CONTRACT_ENDPOINT, MODULE_CONSENSUS_VERSION_ENDPOINT};
use fedimint_lnv2_common::{ARENA_LOCK_CONSENSUS_VERSION, LightningInput, LightningOutput, LightningOutputV0};
use wasm_bindgen::prelude::{JsError, wasm_bindgen};

use crate::{LockClient, block_count, consensus_with_retries, donation_image, js, secret_from_hex, stored_soon};

/// The federations a threshold of guardians said run the Arena lock (module version >= 1.100). A version never goes down
/// (ruling #1134 1), so a "yes" is kept for the page's life and a join asks once.
static ARENA_YES: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

fn contract_from_fields(fields: &str, expiration: Option<u64>) -> Result<ArenaLockContract, JsError> {
    contract_from_fields_at(fields, expiration, None)
}

/// The contract, with `base` the guardians' block count a lock is made at (its fallback height = base + stallBlocks).
fn contract_from_fields_at(fields: &str, expiration: Option<u64>, base: Option<u64>) -> Result<ArenaLockContract, JsError> {
    let f: serde_json::Value = serde_json::from_str(fields).map_err(js)?;
    let text = |k: &str| f.get(k).and_then(|v| v.as_str()).map(str::to_owned).ok_or_else(|| js(format!("the lock names no {k}")));
    let image = f.get("paymentImage").ok_or_else(|| js("the lock names no payment image"))?;
    let bytes = image.get("bytes").and_then(|v| v.as_str()).ok_or_else(|| js("the lock's image has no bytes"))?;
    let payment_image = match image.get("kind").and_then(|v| v.as_str()) {
        Some("point") => PaymentImage::Point(PublicKey::from_str(bytes).map_err(js)?),
        Some("hash") => PaymentImage::Hash(sha256::Hash::from_str(bytes).map_err(js)?),
        _ => return Err(js("a lock's image is a point or a hash")),
    };
    let round_id: [u8; 32] = secret_from_hex(&text("roundId")?).map_err(|_| js("roundId is 32 bytes of hex"))?;
    let claim_keys = f.get("claimKeys").and_then(|v| v.as_array()).ok_or_else(|| js("the lock names no claimKeys"))?
        .iter()
        .map(|k| k.as_str().ok_or_else(|| js("a claim key is hex")).and_then(|s| XOnlyPublicKey::from_str(s).map_err(js)))
        .collect::<Result<Vec<_>, _>>()?;
    let threshold = f.get("threshold").and_then(|v| v.as_u64()).ok_or_else(|| js("the lock names no threshold"))?;
    let expiration = match expiration {
        Some(e) => e,
        None => f.get("expiration").and_then(|v| v.as_u64()).ok_or_else(|| js("the lock names no expiration"))?,
    };
    // THE FALLBACK HEIGHT (spec §23.2, kanban #1281): `fallbackAfter` as named, or the lock's block count plus `stallBlocks`
    let fallback_after = match f.get("fallbackAfter").and_then(|v| v.as_u64()) {
        Some(b) => b,
        None => {
            let stall = f.get("stallBlocks").and_then(|v| v.as_u64()).ok_or_else(|| js("the lock names neither fallbackAfter nor stallBlocks"))?;
            base.map(|c| c + stall).ok_or_else(|| js("stallBlocks needs the guardians' block count: name fallbackAfter"))?
        }
    };
    Ok(ArenaLockContract {
        payment_image,
        amount: Amount::from_msats(text("amountMsat")?.parse().map_err(js)?),
        expiration,
        fallback_after,
        round_id,
        claim_keys,
        threshold: u8::try_from(threshold).map_err(js)?,
        refund_pk: PublicKey::from_str(&text("refundPk")?).map_err(js)?,
    })
}

async fn module_version(api: &DynModuleApi) -> anyhow::Result<ModuleConsensusVersion> {
    consensus_with_retries(|| async {
        Ok(api.request_current_consensus(MODULE_CONSENSUS_VERSION_ENDPOINT.to_string(), ApiRequestErased::new(())).await?)
    })
    .await
}

async fn stored(api: &DynModuleApi, outpoint: OutPoint) -> anyhow::Result<Option<(ArenaLockContract, u64)>> {
    consensus_with_retries(|| async {
        Ok(api.request_current_consensus(ARENA_LOCK_CONTRACT_ENDPOINT.to_string(), ApiRequestErased::new(outpoint)).await?)
    })
    .await
}

fn stored_json(s: &Option<(ArenaLockContract, u64)>) -> serde_json::Value {
    s.as_ref().map_or(serde_json::Value::Null, |(c, left)| {
        serde_json::json!({ "contract_id": c.contract_id().0.to_string(), "blocks_left": left, "expiration": c.expiration })
    })
}

#[wasm_bindgen]
impl LockClient {
    #[wasm_bindgen(js_name = arenaLockContractId)]
    pub fn arena_lock_contract_id(fields: String) -> Result<String, JsError> {
        Ok(contract_from_fields(&fields, None)?.contract_id().0.to_string())
    }

    #[wasm_bindgen(js_name = arenaModuleVersion)]
    pub async fn arena_module_version(&self) -> Result<String, JsError> {
        let api = self.client.api().with_module(self.lnv2);
        let v = module_version(&api).await.map_err(js)?;
        Ok(serde_json::json!({ "major": v.major, "minor": v.minor, "arenaLock": v >= ARENA_LOCK_CONSENSUS_VERSION }).to_string())
    }

    /// One Arena lock funded from this client's ecash, expiration = the guardians' block count + `expiry_delta`; refused
    /// here, before anything is paid, when the federation does not run the Arena lock or the guardians would refuse the
    /// fields (duplicate keys, threshold 0 or above the keys). JSON: { txid, out_idx, contract_id, expiration,
    /// blocks_left, ids_match }.
    #[wasm_bindgen(js_name = arenaLock)]
    pub async fn arena_lock(&self, fields: String, expiry_delta: u32) -> Result<String, JsError> {
        let api = self.client.api().with_module(self.lnv2);
        let v = module_version(&api).await.map_err(|e| js(format!("this federation does not run the Arena lock: {e}")))?;
        if v < ARENA_LOCK_CONSENSUS_VERSION {
            return Err(js(format!("this federation runs LNv2 {}.{}, the Arena lock needs 1.100", v.major, v.minor)));
        }
        let count = block_count(&api).await.map_err(js)?;
        let contract = contract_from_fields_at(&fields, Some(count + u64::from(expiry_delta)), Some(count))?;
        contract.validate().map_err(js)?;
        let bundle = ClientOutputBundle::new_no_sm(vec![ClientOutput {
            output: LightningOutput::ArenaLock(contract.clone()),
            amounts: Amounts::new_bitcoin(contract.amount),
        }])
        .into_dyn(self.lnv2);
        let operation = OperationId::new_random();
        let change = self
            .client
            .finalize_and_submit_transaction(operation, "arena-lock", |_| (), TransactionBuilder::new().with_outputs(bundle))
            .await
            .map_err(js)?;
        let txid = change.txid();
        self.client.transaction_updates(operation).await.await_tx_accepted(txid).await.map_err(js)?;
        for out_idx in 0..16u64 {
            let outpoint = OutPoint { txid, out_idx };
            if let Some((held, left)) = stored(&api, outpoint).await.map_err(js)? {
                if held.contract_id() == contract.contract_id() {
                    return Ok(serde_json::json!({
                        "txid": txid.to_string(), "out_idx": out_idx, "contract_id": held.contract_id().0.to_string(),
                        "expiration": held.expiration, "blocks_left": left, "ids_match": true,
                        "block_count_at_lock": count, "amount_msat": held.amount.msats,
                    })
                    .to_string());
                }
            }
        }
        Err(js(format!("the lock transaction {txid} was accepted but no outpoint of it holds this Arena lock")))
    }

    /// THE STAKE, ITS FEE LOCK AND THE PLAYER'S DONATION IN ONE TRANSACTION, FOR A PROTOCOL-27 ROUND (kanban #1044 B1): as
    /// `lockSubmit`, with the stake and the fee lock Arena locks (`stake`, `fee`: the lock fields without expiration; `fee` ""
    /// for none) and each donation the same pre-expired payout contract `lockSubmit` makes - the seats' verifyEntryGifts reads
    /// the donation outputs in the stake's own transaction. Refused before anything is paid when the federation does not run
    /// the Arena lock or a lock's fields would be refused. Answered on submission: { operation, txid, block_count_at_lock,
    /// expiry_delta, with_fee, arena: true, outputs: [{ out_idx, role, computed_contract_id, computed_expiration, amount_msat,
    /// recipient_pk }] }; `arenaLockAccepted` checks each against what the guardians store.
    #[wasm_bindgen(js_name = arenaLockSubmit)]
    pub async fn arena_lock_submit(&self, stake: String, fee: String, expiry_delta: u32, donations: String) -> Result<String, JsError> {
        let api = self.client.api().with_module(self.lnv2);
        let fed = self.client.federation_id().to_string();
        let known = ARENA_YES.lock().map(|g| g.contains(&fed)).unwrap_or(false);
        if !known {
            let v = module_version(&api).await.map_err(|e| js(format!("this federation does not run the Arena lock: {e}")))?;
            if v < ARENA_LOCK_CONSENSUS_VERSION {
                return Err(js(format!("this federation runs LNv2 {}.{}, the Arena lock needs 1.100", v.major, v.minor)));
            }
            if let Ok(mut g) = ARENA_YES.lock() {
                g.push(fed);
            }
        }
        let count = self.count_for_lock(&api).await.map_err(js)?;
        let expiration = count + u64::from(expiry_delta);
        let mut locks: Vec<(ArenaLockContract, &str)> = vec![(contract_from_fields_at(&stake, Some(expiration), Some(count))?, "stake")];
        let with_fee = !fee.trim().is_empty();
        if with_fee {
            locks.push((contract_from_fields_at(&fee, Some(expiration), Some(count))?, "fee"));
        }
        for (c, role) in &locks {
            c.validate().map_err(|e| js(format!("the {role} lock would be refused: {e}")))?;
        }
        let given: Vec<serde_json::Value> = serde_json::from_str(&donations).map_err(js)?;
        let mut gifts: Vec<OutgoingContract> = Vec::with_capacity(given.len());
        for d in &given {
            let pk = PublicKey::from_str(d.get("pk").and_then(|v| v.as_str()).ok_or_else(|| js("a donation names no pk"))?).map_err(js)?;
            let msat: u64 = d.get("msat").and_then(|v| v.as_str()).ok_or_else(|| js("a donation names no msat"))?.parse().map_err(js)?;
            if msat == 0 {
                return Err(js("a donation output of 0 msat is not made"));
            }
            gifts.push(OutgoingContract {
                payment_image: donation_image(d)?,
                amount: Amount::from_msats(msat),
                expiration: 0,
                claim_pk: pk,
                refund_pk: pk,
                ephemeral_pk: pk,
            });
        }
        let mut outputs: Vec<ClientOutput<LightningOutput>> = locks
            .iter()
            .map(|(c, _)| ClientOutput { output: LightningOutput::ArenaLock(c.clone()), amounts: Amounts::new_bitcoin(c.amount) })
            .collect();
        outputs.extend(gifts.iter().map(|c| ClientOutput {
            output: LightningOutput::V0(LightningOutputV0::Outgoing(c.clone())),
            amounts: Amounts::new_bitcoin(c.amount),
        }));
        let bundle = ClientOutputBundle::new_no_sm(outputs).into_dyn(self.lnv2);
        let operation = OperationId::new_random();
        let change = self
            .client
            .finalize_and_submit_transaction(operation, "arena-lock", |_| (), TransactionBuilder::new().with_outputs(bundle))
            .await
            .map_err(js)?;
        let txid = change.txid();
        let mut built: Vec<serde_json::Value> = locks
            .iter()
            .enumerate()
            .map(|(i, (c, role))| {
                serde_json::json!({ "out_idx": i, "role": role, "computed_contract_id": c.contract_id().0.to_string(),
                    "computed_expiration": c.expiration, "computed_fallback_after": c.fallback_after, "amount_msat": c.amount.msats, "recipient_pk": serde_json::Value::Null })
            })
            .collect();
        built.extend(gifts.iter().enumerate().map(|(i, c)| {
            serde_json::json!({ "out_idx": locks.len() + i, "role": "donation", "computed_contract_id": c.contract_id().0.to_string(),
                "computed_expiration": c.expiration, "amount_msat": c.amount.msats, "recipient_pk": c.refund_pk.to_string() })
        }));
        Ok(serde_json::json!({
            "operation": operation.fmt_full().to_string(), "txid": txid.to_string(), "block_count_at_lock": count,
            "expiry_delta": expiry_delta, "with_fee": with_fee, "arena": true, "outputs": built,
        })
        .to_string())
    }

    /// AND ITS ACCEPTANCE: `arenaLockSubmit`'s answer awaited until the guardians accept it, then every output read where it
    /// was built - an Arena lock by the Arena lock's endpoint, a donation as `lockAccepted` reads one - and its stored id
    /// compared with the id computed. JSON in `lockAccepted`'s shape: { stake, fee, donations }, each { txid, out_idx,
    /// computed_contract_id, stored_contract_id, computed_expiration, stored_expiration, ids_match, amount_msat, recipient_pk }.
    /// An output held nowhere is an error: the entry named that outpoint.
    #[wasm_bindgen(js_name = arenaLockAccepted)]
    pub async fn arena_lock_accepted(&self, submitted: String) -> Result<String, JsError> {
        let s: serde_json::Value = serde_json::from_str(&submitted).map_err(js)?;
        let operation = OperationId::from_str(s.get("operation").and_then(|v| v.as_str()).ok_or_else(|| js("no operation"))?).map_err(js)?;
        let txid = TransactionId::from_str(s.get("txid").and_then(|v| v.as_str()).ok_or_else(|| js("no txid"))?).map_err(js)?;
        let outputs = s.get("outputs").and_then(|v| v.as_array()).ok_or_else(|| js("no outputs"))?.clone();
        self.client
            .transaction_updates(operation)
            .await
            .await_tx_accepted(txid)
            .await
            .map_err(|e| js(format!("the guardians did not accept the lock transaction: {e}")))?;
        let api = self.client.api().with_module(self.lnv2);
        let at_read = block_count(&api).await.map_err(js)?;
        let mut stake = serde_json::Value::Null;
        let mut fee = serde_json::Value::Null;
        let mut donations = Vec::new();
        for o in &outputs {
            let out_idx = o.get("out_idx").and_then(|v| v.as_u64()).ok_or_else(|| js("an output names no index"))?;
            let role = o.get("role").and_then(|v| v.as_str()).unwrap_or("");
            let computed = o.get("computed_contract_id").and_then(|v| v.as_str()).unwrap_or("").to_owned();
            let outpoint = OutPoint { txid, out_idx };
            let (stored_id, stored_expiration) = if role == "donation" {
                let (id, left) = stored_soon(&api, outpoint, 40).await.map_err(js)?
                    .ok_or_else(|| js(format!("the lock transaction {txid} was accepted but its output {out_idx} holds no donation contract")))?;
                (id.0.to_string(), at_read + left)
            } else {
                let (held, _) = stored(&api, outpoint).await.map_err(js)?
                    .ok_or_else(|| js(format!("the lock transaction {txid} was accepted but its output {out_idx} holds no Arena lock")))?;
                (held.contract_id().0.to_string(), held.expiration)
            };
            let one = serde_json::json!({
                "txid": txid.to_string(), "out_idx": out_idx, "computed_contract_id": computed, "stored_contract_id": stored_id,
                "computed_expiration": o.get("computed_expiration").cloned().unwrap_or_default(), "stored_expiration": stored_expiration,
                "ids_match": stored_id == computed, "amount_msat": o.get("amount_msat").cloned().unwrap_or_default(),
                "recipient_pk": o.get("recipient_pk").cloned().unwrap_or_default(), "block_count_at_read": at_read,
            });
            match role {
                "stake" => stake = one,
                "fee" => fee = one,
                _ => donations.push(one),
            }
        }
        Ok(serde_json::json!({ "stake": stake, "fee": fee, "donations": donations }).to_string())
    }

    #[wasm_bindgen(js_name = arenaLockStatus)]
    pub async fn arena_lock_status(&self, txid: String, out_idx: u32) -> Result<String, JsError> {
        let api = self.client.api().with_module(self.lnv2);
        let outpoint = OutPoint { txid: TransactionId::from_str(&txid).map_err(js)?, out_idx: u64::from(out_idx) };
        let count = block_count(&api).await.map_err(js)?;
        let held = stored(&api, outpoint).await.map_err(js)?;
        Ok(serde_json::json!({ "block_count": count, "stored": stored_json(&held) }).to_string())
    }

    /// THE PLAYER TAKES AN ARENA LOCK BACK: by the named seats' forfeit (any time) or by the refund (from expiration),
    /// signed with the player's own key (negated when its point is odd-y, as `refund`). The lock is read from the
    /// guardians, so no fields are needed. A refusal is reported, not thrown. JSON: { forfeit_verifies, accepted, txid,
    /// error, block_count, expiration, stored_before, stored_after, balance_before, balance_after }.
    #[wasm_bindgen(js_name = arenaRedeem)]
    pub async fn arena_redeem(&self, txid: String, out_idx: u32, witness: String, player_secret: String) -> Result<String, JsError> {
        let api = self.client.api().with_module(self.lnv2);
        let outpoint = OutPoint { txid: TransactionId::from_str(&txid).map_err(js)?, out_idx: u64::from(out_idx) };
        let before = stored(&api, outpoint).await.map_err(js)?;
        let Some((contract, _)) = before.clone() else { return Err(js("the guardians hold no Arena lock at that outpoint")) };
        let w: serde_json::Value = serde_json::from_str(&witness).map_err(js)?;
        let (witness, forfeit_verifies) = match w.get("kind").and_then(|v| v.as_str()) {
            Some("cancel") => {
                let signers = w.get("signers").and_then(|v| v.as_array()).ok_or_else(|| js("a forfeit names its signers"))?
                    .iter()
                    .map(|i| i.as_u64().and_then(|i| u8::try_from(i).ok()).ok_or_else(|| js("a signer is a seat index")))
                    .collect::<Result<Vec<u8>, _>>()?;
                let hex = w.get("signature").and_then(|v| v.as_str()).ok_or_else(|| js("a forfeit has a signature"))?;
                let bytes = (0..hex.len()).step_by(2)
                    .map(|i| hex.get(i..i + 2).and_then(|b| u8::from_str_radix(b, 16).ok()))
                    .collect::<Option<Vec<u8>>>()
                    .ok_or_else(|| js("a forfeit is 64 bytes of hex"))?;
                let signature = Signature::from_slice(&bytes).map_err(js)?;
                let ok = contract.verify_forfeit_signature(&signers, &signature);
                (ArenaLockWitness::Cancel { signers, signature }, Some(ok))
            }
            Some("refund") => (ArenaLockWitness::Refund, None),
            _ => return Err(js("a witness is {kind: cancel, signers, signature} or {kind: refund}")),
        };
        let mut secret = SecretKey::from_slice(&secret_from_hex(&player_secret)?).map_err(js)?;
        if PublicKey::from_secret_key(SECP256K1, &secret) != contract.refund_pk {
            secret = secret.negate();
        }
        if PublicKey::from_secret_key(SECP256K1, &secret) != contract.refund_pk {
            return Err(js("that key is not the lock's refund key"));
        }
        let count = block_count(&api).await.map_err(js)?;
        let balance_before = self.client.get_balance_for_btc().await.map_err(js)?;
        let bundle = ClientInputBundle::new_no_sm(vec![ClientInput {
            input: LightningInput::ArenaLock(outpoint, witness),
            keys: vec![secret.keypair(SECP256K1)],
            amounts: Amounts::new_bitcoin(contract.amount),
        }])
        .into_dyn(self.lnv2);
        let operation = OperationId::new_random();
        let (accepted, spend_txid, error) = match self
            .client
            .finalize_and_submit_transaction(operation, "arena-lock-redeem", |_| (), TransactionBuilder::new().with_inputs(bundle))
            .await
        {
            Err(e) => (false, None, Some(format!("not submitted: {e}"))),
            Ok(change) => {
                let t = change.txid();
                match self.client.transaction_updates(operation).await.await_tx_accepted(t).await {
                    Ok(()) => (true, Some(t), None),
                    Err(e) => (false, Some(t), Some(e)),
                }
            }
        };
        let mut balance_after = self.client.get_balance_for_btc().await.map_err(js)?;
        for _ in 0..100 {
            if !accepted || balance_after > balance_before {
                break;
            }
            fedimint_core::runtime::sleep(fedimint_core::runtime::Duration::from_millis(200)).await;
            balance_after = self.client.get_balance_for_btc().await.map_err(js)?;
        }
        let after = stored(&api, outpoint).await.map_err(js)?;
        Ok(serde_json::json!({
            "forfeit_verifies": forfeit_verifies, "accepted": accepted, "txid": spend_txid.map(|t| t.to_string()),
            "error": error, "block_count": count, "expiration": contract.expiration, "amount_msat": contract.amount.msats,
            "stored_before": stored_json(&before), "stored_after": stored_json(&after),
            "balance_before": balance_before.msats, "balance_after": balance_after.msats,
        })
        .to_string())
    }
}
