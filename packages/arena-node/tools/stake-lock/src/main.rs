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
//!     --locks TXID:IDX:PREIMAGE:MSAT[,...] --nonce HEX16 \
//!     (--payouts PK:MSAT[,...] | --qualifier-pk HEX) [--signature HEX]
//!   blwp-stake-lock --mode fees --data-dir D
//!   blwp-stake-lock --mode guardians --data-dir D
//!
//! W4 (the owner 2026-09-14): a loser loses the stake - the seats' settlement names
//! every payout exactly with --payouts (their rule, arena-node settlement.js),
//! and this refuses any set the locks cannot pay for after the guardians' fees.
//! --mode fees prints that fee rule, which the seats read before sizing them.
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
use fedimint_core::{Amount, NumPeersExt, OutPoint, TransactionId};
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

/// JOIN A FEDERATION (kanban #348, RULED the owner 2026-10-13: "Every node serves every federation"): a signer node finds a
/// federation in its census and joins it here, with the invite its signed record carries - as fedimint-cli joins it (the
/// same modules, RocksDB and 12-word secret, stored first), but through the connect overrides this tool reads
/// (FM_WS_API_CONNECT_OVERRIDES), which the stock fedimint-cli does not. A directory that holds a secret already keeps it.
async fn join(data_dir: PathBuf, invite: &str) -> anyhow::Result<ClientHandle> {
    let invite = fedimint_core::invite_code::InviteCode::from_str(invite).context("that is no invite code")?;
    let builder = client_builder().await?;
    std::fs::create_dir_all(&data_dir)?;
    let db: Database = fedimint_rocksdb::RocksDb::build(data_dir.join("client.db"))
        .open()
        .await
        .context("could not open the client's rocksdb")?
        .into();
    let mnemonic = match Client::load_decodable_client_secret_opt::<Vec<u8>>(&db).await? {
        Some(entropy) => Mnemonic::from_entropy(&entropy)?,
        None => {
            // 128 bits from the OS for the 12 words - no RNG crate in this tool's tree
            let mut entropy = [0u8; 16];
            std::io::Read::read_exact(&mut std::fs::File::open("/dev/urandom")?, &mut entropy)?;
            let m = Mnemonic::from_entropy(&entropy)?;
            Client::store_encodable_client_secret(&db, m.to_entropy()).await?;
            m
        }
    };
    let root = RootSecret::StandardDoubleDerive(Bip39RootSecretStrategy::<12>::to_root_secret(&mnemonic));
    let endpoints = ConnectorRegistry::build_from_client_defaults().with_env_var_overrides()?.bind().await?;
    Ok(builder.preview(endpoints, &invite).await?.join(db, root).await?)
}

