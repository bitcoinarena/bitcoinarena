//! THE STAKE LOCK: ONE STOCK LNv2 `OutgoingContract`, FUNDED FROM THE PLAYER'S
//! OWN ECASH, WITH THE ROUND'S COMMITTEE AS `claim_pk` (FEDERATION.md, step 1),
//! AND THE PLAYER'S REDEEM OF THE COMMITTEE'S FORFEIT (step 2).
//!
//! --mode lock (default). The stock client's `send` builds this same
//! contract, but always with the gateway's key as `claim_pk`; nothing in
//! `fedimint-cli` lets a caller name another. So this opens the player's
//! existing client (the one a deposit through a gateway already filled)
//! exactly as `fedimint-cli` does, and asks the stock transaction builder to
//! fund one output:
//!
//!   payment_image  Hash(H(P))           P is the player's; only H(P) is here
//!   amount         the net stake
//!   expiration     the guardians' consensus block count + a delta
//!   claim_pk       the committee's key
//!   refund_pk      the player's key
//!   ephemeral_pk   unused by a stake lock; the refund key is repeated
//!
//! Then it asks the guardians what they stored at that outpoint
//! (`outgoing_contract_expiration`) and prints it beside what it computed -
//! the contract id is the hash of the whole contract, so a match is every
//! field.
//!
//! --mode redeem. The committee's forfeit is a BIP-340 signature by
//! `claim_pk` over the contract id; the guardians take it as
//! `OutgoingWitness::Cancel(sig)` and then want the TRANSACTION signed by the
//! contract's `refund_pk` (lnv2-server lib.rs:491-497). This spends the lock
//! with the given forfeit signature, signs with the given key, and lets the
//! stock builder turn the value into the signer's ecash. It prints what the
//! guardians said - accepted, or their refusal word for word - and what they
//! hold at the outpoint before and after.
//!
//!   blwp-stake-lock --data-dir D --amount-msat N --hash HEX --claim-pk HEX \
//!     --refund-pk HEX --expiry-delta BLOCKS
//!   blwp-stake-lock --mode redeem --data-dir D --outpoint TXID:IDX \
//!     --amount-msat N --hash HEX --claim-pk HEX --refund-pk HEX \
//!     --expiration BLOCK --forfeit-sig HEX --signer-secret HEX
use std::collections::HashMap;
use std::path::PathBuf;
use std::str::FromStr;

use anyhow::{Context, anyhow, bail};
use fedimint_api_client::api::{DynModuleApi, FederationApiExt};
use fedimint_bip39::{Bip39RootSecretStrategy, Mnemonic};
use fedimint_client::module_init::ClientModuleInitRegistry;
use fedimint_client::secret::RootSecretStrategy;
use fedimint_client::transaction::{
    ClientInput, ClientInputBundle, ClientOutput, ClientOutputBundle, TransactionBuilder,
};
use fedimint_client::{Client, ClientHandle, RootSecret};
use fedimint_connectors::ConnectorRegistry;
use fedimint_core::bitcoin::hashes::sha256;
use fedimint_core::core::{IntoDynInstance, ModuleInstanceId, OperationId};
use fedimint_core::db::Database;
use fedimint_core::module::{Amounts, ApiRequestErased};
use fedimint_core::secp256k1::schnorr::Signature;
use fedimint_core::secp256k1::{PublicKey, SECP256K1, SecretKey};
use fedimint_core::{Amount, OutPoint, TransactionId};
use fedimint_lnv2_common::contracts::{OutgoingContract, PaymentImage};
use fedimint_lnv2_common::endpoint_constants::{
    CONSENSUS_BLOCK_COUNT_ENDPOINT, OUTGOING_CONTRACT_EXPIRATION_ENDPOINT,
};
use fedimint_lnv2_common::{
    ContractId, KIND, LightningInput, LightningInputV0, LightningOutput, LightningOutputV0,
    OutgoingWitness,
};

fn args() -> anyhow::Result<HashMap<String, String>> {
    let mut out = HashMap::new();
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        let Some(name) = k.strip_prefix("--") else { bail!("unexpected argument {k}") };
        out.insert(name.to_owned(), it.next().with_context(|| format!("--{name} needs a value"))?);
    }
    Ok(out)
}

fn need<'a>(a: &'a HashMap<String, String>, k: &str) -> anyhow::Result<&'a str> {
    a.get(k).map(String::as_str).with_context(|| format!("--{k} is required"))
}

