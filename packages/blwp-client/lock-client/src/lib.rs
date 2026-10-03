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
use fedimint_core::{Amount, NumPeersExt, OutPoint, TransactionId};
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

/// A CONSENSUS REQUEST ASKED AGAIN WHEN THE GUARDIANS' SOCKETS FAIL (the owner 2026-10-02, playtest: "Not joined PAID ...
/// Federation rpc error { method => consensus_block_count, 2 => Transport error: WebSocket connection failed, 3 => ..., 5 =>
/// ... }"): a consensus answer needs the threshold of guardians, and from some networks a guardian's first socket fails
/// (measured: error, error, open on retry) - one try made it no answer and the join failed. Up to 8 tries, 300 ms doubling
/// to 3 s between them (~15 s at most); the last error is said if every try fails.
async fn consensus_with_retries<T, F, Fut>(mut ask: F) -> anyhow::Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<T>>,
{
    let mut wait = fedimint_core::runtime::Duration::from_millis(300);
    let mut last = None;
    for _ in 0..8 {
        match ask().await {
            Ok(v) => return Ok(v),
            Err(e) => last = Some(e),
        }
        fedimint_core::runtime::sleep(wait).await;
        wait = std::cmp::min(wait * 2, fedimint_core::runtime::Duration::from_secs(3));
    }
    Err(last.unwrap_or_else(|| anyhow::anyhow!("no answer")))
}

async fn block_count(api: &DynModuleApi) -> anyhow::Result<u64> {
    consensus_with_retries(|| async {
        Ok(api.request_current_consensus(CONSENSUS_BLOCK_COUNT_ENDPOINT.to_string(), ApiRequestErased::new(())).await?)
    })
    .await
}