async fn client_builder() -> anyhow::Result<fedimint_client::ClientBuilder> {
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
    Ok(builder)
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
    // THE GUARDIANS ON THIS MACHINE, BY THEIR LOCAL PORTS WHEN SAID (FM_WS_API_CONNECT_OVERRIDES, the stock override - this
    // tool never read it): measured 2026-10-03 16:20Z, every call through the guardians' Funnel addresses lost 3 of 7 peers
    // to the relay that drops this machine, and a consensus read needs 5 - the seats got through on retries only.
    let endpoints = ConnectorRegistry::build_from_client_defaults().with_env_var_overrides()?.bind().await?;
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
///
/// THE IMAGE IS A POINT for a stake lock (v4.6.2 §23.1 step 4, F1): `--point`
/// is the entry's stake_point, the Feldman A0 of the dealt shares, so the seats
/// can check the shares against it. `--hash` stays for a fee lock's H(F) and for
/// the rehearsal's earlier hash-image locks.
fn stake_contract(a: &Args, expiration: u64) -> anyhow::Result<OutgoingContract> {
    let refund_pk = PublicKey::from_str(need(a, "refund-pk")?)?;
    let payment_image = match a.get("point") {
        Some(point) => PaymentImage::Point(PublicKey::from_str(point)?),
        None => PaymentImage::Hash(sha256::Hash::from_str(need(a, "hash")?)?),
    };
    Ok(OutgoingContract {
        payment_image,
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
    // THE CONTRACT ID OF A HANDED-OVER CONTRACT, the stock client's own hash: a
    // seat compares it with the id the guardians hold at the entry's outpoint
    // (§23.1 step 5). Local arithmetic - no client, no federation.
    if mode == "id" {
        let contract = stake_contract(&a, need(&a, "expiration")?.parse()?)?;
        println!("{}", serde_json::json!({ "mode": "id", "contract_id": contract.contract_id().0.to_string() }));
        return Ok(());
    }
    if mode == "join" {
        let client = join(PathBuf::from(need(&a, "data-dir")?), need(&a, "invite")?).await?;
        println!("{}", serde_json::json!({ "mode": "join", "federation_id": client.federation_id().to_string() }));
        return Ok(());
    }
    let client = open(PathBuf::from(need(&a, "data-dir")?)).await?;
    let lnv2 = client.get_first_instance(&KIND).context("this federation has no lnv2 module")?;
    let api = client.api().with_module(lnv2);
    match mode.as_str() {
        "lock" => lock(&a, &client, lnv2, &api).await,
        "redeem" => redeem(&a, &client, lnv2, &api).await,
        "settle" => settle(&a, &client, lnv2, &api).await,
        "status" => { println!("{}", status(&a, &api).await?); Ok(()) }
        "fees" => { println!("{}", fees(&client, lnv2).await?); Ok(()) }
        "guardians" => { println!("{}", guardians(&client).await?); Ok(()) }
        "gateways" => { println!("{}", gateways(&client, &api).await?); Ok(()) }
        // THE SEAT'S READ-ONLY QUESTIONS, ONE CLIENT FOR ALL OF THEM (kanban #293, measured 2026-10-10 on the test host's paid
        // RPS stack: a process per question opened the client's database and reached the guardians each time - dozens of
        // them at 60-80 % CPU each with 8 s paid rounds, the machine at load 50 and a paid tap past 1.5 s): this process
        // stays, the client open, and answers one JSON request per stdin line - { "id", "mode", "args": { name: value } } ->
        // { "id", "ok", "result" | "error" }. Only status, fees, guardians, gateways and id: nothing that moves money.
        "serve" => serve(&client, lnv2, &api).await,
        "send" => send(&a, &client).await,
        // THE ARBITER'S PEG-IN (kanban #307, spec §5A.3: "the arbitration set pegs it into the round's federation"): an
        // address the federation controls, and the claim once a payment to it is confirmed - the escrow becomes e-cash in
        // the arbiter's own client, from which each affected entry's share is locked to its player (mode lock)
        "pegin-address" => pegin_address(&client).await,
        "pegin-claim" => pegin_claim(&a, &client).await,
        // THE SLASH'S PAYOUTS (kanban #307, spec §5A.3B): each wronged player's share, from the arbiter's own e-cash (the escrow
        // it pegged in), as a settlement pays a qualifier - a pre-expired lock only that player's key ever moves
        "pay" => pay(&a, &client, lnv2, &api).await,
        other => bail!("no mode {other}: lock, redeem, settle, status, fees, guardians, gateways, send, serve, pegin-address, pegin-claim, pay or id"),
    }
}

async fn serve(client: &ClientHandle, lnv2: ModuleInstanceId, api: &DynModuleApi) -> anyhow::Result<()> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut line = String::new();
        loop {
            line.clear();
            match std::io::BufRead::read_line(&mut stdin.lock(), &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => { if tx.send(line.clone()).is_err() { break; } }
            }
        }
    });
    println!("{}", serde_json::json!({ "mode": "serve", "ready": true, "federation_id": client.federation_id().to_string() }));
    while let Some(line) = rx.recv().await {
        let req: serde_json::Value = match serde_json::from_str(line.trim()) { Ok(v) => v, Err(e) => {
            println!("{}", serde_json::json!({ "id": null, "ok": false, "error": format!("not JSON: {e}") })); continue; } };
        let id = req.get("id").cloned().unwrap_or(serde_json::Value::Null);
        let mode = req.get("mode").and_then(|m| m.as_str()).unwrap_or("").to_owned();
        let mut a: Args = HashMap::new();
        if let Some(o) = req.get("args").and_then(|v| v.as_object()) {
            for (k, v) in o { a.insert(k.clone(), v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string())); }
        }
        let got = match mode.as_str() {
            "status" => status(&a, api).await,
            "fees" => fees(client, lnv2).await,
            "guardians" => guardians(client).await,
            "gateways" => gateways(client, api).await,
            "id" => match need(&a, "expiration").and_then(|e| e.parse::<u64>().map_err(Into::into)) {
                Ok(exp) => stake_contract(&a, exp).map(|c| serde_json::json!({ "mode": "id", "contract_id": c.contract_id().0.to_string() })),
                Err(e) => Err(e),
            },
            other => Err(anyhow!("serve answers status, fees, guardians, gateways and id - not {other}")),
        };
        let out = match got { Ok(v) => serde_json::json!({ "id": id, "ok": true, "result": v }),
            Err(e) => serde_json::json!({ "id": id, "ok": false, "error": format!("{e:#}") }) };
        println!("{out}");
    }
    Ok(())
}

