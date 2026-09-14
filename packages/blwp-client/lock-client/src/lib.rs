//! THE LOCK CLIENT (W1a, W1b): what the player's page runs to make its stake
//! lock (v4.6.2 §23.1 steps 3-4), on the stock fedimint 0.12.0 client crates,
//! built to wasm. One `LockClient` holds one in-memory client for one session:
//!
//!   federationIdOf(invite)             the federation an invite names, hex
//!   join(invite, federation_id, secret, store)
//!                                      the round's federation - refused if the
//!                                      invite names another - under the
//!                                      player's own secret for this round, its
//!                                      state kept in the tab (store.rs): a
//!                                      reloaded page reopens the same wallet
//!   lockCostMsat(msat)                 what locking msat costs this ecash: the
//!                                      amount and the federation's fee quote
//!   depositFor(msat)                   the invoice that credits msat of ecash,
//!                                      through a gateway the federation lists
//!   receive(msat, gateway)             a deposit invoice ("" = the federation's)
//!   awaitReceive(operation)            until the deposit is Claimed
//!   lock(point, msat, claim, refund, delta)
//!                                      one OutgoingContract funded from that
//!                                      ecash - payment_image Point(stake_point),
//!                                      claim_pk the attested key, refund_pk the
//!                                      player, expiration = count + delta - and
//!                                      what the guardians stored at its outpoint
//!
//! The lock is built exactly as tools/stake-lock's lock mode builds it; this
//! is that code for the browser's target. No consensus code and no crypto of
//! ours: the stock transaction builder funds the output, the stock contract
//! hashes itself.
use std::str::FromStr;

mod store;

use fedimint_api_client::api::{DynModuleApi, FederationApiExt};
use fedimint_client::transaction::{
    ClientInput, ClientInputBundle, ClientOutput, ClientOutputBundle, TransactionBuilder,
};
use fedimint_client::{Client, ClientHandle, RootSecret};
use fedimint_connectors::ConnectorRegistry;
use fedimint_core::core::{IntoDynInstance, ModuleInstanceId, OperationId};
use fedimint_core::db::Database;
use fedimint_core::invite_code::InviteCode;
use fedimint_core::module::{Amounts, ApiRequestErased};
use fedimint_core::secp256k1::{PublicKey, SECP256K1, SecretKey};
use fedimint_core::util::SafeUrl;
use fedimint_core::{Amount, OutPoint, TransactionId};
use fedimint_derive_secret::DerivableSecret;
use fedimint_lnv2_client::{FinalReceiveOperationState, FinalSendOperationState, LightningClientModule};
use fedimint_core::bitcoin::hashes::sha256;
use fedimint_lnv2_common::config::LightningClientConfig;
use fedimint_lnv2_common::contracts::{OutgoingContract, PaymentImage};
use fedimint_lnv2_common::gateway_api::PaymentFee;
use fedimint_lnv2_common::endpoint_constants::{
    CONSENSUS_BLOCK_COUNT_ENDPOINT, OUTGOING_CONTRACT_EXPIRATION_ENDPOINT,
};
use fedimint_lnv2_common::{
    Bolt11InvoiceDescription, ContractId, KIND, LightningInput, LightningInputV0, LightningOutput, LightningOutputV0,
    OutgoingWitness,
};
use wasm_bindgen::prelude::{JsError, wasm_bindgen};

fn js(e: impl std::fmt::Display) -> JsError { JsError::new(&e.to_string()) }

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(s: &str);
    #[wasm_bindgen(js_namespace = console, js_name = trace)]
    fn console_trace(s: &str);
}

/// A PANIC IS SAID, NOT SWALLOWED. Without this a panic in the stock client is
/// a bare `RuntimeError: unreachable` and the page's promise never settles -
/// measured: a reloaded page sat on "recovering" with no word of why.
#[wasm_bindgen(start)]
pub fn said_on_panic() {
    std::panic::set_hook(Box::new(|info| {
        console_error(&format!("blwp-lock-client panicked: {info}"));
        // AND WHERE FROM: the JS stack carries the wasm frames by name.
        console_trace("blwp-lock-client panic stack");
    }));
}

fn secret_from_hex(s: &str) -> Result<[u8; 32], JsError> {
    if s.len() != 64 || !s.is_ascii() {
        return Err(js("the lock client's secret is 32 bytes of hex"));
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).map_err(js)?;
    }
    Ok(out)
}