/// What the guardians hold at an outpoint: the contract id and the blocks LEFT.
async fn stored_at(api: &DynModuleApi, outpoint: OutPoint) -> anyhow::Result<Option<(ContractId, u64)>> {
    consensus_with_retries(|| async {
        Ok(api.request_current_consensus(OUTGOING_CONTRACT_EXPIRATION_ENDPOINT.to_string(), ApiRequestErased::new(outpoint)).await?)
    })
    .await
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

    /// WHERE A LOCK STANDS, asked of the guardians without spending anything (W4 / 6d): the
    /// federation's block count and, while the contract is still at that outpoint, its id and
    /// the blocks left before its expiration. A page refunding a lock no seat will settle asks
    /// this first, so it does not send the guardians a refund they must refuse every few
    /// seconds until the expiry block. JSON: { block_count, stored: { contract_id,
    /// blocks_left } | null }.
    #[wasm_bindgen(js_name = lockStatus)]
    pub async fn lock_status(&self, txid: String, out_idx: u32) -> Result<String, JsError> {
        let api = self.client.api().with_module(self.lnv2);
        let outpoint = OutPoint { txid: TransactionId::from_str(&txid).map_err(js)?, out_idx: u64::from(out_idx) };
        let count = block_count(&api).await.map_err(js)?;
        let stored = stored_at(&api, outpoint).await.map_err(js)?;
        Ok(serde_json::json!({
            "block_count": count,
            "stored": stored.map(|(id, left)| serde_json::json!({ "contract_id": id.0.to_string(), "blocks_left": left })),
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
    pub async fn withdraw(&self, invoice: String, preferred: Option<String>) -> Result<String, JsError> {
        let ln = self.client.get_first_module::<LightningClientModule>().map_err(js)?;
        let invoice: lightning_invoice::Bolt11Invoice = invoice.trim().parse().map_err(|e| js(format!("{e:?}")))?;
        let invoice_msat = invoice.amount_milli_satoshis();
        let balance_before = self.client.get_balance_for_btc().await.map_err(js)?;
        // NEVER THE GATEWAY ON THE INVOICE'S OWN NODE (the owner 2026-10-01 08:34, measured: a withdrawal to an invoice
        // made on LND-a went to gateway A - the stock pick for a payee that is a gateway's node - which took it for a
        // federation receive and cancelled it, "No corresponding decryption contract available"; refunded). The
        // preferred gateway first (the page's funded one), then the federation's list: the first whose Lightning
        // node is not the payee. An invoice can be sent once, so the pick has to be right the first time.
        let payee = invoice.recover_payee_pub_key().serialize();
        let mut candidates: Vec<SafeUrl> = Vec::new();
        if let Some(p) = preferred.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
            if let Ok(u) = SafeUrl::parse(p) { candidates.push(u); }
        }
        for g in ln.list_gateways(None).await.map_err(js)? { if !candidates.contains(&g) { candidates.push(g); } }
        let mut chosen = None;
        for g in &candidates {
            if let Ok(Some(ri)) = ln.routing_info(g).await {
                if ri.lightning_public_key.serialize() != payee { chosen = Some(g.clone()); break; }
            }
        }
        let gateway = match chosen { Some(g) => g, None => ln.select_gateway(Some(invoice.clone())).await.map_err(js)?.0 };
        let op = ln.send(invoice, Some(gateway.clone()), serde_json::Value::Null).await.map_err(js)?;
        let (state, preimage) = match ln.await_final_send_operation_state(op).await.map_err(js)? {
            FinalSendOperationState::Success(p) => ("Success", Some(p.iter().map(|b| format!("{b:02x}")).collect::<String>())),
            FinalSendOperationState::Refunded => ("Refunded", None),
            FinalSendOperationState::Failure => ("Failure", None),
        };
        // WHY IT FAILED (measured 2026-10-01: "Failure" with no reason - the funding transaction was rejected and the
        // reason stayed inside the client): the federation's own answer on the funding transaction.
        let mut why: Option<String> = None;
        if state == "Failure" {
            if let Some(entry) = self.client.operation_log().get_operation(op).await {
                if let Ok(fedimint_lnv2_client::LightningOperationMeta::Send(m)) = entry.try_meta::<fedimint_lnv2_client::LightningOperationMeta>() {
                    let txid = m.change_outpoint_range.txid();
                    if let Err(e) = self.client.transaction_updates(op).await.await_tx_accepted(txid).await { why = Some(e); }
                }
            }
        }
        let balance_after = self.client.get_balance_for_btc().await.map_err(js)?;
        Ok(serde_json::json!({
            "state": state, "preimage": preimage, "why": why, "invoice_msat": invoice_msat, "gateway": gateway.to_string(),
            "balance_before": balance_before.msats, "balance_after": balance_after.msats,
        })
        .to_string())
    }

    /// THE SEND OPERATIONS THIS CLIENT KEEPS (read-only; measured 2026-10-01: a failed withdraw held 8192 msat that did
    /// not come back): each with its gateway, contract amount, funding transaction and the federation's answer on it -
    /// accepted, rejected with its reason, or undecided after 5 s. Spends nothing.
    #[wasm_bindgen(js_name = sendLog)]
    pub async fn send_log(&self) -> Result<String, JsError> {
        let ops = self.client.operation_log().paginate_operations_rev(30, None).await;
        let mut out = Vec::new();
        for (key, entry) in ops {
            let op = key.operation_id;
            let Ok(fedimint_lnv2_client::LightningOperationMeta::Send(m)) =
                entry.try_meta::<fedimint_lnv2_client::LightningOperationMeta>() else { continue };
            let txid = m.change_outpoint_range.txid();
            let client = &self.client;
            let wait = Box::pin(async { client.transaction_updates(op).await.await_tx_accepted(txid).await });
            let tick = Box::pin(fedimint_core::runtime::sleep(fedimint_core::runtime::Duration::from_secs(5)));
            let funding = match futures::future::select(wait, tick).await {
                futures::future::Either::Left((Ok(()), _)) => "accepted".to_owned(),
                futures::future::Either::Left((Err(e), _)) => format!("rejected: {e}"),
                futures::future::Either::Right(_) => "undecided".to_owned(),
            };
            out.push(serde_json::json!({ "operation": op.fmt_full().to_string(), "gateway": m.gateway.to_string(),
                "contract_msat": m.contract.amount.msats, "txid": txid.to_string(), "funding": funding }));
        }
        Ok(serde_json::Value::Array(out).to_string())
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

    /// THE FEDERATION'S GUARDIANS, off the config this client downloaded and
    /// checked on join (the owner 2026-09-15 07:33: every guardian has its own
    /// bond) - as JSON { federation_id, guardians, threshold, keys: [{ peer, key }] }.
    /// Each key is the guardian's 33-byte broadcast key, the one a census node
    /// advertises under guardian_of[] (§5A.1); the threshold is the federation's
    /// own n - floor((n-1)/3) over its API endpoints, which its id hashes. The
    /// same read as the seats' stake-lock `--mode guardians`, so the page counts
    /// bonded guardians against the federation's word and not a seat's.
    #[wasm_bindgen(js_name = guardians)]
    pub async fn guardians(&self) -> Result<String, JsError> {
        let config = self.client.config().await;
        let n = config.global.api_endpoints.to_num_peers();
        let keys = config
            .global
            .broadcast_public_keys
            .clone()
            .ok_or_else(|| js("this federation's config names no guardian broadcast keys"))?;
        let listed: Vec<serde_json::Value> = keys
            .iter()
            .map(|(peer, key)| serde_json::json!({ "peer": peer.to_string(), "key": key.to_string() }))
            .collect();
        Ok(serde_json::json!({
            "federation_id": self.client.federation_id().to_string(),
            "guardians": n.total(),
            "threshold": n.threshold(),
            "keys": listed,
        })
        .to_string())
    }

    /// THE WHOLE BALANCE AS E-CASH (the owner 2026-10-02: "Can't we show all wallets we have and combine all of them when
    /// playing a round?"): the stock mint module's send of everything this wallet holds, as the prefixed base32 string
    /// another wallet of the same federation receives. Answers {"msat", "ecash"}; ecash null when the wallet is empty.
    /// The caller keeps the string until it is received - spent here, it exists nowhere else.
    #[wasm_bindgen(js_name = sendAllEcash)]
    pub async fn send_all_ecash(&self) -> Result<String, JsError> {
        let mint = self.client.get_first_module::<fedimint_mintv2_client::MintClientModule>().map_err(js)?;
        let balance = self.client.get_balance_for_btc().await.map_err(js)?;
        if balance.msats == 0 {
            return Ok(serde_json::json!({ "msat": 0, "ecash": serde_json::Value::Null }).to_string());
        }
        let (_, ecash) = mint.send(balance, serde_json::Value::Null, false).await.map_err(js)?;
        Ok(serde_json::json!({
            "msat": balance.msats,
            "ecash": fedimint_core::base32::encode_prefixed(fedimint_core::base32::FEDIMINT_PREFIX, &ecash),
        })
        .to_string())
    }

    /// E-CASH IN: reissued into this wallet; answers once the federation has reissued it - {"state": "Success" |
    /// "Rejected" (already spent) | "AlreadyReceived"}.
    #[wasm_bindgen(js_name = receiveEcash)]
    pub async fn receive_ecash(&self, ecash: String) -> Result<String, JsError> {
        let mint = self.client.get_first_module::<fedimint_mintv2_client::MintClientModule>().map_err(js)?;
        let bytes = fedimint_core::base32::decode_prefixed(fedimint_core::base32::FEDIMINT_PREFIX, ecash.trim()).map_err(js)?;
        let operation = match mint.receive(bytes, serde_json::Value::Null).await {
            Ok(op) => op,
            Err(fedimint_mintv2_client::ReceiveECashError::AlreadyReceived) => {
                return Ok(serde_json::json!({ "state": "AlreadyReceived" }).to_string());
            }
            Err(e) => return Err(js(e)),
        };
        let state = mint.await_final_receive_operation_state(operation).await.map_err(js)?;
        Ok(serde_json::json!({ "state": format!("{state:?}") }).to_string())
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

    /// THE STAKE LOCK AND THE FEE LOCK IN ONE TRANSACTION (the owner 2026-10-02, the join's 2-3 s: "Cut whatever is between the
    /// click and the loaded round"). Measured on testnet4 the two locks were two transactions one after the other - each a
    /// block count, a submit, the wait for the guardians to accept it, a search of its outputs and a second block count:
    /// 'locking the stake' to 'fee lock: minted' 7.2 s in a paid join (Q4, 22:29:17-25Z). Here: one block count, one
    /// transaction carrying both outgoing contracts, one acceptance, and both outpoints read together - outputs 0 and 1 as
    /// built, any other output only if they are not it. Each contract is matched to its outpoint by the id the guardians
    /// store, so the answer is two answers of `lock`'s own shape ("stake", "fee"), checked by the page as before.
    #[wasm_bindgen(js_name = lockBoth)]
    pub async fn lock_both(
        &self,
        point: String,
        stake_msat: String,
        fee_hash: String,
        fee_msat: String,
        claim_pk: String,
        refund_pk: String,
        expiry_delta: u32,
    ) -> Result<String, JsError> {
        let api = self.client.api().with_module(self.lnv2);
        let count = block_count(&api).await.map_err(js)?;
        let refund = PublicKey::from_str(&refund_pk).map_err(js)?;
        let claim = PublicKey::from_str(&claim_pk).map_err(js)?;
        let make = |payment_image: PaymentImage, msat: &str| -> Result<OutgoingContract, JsError> {
            Ok(OutgoingContract {
                payment_image,
                amount: Amount::from_msats(msat.parse().map_err(js)?),
                expiration: count + u64::from(expiry_delta),
                claim_pk: claim,
                refund_pk: refund,
                ephemeral_pk: refund,
            })
        };
        let stake = make(PaymentImage::Point(PublicKey::from_str(&point).map_err(js)?), &stake_msat)?;
        let fee = make(PaymentImage::Hash(sha256::Hash::from_str(&fee_hash).map_err(js)?), &fee_msat)?;
        let outputs = [&stake, &fee]
            .iter()
            .map(|c| ClientOutput {
                output: LightningOutput::V0(LightningOutputV0::Outgoing((*c).clone())),
                amounts: Amounts::new_bitcoin(c.amount),
            })
            .collect::<Vec<_>>();
        let bundle = ClientOutputBundle::new_no_sm(outputs).into_dyn(self.lnv2);
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
        let ids = [stake.contract_id(), fee.contract_id()];
        let mut found: [Option<(u64, ContractId, u64)>; 2] = [None, None];
        let take = |found: &mut [Option<(u64, ContractId, u64)>; 2], out_idx: u64, got: Option<(ContractId, u64)>| {
            if let Some((id, left)) = got {
                for k in 0..2 {
                    if id == ids[k] && found[k].is_none() {
                        found[k] = Some((out_idx, id, left));
                    }
                }
            }
        };
        let (a, b) = futures::future::join(
            stored_at(&api, OutPoint { txid, out_idx: 0 }),
            stored_at(&api, OutPoint { txid, out_idx: 1 }),
        )
        .await;
        take(&mut found, 0, a.map_err(js)?);
        take(&mut found, 1, b.map_err(js)?);
        for out_idx in 2..16u64 {
            if found.iter().all(|f| f.is_some()) {
                break;
            }
            let got = stored_at(&api, OutPoint { txid, out_idx }).await.map_err(js)?;
            take(&mut found, out_idx, got);
        }
        let at_read = block_count(&api).await.map_err(js)?;
        let describe = |c: &OutgoingContract, f: Option<(u64, ContractId, u64)>| -> Result<serde_json::Value, JsError> {
            let (out_idx, stored_id, left) = f.ok_or_else(|| {
                js(format!("the lock transaction {txid} was accepted but no output of it holds this outgoing contract"))
            })?;
            Ok(serde_json::json!({
                "txid": txid.to_string(), "out_idx": out_idx,
                "block_count_at_lock": count, "expiry_delta": expiry_delta,
                "computed_contract_id": c.contract_id().0.to_string(), "computed_expiration": c.expiration,
                "stored_contract_id": stored_id.0.to_string(), "stored_blocks_left": left,
                "block_count_at_read": at_read, "stored_expiration": at_read + left,
                "ids_match": stored_id == c.contract_id(), "amount_msat": c.amount.msats,
            }))
        };
        Ok(serde_json::json!({ "stake": describe(&stake, found[0])?, "fee": describe(&fee, found[1])? }).to_string())
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
