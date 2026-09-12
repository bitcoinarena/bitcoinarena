//! THE LOCK CLIENT (W1a): what the player's page will run to make its stake
//! lock (v4.6.2 §23.1 steps 3-4), on the stock fedimint 0.12.0 client crates,
//! built to wasm. One `LockClient` holds one in-memory client for one session:
//!
//!   join(invite)                       the round's federation, a fresh client
//!   receive(msat, gateway)             a deposit invoice through a gateway
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

use fedimint_api_client::api::{DynModuleApi, FederationApiExt};
use fedimint_bip39::{Bip39RootSecretStrategy, Mnemonic};
use fedimint_client::secret::RootSecretStrategy;
use fedimint_client::transaction::{ClientOutput, ClientOutputBundle, TransactionBuilder};
use fedimint_client::{Client, ClientHandle, RootSecret};
use fedimint_connectors::ConnectorRegistry;
use fedimint_core::core::{IntoDynInstance, ModuleInstanceId, OperationId};
use fedimint_core::db::Database;
use fedimint_core::db::mem_impl::MemDatabase;
use fedimint_core::invite_code::InviteCode;
use fedimint_core::module::{Amounts, ApiRequestErased};
use fedimint_core::secp256k1::PublicKey;
use fedimint_core::util::SafeUrl;
use fedimint_core::{Amount, OutPoint};
use fedimint_lnv2_client::{FinalReceiveOperationState, LightningClientModule};
use fedimint_lnv2_common::contracts::{OutgoingContract, PaymentImage};
use fedimint_lnv2_common::endpoint_constants::{
    CONSENSUS_BLOCK_COUNT_ENDPOINT, OUTGOING_CONTRACT_EXPIRATION_ENDPOINT,
};
use fedimint_lnv2_common::{Bolt11InvoiceDescription, ContractId, KIND, LightningOutput, LightningOutputV0};
use wasm_bindgen::prelude::{JsError, wasm_bindgen};

fn js(e: impl std::fmt::Display) -> JsError { JsError::new(&e.to_string()) }

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
    /// A fresh client of the federation the invite names, its state in memory.
    pub async fn join(invite: String) -> Result<LockClient, JsError> {
        let invite = InviteCode::from_str(&invite).map_err(js)?;
        let mut builder = Client::builder().await.map_err(js)?;
        builder.with_module(fedimint_mintv2_client::MintClientInit);
        builder.with_module(fedimint_lnv2_client::LightningClientInit::default());
        let connectors = ConnectorRegistry::build_from_client_defaults().bind().await.map_err(js)?;
        let preview = builder.preview(connectors, &invite).await.map_err(js)?;
        let mnemonic: Mnemonic = Bip39RootSecretStrategy::<12>::random(&mut rand::thread_rng());
        let root = RootSecret::StandardDoubleDerive(Bip39RootSecretStrategy::<12>::to_root_secret(&mnemonic));
        let db: Database = MemDatabase::new().into();
        let client = preview.join(db, root).await.map_err(js)?;
        let lnv2 = client.get_first_instance(&KIND).ok_or_else(|| js("this federation has no lnv2 module"))?;
        Ok(LockClient { client, lnv2 })
    }

    /// The client's ecash, in msat, as a decimal string.
    #[wasm_bindgen(js_name = balanceMsat)]
    pub async fn balance_msat(&self) -> Result<String, JsError> {
        Ok(self.client.get_balance_for_btc().await.map_err(js)?.msats.to_string())
    }

    /// A deposit invoice for `amount_msat` through the gateway at `gateway`:
    /// JSON { invoice, operation }.
    pub async fn receive(&self, amount_msat: String, gateway: String) -> Result<String, JsError> {
        let ln = self.client.get_first_module::<LightningClientModule>().map_err(js)?;
        let amount = Amount::from_msats(amount_msat.parse().map_err(js)?);
        let description = Bolt11InvoiceDescription::Direct(String::new());
        let (invoice, op) = ln
            .receive(amount, 3600, description, Some(SafeUrl::parse(&gateway).map_err(js)?), serde_json::Value::Null)
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
        let api = self.client.api().with_module(self.lnv2);
        let count = block_count(&api).await.map_err(js)?;
        let refund_pk = PublicKey::from_str(&refund_pk).map_err(js)?;
        let contract = OutgoingContract {
            payment_image: PaymentImage::Point(PublicKey::from_str(&point).map_err(js)?),
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