/// WINNINGS SENT: A GATEWAY IS ASKED TO PAY ONE OUTGOING CONTRACT'S INVOICE (§23.6; "winnings are always sent",
/// the owner 2026-09-21, ruled for FEDERATION 2026-09-23). The contract is the one the settlement funded, rebuilt from
/// its fields; the gateway pays only with a BIP-340 signature by the contract's refund key over the invoice's
/// consensus hash (gwv2-client: "Invalid auth signature for the invoice data"), and the refund key is the round's
/// committee claim key - so without --auth this prints the message the committee must sign, and with it, the
/// stock client's own send_payment is posted to --gateway: the preimage if the gateway paid, or its answer.
async fn send(a: &Args, client: &ClientHandle) -> anyhow::Result<()> {
    use fedimint_core::encoding::Encodable;
    use fedimint_lnv2_common::gateway_api::{GatewayConnection, RealGatewayConnection};
    let refund_pk = PublicKey::from_str(need(a, "refund-pk")?)?;
    let contract = OutgoingContract {
        payment_image: PaymentImage::Hash(sha256::Hash::from_str(need(a, "hash")?)?),
        amount: Amount::from_msats(need(a, "amount-msat")?.parse()?),
        expiration: need(a, "expiration")?.parse()?,
        claim_pk: PublicKey::from_str(need(a, "claim-pk")?)?,
        refund_pk,
        ephemeral_pk: refund_pk,
    };
    let bolt11 = lightning_invoice::Bolt11Invoice::from_str(need(a, "invoice")?).map_err(|e| anyhow!("not a bolt11 invoice: {e:?}"))?;
    if bolt11.payment_hash().to_byte_array() != match &contract.payment_image { PaymentImage::Hash(h) => h.to_byte_array(), PaymentImage::Point(_) => [0u8; 32] } {
        bail!("the invoice's payment hash is not the contract's");
    }
    let invoice = fedimint_lnv2_common::LightningInvoice::Bolt11(bolt11);
    let message = invoice.consensus_hash::<sha256::Hash>();
    let mut report = serde_json::json!({
        "mode": "send",
        "contract_id": contract.contract_id().0.to_string(),
        "auth_message_hex": hex(message.as_ref()),
    });
    let Some(auth_hex) = a.get("auth") else {
        println!("{report}");
        return Ok(());
    };
    let auth = Signature::from_slice(&hex_bytes(auth_hex)?)?;
    if SECP256K1.verify_schnorr(&auth, &Message::from_digest(*message.as_ref()), &refund_pk.x_only_public_key().0).is_err() {
        bail!("that auth signature is not the refund key's over this invoice");
    }
    let (txid, idx) = need(a, "outpoint")?.split_once(':').context("an outpoint is TXID:IDX")?;
    let outpoint = OutPoint { txid: TransactionId::from_str(txid)?, out_idx: idx.parse()? };
    let gateway = fedimint_core::util::SafeUrl::parse(need(a, "gateway")?)?;
    let connectors = ConnectorRegistry::build_from_client_defaults().with_env_var_overrides()?.bind().await?;
    let conn = RealGatewayConnection { api: fedimint_lnv2_common::GatewayApi::new(None, connectors) };
    let said = conn.send_payment(gateway.clone(), client.federation_id(), outpoint, contract, invoice, auth).await;
    match said {
        Ok(Ok(preimage)) => { report["sent"] = true.into(); report["preimage"] = hex(&preimage).into(); }
        Ok(Err(forfeit)) => { report["sent"] = false.into(); report["why"] = "the gateway cancelled: it forfeits its claim".into();
            report["forfeit_signature"] = hex(&forfeit.serialize()).into(); }
        Err(e) => { report["sent"] = false.into(); report["why"] = format!("{e:?}").into(); }
    }
    report["gateway"] = gateway.to_string().into();
    println!("{report}");
    Ok(())
}

