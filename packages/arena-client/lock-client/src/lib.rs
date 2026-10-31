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

/// A DONATION'S PAYMENT IMAGE (2026-10-05): the sender's 32-byte x-only player key when the page names
/// it ("image", 64 hex), else the zero hash as before. Nobody can make a preimage of either, so the claim path stays dead and
/// the recipient's Refund is the only spend; the key is then part of the contract the guardians store, and of its id.
fn donation_image(d: &serde_json::Value) -> Result<PaymentImage, JsError> {
    let image = d.get("image").and_then(|v| v.as_str()).unwrap_or("");
    let hex = if image.is_empty() { "00".repeat(32) } else { image.to_string() };
    if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(js("a donation's image is 32 bytes of hex"));
    }
    Ok(PaymentImage::Hash(sha256::Hash::from_str(&hex).map_err(js)?))
}

fn js(e: impl std::fmt::Display) -> JsError { JsError::new(&e.to_string()) }

/// A deposit invoice's life in seconds: short, so a stalled payment returns to its payer within minutes.
const DEPOSIT_INVOICE_SECS: u32 = 600;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(s: &str);
    #[wasm_bindgen(js_namespace = console, js_name = trace)]
    fn console_trace(s: &str);
    /// performance.now(): a sub-millisecond clock in the page and in node (timing)
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    pub(crate) fn perf_now() -> f64;
    /// Date.now(): the wall clock, to set against the harness's and the guardians' clocks
    #[wasm_bindgen(js_namespace = Date, js_name = now)]
    fn js_sys_date_now() -> f64;
    /// step 1 probe: globalThis.__blwp178(ms) if the harness set it (absent in the page: a no-op there)
    #[wasm_bindgen(js_namespace = globalThis, js_name = __blwp178, catch)]
    fn probe_178(ms: f64) -> Result<(), wasm_bindgen::JsValue>;
}

/// KANBAN STEP 1 (2026-10-05, comment 348): timing only, no behaviour change. The client store's commits
/// (count, ms) since the last take, and every round of the faster 5-of-7 read in `lockAccepted`.
pub(crate) static STORE_COMMITS: std::sync::Mutex<(u64, f64)> = std::sync::Mutex::new((0, 0.0));
static READ_ROUNDS: std::sync::Mutex<Vec<serde_json::Value>> = std::sync::Mutex::new(Vec::new());
fn take_store() -> (u64, f64) {
    STORE_COMMITS.lock().map(|mut g| std::mem::replace(&mut *g, (0, 0.0))).unwrap_or((0, 0.0))
}
fn r1(x: f64) -> f64 { (x * 10.0).round() / 10.0 }

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

/// A CONSENSUS REQUEST ASKED AGAIN WHEN THE GUARDIANS' SOCKETS FAIL (2026-10-02, playtest: "Not joined PAID ...
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
/// A THRESHOLD OF GUARDIANS AGREEING ON THE CONTRACT STORED AT AN OUTPUT. The endpoint answers
/// (contract id, blocks left), and each guardian counts blocks left from its own consensus block count - measured on the
/// 7-guardian regtest federation, those differ for up to ~1 s around a block-count change, and a threshold of IDENTICAL
/// answers (request_current_consensus) waits that out. The contract id is what the lock is; so this asks for a threshold
/// agreeing on the id (the same security: no fewer guardians than the federation's threshold), and keeps the smallest
/// blocks left among them (the earliest expiry any of them sees). None once every guardian answered without such a
/// threshold - not yet held - or on an error.
struct StoredIdThreshold {
    seen: std::collections::BTreeMap<fedimint_core::PeerId, Option<(ContractId, u64)>>,
    threshold: usize,
    total: usize,
}

impl fedimint_api_client::query::QueryStrategy<Option<(ContractId, u64)>, Option<(ContractId, u64)>> for StoredIdThreshold {
    fn process(&mut self, peer: fedimint_core::PeerId, response: Option<(ContractId, u64)>) -> fedimint_api_client::query::QueryStep<Option<(ContractId, u64)>> {
        use fedimint_api_client::query::QueryStep;
        self.seen.insert(peer, response);
        if let Some((id, _)) = response {
            let agreeing: Vec<u64> = self.seen.values().filter_map(|v| v.filter(|(i, _)| *i == id).map(|(_, left)| left)).collect();
            if agreeing.len() >= self.threshold {
                return QueryStep::Success(Some((id, agreeing.into_iter().min().unwrap_or(0))));
            }
        }
        if self.seen.len() >= self.total { QueryStep::Success(None) } else { QueryStep::Continue }
    }
}

/// step 1: the same read, with each guardian's answer and when (ms after `t0`): "<peer>S" / "<peer>N" @ms, in
/// answer order, or the call's error. Behaves as `stored_now`.
async fn stored_now_traced(api: &DynModuleApi, outpoint: OutPoint, t0: f64) -> (Option<(ContractId, u64)>, serde_json::Value) {
    let peers = api.all_peers().to_num_peers();
    let trace = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let r = api
        .request_with_strategy(
            Traced { inner: StoredIdThreshold { seen: Default::default(), threshold: peers.threshold(), total: peers.total() }, trace: trace.clone(), t0 },
            OUTGOING_CONTRACT_EXPIRATION_ENDPOINT.to_string(),
            ApiRequestErased::new(outpoint),
        )
        .await;
    let answers = trace.lock().map(|g| g.clone()).unwrap_or_default();
    match r {
        Ok(v) => (v, serde_json::json!({ "out": outpoint.out_idx, "held": v.is_some(), "answers": answers })),
        Err(e) => (None, serde_json::json!({ "out": outpoint.out_idx, "error": e.to_string().chars().take(160).collect::<String>(), "answers": answers })),
    }
}