/// THE PLAYER'S CLIENT, OPENED AS fedimint-cli OPENS IT: the same modules, the
/// same RocksDB, the same root secret from the stored mnemonic.
async fn open(data_dir: PathBuf) -> anyhow::Result<ClientHandle> {
    let mut modules = ClientModuleInitRegistry::new();
    modules.attach(fedimint_ln_client::LightningClientInit::default());
    modules.attach(fedimint_mint_client::MintClientInit);
    modules.attach(fedimint_mintv2_client::MintClientInit);
    modules.attach(fedimint_wallet_client::WalletClientInit::default());
    modules.attach(fedimint_meta_client::MetaClientInit);
    modules.attach(fedimint_lnv2_client::LightningClientInit::default());
    modules.attach(fedimint_walletv2_client::WalletClientInit);
    let mut builder = Client::builder().await?;
    builder.with_module_inits(modules);
    let db: Database = fedimint_rocksdb::RocksDb::build(data_dir.join("client.db"))
        .open()
        .await
        .context("could not open the client's rocksdb")?
        .into();
    let entropy = Client::load_decodable_client_secret_opt::<Vec<u8>>(&db)
        .await?
        .context("that client has no secret: join the federation first")?;
    let mnemonic = Mnemonic::from_entropy(&entropy)?;
    let root = RootSecret::StandardDoubleDerive(Bip39RootSecretStrategy::<12>::to_root_secret(&mnemonic));
    let endpoints = ConnectorRegistry::build_from_client_defaults().bind().await?;
    Ok(builder.open(endpoints, db, root).await?)
}

async fn block_count(api: &DynModuleApi) -> anyhow::Result<u64> {
    Ok(api
        .request_current_consensus(CONSENSUS_BLOCK_COUNT_ENDPOINT.to_string(), ApiRequestErased::new(()))
        .await?)
}

/// What the guardians hold at an outpoint: the contract id and the blocks
/// LEFT until it expires - `contract.expiration.saturating_sub(consensus_block_count)`
/// (lnv2-server lib.rs:851-865), not a height.
async fn stored_at(api: &DynModuleApi, outpoint: OutPoint) -> anyhow::Result<Option<(ContractId, u64)>> {
    Ok(api
        .request_current_consensus(OUTGOING_CONTRACT_EXPIRATION_ENDPOINT.to_string(), ApiRequestErased::new(outpoint))
        .await?)
}