/// The ecash an invoice of `invoice` msat credits: the gateway's receive fee
/// comes off the invoice (the contract amount, as the stock client computes
/// it), and the federation's fee for claiming that contract comes off that.
async fn credited(ln: &LightningClientModule, fee: &PaymentFee, invoice: u64) -> anyhow::Result<u64> {
    let contract = fee.subtract_from(invoice);
    let claim = ln.receive_fee_quote(contract).await?.total().get_bitcoin();
    Ok(contract.msats.saturating_sub(claim.msats))
}

async fn block_count(api: &DynModuleApi) -> anyhow::Result<u64> {
    Ok(api.request_current_consensus(CONSENSUS_BLOCK_COUNT_ENDPOINT.to_string(), ApiRequestErased::new(())).await?)
}

/// What the guardians hold at an outpoint: the contract id and the blocks LEFT.
async fn stored_at(api: &DynModuleApi, outpoint: OutPoint) -> anyhow::Result<Option<(ContractId, u64)>> {
    Ok(api.request_current_consensus(OUTGOING_CONTRACT_EXPIRATION_ENDPOINT.to_string(), ApiRequestErased::new(outpoint)).await?)
}

#[wasm_bindgen]
pub struct LockClient {
    client: ClientHandle,
    lnv2: ModuleInstanceId,
}

#[wasm_bindgen]
impl LockClient {
    /// The federation an invite code names, as hex - the id a Round Contract carries.
    #[wasm_bindgen(js_name = federationIdOf)]
    pub fn federation_id_of(invite: String) -> Result<String, JsError> {
        Ok(InviteCode::from_str(&invite).map_err(js)?.federation_id().to_string())
    }

    /// A client of the federation the invite names - REFUSED unless that
    /// federation is `federation_id` (hex, the round's), so a link cannot send
    /// the stake to another federation. Its root is the player's own `secret`
    /// (32 bytes hex, from their seed, per round), and its state is kept in
    /// `store`, the tab's: a page reloaded after the deposit reopens the wallet
    /// that holds it - and a deposit still being claimed resumes - instead of
    /// joining an empty one.
    pub async fn join(
        invite: String,
        federation_id: String,
        secret: String,
        store: store::LockStore,
    ) -> Result<LockClient, JsError> {
        let invite = InviteCode::from_str(&invite).map_err(js)?;
        let named = invite.federation_id().to_string();
        if named != federation_id.to_ascii_lowercase() {
            return Err(js(format!(
                "that invite is to federation {named}, and this round's stake goes into {federation_id}"
            )));
        }
        let secret = secret_from_hex(&secret)?;
        let mut builder = Client::builder().await.map_err(js)?;
        builder.with_module(fedimint_mintv2_client::MintClientInit);
        builder.with_module(fedimint_lnv2_client::LightningClientInit::default());
        let connectors = ConnectorRegistry::build_from_client_defaults().bind().await.map_err(js)?;
        let root = RootSecret::StandardDoubleDerive(DerivableSecret::new_root(&secret, b"BLWP/v1/LockClient"));
        let (tab, _kept) = store::TabDatabase::load(store).map_err(js)?;
        let db: Database = tab.into();
        let client = if Client::is_initialized(&db).await {
            builder.open(connectors, db, root).await.map_err(js)?
        } else {
            let preview = builder.preview(connectors, &invite).await.map_err(js)?;
            preview.join(db, root).await.map_err(js)?
        };
        if client.federation_id().to_string() != named {
            return Err(js("the wallet this tab kept is another federation's"));
        }
        let lnv2 = client.get_first_instance(&KIND).ok_or_else(|| js("this federation has no lnv2 module"))?;
        Ok(LockClient { client, lnv2 })
    }