struct Traced {
    inner: StoredIdThreshold,
    trace: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    t0: f64,
}

impl fedimint_api_client::query::QueryStrategy<Option<(ContractId, u64)>, Option<(ContractId, u64)>> for Traced {
    fn process(&mut self, peer: fedimint_core::PeerId, response: Option<(ContractId, u64)>) -> fedimint_api_client::query::QueryStep<Option<(ContractId, u64)>> {
        let _ = self.trace.lock().map(|mut g| g.push(format!("{}{}@{}", peer, if response.is_some() { "S" } else { "N" }, r1(perf_now() - self.t0))));
        self.inner.process(peer, response)
    }
}

/// One such read now (no retries, no back-off): Some once a threshold of guardians hold the same contract there.
async fn stored_now(api: &DynModuleApi, outpoint: OutPoint) -> Option<(ContractId, u64)> {
    let peers = api.all_peers().to_num_peers();
    api.request_with_strategy(
        StoredIdThreshold { seen: Default::default(), threshold: peers.threshold(), total: peers.total() },
        OUTGOING_CONTRACT_EXPIRATION_ENDPOINT.to_string(),
        ApiRequestErased::new(outpoint),
    )
    .await
    .ok()
    .flatten()
}

/// Read until held, every 50 ms, for at most `tries` reads; then the old read with its retries as the fallback.
async fn stored_soon(api: &DynModuleApi, outpoint: OutPoint, tries: u32) -> anyhow::Result<Option<(ContractId, u64)>> {
    for _ in 0..tries {
        if let Some(held) = stored_now(api, outpoint).await {
            return Ok(Some(held));
        }
        fedimint_core::runtime::sleep(fedimint_core::runtime::Duration::from_millis(50)).await;
    }
    stored_at(api, outpoint).await
}

async fn stored_at(api: &DynModuleApi, outpoint: OutPoint) -> anyhow::Result<Option<(ContractId, u64)>> {
    consensus_with_retries(|| async {
        Ok(api.request_current_consensus(OUTGOING_CONTRACT_EXPIRATION_ENDPOINT.to_string(), ApiRequestErased::new(outpoint)).await?)
    })
    .await
}

/// How long a consensus block count is built on (see `count_for_lock`).
const COUNT_KEPT_MS: u64 = 300_000;

#[wasm_bindgen]
pub struct LockClient {
    client: ClientHandle,
    lnv2: ModuleInstanceId,
    /// THE LAST CONSENSUS BLOCK COUNT READ, and when (ms since the epoch) - see `count_for_lock`.
    last_count: std::sync::Mutex<Option<(u64, u64)>>,
}

/// A LOCK'S CONTRACT FROM ITS FIELDS (JSON: paymentImage {kind, bytes}, amountMsat, claimPk, refundPk, expiration) - a stake
/// lock's image is a point, a node-fee lock's (and a payout contract's) a hash. (measured live 2026-10-06 07:58Z,
/// round 422ecd2e): the redeem built only point images, so a refused round's node-fee lock - forfeited by the seats like its
/// stake - was refused here ("only a stake lock, whose image is a point, is redeemed here") and stayed to its expiry.
fn contract_from_fields(fields: &str) -> Result<OutgoingContract, JsError> {
    let f: serde_json::Value = serde_json::from_str(fields).map_err(js)?;
    let text = |k: &str| {
        f.get(k).and_then(|v| v.as_str()).map(str::to_owned).ok_or_else(|| js(format!("the lock names no {k}")))
    };
    let image = f.get("paymentImage").ok_or_else(|| js("the lock names no payment image"))?;
    let bytes = image.get("bytes").and_then(|v| v.as_str()).ok_or_else(|| js("the lock's image has no bytes"))?;
    let payment_image = match image.get("kind").and_then(|v| v.as_str()) {
        Some("point") => PaymentImage::Point(PublicKey::from_str(bytes).map_err(js)?),
        Some("hash") => PaymentImage::Hash(sha256::Hash::from_str(bytes).map_err(js)?),
        _ => return Err(js("a lock's image is a point or a hash")),
    };
    let refund_pk = PublicKey::from_str(&text("refundPk")?).map_err(js)?;
    let expiration = f.get("expiration").and_then(|v| v.as_u64()).ok_or_else(|| js("the lock names no expiration"))?;
    Ok(OutgoingContract {
        payment_image,
        amount: Amount::from_msats(text("amountMsat")?.parse().map_err(js)?),
        expiration,
        claim_pk: PublicKey::from_str(&text("claimPk")?).map_err(js)?,
        refund_pk,
        ephemeral_pk: refund_pk,
    })
}

