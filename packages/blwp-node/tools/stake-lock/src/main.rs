//! THE STAKE LOCK: ONE STOCK LNv2 `OutgoingContract`, FUNDED FROM THE PLAYER'S
//! OWN ECASH, WITH THE ROUND'S COMMITTEE AS `claim_pk` (FEDERATION.md, step 1);
//! THE PLAYER'S REDEEM OF THE COMMITTEE'S FORFEIT (step 2); AND THE
//! COMMITTEE'S ONE SETTLEMENT TRANSACTION (step 3a).
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
//! stock builder turn the value into the signer's ecash.
//!
//! --mode settle. The committee cannot hand the stock builder a `Keypair` -
//! its key is split - so this builds the raw `Transaction` itself: every given
//! lock in as `Claim(P)`, one payout out. The payout is a PRE-EXPIRED lock
//! (expiration 0) whose claim and refund keys are the qualifier's, so only the
//! qualifier can ever move it (FEDERATION.md, source audit point 2). Its value
//! is the inputs less the guardians' own LNv2 fees, read from the federation's
//! config: `base + amount * ppm / 1e6` on every input and every output
//! (lnv2-common config.rs). Without --signature it prints the txid and the
//! 32 bytes the guardians verify; with one it submits. The guardians check one
//! BIP-340 signature PER INPUT over the txid, each under that input's key
//! (fedimint-core transaction.rs, `validate_signatures`): every lock names the
//! committee, so the one signature is listed once per input.
//!
//!   blwp-stake-lock --data-dir D --amount-msat N --hash HEX --claim-pk HEX \
//!     --refund-pk HEX --expiry-delta BLOCKS
//!   blwp-stake-lock --mode redeem --data-dir D --outpoint TXID:IDX \
//!     --amount-msat N --hash HEX --claim-pk HEX --refund-pk HEX \
//!     --expiration BLOCK [--witness cancel --forfeit-sig HEX | --witness refund] \
//!     --signer-secret HEX
//!   blwp-stake-lock --mode status --data-dir D --outpoint TXID:IDX
//!   blwp-stake-lock --mode settle --data-dir D --claim-pk HEX \
//!     --locks TXID:IDX:PREIMAGE:MSAT[,...] --qualifier-pk HEX --nonce HEX16 \
//!     [--signature HEX]
use std::collections::HashMap;
use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

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
use fedimint_core::bitcoin::hashes::{Hash, sha256};
use fedimint_core::core::{IntoDynInstance, ModuleInstanceId, OperationId};
use fedimint_core::db::Database;
use fedimint_core::module::{Amounts, ApiRequestErased};
use fedimint_core::secp256k1::schnorr::Signature;
use fedimint_core::secp256k1::{Message, PublicKey, SECP256K1, SecretKey};
use fedimint_core::transaction::{Transaction, TransactionSignature};
use fedimint_core::{Amount, OutPoint, TransactionId};
use fedimint_lnv2_common::config::LightningClientConfig;
use fedimint_lnv2_common::contracts::{OutgoingContract, PaymentImage};
use fedimint_lnv2_common::endpoint_constants::{
    CONSENSUS_BLOCK_COUNT_ENDPOINT, OUTGOING_CONTRACT_EXPIRATION_ENDPOINT,
};
use fedimint_lnv2_common::{
    ContractId, KIND, LightningInput, LightningInputV0, LightningOutput, LightningOutputV0,
    OutgoingWitness,
};

type Args = HashMap<String, String>;

fn args() -> anyhow::Result<Args> {
    let mut out = HashMap::new();
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        let Some(name) = k.strip_prefix("--") else { bail!("unexpected argument {k}") };
        out.insert(name.to_owned(), it.next().with_context(|| format!("--{name} needs a value"))?);
    }
    Ok(out)
}

fn need<'a>(a: &'a Args, k: &str) -> anyhow::Result<&'a str> {
    a.get(k).map(String::as_str).with_context(|| format!("--{k} is required"))
}