    /// THE PLAYER'S REFUND (§23.2: nobody acted, and the lock expired). The
    /// stake lock at `txid:out_idx`, rebuilt from `fields` (the JSON a seat
    /// keeps: paymentImage, amountMsat, claimPk, refundPk, expiration), spent by
    /// `OutgoingWitness::Refund` and signed by the player's own key -
    /// `player_secret`, 32 bytes hex, negated when its point is odd-y, since the
    /// lock's refund_pk is the even-y point of the x-only player key. The
    /// guardians take it only at or past the lock's expiration; a refusal is
    /// reported, not thrown. JSON: { accepted, txid, error, block_count,
    /// expiration, stored_before, stored_after, balance_before, balance_after }.
    pub async fn refund(
        &self,
        txid: String,
        out_idx: u32,
        fields: String,
        player_secret: String,
    ) -> Result<String, JsError> {
        let f: serde_json::Value = serde_json::from_str(&fields).map_err(js)?;
        let text = |k: &str| {
            f.get(k).and_then(|v| v.as_str()).map(str::to_owned).ok_or_else(|| js(format!("the lock names no {k}")))
        };
        let image = f.get("paymentImage").ok_or_else(|| js("the lock names no payment image"))?;
        let bytes = image.get("bytes").and_then(|v| v.as_str()).ok_or_else(|| js("the lock's image has no bytes"))?;
        // A STAKE LOCK'S IMAGE IS A POINT; A PAYOUT CONTRACT'S (W4, 6d) IS A HASH - a
        // pre-expired lock the seats' settlement made to the winner's key, spent the
        // same way, by Refund under that key, open at once.
        let payment_image = match image.get("kind").and_then(|v| v.as_str()) {
            Some("point") => PaymentImage::Point(PublicKey::from_str(bytes).map_err(js)?),
            Some("hash") => PaymentImage::Hash(sha256::Hash::from_str(bytes).map_err(js)?),
            _ => return Err(js("a lock's image is a point or a hash")),
        };
        let refund_pk = PublicKey::from_str(&text("refundPk")?).map_err(js)?;
        let expiration = f.get("expiration").and_then(|v| v.as_u64()).ok_or_else(|| js("the lock names no expiration"))?;
        let contract = OutgoingContract {
            payment_image,
            amount: Amount::from_msats(text("amountMsat")?.parse().map_err(js)?),
            expiration,
            claim_pk: PublicKey::from_str(&text("claimPk")?).map_err(js)?,
            refund_pk,
            ephemeral_pk: refund_pk,
        };
        let mut secret = SecretKey::from_slice(&secret_from_hex(&player_secret)?).map_err(js)?;
        if PublicKey::from_secret_key(SECP256K1, &secret) != refund_pk {
            secret = secret.negate();
        }
        if PublicKey::from_secret_key(SECP256K1, &secret) != refund_pk {
            return Err(js("that key is not the lock's refund key"));
        }
        let signer = secret.keypair(SECP256K1);
        let api = self.client.api().with_module(self.lnv2);
        let outpoint = OutPoint { txid: TransactionId::from_str(&txid).map_err(js)?, out_idx: u64::from(out_idx) };
        let before = stored_at(&api, outpoint).await.map_err(js)?;
        if let Some((id, _)) = before {
            if id != contract.contract_id() {
                return Err(js("the guardians hold another contract at that outpoint than this lock's"));
            }
        }
        let count = block_count(&api).await.map_err(js)?;
        let balance_before = self.client.get_balance_for_btc().await.map_err(js)?;
        let bundle = ClientInputBundle::new_no_sm(vec![ClientInput {
            input: LightningInput::V0(LightningInputV0::Outgoing(outpoint, OutgoingWitness::Refund)),
            keys: vec![signer],
            amounts: Amounts::new_bitcoin(contract.amount),
        }])
        .into_dyn(self.lnv2);
        let operation = OperationId::new_random();
        let (accepted, refund_txid, error) = match self
            .client
            .finalize_and_submit_transaction(operation, "blwp-stake-refund", |_| (), TransactionBuilder::new().with_inputs(bundle))
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
        // THE NOTES THE REFUND MINTS arrive after the transaction is accepted;
        // the balance is read once they have (bounded).
        let mut balance_after = self.client.get_balance_for_btc().await.map_err(js)?;
        for _ in 0..100 {
            if !accepted || balance_after > balance_before {
                break;
            }
            fedimint_core::runtime::sleep(fedimint_core::runtime::Duration::from_millis(200)).await;
            balance_after = self.client.get_balance_for_btc().await.map_err(js)?;
        }
        let after = stored_at(&api, outpoint).await.map_err(js)?;
        let stored = |s: Option<(ContractId, u64)>| s.map(|(id, left)| serde_json::json!({ "contract_id": id.0.to_string(), "blocks_left": left }));
        Ok(serde_json::json!({
            "accepted": accepted, "txid": refund_txid.map(|t| t.to_string()), "error": error,
            "block_count": count, "expiration": expiration, "amount_msat": contract.amount.msats,
            "stored_before": stored(before), "stored_after": stored(after),
            "balance_before": balance_before.msats, "balance_after": balance_after.msats,
        })
        .to_string())
    }