/// THE FEDERATION'S GATEWAYS, AS ITS GUARDIANS LIST THEM AND AS EACH ANSWERS (§23.6: "deposits and
/// withdrawals through any of at least two gateways run by different operators"; FEDERATION.md condition 3).
/// Every gateway URL the guardians have registered (lnv2 `list_gateways`, the union over peers), and for
/// each one what it says for itself when asked (`routing_info` for this federation): its Lightning node's
/// public key - which signs its invoices, so it IS the gateway's identity - and its module key. A gateway
/// that does not answer, or answers that it does not serve this federation, is listed with `live: false`.
/// Two URLs in front of one Lightning node carry one key and are one gateway; counting them is the
/// caller's (`gatewaysAreIndependent`), not this tool's. Read-only: nothing is paid or registered.
async fn gateways(client: &ClientHandle, api: &DynModuleApi) -> anyhow::Result<serde_json::Value> {
    let lnv2 = client.get_first_module::<fedimint_lnv2_client::LightningClientModule>()?;
    let urls = lnv2.list_gateways(None).await.map_err(|e| anyhow!("the guardians did not list gateways: {e:?}"))?;
    let mut listed = Vec::new();
    for url in urls {
        let said = lnv2.routing_info(&url).await;
        listed.push(match said {
            Ok(Some(info)) => serde_json::json!({
                "url": url.to_string(), "live": true,
                "lightning_public_key": info.lightning_public_key.to_string(),
                "module_public_key": info.module_public_key.to_string(),
                // ITS OWN TERMS FOR A LIGHTNING SEND: the fee it takes out of an outgoing contract and the
                // expiration it wants - what a winnings contract is sized and dated by.
                "send_fee_default": { "base_msat": info.send_fee_default.base.msats, "ppm": info.send_fee_default.parts_per_million },
                "expiration_delta_default": info.expiration_delta_default,
                "expiration_delta_minimum": info.expiration_delta_minimum,
            }),
            Ok(None) => serde_json::json!({ "url": url.to_string(), "live": false,
                "why": "the gateway answered that it does not serve this federation" }),
            Err(e) => serde_json::json!({ "url": url.to_string(), "live": false, "why": format!("{e:?}") }),
        });
    }
    Ok(serde_json::json!({
        "mode": "gateways",
        "federation_id": client.federation_id().to_string(),
        // THE FEDERATION'S OWN HEIGHT, the consensus block count a contract's expiration is measured against.
        "block_count": block_count(api).await?,
        "gateways": listed,
    }))
}

