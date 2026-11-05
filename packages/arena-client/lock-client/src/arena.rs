//! THE ARENA LOCK IN THE PLAYER'S CLIENT (kanban #1044 B1, ruling #1131): the stake or fee lock whose claim and forfeit
//! name their signers - the fork's LNv2 variant `ArenaLockContract`, not a stock `OutgoingContract`. The player funds it
//! to the round's settlement seats' node keys (`claim_keys`, seat order, at most 7) and threshold, and takes it back by
//! the named seats' forfeit or, from expiration, by the refund. Claiming is the seats' (tools/stake-lock arena-settle).
//!
//!   arenaLockContractId(fields)              the contract id (hex), no federation
//!   arenaModuleVersion()                     the federation's LNv2 module version; the lock needs 1.100
//!   arenaLock(fields, expiry_delta)          one Arena lock funded from this ecash, and what the guardians stored
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
use fedimint_lnv2_common::contracts::PaymentImage;
use fedimint_lnv2_common::endpoint_constants::{ARENA_LOCK_CONTRACT_ENDPOINT, MODULE_CONSENSUS_VERSION_ENDPOINT};
use fedimint_lnv2_common::{ARENA_LOCK_CONSENSUS_VERSION, LightningInput, LightningOutput};
use wasm_bindgen::prelude::{JsError, wasm_bindgen};

use crate::{LockClient, block_count, consensus_with_retries, js, secret_from_hex};

fn contract_from_fields(fields: &str, expiration: Option<u64>) -> Result<ArenaLockContract, JsError> {
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
    Ok(ArenaLockContract {
        payment_image,
        amount: Amount::from_msats(text("amountMsat")?.parse().map_err(js)?),
        expiration,
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
        let contract = contract_from_fields(&fields, Some(count + u64::from(expiry_delta)))?;
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