    /// THE PLAYER'S REDEEM OF A FORFEITED LOCK (§23.2 row 1: "the player's own
    /// client redeems it, and only the player can"). The lock at `txid:out_idx`,
    /// rebuilt from `fields` as `refund` rebuilds it, spent by
    /// `OutgoingWitness::Cancel(forfeit)` - the committee's BIP-340 signature by
    /// claim_pk over the contract id - and signed by the player's own key. Open
    /// at any time, before the expiry or after. The stock contract says whether
    /// the forfeit verifies; the transaction is submitted either way, so a
    /// forfeit that does not verify is refused by the guardians, not by this
    /// client. JSON: { forfeit_verifies, accepted, txid, error, block_count,
    /// expiration, stored_before, stored_after, balance_before, balance_after }.
    pub async fn redeem(
        &self,
        txid: String,
        out_idx: u32,
        fields: String,
        forfeit: String,
        player_secret: String,
    ) -> Result<String, JsError> {
        let f: serde_json::Value = serde_json::from_str(&fields).map_err(js)?;
        let text = |k: &str| {
            f.get(k).and_then(|v| v.as_str()).map(str::to_owned).ok_or_else(|| js(format!("the lock names no {k}")))
        };
        let image = f.get("paymentImage").ok_or_else(|| js("the lock names no payment image"))?;
        if image.get("kind").and_then(|v| v.as_str()) != Some("point") {
            return Err(js("only a stake lock, whose image is a point, is redeemed here"));
        }
        let point = image.get("bytes").and_then(|v| v.as_str()).ok_or_else(|| js("the lock's image has no bytes"))?;
        let refund_pk = PublicKey::from_str(&text("refundPk")?).map_err(js)?;
        let expiration = f.get("expiration").and_then(|v| v.as_u64()).ok_or_else(|| js("the lock names no expiration"))?;
        let contract = OutgoingContract {
            payment_image: PaymentImage::Point(PublicKey::from_str(point).map_err(js)?),
            amount: Amount::from_msats(text("amountMsat")?.parse().map_err(js)?),
            expiration,
            claim_pk: PublicKey::from_str(&text("claimPk")?).map_err(js)?,
            refund_pk,
            ephemeral_pk: refund_pk,
        };
        let sig_bytes = (0..forfeit.len())
            .step_by(2)
            .map(|i| forfeit.get(i..i + 2).and_then(|b| u8::from_str_radix(b, 16).ok()))
            .collect::<Option<Vec<u8>>>()
            .ok_or_else(|| js("a forfeit is 64 bytes of hex"))?;
        let sig = fedimint_core::secp256k1::schnorr::Signature::from_slice(&sig_bytes).map_err(js)?;
        let forfeit_verifies = contract.verify_forfeit_signature(&sig);
        let mut secret = SecretKey::from_slice(&secret_from_hex(&player_secret)?).map_err(js)?;
        if PublicKey::from_secret_key(SECP256K1, &secret) != refund_pk {
            secret = secret.negate();
        }
        if PublicKey::from_secret_key(SECP256K1, &secret) != refund_pk {
            return Err(js("that key is not the lock's refund key"));
        }
        let signer = secret.keypair(SECP256K1);
        let api = self.client.api().with_module(self.lnv2);
        let outpoint = OutPoint { txid: TransactionId::from_str(&txid).map_err(js)?, out_idx: u64::from(out_idx) };
        let before = stored_at(&api, outpoint).await.map_err(js)?;
        if let Some((id, _)) = before {
            if id != contract.contract_id() {
                return Err(js("the guardians hold another contract at that outpoint than this lock's"));
            }
        }
        let count = block_count(&api).await.map_err(js)?;
        let balance_before = self.client.get_balance_for_btc().await.map_err(js)?;
        let bundle = ClientInputBundle::new_no_sm(vec![ClientInput {
            input: LightningInput::V0(LightningInputV0::Outgoing(outpoint, OutgoingWitness::Cancel(sig))),
            keys: vec![signer],
            amounts: Amounts::new_bitcoin(contract.amount),
        }])
        .into_dyn(self.lnv2);
        let operation = OperationId::new_random();
        let (accepted, redeem_txid, error) = match self
            .client
            .finalize_and_submit_transaction(operation, "blwp-stake-redeem", |_| (), TransactionBuilder::new().with_inputs(bundle))
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
        let after = stored_at(&api, outpoint).await.map_err(js)?;
        let stored = |s: Option<(ContractId, u64)>| s.map(|(id, left)| serde_json::json!({ "contract_id": id.0.to_string(), "blocks_left": left }));
        Ok(serde_json::json!({
            "forfeit_verifies": forfeit_verifies, "accepted": accepted, "txid": redeem_txid.map(|t| t.to_string()),
            "error": error, "block_count": count, "expiration": expiration, "amount_msat": contract.amount.msats,
            "stored_before": stored(before), "stored_after": stored(after),
            "balance_before": balance_before.msats, "balance_after": balance_after.msats,
        })
        .to_string())
    }