fn hex_bytes(s: &str) -> anyhow::Result<Vec<u8>> {
    if s.len() % 2 != 0 { bail!("odd-length hex") }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(Into::into)).collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn outpoint(s: &str) -> anyhow::Result<OutPoint> {
    let (txid, idx) = s.split_once(':').context("an outpoint is TXID:IDX")?;
    Ok(OutPoint { txid: TransactionId::from_str(txid)?, out_idx: idx.parse()? })
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

/// The stake lock's own fields, as the lock and redeem modes name them.
fn stake_contract(a: &Args, expiration: u64) -> anyhow::Result<OutgoingContract> {
    let refund_pk = PublicKey::from_str(need(a, "refund-pk")?)?;
    Ok(OutgoingContract {
        payment_image: PaymentImage::Hash(sha256::Hash::from_str(need(a, "hash")?)?),
        amount: Amount::from_msats(need(a, "amount-msat")?.parse()?),
        expiration,
        claim_pk: PublicKey::from_str(need(a, "claim-pk")?)?,
        refund_pk,
        ephemeral_pk: refund_pk,
    })
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let a = args()?;
    let mode = a.get("mode").map_or("lock", String::as_str).to_owned();
    let client = open(PathBuf::from(need(&a, "data-dir")?)).await?;
    let lnv2 = client.get_first_instance(&KIND).context("this federation has no lnv2 module")?;
    let api = client.api().with_module(lnv2);
    match mode.as_str() {
        "lock" => lock(&a, &client, lnv2, &api).await,
        "redeem" => redeem(&a, &client, lnv2, &api).await,
        "settle" => settle(&a, &client, lnv2, &api).await,
        "status" => status(&a, &api).await,
        other => bail!("no mode {other}: lock, redeem, settle or status"),
    }
}

async fn lock(a: &Args, client: &ClientHandle, lnv2: ModuleInstanceId, api: &DynModuleApi) -> anyhow::Result<()> {
    let delta: u64 = need(a, "expiry-delta")?.parse()?;
    let count = block_count(api).await?;
    let contract = stake_contract(a, count + delta)?;
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
                    "claim_pk": contract.claim_pk.to_string(),
                    "refund_pk": contract.refund_pk.to_string(),
                })
            );
            return Ok(());
        }
    }
    bail!("the lock transaction {txid} was accepted but no outpoint of it holds an outgoing contract")
}

async fn redeem(a: &Args, client: &ClientHandle, lnv2: ModuleInstanceId, api: &DynModuleApi) -> anyhow::Result<()> {
    let outpoint = outpoint(need(a, "outpoint")?)?;
    let expiration: u64 = need(a, "expiration")?.parse()?;
    let signer = SecretKey::from_slice(&hex_bytes(need(a, "signer-secret")?)?)?.keypair(SECP256K1);

    // THE CONTRACT, REBUILT FROM ITS FIELDS: its id must be the one the
    // guardians hold at that outpoint, or this is some other lock.
    let contract = stake_contract(a, expiration)?;
    let before = stored_at(api, outpoint).await?;
    let count = block_count(api).await?;

    // WHICH WAY OUT (lnv2-server lib.rs:466-497): `cancel` is the committee's
    // forfeit - a signature by claim_pk over the contract id, any time;
    // `refund` needs no signature in the witness at all, only the lock's
    // expiration at or below the guardians' block count. Both then want the
    // TRANSACTION signed by refund_pk.
    let witness_kind = a.get("witness").map_or("cancel", String::as_str).to_owned();
    let (witness, forfeit_verifies) = match witness_kind.as_str() {
        "cancel" => {
            let forfeit = Signature::from_slice(&hex_bytes(need(a, "forfeit-sig")?)?)?;
            let verifies = contract.verify_forfeit_signature(&forfeit);
            (OutgoingWitness::Cancel(forfeit), Some(verifies))
        }
        "refund" => (OutgoingWitness::Refund, None),
        other => bail!("no witness {other}: cancel or refund"),
    };

    let bundle = ClientInputBundle::new_no_sm(vec![ClientInput {
        input: LightningInput::V0(LightningInputV0::Outgoing(outpoint, witness)),
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
            "witness": witness_kind,
            "outpoint": format!("{}:{}", outpoint.txid, outpoint.out_idx),
            "contract_id": contract.contract_id().0.to_string(),
            "ids_match_before": before.map(|(id, _)| id == contract.contract_id()),
            "stored_before": stored_json(before),
            "block_count_at_redeem": count,
            "expiration": expiration,
            "forfeit_verifies_under_claim_pk": forfeit_verifies,
            "signer_pk": signer.public_key().to_string(),
            "signer_is_refund_pk": signer.public_key() == contract.refund_pk,
            "accepted": accepted,
            "txid": redeem_txid.map(|t| t.to_string()),
            "error": error,
            "stored_after": stored_json(after),
        })
    );
    Ok(())
}