#[wasm_bindgen]
impl LockClient {
    /// The id of the contract a lock's fields build (hex) - the builder the redeem uses, reachable without a federation.
    #[wasm_bindgen(js_name = outgoingContractId)]
    pub fn outgoing_contract_id(fields: String) -> Result<String, JsError> {
        Ok(contract_from_fields(&fields)?.contract_id().0.to_string())
    }

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
        Self::start(invite, federation_id, secret, store, false).await
    }

    /// THE WALLET ON A NEW DEVICE (2026-10-04: "patch Fedimint's recovery so it runs in the browser"): as
    /// `join`, but a store that holds no wallet yet is RECOVERED from the federation instead of joined empty - Fedimint's
    /// own recovery (mintv2 scans the federation's issuance history for the notes this secret's keys made) runs, and
    /// this waits for it. A secret that never held notes recovers an empty wallet; a kept store opens as with `join`.
    pub async fn recover(
        invite: String,
        federation_id: String,
        secret: String,
        store: store::LockStore,
    ) -> Result<LockClient, JsError> {
        Self::start(invite, federation_id, secret, store, true).await
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
        // THE STAKE (image a point) AND A REFUSED ROUND'S NODE-FEE LOCK (image a hash) alike
        let contract = contract_from_fields(&fields)?;
        let refund_pk = contract.refund_pk;
        let expiration = contract.expiration;
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
        // NEVER THE GATEWAY ON THE INVOICE'S OWN NODE (2026-10-01 08:34, measured: a withdrawal to an invoice
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

    /// THE E-CASH STILL BEING ISSUED to this wallet, in msat, as a decimal string: every pending mintv2 output
    /// state machine's denominations - a recovery's re-issue, a deposit's notes, a payment's change. `balanceMsat` counts
    /// none of it until its machine finishes; held + issuing is what the wallet will hold.
    #[wasm_bindgen(js_name = issuingMsat)]
    pub async fn issuing_msat(&self) -> Result<String, JsError> {
        let mint = self.client.get_first_module::<fedimint_mintv2_client::MintClientModule>().map_err(js)?;
        Ok(mint.blwp_issuing_msat().await.msats.to_string())
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
            // 600 s (spec §23.1: "the invoice's CLTV is short, and a client moves to the next gateway after a
            // timeout"): a payment a gateway takes and stalls on returns to the payer within minutes, not an hour
            .receive(amount, DEPOSIT_INVOICE_SECS, description, gateway, serde_json::Value::Null)
            .await
            .map_err(js)?;
        Ok(serde_json::json!({ "invoice": invoice.to_string(), "operation": op.fmt_full().to_string() }).to_string())
    }

    /// THE GATEWAYS THE FEDERATION LISTS (spec §23.1: "made through any gateway the federation lists"): the
    /// union of every guardian's registered list, most-listed first - JSON ["https://...", ...]. The page tries them in
    /// turn and moves to the next after a timeout.
    pub async fn gateways(&self) -> Result<String, JsError> {
        let ln = self.client.get_first_module::<LightningClientModule>().map_err(js)?;
        let list = ln.list_gateways(None).await.map_err(js)?;
        Ok(serde_json::Value::from(list.iter().map(|u| u.to_string()).collect::<Vec<_>>()).to_string())
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

    /// A BATCH OF THE SCAN FOR LOST DEPOSITS (kanban #883), from `start`: JSON { next, done, found: [{ operation, msat }] }. The caller waits on each
    /// found operation with awaitReceive; the federation answers at once while there is more, and holds a read at its end, so the page bounds the call.
    #[wasm_bindgen(js_name = scanDeposits)]
    pub async fn scan_deposits(&self, start: String) -> Result<String, JsError> {
        let ln = self.client.get_first_module::<LightningClientModule>().map_err(js)?;
        let (next, done, found) = ln.scan_receives(start.parse().map_err(js)?, 128).await;
        let found: Vec<_> = found.iter().map(|(op, a)| serde_json::json!({ "operation": op.fmt_full().to_string(), "msat": a.msats.to_string() })).collect();
        Ok(serde_json::json!({ "next": next.to_string(), "done": done, "found": found }).to_string())
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
    /// checked on join (2026-09-15 07:33: every guardian has its own
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

    /// THE WHOLE BALANCE AS E-CASH (2026-10-02: "Can't we show all wallets we have and combine all of them when
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

    /// AN AMOUNT AS E-CASH (kanban #614, 2026-10-24: "Kein Lightning swap, sondern übertragen in die andere federation"): the stock
    /// mint module's send of exactly `amount_msat`, as the prefixed base32 string a seat's exchange takes - the player's side of an e-cash
    /// exchange into another federation. Answers {"msat", "ecash"}; the caller keeps the string until the exchange answered.
    #[wasm_bindgen(js_name = sendEcash)]
    pub async fn send_ecash(&self, amount_msat: String) -> Result<String, JsError> {
        let mint = self.client.get_first_module::<fedimint_mintv2_client::MintClientModule>().map_err(js)?;
        let amount = Amount::from_msats(amount_msat.parse().map_err(js)?);
        let (_, ecash) = mint.send(amount, serde_json::Value::Null, false).await.map_err(js)?;
        Ok(serde_json::json!({
            "msat": amount.msats,
            "ecash": fedimint_core::base32::encode_prefixed(fedimint_core::base32::FEDIMINT_PREFIX, &ecash),
        })
        .to_string())
    }

    /// THE OUTPUTS STILL IN ISSUANCE (spec 23A.5 "Notes still in issuance at the halt"): everything issued to this
    /// wallet's seed that it neither holds as a note nor has spent - read from one answering guardian, so it works while the
    /// federation is halted. Answers [{"nonce", "amount_msat", "request"}]; `request` is what a pending-output claim presents.
    #[wasm_bindgen(js_name = pendingOutputs)]
    pub async fn pending_outputs(&self) -> Result<String, JsError> {
        let mint = self.client.get_first_module::<fedimint_mintv2_client::MintClientModule>().map_err(js)?;
        let pending = mint.blwp_pending_outputs().await.map_err(js)?;
        Ok(serde_json::Value::Array(pending.into_iter().map(|(nonce, amount, request)| serde_json::json!({
            "nonce": nonce.to_string(), "amount_msat": amount.msats, "request": request,
        })).collect()).to_string())
    }

    /// WHAT THE ARRIVING MONEY WAITS FOR (kanban #908): each output still being issued, its transaction, and whether the federation
    /// has accepted that transaction, asked now. Answers [{"txid", "msat", "accepted"}]; a restore's re-issue has no txid.
    #[wasm_bindgen(js_name = issuingDetail)]
    pub async fn issuing_detail(&self) -> Result<String, JsError> {
        let mint = self.client.get_first_module::<fedimint_mintv2_client::MintClientModule>().map_err(js)?;
        Ok(serde_json::Value::Array(mint.blwp_issuing_detail().await.into_iter().map(|(txid, msat, accepted)| serde_json::json!({
            "txid": txid, "msat": msat.msats, "accepted": accepted,
        })).collect()).to_string())
    }

    /// STUCK MONEY BACK (kanban #910): ends the output machines stuck on a transaction and re-issues what this seed was issued and neither
    /// holds nor has spent. Answers {"ended", "reissuingMsat"}.
    #[wasm_bindgen(js_name = recoverStuck)]
    pub async fn recover_stuck(&self) -> Result<String, JsError> {
        let mint = self.client.get_first_module::<fedimint_mintv2_client::MintClientModule>().map_err(js)?;
        let (ended, amount) = mint.blwp_recover_stuck().await.map_err(js)?;
        Ok(serde_json::json!({ "ended": ended, "reissuingMsat": amount.msats }).to_string())
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

    /// THE STAKE LOCK AND THE FEE LOCK IN ONE TRANSACTION (2026-10-02, the join's 2-3 s: "Cut whatever is between the
    /// click and the loaded round"). Measured on testnet4 the two locks were two transactions one after the other - each a
    /// block count, a submit, the wait for the guardians to accept it, a search of its outputs and a second block count:
    /// 'locking the stake' to 'fee lock: minted' 7.2 s in a paid join (Q4, 22:29:17-25Z). Here: one block count, one
    /// transaction carrying both outgoing contracts, one acceptance, and both outpoints read together - outputs 0 and 1 as
    /// built, any other output only if they are not it. Each contract is matched to its outpoint by the id the guardians
    /// store, so the answer is two answers of `lock`'s own shape ("stake", "fee"), checked by the page as before.
    /// THE BLOCK COUNT READ AHEAD (the join's 2-3 s): the lobby asks it once its wallet is open, so the lock that follows
    /// within a minute builds on it instead of a consensus read of its own. Answers the count.
    #[wasm_bindgen(js_name = warmBlockCount)]
    pub async fn warm_block_count(&self) -> Result<String, JsError> {
        let api = self.client.api().with_module(self.lnv2);
        let count = block_count(&api).await.map_err(js)?;
        self.keep_count(count);
        Ok(count.to_string())
    }

    /// A BLOCK COUNT THE PAGE KEPT (kanban #625: it survives a reload, the client's own does not): taken when it is newer
    /// than the one held, `at_ms` when it was read (ms since the epoch). Built on as a count this client read itself.
    #[wasm_bindgen(js_name = keepBlockCount)]
    pub fn keep_block_count(&self, count: f64, at_ms: f64) {
        if !(count > 0.0) || !(at_ms > 0.0) { return; }
        if let Ok(mut kept) = self.last_count.lock() {
            let newer = match *kept { Some((at, _)) => (at_ms as u64) > at, None => true };
            if newer { *kept = Some((at_ms as u64, count as u64)); }
        }
    }

    /// The block count held, for the page to keep: JSON { count, at } or null.
    #[wasm_bindgen(js_name = keptBlockCount)]
    pub fn kept_block_count(&self) -> String {
        match self.last_count.lock().ok().and_then(|k| *k) {
            Some((at, count)) => serde_json::json!({ "count": count, "at": at }).to_string(),
            None => "null".to_string(),
        }
    }

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
        let count = self.count_for_lock(&api).await.map_err(js)?;
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
        // THE BLOCK COUNT BESIDE THE TWO READS, not after them (a third consensus call that waited on the other two)
        let (a, b, counted) = futures::future::join3(
            stored_at(&api, OutPoint { txid, out_idx: 0 }),
            stored_at(&api, OutPoint { txid, out_idx: 1 }),
            block_count(&api),
        )
        .await;
        take(&mut found, 0, a.map_err(js)?);
        take(&mut found, 1, b.map_err(js)?);
        let mut at_read = counted.map_err(js)?;
        self.keep_count(at_read);
        if !found.iter().all(|f| f.is_some()) {
            for out_idx in 2..16u64 {
                if found.iter().all(|f| f.is_some()) {
                    break;
                }
                let got = stored_at(&api, OutPoint { txid, out_idx }).await.map_err(js)?;
                take(&mut found, out_idx, got);
            }
            at_read = block_count(&api).await.map_err(js)?;
        }
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

    /// THE STAKE, ITS FEE LOCK AND THE PLAYER'S DONATION IN ONE TRANSACTION (2026-10-03, FEDERATION.md "Donations in
    /// the federation"): the stake lock and - when `fee_hash` is not empty - the fee lock as `lockBoth` builds them, and one
    /// payout contract per entry of `donations` (JSON `[{"pk": 33-byte hex, "msat": "n"}, ...]` in the set's order): the zero
    /// hash image, expired from the start, claim, refund and ephemeral key all the recipient's - only that key can spend it,
    /// by Refund, at any time (the settlement's payout shape). Every output is matched to its outpoint by the id the guardians
    /// store. JSON: { "stake": <lock's shape>, "fee": <lock's shape> | null, "donations": [{ txid, out_idx, recipient_pk,
    /// amount_msat, stored_contract_id, ids_match }] }.
    #[wasm_bindgen(js_name = lockWithDonations)]
    #[allow(clippy::too_many_arguments)]
    pub async fn lock_with_donations(
        &self,
        point: String,
        stake_msat: String,
        fee_hash: String,
        fee_msat: String,
        claim_pk: String,
        refund_pk: String,
        expiry_delta: u32,
        donations: String,
    ) -> Result<String, JsError> {
        let api = self.client.api().with_module(self.lnv2);
        let count = self.count_for_lock(&api).await.map_err(js)?;
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
        let mut contracts: Vec<OutgoingContract> = vec![make(PaymentImage::Point(PublicKey::from_str(&point).map_err(js)?), &stake_msat)?];
        let with_fee = !fee_hash.trim().is_empty();
        if with_fee {
            contracts.push(make(PaymentImage::Hash(sha256::Hash::from_str(&fee_hash).map_err(js)?), &fee_msat)?);
        }
        let given: Vec<serde_json::Value> = serde_json::from_str(&donations).map_err(js)?;
        let first_donation = contracts.len();
        for d in &given {
            let pk = PublicKey::from_str(d.get("pk").and_then(|v| v.as_str()).ok_or_else(|| js("a donation names no pk"))?).map_err(js)?;
            let msat: u64 = d.get("msat").and_then(|v| v.as_str()).ok_or_else(|| js("a donation names no msat"))?.parse().map_err(js)?;
            if msat == 0 {
                return Err(js("a donation output of 0 msat is not made"));
            }
            contracts.push(OutgoingContract {
                payment_image: donation_image(d)?,
                amount: Amount::from_msats(msat),
                expiration: 0,
                claim_pk: pk,
                refund_pk: pk,
                ephemeral_pk: pk,
            });
        }
        let outputs = contracts
            .iter()
            .map(|c| ClientOutput {
                output: LightningOutput::V0(LightningOutputV0::Outgoing(c.clone())),
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
        // EVERY OUTPUT BY ITS STORED ID: the ones built first are read together, change outputs after them only if needed
        let ids: Vec<ContractId> = contracts.iter().map(OutgoingContract::contract_id).collect();
        let mut found: Vec<Option<(u64, ContractId, u64)>> = vec![None; contracts.len()];
        let take = |found: &mut Vec<Option<(u64, ContractId, u64)>>, out_idx: u64, got: Option<(ContractId, u64)>| {
            if let Some((id, left)) = got {
                for k in 0..ids.len() {
                    if id == ids[k] && found[k].is_none() {
                        found[k] = Some((out_idx, id, left));
                        break;
                    }
                }
            }
        };
        let n = contracts.len() as u64;
        let reads = futures::future::join_all((0..n).map(|i| stored_at(&api, OutPoint { txid, out_idx: i }))).await;
        for (i, r) in reads.into_iter().enumerate() {
            take(&mut found, i as u64, r.map_err(js)?);
        }
        let mut out_idx = n;
        while !found.iter().all(Option::is_some) && out_idx < n + 16 {
            let got = stored_at(&api, OutPoint { txid, out_idx }).await.map_err(js)?;
            take(&mut found, out_idx, got);
            out_idx += 1;
        }
        let at_read = block_count(&api).await.map_err(js)?;
        self.keep_count(at_read);
        let missing = |k: usize| js(format!("the lock transaction {txid} was accepted but no output of it holds outgoing contract {k}"));
        let describe = |k: usize| -> Result<serde_json::Value, JsError> {
            let c = &contracts[k];
            let (out_idx, stored_id, left) = found[k].ok_or_else(|| missing(k))?;
            Ok(serde_json::json!({
                "txid": txid.to_string(), "out_idx": out_idx,
                "block_count_at_lock": count, "expiry_delta": expiry_delta,
                "computed_contract_id": c.contract_id().0.to_string(), "computed_expiration": c.expiration,
                "stored_contract_id": stored_id.0.to_string(), "stored_blocks_left": left,
                "block_count_at_read": at_read, "stored_expiration": at_read + left,
                "ids_match": stored_id == c.contract_id(), "amount_msat": c.amount.msats,
            }))
        };
        let mut donated = Vec::new();
        for k in first_donation..contracts.len() {
            let (out_idx, stored_id, _) = found[k].ok_or_else(|| missing(k))?;
            donated.push(serde_json::json!({
                "txid": txid.to_string(), "out_idx": out_idx, "recipient_pk": contracts[k].refund_pk.to_string(),
                "amount_msat": contracts[k].amount.msats, "stored_contract_id": stored_id.0.to_string(),
                "ids_match": stored_id == contracts[k].contract_id(),
            }));
        }
        Ok(serde_json::json!({
            "stake": describe(0)?, "fee": if with_fee { describe(1)? } else { serde_json::Value::Null }, "donations": donated,
        })
        .to_string())
    }

    /// THE LOCK SUBMITTED, NOT YET ACCEPTED (2026-10-03, OPEN-LIST-2140 item 3: "A funded paid join of an already-open
    /// round is still 3.5-4.7 s from PLAY to the entry committed ... The leftover is the lock's acceptance"). The same
    /// transaction as `lockWithDonations` - the stake lock, the fee lock when `fee_hash` is not empty, one payout contract per
    /// donation - answered the moment the guardians are handed it: its txid, the operation to await it by, and each output
    /// as built. The outputs a client builds come first in its transaction, in the order built (measured on testnet4: stake
    /// 0, donations 1 and 2), so the entry can name them now; `lockAccepted` checks every one against what the guardians
    /// store once they accept it. JSON: { operation, txid, block_count_at_lock, expiry_delta, with_fee, outputs: [{ out_idx,
    /// role, computed_contract_id, computed_expiration, amount_msat, recipient_pk }] }.
    /// HOW MANY TWEAKS ARE GROUND AND WAITING: a lock takes one per change note; the lobby keeps the queue
    /// (200) full before a join, so lockSubmit does not wait for grinding.
    #[wasm_bindgen(js_name = tweaksReady)]
    pub fn tweaks_ready(&self) -> Result<u32, JsError> {
        let mint = self.client.get_first_module::<fedimint_mintv2_client::MintClientModule>().map_err(js)?;
        Ok(mint.blwp_tweaks_ready() as u32)
    }

    #[wasm_bindgen(js_name = lockSubmit)]
    #[allow(clippy::too_many_arguments)]
    pub async fn lock_submit(
        &self,
        point: String,
        stake_msat: String,
        fee_hash: String,
        fee_msat: String,
        claim_pk: String,
        refund_pk: String,
        expiry_delta: u32,
        donations: String,
    ) -> Result<String, JsError> {
        let api = self.client.api().with_module(self.lnv2);
        // step 1: (a) the count - kept or read; (b) building; (c) finalize and submit, the mint's tweaks, the store
        let t_a = perf_now();
        let _ = take_store();
        let _ = fedimint_mintv2_client::BLWP_OUTPUT_TIMING.lock().map(|mut g| g.clear());
        let count_kept = {
            let now = fedimint_core::time::duration_since_epoch().as_millis() as u64;
            self.last_count.lock().ok().and_then(|k| *k).is_some_and(|(at, _)| now.saturating_sub(at) < 60_000)
        };
        let count = self.count_for_lock(&api).await.map_err(js)?;
        let t_b = perf_now();
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
        let mut contracts: Vec<(OutgoingContract, &str)> =
            vec![(make(PaymentImage::Point(PublicKey::from_str(&point).map_err(js)?), &stake_msat)?, "stake")];
        let with_fee = !fee_hash.trim().is_empty();
        if with_fee {
            contracts.push((make(PaymentImage::Hash(sha256::Hash::from_str(&fee_hash).map_err(js)?), &fee_msat)?, "fee"));
        }
        let given: Vec<serde_json::Value> = serde_json::from_str(&donations).map_err(js)?;
        for d in &given {
            let pk = PublicKey::from_str(d.get("pk").and_then(|v| v.as_str()).ok_or_else(|| js("a donation names no pk"))?).map_err(js)?;
            let msat: u64 = d.get("msat").and_then(|v| v.as_str()).ok_or_else(|| js("a donation names no msat"))?.parse().map_err(js)?;
            if msat == 0 {
                return Err(js("a donation output of 0 msat is not made"));
            }
            contracts.push((
                OutgoingContract {
                    payment_image: donation_image(d)?,
                    amount: Amount::from_msats(msat),
                    expiration: 0,
                    claim_pk: pk,
                    refund_pk: pk,
                    ephemeral_pk: pk,
                },
                "donation",
            ));
        }
        let outputs = contracts
            .iter()
            .map(|(c, _)| ClientOutput {
                output: LightningOutput::V0(LightningOutputV0::Outgoing(c.clone())),
                amounts: Amounts::new_bitcoin(c.amount),
            })
            .collect::<Vec<_>>();
        let bundle = ClientOutputBundle::new_no_sm(outputs).into_dyn(self.lnv2);
        let operation = OperationId::new_random();
        let t_c = perf_now();
        let change = self
            .client
            .finalize_and_submit_transaction(operation, "blwp-lock-client", |_| (), TransactionBuilder::new().with_outputs(bundle))
            .await
            .map_err(js)?;
        let t_d = perf_now();
        let (store_commits, store_ms) = take_store();
        let mint: Vec<serde_json::Value> = fedimint_mintv2_client::BLWP_OUTPUT_TIMING
            .lock()
            .map(|mut g| g.drain(..).map(|(asked, ready, wait)| serde_json::json!({ "notes": asked, "tweaksReady": ready, "tweakWaitMs": r1(wait) })).collect())
            .unwrap_or_default();
        let timing = serde_json::json!({ "countMs": r1(t_b - t_a), "countKept": count_kept, "buildMs": r1(t_c - t_b),
            "finalizeMs": r1(t_d - t_c), "mintOutputs": mint, "storeCommits": store_commits, "storeMs": r1(store_ms) });
        let txid = change.txid();
        let built: Vec<serde_json::Value> = contracts
            .iter()
            .enumerate()
            .map(|(i, (c, role))| {
                serde_json::json!({
                    "out_idx": i, "role": role, "computed_contract_id": c.contract_id().0.to_string(),
                    "computed_expiration": c.expiration, "amount_msat": c.amount.msats,
                    "recipient_pk": if *role == "donation" { serde_json::Value::String(c.refund_pk.to_string()) } else { serde_json::Value::Null },
                })
            })
            .collect();
        Ok(serde_json::json!({
            "operation": operation.fmt_full().to_string(), "txid": txid.to_string(), "block_count_at_lock": count,
            "expiry_delta": expiry_delta, "with_fee": with_fee, "outputs": built, "timing": timing,
        })
        .to_string())
    }

    /// A PAYMENT TO KEYS AND NOTHING ELSE (an in-game item's purchase): one transaction from this wallet's e-cash whose
    /// outputs are only pre-expired payout contracts - each `payouts` entry (JSON `[{"pk": 33-byte hex, "msat": "n", "image": 64
    /// hex}]`, in the order given) one contract its payee alone can Refund, built exactly as `lockSubmit` builds a donation's. No
    /// stake, no fee lock, no block count (a payout's expiration is 0). Answered on submission in `lockSubmit`'s shape (every output
    /// of role "payout", block_count_at_lock and expiry_delta 0), so `lockAccepted` awaits and checks it unchanged.
    #[wasm_bindgen(js_name = paySubmit)]
    pub async fn pay_submit(&self, payouts: String) -> Result<String, JsError> {
        let given: Vec<serde_json::Value> = serde_json::from_str(&payouts).map_err(js)?;
        if given.is_empty() {
            return Err(js("a payment names at least one payout"));
        }
        let mut contracts: Vec<OutgoingContract> = Vec::with_capacity(given.len());
        for d in &given {
            let pk = PublicKey::from_str(d.get("pk").and_then(|v| v.as_str()).ok_or_else(|| js("a payout names no pk"))?).map_err(js)?;
            let msat: u64 = d.get("msat").and_then(|v| v.as_str()).ok_or_else(|| js("a payout names no msat"))?.parse().map_err(js)?;
            if msat == 0 {
                return Err(js("a payout output of 0 msat is not made"));
            }
            contracts.push(OutgoingContract {
                payment_image: donation_image(d)?,
                amount: Amount::from_msats(msat),
                expiration: 0,
                claim_pk: pk,
                refund_pk: pk,
                ephemeral_pk: pk,
            });
        }
        let outputs = contracts
            .iter()
            .map(|c| ClientOutput {
                output: LightningOutput::V0(LightningOutputV0::Outgoing(c.clone())),
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
        let built: Vec<serde_json::Value> = contracts
            .iter()
            .enumerate()
            .map(|(i, c)| {
                serde_json::json!({
                    "out_idx": i, "role": "payout", "computed_contract_id": c.contract_id().0.to_string(),
                    "computed_expiration": c.expiration, "amount_msat": c.amount.msats, "recipient_pk": c.refund_pk.to_string(),
                })
            })
            .collect();
        Ok(serde_json::json!({
            "operation": operation.fmt_full().to_string(), "txid": txid.to_string(), "block_count_at_lock": 0,
            "expiry_delta": 0, "with_fee": false, "outputs": built,
        })
        .to_string())
    }

    /// AND ITS ACCEPTANCE: the submitted lock (`submitted`, `lockSubmit`'s answer) awaited until the guardians accept it, then
    /// every output read where it was built and checked against the contract id computed - answered in `lockWithDonations`'
    /// shape ({ stake, fee, donations }), so the page checks it exactly as before. An output the guardians hold elsewhere, or
    /// not at all, is an error: the entry named that outpoint.
    #[wasm_bindgen(js_name = lockAccepted)]
    pub async fn lock_accepted(&self, submitted: String) -> Result<String, JsError> {
        // step 1: the inner body returns with every local dropped; "returned" is marked after that
        let out = self.lock_accepted_inner(submitted).await?;
        let returned = js_sys_date_now();
        let _ = probe_178(returned);
        let mut v: serde_json::Value = serde_json::from_str(&out).map_err(js)?;
        v["timing"]["wall"]["returned"] = serde_json::json!(returned);
        Ok(v.to_string())
    }

    async fn lock_accepted_inner(&self, submitted: String) -> Result<String, JsError> {
        // step 1: wall clock (ms since the epoch) at entry, at the race's start and end, and at the answer
        let w_entry = js_sys_date_now();
        let s: serde_json::Value = serde_json::from_str(&submitted).map_err(js)?;
        let operation = OperationId::from_str(s.get("operation").and_then(|v| v.as_str()).ok_or_else(|| js("no operation"))?).map_err(js)?;
        let txid = TransactionId::from_str(s.get("txid").and_then(|v| v.as_str()).ok_or_else(|| js("no txid"))?).map_err(js)?;
        let count = s.get("block_count_at_lock").and_then(|v| v.as_u64()).ok_or_else(|| js("no block count"))?;
        let expiry_delta = s.get("expiry_delta").and_then(|v| v.as_u64()).ok_or_else(|| js("no expiry delta"))?;
        let outputs = s.get("outputs").and_then(|v| v.as_array()).ok_or_else(|| js("no outputs"))?.clone();
        let api = self.client.api().with_module(self.lnv2);
        // THE ACCEPTANCE, LEARNED AT ONCE (2026-10-05, option A): measured on the 7-guardian regtest
        // federation, the client's transaction state machine reported an acceptance ~1.1 s (median) after the fifth guardian
        // had recorded it. So beside it, the stake output is read every 50 ms with one threshold read: an output the guardians'
        // consensus holds exists only once the transaction was accepted, and the read counts only when a threshold of them
        // agree - the same security. Whichever answers first stands; every output is then read and checked below as before.
        let accepted = async {
            self.client
                .transaction_updates(operation)
                .await
                .await_tx_accepted(txid)
                .await
                .map_err(|e| js(format!("the guardians did not accept the lock transaction: {e}")))
        };
        let points: Vec<OutPoint> = outputs
            .iter()
            .map(|o| OutPoint { txid, out_idx: o.get("out_idx").and_then(|v| v.as_u64()).unwrap_or(u64::MAX) })
            .collect();
        // every output, every 50 ms: done once a threshold of guardians hold the same contract at each of them
        let _ = READ_ROUNDS.lock().map(|mut g| g.clear());
        let t0 = perf_now();
        let held = async {
            loop {
                let started = perf_now();
                let traced = futures::future::join_all(points.iter().map(|p| stored_now_traced(&api, *p, t0))).await;
                let ended = perf_now();
                let _ = READ_ROUNDS.lock().map(|mut g| {
                    g.push(serde_json::json!({ "s": r1(started - t0), "e": r1(ended - t0), "outs": traced.iter().map(|(_, t)| t.clone()).collect::<Vec<_>>() }))
                });
                let now: Vec<Option<(ContractId, u64)>> = traced.into_iter().map(|(r, _)| r).collect();
                if now.iter().all(Option::is_some) {
                    return Ok::<_, JsError>(now);
                }
                fedimint_core::runtime::sleep(fedimint_core::runtime::Duration::from_millis(50)).await;
            }
        };
        let t_start = fedimint_core::time::duration_since_epoch().as_millis() as u64;
        let w_race = js_sys_date_now();
        futures::pin_mut!(accepted, held);
        let mut w_dropped = 0.0;
        let (which, read_by_loop) = match futures::future::select(accepted, held).await {
            futures::future::Either::Left((r, rest)) => {
                let w = js_sys_date_now();
                drop(rest);
                w_dropped = js_sys_date_now() - w;
                r?;
                ("sm", None)
            }
            futures::future::Either::Right((r, rest)) => {
                let w = js_sys_date_now();
                drop(rest);
                w_dropped = js_sys_date_now() - w;
                ("held", Some(r?))
            }
        };
        let t_held = fedimint_core::time::duration_since_epoch().as_millis() as u64;
        let w_raced = js_sys_date_now();
        // the outputs (unless the loop already read them) and the block count, read together, not one after the other;
        // the id-threshold read for a few 50 ms ticks, the old read with its retries only as the fallback
        let outputs_read = async {
            match read_by_loop {
                Some(now) => now.into_iter().map(Ok).collect::<Vec<anyhow::Result<Option<(ContractId, u64)>>>>(),
                None => futures::future::join_all(points.iter().map(|p| stored_soon(&api, *p, 40))).await,
            }
        };
        let (reads, at_read) = futures::future::join(outputs_read, block_count(&api)).await;
        let at_read = at_read.map_err(js)?;
        let t_reads = fedimint_core::time::duration_since_epoch().as_millis() as u64;
        let t_count = t_reads;
        self.keep_count(at_read);
        let mut stake = serde_json::Value::Null;
        let mut fee = serde_json::Value::Null;
        let mut donations = Vec::new();
        for (o, r) in outputs.iter().zip(reads.into_iter()) {
            let out_idx = o.get("out_idx").and_then(|v| v.as_u64()).unwrap_or(u64::MAX);
            let computed = o.get("computed_contract_id").and_then(|v| v.as_str()).unwrap_or("").to_owned();
            let (stored_id, left) = r.map_err(js)?.ok_or_else(|| js(format!("the lock transaction {txid} was accepted but its output {out_idx} holds no outgoing contract")))?;
            let ids_match = stored_id.0.to_string() == computed;
            let one = serde_json::json!({
                "txid": txid.to_string(), "out_idx": out_idx, "block_count_at_lock": count, "expiry_delta": expiry_delta,
                "computed_contract_id": computed, "computed_expiration": o.get("computed_expiration").cloned().unwrap_or_default(),
                "stored_contract_id": stored_id.0.to_string(), "stored_blocks_left": left, "block_count_at_read": at_read,
                "stored_expiration": at_read + left, "ids_match": ids_match, "amount_msat": o.get("amount_msat").cloned().unwrap_or_default(),
                "recipient_pk": o.get("recipient_pk").cloned().unwrap_or_default(),
            });
            match o.get("role").and_then(|v| v.as_str()) {
                Some("stake") => stake = one,
                Some("fee") => fee = one,
                _ => donations.push(one),
            }
        }
        Ok(serde_json::json!({ "stake": stake, "fee": fee, "donations": donations, "timing": { "which": which, "held": t_held - t_start, "reads": t_reads - t_held, "count": t_count - t_reads,
            "rounds": READ_ROUNDS.lock().map(|mut g| std::mem::take(&mut *g)).unwrap_or_default(),
            "wall": { "entry": w_entry, "race": w_race, "raced": w_raced, "loserDropMs": w_dropped, "answer": js_sys_date_now() } } }).to_string())
    }
}

impl LockClient {
    /// THE BLOCK COUNT A LOCK IS BUILT ON (2026-10-02, the join's 2-3 s): a count read in the last COUNT_KEPT_MS, else a fresh
    /// consensus read. The seats accept a lock whose lock_height (its expiration less stake_expiry_blocks) is up to 12
    /// blocks below the height they verify at (stake-lock-signer-node.js, RULED 2026-09-24 option a); a count five minutes
    /// old is a block or two behind on any chain this runs on. (kanban #625, the owner's log 2026-10-24 20:52Z: an order's lock
    /// read it fresh - countMs 29018 - ten seconds after a reload, a guardian of the federation down: kept five minutes now,
    /// and the page hands a kept count in at the wallet's open, `keep_block_count`.)
    async fn count_for_lock(&self, api: &DynModuleApi) -> anyhow::Result<u64> {
        let now = fedimint_core::time::duration_since_epoch().as_millis() as u64;
        if let Ok(kept) = self.last_count.lock() {
            if let Some((at, count)) = *kept {
                if now.saturating_sub(at) < COUNT_KEPT_MS {
                    return Ok(count);
                }
            }
        }
        let count = block_count(api).await?;
        self.keep_count(count);
        Ok(count)
    }

    fn keep_count(&self, count: u64) {
        let now = fedimint_core::time::duration_since_epoch().as_millis() as u64;
        if let Ok(mut kept) = self.last_count.lock() {
            *kept = Some((now, count));
        }
    }

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

impl LockClient {
    async fn start(
        invite: String,
        federation_id: String,
        secret: String,
        store: store::LockStore,
        recover: bool,
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
            let client = builder.open(connectors, db, root).await.map_err(js)?;
            // A RECOVERY A TAB LEFT HALF DONE: the store is initialized as soon as recovery starts, so a tab closed,
            // reloaded or timed out mid-recovery reopens here - Fedimint resumes the recovery on open, and this waits for it
            // (at once when none is pending) instead of handing over a wallet whose notes are still being found
            client.wait_for_all_recoveries().await.map_err(js)?;
            client
        } else if recover {
            let preview = builder.preview(connectors, &invite).await.map_err(js)?;
            let client = preview.recover(db, root, None).await.map_err(js)?;
            client.wait_for_all_recoveries().await.map_err(js)?;
            client
        } else {
            let preview = builder.preview(connectors, &invite).await.map_err(js)?;
            preview.join(db, root).await.map_err(js)?
        };
        if client.federation_id().to_string() != named {
            return Err(js("the wallet this tab kept is another federation's"));
        }
        let lnv2 = client.get_first_instance(&KIND).ok_or_else(|| js("this federation has no lnv2 module"))?;
        Ok(LockClient { client, lnv2, last_count: std::sync::Mutex::new(None) })
    }
}