    /// The largest invoice this client can pay out of its balance through a
    /// gateway the federation lists - the gateway's fee and the federation's
    /// both taken off (the stock client's own sum), in msat.
    #[wasm_bindgen(js_name = withdrawableMsat)]
    pub async fn withdrawable_msat(&self) -> Result<String, JsError> {
        let ln = self.client.get_first_module::<LightningClientModule>().map_err(js)?;
        let balance = self.client.get_balance_for_btc().await.map_err(js)?;
        Ok(ln.spendable_amount(balance, None).await.map_err(js)?.msats.to_string())
    }

    /// THE WITHDRAW: the stock LNv2 send of this client's ecash to `invoice`
    /// (the player's own wallet's), through a gateway the federation lists. The
    /// gateway is paid only against the invoice's preimage; otherwise the
    /// contract refunds this client. JSON: { state, preimage, invoice_msat,
    /// balance_before, balance_after }.
    pub async fn withdraw(&self, invoice: String) -> Result<String, JsError> {
        let ln = self.client.get_first_module::<LightningClientModule>().map_err(js)?;
        let invoice: lightning_invoice::Bolt11Invoice = invoice.trim().parse().map_err(|e| js(format!("{e:?}")))?;
        let invoice_msat = invoice.amount_milli_satoshis();
        let balance_before = self.client.get_balance_for_btc().await.map_err(js)?;
        // THE GATEWAY `send` WOULD PICK, picked by the same stock call and
        // handed to it, so the withdraw can say which one carried it.
        let (gateway, _) = ln.select_gateway(Some(invoice.clone())).await.map_err(js)?;
        let op = ln.send(invoice, Some(gateway.clone()), serde_json::Value::Null).await.map_err(js)?;
        let (state, preimage) = match ln.await_final_send_operation_state(op).await.map_err(js)? {
            FinalSendOperationState::Success(p) => ("Success", Some(p.iter().map(|b| format!("{b:02x}")).collect::<String>())),
            FinalSendOperationState::Refunded => ("Refunded", None),
            FinalSendOperationState::Failure => ("Failure", None),
        };
        let balance_after = self.client.get_balance_for_btc().await.map_err(js)?;
        Ok(serde_json::json!({
            "state": state, "preimage": preimage, "invoice_msat": invoice_msat, "gateway": gateway.to_string(),
            "balance_before": balance_before.msats, "balance_after": balance_after.msats,
        })
        .to_string())
    }

    /// The client's ecash, in msat, as a decimal string.
    #[wasm_bindgen(js_name = balanceMsat)]
    pub async fn balance_msat(&self) -> Result<String, JsError> {
        Ok(self.client.get_balance_for_btc().await.map_err(js)?.msats.to_string())
    }

    /// What locking `amount_msat` costs this client's ecash: the amount plus the
    /// federation's own quote for that transaction (one Lightning output), as a
    /// decimal string. Point-in-time: it moves with the notes the client holds.
    #[wasm_bindgen(js_name = lockCostMsat)]
    pub async fn lock_cost_msat(&self, amount_msat: String) -> Result<String, JsError> {
        let ln = self.client.get_first_module::<LightningClientModule>().map_err(js)?;
        let amount = Amount::from_msats(amount_msat.parse().map_err(js)?);
        let fee = ln.send_fee_quote(amount).await.map_err(js)?.total().get_bitcoin();
        Ok((amount.msats + fee.msats).to_string())
    }