/// What the guardians hold at an outpoint, and their block count - for a
/// caller waiting on the guardians' count to reach an expiry.
async fn status(a: &Args, api: &DynModuleApi) -> anyhow::Result<()> {
    let op = outpoint(need(a, "outpoint")?)?;
    let count = block_count(api).await?;
    let stored = stored_at(api, op).await?;
    println!("{}", serde_json::json!({ "mode": "status", "block_count": count, "stored": stored_json(stored) }));
    Ok(())
}

async fn settle(a: &Args, client: &ClientHandle, lnv2: ModuleInstanceId, api: &DynModuleApi) -> anyhow::Result<()> {
    let claim_pk = PublicKey::from_str(need(a, "claim-pk")?)?;
    let qualifier = PublicKey::from_str(need(a, "qualifier-pk")?)?;
    let nonce: [u8; 8] = hex_bytes(need(a, "nonce")?)?.try_into().map_err(|_| anyhow!("--nonce is 8 bytes"))?;

    // THE GUARDIANS' OWN FEE RULE, off the federation's config - not assumed.
    let config = client.config().await;
    let fee = config
        .modules
        .get(&lnv2)
        .context("no lnv2 config")?
        .cast::<LightningClientConfig>()?
        .fee_consensus
        .clone();

    // EVERY LOCK IN, AS Claim(P).
    let mut locks = Vec::new();
    let mut inputs = Vec::new();
    let mut input_msats = 0u64;
    let mut input_fee_msats = 0u64;
    for spec in need(a, "locks")?.split(',') {
        let parts: Vec<&str> = spec.split(':').collect();
        let [txid, idx, preimage, msat] = parts[..] else { bail!("a lock is TXID:IDX:PREIMAGE:MSAT") };
        let op = OutPoint { txid: TransactionId::from_str(txid)?, out_idx: idx.parse()? };
        let preimage: [u8; 32] = hex_bytes(preimage)?.try_into().map_err(|_| anyhow!("a preimage is 32 bytes"))?;
        let amount = Amount::from_msats(msat.parse()?);
        input_msats += amount.msats;
        input_fee_msats += fee.fee(amount).msats;
        inputs.push(LightningInput::V0(LightningInputV0::Outgoing(op, OutgoingWitness::Claim(preimage))).into_dyn(lnv2));
        locks.push(op);
    }

    // ONE PAYOUT OUT, THE LARGEST THAT THE INPUTS PAY FOR: out + fee(out) <=
    // inputs - their fees. Stepped down from the top, so the figure is the
    // rule's and not an estimate of it.
    let spendable = input_msats - input_fee_msats;
    let mut out = spendable;
    while out > 0 && out + fee.fee(Amount::from_msats(out)).msats > spendable {
        out -= 1;
    }
    let output_fee_msats = fee.fee(Amount::from_msats(out)).msats;
    let payout = OutgoingContract {
        // Unused: the lock is pre-expired, so Claim is refused for everybody,
        // and its claim key is the qualifier's anyway.
        payment_image: PaymentImage::Hash(sha256::Hash::from_byte_array([0u8; 32])),
        amount: Amount::from_msats(out),
        expiration: 0,
        claim_pk: qualifier,
        refund_pk: qualifier,
        ephemeral_pk: qualifier,
    };
    let outputs = vec![LightningOutput::V0(LightningOutputV0::Outgoing(payout.clone())).into_dyn(lnv2)];
    let txid = Transaction::tx_hash_from_parts(&inputs, &outputs, nonce);
    let message_hex = hex(&txid[..]);

    let mut report = serde_json::json!({
        "mode": "settle",
        "txid": txid.to_string(),
        "message_hex": message_hex,
        "inputs": locks.iter().map(|o| format!("{}:{}", o.txid, o.out_idx)).collect::<Vec<_>>(),
        "input_msat": input_msats,
        "fee_ppm": fee.parts_per_million,
        "fee_base_msat": fee.base.msats,
        "input_fees_msat": input_fee_msats,
        "payout_msat": out,
        "output_fee_msat": output_fee_msats,
        "unspent_msat": input_msats - input_fee_msats - out - output_fee_msats,
        "payout_contract_id": payout.contract_id().0.to_string(),
        "qualifier_pk": qualifier.to_string(),
    });
    let Some(sig_hex) = a.get("signature") else {
        println!("{report}");
        return Ok(());
    };

    let signature = Signature::from_slice(&hex_bytes(sig_hex)?)?;
    let verifies = SECP256K1
        .verify_schnorr(&signature, &Message::from_digest_slice(&txid[..])?, &claim_pk.x_only_public_key().0)
        .is_ok();
    let before: Vec<_> = futures_join(api, &locks).await?;
    let count = block_count(api).await?;
    let tx = Transaction {
        inputs,
        outputs,
        nonce,
        // ONE SIGNATURE PER INPUT, each under that input's key: every lock names
        // the committee, so the committee's one signature is listed per input.
        signatures: TransactionSignature::NaiveMultisig(vec![signature; locks.len()]),
    };
    let outcome = client
        .api()
        .submit_transaction(tx)
        .await
        .try_into_inner(client.decoders())
        .map_err(|e| anyhow!("the guardians' answer did not decode: {e}"))?;
    let (accepted, error) = match outcome.0 {
        Ok(_) => (true, None),
        Err(e) => (false, Some(e.to_string())),
    };

    // AND WHAT THE GUARDIANS HOLD AFTERWARDS. An accepted submission is then
    // processed in consensus, so the payout is waited for (up to 60 s).
    let payout_outpoint = OutPoint { txid, out_idx: 0 };
    let mut payout_stored = stored_at(api, payout_outpoint).await?;
    let started = std::time::Instant::now();
    while accepted && payout_stored.is_none() && started.elapsed() < Duration::from_secs(60) {
        tokio::time::sleep(Duration::from_millis(500)).await;
        payout_stored = stored_at(api, payout_outpoint).await?;
    }
    let after: Vec<_> = futures_join(api, &locks).await?;
    let obj = report.as_object_mut().expect("an object");
    obj.insert("signature_verifies_under_claim_pk".into(), verifies.into());
    obj.insert("signatures_listed".into(), locks.len().into());
    obj.insert("block_count_at_submit".into(), count.into());
    obj.insert("locks_before".into(), serde_json::Value::Array(before));
    obj.insert("accepted".into(), accepted.into());
    obj.insert("error".into(), error.into());
    obj.insert("locks_after".into(), serde_json::Value::Array(after));
    obj.insert("payout_stored".into(), stored_json(payout_stored));
    obj.insert("payout_wait_ms".into(), (started.elapsed().as_millis() as u64).into());
    println!("{report}");
    Ok(())
}

async fn futures_join(api: &DynModuleApi, locks: &[OutPoint]) -> anyhow::Result<Vec<serde_json::Value>> {
    let mut out = Vec::new();
    for op in locks {
        out.push(stored_json(stored_at(api, *op).await?));
    }
    Ok(out)
}