fn stored_json(s: Option<(ContractId, u64)>) -> serde_json::Value {
    match s {
        Some((id, left)) => serde_json::json!({ "contract_id": id.0.to_string(), "blocks_left": left }),
        None => serde_json::Value::Null,
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let a = args()?;
    let mode = a.get("mode").map_or("lock", String::as_str).to_owned();
    let data_dir = PathBuf::from(need(&a, "data-dir")?);
    let amount = Amount::from_msats(need(&a, "amount-msat")?.parse()?);
    let hash = sha256::Hash::from_str(need(&a, "hash")?)?;
    let claim_pk = PublicKey::from_str(need(&a, "claim-pk")?)?;
    let refund_pk = PublicKey::from_str(need(&a, "refund-pk")?)?;

    let client = open(data_dir).await?;
    let lnv2 = client.get_first_instance(&KIND).context("this federation has no lnv2 module")?;
    let api = client.api().with_module(lnv2);

    match mode.as_str() {
        "lock" => lock(&a, &client, lnv2, &api, amount, hash, claim_pk, refund_pk).await,
        "redeem" => redeem(&a, &client, lnv2, &api, amount, hash, claim_pk, refund_pk).await,
        other => bail!("no mode {other}: lock or redeem"),
    }
}

#[allow(clippy::too_many_arguments)]
async fn lock(
    a: &HashMap<String, String>,
    client: &ClientHandle,
    lnv2: ModuleInstanceId,
    api: &DynModuleApi,
    amount: Amount,
    hash: sha256::Hash,
    claim_pk: PublicKey,
    refund_pk: PublicKey,
) -> anyhow::Result<()> {
    let delta: u64 = need(a, "expiry-delta")?.parse()?;
    let count = block_count(api).await?;
    let contract = OutgoingContract {
        payment_image: PaymentImage::Hash(hash),
        amount,
        expiration: count + delta,
        claim_pk,
        refund_pk,
        ephemeral_pk: refund_pk,
    };
    let contract_id = contract.contract_id();

    let bundle = ClientOutputBundle::new_no_sm(vec![ClientOutput {
        output: LightningOutput::V0(LightningOutputV0::Outgoing(contract.clone())),
        amounts: Amounts::new_bitcoin(contract.amount),
    }])
    .into_dyn(lnv2);
    let operation = OperationId::new_random();
    let change = client
        .finalize_and_submit_transaction(operation, "blwp-stake-lock", |_| (), TransactionBuilder::new().with_outputs(bundle))
        .await?;
    let txid = change.txid();
    client
        .transaction_updates(operation)
        .await
        .await_tx_accepted(txid)
        .await
        .map_err(|e| anyhow!("the guardians did not accept the lock transaction: {e}"))?;

    // WHAT THE GUARDIANS STORED, asked output by output: the builder decides
    // where change goes, so the lock's index is read, not assumed.
    for out_idx in 0..16u64 {
        let outpoint = OutPoint { txid, out_idx };
        if let Some((stored_id, blocks_left)) = stored_at(api, outpoint).await? {
            // THE ENDPOINT ANSWERS IN BLOCKS LEFT, not a height. Measured first
            // as 144 against a computed 454 at block count 310. So the
            // guardians' own count is read again here and the height is theirs.
            let block_count_at_read = block_count(api).await?;
            let stored_expiration = block_count_at_read + blocks_left;
            println!(
                "{}",
                serde_json::json!({
                    "txid": txid.to_string(),
                    "out_idx": out_idx,
                    "block_count_at_lock": count,
                    "expiry_delta": delta,
                    "computed_contract_id": contract_id.0.to_string(),
                    "computed_expiration": contract.expiration,
                    "stored_contract_id": stored_id.0.to_string(),
                    "stored_blocks_left": blocks_left,
                    "block_count_at_read": block_count_at_read,
                    "stored_expiration": stored_expiration,
                    "ids_match": stored_id == contract_id,
                    "amount_msat": contract.amount.msats,
                    "claim_pk": claim_pk.to_string(),
                    "refund_pk": refund_pk.to_string(),
                })
            );
            return Ok(());
        }
    }
    bail!("the lock transaction {txid} was accepted but no outpoint of it holds an outgoing contract")
}

#[allow(clippy::too_many_arguments)]
async fn redeem(
    a: &HashMap<String, String>,
    client: &ClientHandle,
    lnv2: ModuleInstanceId,
    api: &DynModuleApi,
    amount: Amount,
    hash: sha256::Hash,
    claim_pk: PublicKey,
    refund_pk: PublicKey,
) -> anyhow::Result<()> {
    let (txid, idx) = need(a, "outpoint")?.split_once(':').context("--outpoint is TXID:IDX")?;
    let outpoint = OutPoint { txid: TransactionId::from_str(txid)?, out_idx: idx.parse()? };
    let expiration: u64 = need(a, "expiration")?.parse()?;
    let forfeit = Signature::from_slice(&hex_bytes(need(a, "forfeit-sig")?)?)?;
    let signer = SecretKey::from_slice(&hex_bytes(need(a, "signer-secret")?)?)?.keypair(SECP256K1);

    // THE CONTRACT, REBUILT FROM ITS FIELDS: its id must be the one the
    // guardians hold at that outpoint, or this is some other lock.
    let contract = OutgoingContract {
        payment_image: PaymentImage::Hash(hash),
        amount,
        expiration,
        claim_pk,
        refund_pk,
        ephemeral_pk: refund_pk,
    };
    let before = stored_at(api, outpoint).await?;
    let count = block_count(api).await?;
    let forfeit_verifies = contract.verify_forfeit_signature(&forfeit);

    let bundle = ClientInputBundle::new_no_sm(vec![ClientInput {
        input: LightningInput::V0(LightningInputV0::Outgoing(outpoint, OutgoingWitness::Cancel(forfeit))),
        keys: vec![signer],
        amounts: Amounts::new_bitcoin(contract.amount),
    }])
    .into_dyn(lnv2);
    let operation = OperationId::new_random();
    let (accepted, redeem_txid, error) = match client
        .finalize_and_submit_transaction(operation, "blwp-stake-redeem", |_| (), TransactionBuilder::new().with_inputs(bundle))
        .await
    {
        Err(e) => (false, None, Some(format!("not submitted: {e}"))),
        Ok(change) => {
            let txid = change.txid();
            match client.transaction_updates(operation).await.await_tx_accepted(txid).await {
                Ok(()) => (true, Some(txid), None),
                Err(e) => (false, Some(txid), Some(e)),
            }
        }
    };
    let after = stored_at(api, outpoint).await?;
    println!(
        "{}",
        serde_json::json!({
            "mode": "redeem",
            "outpoint": format!("{}:{}", outpoint.txid, outpoint.out_idx),
            "contract_id": contract.contract_id().0.to_string(),
            "ids_match_before": before.map(|(id, _)| id == contract.contract_id()),
            "stored_before": stored_json(before),
            "block_count_at_redeem": count,
            "expiration": expiration,
            "forfeit_verifies_under_claim_pk": forfeit_verifies,
            "signer_pk": signer.public_key().to_string(),
            "signer_is_refund_pk": signer.public_key() == refund_pk,
            "accepted": accepted,
            "txid": redeem_txid.map(|t| t.to_string()),
            "error": error,
            "stored_after": stored_json(after),
        })
    );
    Ok(())
}

fn hex_bytes(s: &str) -> anyhow::Result<Vec<u8>> {
    if s.len() % 2 != 0 { bail!("odd-length hex") }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(Into::into)).collect()
}