    /// The federation-fee allowance for a transaction of `amount_msat` BEFORE
    /// this client holds notes to quote it with (`lockCostMsat` is a dry run
    /// over the notes held, and an empty client cannot run it): the stock
    /// `PaymentFee::TRANSACTION_FEE_DEFAULT`, "the fee the gateway uses to
    /// cover transaction fees with the federation". Not ours; the quote, once
    /// there are notes, is what decides.
    #[wasm_bindgen(js_name = lockAllowanceMsat)]
    pub fn lock_allowance_msat(amount_msat: String) -> Result<String, JsError> {
        let msats: u64 = amount_msat.parse().map_err(js)?;
        Ok(PaymentFee::TRANSACTION_FEE_DEFAULT.fee(msats).msats.to_string())
    }

    /// The smallest invoice that credits at least `ecash_msat` of ecash, through
    /// a gateway the federation lists: JSON { invoice_msat, credited_msat, gateway }.
    /// Both fees are the ones the gateway and the federation publish.
    #[wasm_bindgen(js_name = depositFor)]
    pub async fn deposit_for(&self, ecash_msat: String) -> Result<String, JsError> {
        let ln = self.client.get_first_module::<LightningClientModule>().map_err(js)?;
        let want: u64 = ecash_msat.parse().map_err(js)?;
        let (gateway, routing) = ln.select_gateway(None).await.map_err(js)?;
        let fee = routing.receive_fee;
        let mut hi = want.max(1);
        for _ in 0..40 {
            if credited(&ln, &fee, hi).await.map_err(js)? >= want { break; }
            hi = hi.saturating_mul(2);
        }
        let mut lo = want;
        if credited(&ln, &fee, hi).await.map_err(js)? < want {
            return Err(js(format!("no invoice through {gateway} credits {want} msat")));
        }
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if credited(&ln, &fee, mid).await.map_err(js)? >= want { hi = mid } else { lo = mid + 1 }
        }
        Ok(serde_json::json!({
            "invoice_msat": hi.to_string(),
            "credited_msat": credited(&ln, &fee, hi).await.map_err(js)?.to_string(),
            "gateway": gateway.to_string(),
        })
        .to_string())
    }

    /// A deposit invoice for `amount_msat` through the gateway at `gateway`, or
    /// one the federation lists when `gateway` is empty: JSON { invoice, operation }.
    pub async fn receive(&self, amount_msat: String, gateway: String) -> Result<String, JsError> {
        let ln = self.client.get_first_module::<LightningClientModule>().map_err(js)?;
        let amount = Amount::from_msats(amount_msat.parse().map_err(js)?);
        let description = Bolt11InvoiceDescription::Direct(String::new());
        let gateway = if gateway.is_empty() { None } else { Some(SafeUrl::parse(&gateway).map_err(js)?) };
        let (invoice, op) = ln
            .receive(amount, 3600, description, gateway, serde_json::Value::Null)
            .await
            .map_err(js)?;
        Ok(serde_json::json!({ "invoice": invoice.to_string(), "operation": op.fmt_full().to_string() }).to_string())
    }

    /// Until the deposit is final: "Claimed", "Expired" or "Failure".
    #[wasm_bindgen(js_name = awaitReceive)]
    pub async fn await_receive(&self, operation: String) -> Result<String, JsError> {
        let ln = self.client.get_first_module::<LightningClientModule>().map_err(js)?;
        let op = OperationId::from_str(&operation).map_err(js)?;
        Ok(match ln.await_final_receive_operation_state(op).await.map_err(js)? {
            FinalReceiveOperationState::Claimed => "Claimed",
            FinalReceiveOperationState::Expired => "Expired",
            FinalReceiveOperationState::Failure => "Failure",
        }
        .to_owned())
    }

    /// THE FEDERATION'S OWN LNv2 FEE RULE, off its config - `base + amount *
    /// ppm / 1e6` on every input and every output (lnv2-common config.rs) - as
    /// JSON { fee_ppm, fee_base_msat }. The page's fee-lock gate reads it here,
    /// from the federation it joined, and not from a seat's word.
    #[wasm_bindgen(js_name = feeRule)]
    pub async fn fee_rule(&self) -> Result<String, JsError> {
        let config = self.client.config().await;
        let fee = config
            .modules
            .get(&self.lnv2)
            .ok_or_else(|| js("no lnv2 config"))?
            .cast::<LightningClientConfig>()
            .map_err(js)?
            .fee_consensus
            .clone();
        Ok(serde_json::json!({ "fee_ppm": fee.parts_per_million, "fee_base_msat": fee.base.msats }).to_string())
    }

    /// THE STAKE LOCK: one stock OutgoingContract funded from this client's
    /// ecash, then what the guardians stored at its outpoint beside what was
    /// computed. `point`, `claim_pk`, `refund_pk` are 33-byte compressed hex.
    pub async fn lock(
        &self,
        point: String,
        amount_msat: String,
        claim_pk: String,
        refund_pk: String,
        expiry_delta: u32,
    ) -> Result<String, JsError> {
        let image = PaymentImage::Point(PublicKey::from_str(&point).map_err(js)?);
        self.lock_to(image, amount_msat, claim_pk, refund_pk, expiry_delta).await
    }

    /// THE FEE LOCK (F5, Pick b): the same contract to a HASH image, H(F) -
    /// `hash` 32-byte hex - so claiming the fee never publishes the stake's P.
    #[wasm_bindgen(js_name = lockHash)]
    pub async fn lock_hash(
        &self,
        hash: String,
        amount_msat: String,
        claim_pk: String,
        refund_pk: String,
        expiry_delta: u32,
    ) -> Result<String, JsError> {
        let image = PaymentImage::Hash(sha256::Hash::from_str(&hash).map_err(js)?);
        self.lock_to(image, amount_msat, claim_pk, refund_pk, expiry_delta).await
    }
}