/// THE FEDERATION'S GUARDIANS, OFF ITS OWN CONFIG (the owner 2026-09-15 07:33: every guardian
/// has its own bond; federationIsBonded stays on). Each guardian's broadcast key - the 33-byte
/// secp256k1 key a census node advertises under guardian_of[] (§5A.1) - and the federation's
/// own consensus threshold, n - floor((n-1)/3) over its API endpoints (NumPeers::threshold).
/// fedimint 0.12 hashes the endpoints into the federation id (calculate_federation_id), so the
/// id fixes n and the threshold; the keys come with the config the stock client downloaded
/// and checked on join. Read-only: nothing is sent.
async fn guardians(client: &ClientHandle) -> anyhow::Result<serde_json::Value> {
    let config = client.config().await;
    let n = config.global.api_endpoints.to_num_peers();
    let keys = config
        .global
        .broadcast_public_keys
        .clone()
        .context("this federation's config names no guardian broadcast keys")?;
    let listed: Vec<serde_json::Value> = keys
        .iter()
        .map(|(peer, key)| serde_json::json!({ "peer": peer.to_string(), "key": key.to_string() }))
        .collect();
    Ok(serde_json::json!({
        "mode": "guardians",
        "federation_id": client.federation_id().to_string(),
        "guardians": n.total(),
        "threshold": n.threshold(),
        "keys": listed,
    }))
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

/// --mode pay --payouts PK:MSAT[,PK:MSAT...] (kanban #307, spec §5A.3B "the arbitration set pegs it into the round's
/// federation and locks each share to its player"): ONE transaction from this client's own e-cash, one output per player -
/// the payout shape of --mode settle: expiration 0 (pre-expired, so Claim is refused for everybody), claim and refund keys
/// the player's, the image unused - so only that player's key ever moves it, by the refund the page already takes for a
/// settlement's payout. Each payout's outpoint is read back from the guardians by its contract id.
async fn pay(a: &Args, client: &ClientHandle, lnv2: ModuleInstanceId, api: &DynModuleApi) -> anyhow::Result<()> {
    let mut contracts: Vec<OutgoingContract> = Vec::new();
    for spec in need(a, "payouts")?.split(',') {
        let (pk, msat) = spec.split_once(':').context("a payout is PK:MSAT")?;
        let pk = PublicKey::from_str(pk)?;
        contracts.push(OutgoingContract {
            payment_image: PaymentImage::Hash(sha256::Hash::from_byte_array([0u8; 32])),
            amount: Amount::from_msats(msat.parse()?),
            expiration: 0,
            claim_pk: pk,
            refund_pk: pk,
            ephemeral_pk: pk,
        });
    }
    let outputs = contracts
        .iter()
        .map(|c| ClientOutput { output: LightningOutput::V0(LightningOutputV0::Outgoing(c.clone())), amounts: Amounts::new_bitcoin(c.amount) })
        .collect::<Vec<_>>();
    let bundle = ClientOutputBundle::new_no_sm(outputs).into_dyn(lnv2);
    let operation = OperationId::new_random();
    let change = client
        .finalize_and_submit_transaction(operation, "arena-slash-payouts", |_| (), TransactionBuilder::new().with_outputs(bundle))
        .await?;
    let txid = change.txid();
    client
        .transaction_updates(operation)
        .await
        .await_tx_accepted(txid)
        .await
        .map_err(|e| anyhow!("the guardians did not accept the payout transaction: {e}"))?;
    // WHERE EACH PAYOUT LANDED: the builder places the change, so every outpoint is read and matched by contract id
    let mut found = Vec::new();
    for out_idx in 0..(contracts.len() as u64 + 16) {
        if let Some((stored_id, _)) = stored_at(api, OutPoint { txid, out_idx }).await? {
            if let Some(c) = contracts.iter().find(|c| c.contract_id() == stored_id) {
                found.push(serde_json::json!({ "out_idx": out_idx, "contract_id": stored_id.0.to_string(),
                    "refund_pk": c.refund_pk.to_string(), "amount_msat": c.amount.msats }));
            }
        }
    }
    if found.len() != contracts.len() {
        bail!("the payout transaction {txid} was accepted, and {} of its {} payouts were found at the guardians", found.len(), contracts.len());
    }
    let balance = client.get_balance_for_btc().await.map(|b| b.msats).unwrap_or(0);
    println!("{}", serde_json::json!({ "mode": "pay", "txid": txid.to_string(), "payouts": found, "balance_after_msat": balance }));
    Ok(())
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
async fn status(a: &Args, api: &DynModuleApi) -> anyhow::Result<serde_json::Value> {
    let op = outpoint(need(a, "outpoint")?)?;
    let count = block_count(api).await?;
    let stored = stored_at(api, op).await?;
    Ok(serde_json::json!({ "mode": "status", "block_count": count, "stored": stored_json(stored) }))
}

/// THE GUARDIANS' OWN LNv2 FEE RULE, off the federation's config: `base +
/// amount * ppm / 1e6` on every input and every output (lnv2-common config.rs).
/// The seats read it before they size a settlement's payouts.
async fn fees(client: &ClientHandle, lnv2: ModuleInstanceId) -> anyhow::Result<serde_json::Value> {
    let config = client.config().await;
    let fee = config
        .modules
        .get(&lnv2)
        .context("no lnv2 config")?
        .cast::<LightningClientConfig>()?
        .fee_consensus
        .clone();
    Ok(serde_json::json!({ "mode": "fees", "fee_ppm": fee.parts_per_million, "fee_base_msat": fee.base.msats }))
}

async fn settle(a: &Args, client: &ClientHandle, lnv2: ModuleInstanceId, api: &DynModuleApi) -> anyhow::Result<()> {
    let claim_pk = PublicKey::from_str(need(a, "claim-pk")?)?;
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
    for spec in a.get("locks").map(String::as_str).unwrap_or("").split(',').filter(|x| !x.is_empty()) {
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

    // AND EVERY EXPIRED PAYOUT CONTRACT OF THE COMMITTEE'S, AS Refund: a winnings contract whose gateway did not
    // pay before its expiration returns to the refund key it names - the round's committee claim key - and is
    // spent here into the payout that re-sends it (--refunds TXID:IDX:MSAT[,...]; the one signature covers it).
    for spec in a.get("refunds").map(String::as_str).unwrap_or("").split(',').filter(|x| !x.is_empty()) {
        let parts: Vec<&str> = spec.split(':').collect();
        let [txid, idx, msat] = parts[..] else { bail!("a refund is TXID:IDX:MSAT") };
        let op = OutPoint { txid: TransactionId::from_str(txid)?, out_idx: idx.parse()? };
        let amount = Amount::from_msats(msat.parse()?);
        input_msats += amount.msats;
        input_fee_msats += fee.fee(amount).msats;
        inputs.push(LightningInput::V0(LightningInputV0::Outgoing(op, OutgoingWitness::Refund)).into_dyn(lnv2));
        locks.push(op);
    }
    if inputs.is_empty() {
        bail!("a settlement spends at least one lock (--locks) or one expired payout (--refunds)");
    }

    // THE PAYOUTS. With --payouts PK:MSAT[,...] exactly those, in that order -
    // the amounts are the seats' rule (arena-node settlement), not this tool's -
    // and refused outright if they and their fees are more than the locks pay
    // for. Without it, the rehearsal's shape: ONE payout to --qualifier-pk, the
    // largest the inputs pay for (out + fee(out) <= inputs - their fees),
    // stepped down from the top so the figure is the rule's.
    let spendable = input_msats - input_fee_msats;
    // A PAYOUT IS ONE OF TWO SHAPES. `PK:MSAT` is the pre-expired contract only PK can move (the Collect shape).
    // `invoice:HASH:GATEWAY_PK:REFUND_PK:EXPIRATION:MSAT` is WINNINGS ALWAYS SENT (the owner 2026-09-21, ruled for
    // FEDERATION 2026-09-23): an outgoing contract the named gateway may claim only with the preimage of HASH -
    // that is, only by paying the winner's invoice - and which, unpaid past EXPIRATION, refunds to REFUND_PK, the
    // round's committee claim key, never the winner's. The fields are the signer node's, rebuilt byte for byte.
    // ONE LIST, IN THE ORDER GIVEN: the txid is over the outputs in order, and the signer node sorts them.
    let mut payouts: Vec<(PublicKey, u64)> = Vec::new();
    let mut ordered: Vec<OutgoingContract> = Vec::new();
    if let Some(list) = a.get("payouts") {
        for spec in list.split(',') {
            if let Some(rest) = spec.strip_prefix("invoice:") {
                let p: Vec<&str> = rest.split(':').collect();
                let [hash, gateway, refund, expiration, msat] = p[..] else {
                    bail!("an invoice payout is invoice:HASH:GATEWAY_PK:REFUND_PK:EXPIRATION:MSAT")
                };
                let refund_pk = PublicKey::from_str(refund)?;
                ordered.push(OutgoingContract {
                    payment_image: PaymentImage::Hash(sha256::Hash::from_str(hash)?),
                    amount: Amount::from_msats(msat.parse()?),
                    expiration: expiration.parse()?,
                    claim_pk: PublicKey::from_str(gateway)?,
                    refund_pk,
                    ephemeral_pk: refund_pk,
                });
                continue;
            }
            let (pk, msat) = spec.split_once(':').context("a payout is PK:MSAT")?;
            let pk = PublicKey::from_str(pk)?;
            payouts.push((pk, msat.parse()?));
            ordered.push(OutgoingContract {
                // Unused: the lock is pre-expired, so Claim is refused for everybody,
                // and its claim key is the qualifier's anyway.
                payment_image: PaymentImage::Hash(sha256::Hash::from_byte_array([0u8; 32])),
                amount: Amount::from_msats(msat.parse()?),
                expiration: 0,
                claim_pk: pk,
                refund_pk: pk,
                ephemeral_pk: pk,
            });
        }
    } else {
        let qualifier = PublicKey::from_str(need(a, "qualifier-pk")?)?;
        let mut out = spendable;
        while out > 0 && out + fee.fee(Amount::from_msats(out)).msats > spendable {
            out -= 1;
        }
        payouts.push((qualifier, out));
    }
    if a.get("payouts").is_none() {
        for (pk, msat) in &payouts {
            ordered.push(OutgoingContract {
                payment_image: PaymentImage::Hash(sha256::Hash::from_byte_array([0u8; 32])),
                amount: Amount::from_msats(*msat), expiration: 0, claim_pk: *pk, refund_pk: *pk, ephemeral_pk: *pk,
            });
        }
    }
    let mut outputs = Vec::new();
    let mut contracts = Vec::new();
    let mut out = 0u64;
    let mut output_fee_msats = 0u64;
    for c in &ordered {
        out += c.amount.msats;
        output_fee_msats += fee.fee(c.amount).msats;
        outputs.push(LightningOutput::V0(LightningOutputV0::Outgoing(c.clone())).into_dyn(lnv2));
        contracts.push(c.clone());
    }
    if out + output_fee_msats > spendable {
        bail!("the payouts ({out} msat, {output_fee_msats} msat in fees) are more than the locks pay for ({spendable} msat after their own fees)");
    }
    let payout = contracts.first().cloned().context("a settlement pays at least one payout")?;
    let qualifier = payout.refund_pk;
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
        "payouts": contracts.iter().enumerate().map(|(i, c)| serde_json::json!({
            "out_idx": i, "pk": c.refund_pk.to_string(), "msat": c.amount.msats,
            "contract_id": c.contract_id().0.to_string(),
            "claim_pk": c.claim_pk.to_string(), "expiration": c.expiration,
            "payment_hash": match &c.payment_image { PaymentImage::Hash(h) => h.to_string(), PaymentImage::Point(p) => p.to_string() },
        })).collect::<Vec<_>>(),
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
    let payout_outpoints: Vec<OutPoint> = (0..contracts.len()).map(|i| OutPoint { txid, out_idx: i as u64 }).collect();
    let payouts_stored: Vec<_> = futures_join(api, &payout_outpoints).await?;
    let obj = report.as_object_mut().expect("an object");
    obj.insert("payouts_stored".into(), serde_json::Value::Array(payouts_stored));
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

// ALL AT ONCE, IN THE ORDER GIVEN (kanban #336, measured 2026-10-11 on the regtest Up/Down market: a book round's settle read
// each of its ~50 locks before and after the submit and each of its ~30 payouts after it ONE AFTER ANOTHER - ~135 consensus
// reads at 1-2 s each - and was killed at 300 s every time; a two-order round's 8 reads had always fit). One task a read.
async fn futures_join(api: &DynModuleApi, locks: &[OutPoint]) -> anyhow::Result<Vec<serde_json::Value>> {
    let mut set = tokio::task::JoinSet::new();
    for (i, op) in locks.iter().enumerate() {
        let api = api.clone();
        let op = *op;
        set.spawn(async move { (i, stored_at(&api, op).await) });
    }
    let mut out = vec![serde_json::Value::Null; locks.len()];
    while let Some(done) = set.join_next().await {
        let (i, got) = done.map_err(|e| anyhow!("a consensus read did not finish: {e}"))?;
        out[i] = stored_json(got?);
    }
    Ok(out)
}


/// A PEG-IN ADDRESS of this client's federation: the wallet module the federation runs (testnet4: `wallet`, the fork's
/// regtest: `walletv2`). Prints { mode, kind, address, operation_id?, tweak_idx? }.
async fn pegin_address(client: &ClientHandle) -> anyhow::Result<()> {
    if let Ok(w) = client.get_first_module::<fedimint_wallet_client::WalletClientModule>() {
        let info = w.safe_allocate_deposit_address(()).await?;
        println!("{}", serde_json::json!({ "mode": "pegin-address", "kind": "wallet", "address": info.address.to_string(),
            "operation_id": info.operation_id.fmt_full().to_string(), "tweak_idx": format!("{:?}", info.tweak_idx) }));
        return Ok(());
    }
    let w = client.get_first_module::<fedimint_walletv2_client::WalletClientModule>().context("this federation runs no wallet module")?;
    let address = w.receive().await;
    println!("{}", serde_json::json!({ "mode": "pegin-address", "kind": "walletv2", "address": address.to_string() }));
    Ok(())
}

/// THE CLAIM of a confirmed payment to a peg-in address (--address): waits until the federation has claimed it and its
/// e-cash is in this client (at most --timeout-s, default 900), and prints the balance before and after.
async fn pegin_claim(a: &Args, client: &ClientHandle) -> anyhow::Result<()> {
    let before = client.get_balance_for_btc().await?;
    let timeout = std::time::Duration::from_secs(a.get("timeout-s").map_or(Ok(900), |t| t.parse())?);
    let waited = async {
        if let Ok(w) = client.get_first_module::<fedimint_wallet_client::WalletClientModule>() {
            let address = fedimint_core::bitcoin::Address::<fedimint_core::bitcoin::address::NetworkUnchecked>::from_str(need(a, "address")?)?;
            w.await_num_deposits_by_address(address, 1).await?;
            return anyhow::Ok("wallet");
        }
        // walletv2 claims in the background: wait for the balance to grow
        loop {
            if client.get_balance_for_btc().await? > before { return anyhow::Ok("walletv2"); }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    };
    let kind = tokio::time::timeout(timeout, waited).await.map_err(|_| anyhow!("no claim within {timeout:?}"))??;
    // the e-cash a claim mints is issued after its consensus item: wait a moment for the balance to show it
    let mut after = client.get_balance_for_btc().await?;
    for _ in 0..30 { if after > before { break; } tokio::time::sleep(std::time::Duration::from_secs(1)).await; after = client.get_balance_for_btc().await?; }
    println!("{}", serde_json::json!({ "mode": "pegin-claim", "kind": kind, "balance_before_msat": before.msats, "balance_after_msat": after.msats }));
    Ok(())
}