impl LockClient {
    async fn lock_to(
        &self,
        payment_image: PaymentImage,
        amount_msat: String,
        claim_pk: String,
        refund_pk: String,
        expiry_delta: u32,
    ) -> Result<String, JsError> {
        let api = self.client.api().with_module(self.lnv2);
        let count = block_count(&api).await.map_err(js)?;
        let refund_pk = PublicKey::from_str(&refund_pk).map_err(js)?;
        let contract = OutgoingContract {
            payment_image,
            amount: Amount::from_msats(amount_msat.parse().map_err(js)?),
            expiration: count + u64::from(expiry_delta),
            claim_pk: PublicKey::from_str(&claim_pk).map_err(js)?,
            refund_pk,
            ephemeral_pk: refund_pk,
        };
        let contract_id = contract.contract_id();
        let bundle = ClientOutputBundle::new_no_sm(vec![ClientOutput {
            output: LightningOutput::V0(LightningOutputV0::Outgoing(contract.clone())),
            amounts: Amounts::new_bitcoin(contract.amount),
        }])
        .into_dyn(self.lnv2);
        let operation = OperationId::new_random();
        let change = self
            .client
            .finalize_and_submit_transaction(operation, "blwp-lock-client", |_| (), TransactionBuilder::new().with_outputs(bundle))
            .await
            .map_err(js)?;
        let txid = change.txid();
        self.client
            .transaction_updates(operation)
            .await
            .await_tx_accepted(txid)
            .await
            .map_err(|e| js(format!("the guardians did not accept the lock transaction: {e}")))?;
        for out_idx in 0..16u64 {
            let outpoint = OutPoint { txid, out_idx };
            if let Some((stored_id, blocks_left)) = stored_at(&api, outpoint).await.map_err(js)? {
                let at_read = block_count(&api).await.map_err(js)?;
                return Ok(serde_json::json!({
                    "txid": txid.to_string(), "out_idx": out_idx,
                    "block_count_at_lock": count, "expiry_delta": expiry_delta,
                    "computed_contract_id": contract_id.0.to_string(), "computed_expiration": contract.expiration,
                    "stored_contract_id": stored_id.0.to_string(), "stored_blocks_left": blocks_left,
                    "block_count_at_read": at_read, "stored_expiration": at_read + blocks_left,
                    "ids_match": stored_id == contract_id, "amount_msat": contract.amount.msats,
                })
                .to_string());
            }
        }
        Err(js(format!("the lock transaction {txid} was accepted but no outpoint of it holds an outgoing contract")))
    }
}
