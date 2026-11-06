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
//!   arena-stake-lock --data-dir D --amount-msat N --hash HEX --claim-pk HEX \
//!     --refund-pk HEX --expiry-delta BLOCKS
//!   arena-stake-lock --mode redeem --data-dir D --outpoint TXID:IDX \
//!     --amount-msat N --hash HEX --claim-pk HEX --refund-pk HEX \
//!     --expiration BLOCK [--witness cancel --forfeit-sig HEX | --witness refund] \
//!     --signer-secret HEX
//!   arena-stake-lock --mode status --data-dir D --outpoint TXID:IDX
//!   arena-stake-lock --mode send-claimed --data-dir D --outpoint TXID:IDX [--wait-ms N]   did a gateway claim it (kanban #1185)
//!   arena-stake-lock --mode settle --data-dir D --claim-pk HEX \
//!     --locks TXID:IDX:PREIMAGE:MSAT[,...] --nonce HEX16 \
//!     (--payouts PK:MSAT[,...] | --qualifier-pk HEX) [--signature HEX]
//!   arena-stake-lock --mode fees --data-dir D
//!   arena-stake-lock --mode guardians --data-dir D
//!   arena-stake-lock --mode session-audit --data-dir D [--from N] [--to N] [--peer ID] [--parallel N]
//!     [--max-sessions N] [--carry-issued-msat N --carry-redeemed-msat N] [--cursor FILE] [--follow SECONDS]
//!     [--sessions-dir DIR | --replay-dir DIR] [--bitcoind URL [--depth 6]] [--proof-out FILE] [--tamper false]
//!   arena-stake-lock --mode session-proof-verify --proof FILE|- [--keys JSON|@FILE]
//!   arena-stake-lock --mode theft-verify < {federationId, config, firstSession, sessions, spendTxid?, reserve?}
//!   arena-stake-lock --mode session-export --data-dir D --from N --to M --out F
//!   arena-stake-lock --mode session-count --data-dir D                        how many sessions the federation finished
//!   arena-stake-lock --mode pegout --data-dir D --address ADDR --sats N
//!   (src/audit.rs; the regtest rehearsal modes are in src/rehearsal.rs)
//!   arena-id | arena-version | arena-lock | arena-status | arena-redeem | arena-settle | musig-* : THE ARENA LOCK
//!   (kanban #1044 B1), whose claim and forfeit name their signers - src/arena.rs
//!
//! A CLIENT WITH NO ESPLORA (regtest): ARENA_CLIENT_BITCOIND=http://user:pass@host:port gives the wallet client a
//! bitcoind to watch peg-in addresses with, instead of the federation's default Bitcoin API.
//!
//! W4 (2026-09-14): a loser loses the stake - the seats' settlement names
//! every payout exactly with --payouts (their rule, arena-node settlement.js),
//! and this refuses any set the locks cannot pay for after the guardians' fees.
//! --mode fees prints that fee rule, which the seats read before sizing them.
#![recursion_limit = "256"] // the session-audit report is one json! object
use std::collections::HashMap;

// THE ARENA LOCK (kanban #1044 B1): --features arena-lock, against the fork's LNv2 with the ArenaLockContract variant
#[cfg(feature = "arena-lock")]
mod arena;
mod audit;
mod rehearsal;
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
    AWAIT_PREIMAGE_ENDPOINT, CONSENSUS_BLOCK_COUNT_ENDPOINT, OUTGOING_CONTRACT_EXPIRATION_ENDPOINT,
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

/// JOIN A FEDERATION (RULED 2026-10-13: "Every node serves every federation"): a signer node finds a
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

/// ARENA_CLIENT_BITCOIND: a bitcoind for the wallet client (regtest has no esplora); the watch-only wallet it creates there
/// is named after this process's data dir.
fn with_client_bitcoind(builder: fedimint_client::ClientBuilder) -> anyhow::Result<fedimint_client::ClientBuilder> {
    let Ok(url) = std::env::var("ARENA_CLIENT_BITCOIND") else { return Ok(builder) };
    let u = fedimint_core::util::SafeUrl::parse(&url)?;
    let (user, pass) = (u.username().to_owned(), u.password().unwrap_or("").to_owned());
    let network = match std::env::var("ARENA_CLIENT_BITCOIND_NETWORK").as_deref() { Ok("testnet4") => fedimint_core::bitcoin::Network::Testnet4, _ => fedimint_core::bitcoin::Network::Regtest };
    let wallet = std::env::var("ARENA_CLIENT_BITCOIND_WALLET").unwrap_or_else(|_| "arena-client".into());
    Ok(builder.with_bitcoind_rpc(move |_chain| async move {
        let c = fedimint_bitcoind::bitcoincore::BitcoindClient::new(&u, user, pass, &wallet, network).ok()?;
        Some(std::sync::Arc::new(c) as fedimint_bitcoind::DynBitcoindRpc)
    }))
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
    let builder = with_client_bitcoind(builder)?;
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
    let builder = with_client_bitcoind(builder)?;
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

#[cfg(feature = "arena-lock")]
fn arena_offline(mode: &str, a: &Args) -> Option<anyhow::Result<()>> {
    if mode == "arena-id" {
        return Some(arena::id(a).map(|v| println!("{v}")));
    }
    // offence rows (a) and (b): the Arena-lock spends a federation's signed sessions name (src/arena.rs claim_read)
    if mode == "arena-z-key" {
        return Some(Ok(println!("{}", serde_json::json!({ "mode": "arena-z-key", "z_key": arena::z_key().to_string() }))));
    }
    if mode == "arena-claim-read" {
        return Some(arena::claim_read().map(|v| println!("{v}")));
    }
    // a level-1 proof (a)'s correct body, rebuilt from the lock contracts its sessions funded (src/arena.rs body_offline)
    if mode == "arena-body" {
        return Some(arena::body_offline().map(|v| println!("{v}")));
    }
    arena::musig_mode(mode, a).map(|out| out.map(|v| println!("{v}")))
}

#[cfg(not(feature = "arena-lock"))]
fn arena_offline(_mode: &str, _a: &Args) -> Option<anyhow::Result<()>> {
    None
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
    // THE ARENA LOCK OFFLINE (kanban #1044 B1): a lock's id, and the named seats' two MuSig2 rounds (src/arena.rs)
    if let Some(done) = arena_offline(&mode, &a) {
        return done;
    }
    if mode == "join" {
        let client = join(PathBuf::from(need(&a, "data-dir")?), need(&a, "invite")?).await?;
        println!("{}", serde_json::json!({ "mode": "join", "federation_id": client.federation_id().to_string() }));
        return Ok(());
    }
    // THE THEFT JUDGE'S CHECK (ruling #1109): proof bytes verified offline - no client, no guardian, no bitcoind
    if mode == "session-proof-verify" { return audit::proof_verify(&a); }
    // the seats' theft-slash judge (packages/arena-protocol/src/theft-slash.js, SESSION VERIFIER): stdin in, one line out
    if mode == "theft-verify" { return audit::theft_verify(); }
    let client = open(PathBuf::from(need(&a, "data-dir")?)).await?;
    // THE FEDERATION'S SIGNED HISTORY, READ BY THE SEAT ITSELF (kanban #1093 part 2, ruling #1106): needs no lnv2 module
    match mode.as_str() {
        "session-audit" => return audit::session_audit(&a, &client).await,
        "session-export" => return audit::session_export(&a, &client).await,
        // a protocol-27 round's funding sessions start at or after this count (kanban #1044 B1: the named claim's proof reads from there)
        "session-count" => {
            let count = client.fetch_session_count().await.map_err(|e| anyhow!("no session count: {e}"))?;
            println!("{}", serde_json::json!({ "mode": "session-count", "count": count }));
            return Ok(());
        }
        // regtest only: what a colluding threshold can do outside consensus, for the audit to mark (kanban #1108)
        "rehearsal-forge" => return rehearsal::forge(&a, &client).await,
        "rehearsal-resign" => return rehearsal::resign(&a, &client).await,
        "rehearsal-rogue-spend" => return rehearsal::rogue_spend(&a, &client).await,
        "pegout" => return pegout(&a, &client).await,
        _ => {}
    }
    let lnv2 = client.get_first_instance(&KIND).context("this federation has no lnv2 module")?;
    let api = client.api().with_module(lnv2);
    match mode.as_str() {
        "lock" => lock(&a, &client, lnv2, &api).await,
        "redeem" => redeem(&a, &client, lnv2, &api).await,
        "settle" => settle(&a, &client, lnv2, &api).await,
        "status" => { println!("{}", status(&a, &api).await?); Ok(()) }
        // kanban #1185: whether a gateway claimed a settlement's outgoing contract - the proof a paid send landed
        "send-claimed" => { println!("{}", send_claimed(&a, &api).await?); Ok(()) }
        "fees" => { println!("{}", fees(&client, lnv2).await?); Ok(()) }
        "guardians" => { println!("{}", guardians(&client).await?); Ok(()) }
        "gateways" => { println!("{}", gateways(&client, &api).await?); Ok(()) }
        // THE SEAT'S READ-ONLY QUESTIONS, ONE CLIENT FOR ALL OF THEM (measured 2026-10-10 on the test host's paid
        // RPS stack: a process per question opened the client's database and reached the guardians each time - dozens of
        // them at 60-80 % CPU each with 8 s paid rounds, the machine at load 50 and a paid tap past 1.5 s): this process
        // stays, the client open, and answers one JSON request per stdin line - { "id", "mode", "args": { name: value } } ->
        // { "id", "ok", "result" | "error" }. Only status, send-claimed, fees, guardians, gateways and id: nothing that moves money.
        "serve" => serve(&client, lnv2, &api).await,
        // THE ARENA LOCK (kanban #1044 B1, ruling #1131): claim and forfeit name their signers (src/arena.rs)
        #[cfg(feature = "arena-lock")]
        "arena-version" => {
            let v = arena::version(&api).await?;
            println!("{}", serde_json::json!({ "mode": "arena-version", "major": v.major, "minor": v.minor,
                "arena_lock": v >= fedimint_lnv2_common::ARENA_LOCK_CONSENSUS_VERSION }));
            Ok(())
        }
        #[cfg(feature = "arena-lock")]
        "arena-lock" => arena::lock(&a, &client, lnv2, &api).await,
        #[cfg(feature = "arena-lock")]
        "arena-status" => { println!("{}", arena::status(&a, &api).await?); Ok(()) }
        #[cfg(feature = "arena-lock")]
        "arena-redeem" => arena::redeem(&a, &client, lnv2, &api).await,
        #[cfg(feature = "arena-lock")]
        "arena-settle" => arena::settle(&a, &client, lnv2, &api).await,
        #[cfg(feature = "arena-lock")]
        "arena-send-refund" => arena::send_refund(&a, &client, lnv2).await,
        "send" => send(&a, &client).await,
        // THE ARBITER'S PEG-IN (spec §5A.3: "the arbitration set pegs it into the round's federation"): an
        // address the federation controls, and the claim once a payment to it is confirmed - the escrow becomes e-cash in
        // the arbiter's own client, from which each affected entry's share is locked to its player (mode lock)
        "pegin-address" => pegin_address(&client).await,
        "pegin-claim" => pegin_claim(&a, &client).await,
        // THE SLASH'S PAYOUTS (spec §5A.3B): each wronged player's share, from the arbiter's own e-cash (the escrow
        // it pegged in), as a settlement pays a qualifier - a pre-expired lock only that player's key ever moves
        "pay" => pay(&a, &client, lnv2, &api).await,
        // kanban #1174: the payout a keyed pay made, read back from the client's operation log (never paid twice)
        "pay-sent" => pay_sent(&a, &client, &api).await,
        // THE PROTOCOL RESERVES MOVED BETWEEN FEDERATIONS (2026-10-17 decision A: "Add the two receive-and-claim
        // modes to the stake-lock tool"): an invoice of a gateway of THIS federation whose incoming contract only the destination's
        // reserve key - a 5-of-7 key nobody holds alone - can claim; and that claim, FROST-signed by the seats, into a reserve output
        "receive-to-key" => receive_to_key(&a, &client, lnv2).await,
        "claim-incoming" => claim_incoming(&a, &client, lnv2, &api).await,
        // THE SEAT'S SIDE OF AN E-CASH EXCHANGE BETWEEN FEDERATIONS (kanban #614, 2026-10-24: "Kein Lightning swap, sondern übertragen
        // in die andere federation"): the player's notes of one federation reissued into the seat's client there (ecash-receive), the seat's
        // notes of the other federation handed back (ecash-send), and what the seat's client holds (balance)
        "ecash-send" => ecash_send(&a, &client).await,
        "ecash-receive" => ecash_receive(&a, &client).await,
        // kanban #1160: the e-cash a keyed ecash-send made, read back from the client's operation log (never spent twice)
        "ecash-sent" => ecash_sent(&a, &client).await,
        "balance" => { println!("{}", serde_json::json!({ "mode": "balance", "msat": client.get_balance_for_btc().await?.msats })); Ok(()) }
        other => bail!("no mode {other}: lock, redeem, settle, status, send-claimed, fees, guardians, gateways, send, serve, pegin-address, pegin-claim, pay, pay-sent, receive-to-key, claim-incoming, ecash-send, ecash-receive, ecash-sent, balance, session-audit, id, arena-id, arena-version, arena-lock, arena-status, arena-redeem, arena-settle or musig-*"),
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
            "send-claimed" => send_claimed(&a, api).await,
            "fees" => fees(client, lnv2).await,
            "guardians" => guardians(client).await,
            "gateways" => gateways(client, api).await,
            #[cfg(feature = "arena-lock")]
            "arena-status" => arena::status(&a, api).await,
            // THE GATE'S READ (ruling #1134 1): the module version a threshold of guardians agree on (request_current_consensus)
            #[cfg(feature = "arena-lock")]
            "arena-version" => arena::version(api).await.map(|v| serde_json::json!({ "mode": "arena-version", "major": v.major, "minor": v.minor,
                "arena_lock": v >= fedimint_lnv2_common::ARENA_LOCK_CONSENSUS_VERSION })),
            #[cfg(feature = "arena-lock")]
            "arena-id" => arena::id(&a),
            "id" => match need(&a, "expiration").and_then(|e| e.parse::<u64>().map_err(Into::into)) {
                Ok(exp) => stake_contract(&a, exp).map(|c| serde_json::json!({ "mode": "id", "contract_id": c.contract_id().0.to_string() })),
                Err(e) => Err(e),
            },
            other => Err(anyhow!("serve answers status, send-claimed, fees, guardians, gateways, id, arena-status, arena-version and arena-id - not {other}")),
        };
        let out = match got { Ok(v) => serde_json::json!({ "id": id, "ok": true, "result": v }),
            Err(e) => serde_json::json!({ "id": id, "ok": false, "error": format!("{e:#}") }) };
        println!("{out}");
    }
    Ok(())
}

/// WINNINGS SENT: A GATEWAY IS ASKED TO PAY ONE OUTGOING CONTRACT'S INVOICE (§23.6; "winnings are always sent",
/// 2026-09-21, ruled for FEDERATION 2026-09-23). The contract is the one the settlement funded, rebuilt from
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

/// THE FEDERATION'S GUARDIANS, OFF ITS OWN CONFIG (2026-09-15 07:33: every guardian
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
        .finalize_and_submit_transaction(operation, "arena-stake-lock", |_| (), TransactionBuilder::new().with_outputs(bundle))
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

/// THE PAYOUT CONTRACTS OF --payouts PK:MSAT[,PK:MSAT...]: pre-expired (expiration 0, so Claim is refused for everybody), claim and refund
/// keys the player's, the image unused - so only that player's key ever moves one, by the refund the page already takes for a settlement's payout.
fn payout_contracts(a: &Args) -> anyhow::Result<Vec<OutgoingContract>> {
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
    Ok(contracts)
}

/// A KEYED PAYOUT'S OPERATION (kanban #1174): H("arena-payout:" || key) - the client refuses a second operation of one id, so a payout
/// of one key is submitted once, and its operation log entry names the transaction it made.
fn payout_operation(key: &str) -> OperationId {
    OperationId(sha256::Hash::hash(format!("arena-payout:{key}").as_bytes()).to_byte_array())
}

/// WHERE EACH PAYOUT OF `txid` LANDED: the builder places the change, so every outpoint is read and matched by contract id.
async fn payouts_at(api: &DynModuleApi, txid: TransactionId, contracts: &[OutgoingContract]) -> anyhow::Result<Vec<serde_json::Value>> {
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
    Ok(found)
}

/// WHAT A KEYED PAYOUT MADE BEFORE (kanban #1174): None - this client never submitted one of that key; Some(Ok(txid)) - it did and the guardians
/// accepted it; Some(Err(why)) - it did and they refused it (nothing was paid: a new key pays it).
async fn payout_sent_with(client: &ClientHandle, operation: OperationId) -> anyhow::Result<Option<Result<TransactionId, String>>> {
    let Some(entry) = client.operation_log().get_operation(operation).await else { return Ok(None) };
    let meta = entry.try_meta::<serde_json::Value>().context("the keyed payout's operation has no meta")?;
    let txid = TransactionId::from_str(meta.get("txid").and_then(|v| v.as_str()).context("the keyed payout's operation names no transaction")?)?;
    match client.transaction_updates(operation).await.await_tx_accepted(txid).await {
        Ok(()) => Ok(Some(Ok(txid))),
        Err(e) => Ok(Some(Err(format!("{e}")))),
    }
}

/// --mode pay --payouts PK:MSAT[,PK:MSAT...] [--key K] (spec §5A.3B "the arbitration set pegs it into the round's
/// federation and locks each share to its player"): ONE transaction from this client's own e-cash, one output per player -
/// the payout shape of --mode settle (payout_contracts). Each payout's outpoint is read back from the guardians by its contract id.
/// KEYED (kanban #1174): with --key K the transaction is the operation payout_operation(K), its meta {"arena_payout": K, "txid"}; a pay of a
/// key paid before answers that transaction again ("again": true) instead of paying a second time; one the guardians refused is said so.
async fn pay(a: &Args, client: &ClientHandle, lnv2: ModuleInstanceId, api: &DynModuleApi) -> anyhow::Result<()> {
    let contracts = payout_contracts(a)?;
    let key = a.get("key").cloned();
    let operation = match &key { Some(k) => payout_operation(k), None => OperationId::new_random() };
    if key.is_some() {
        match payout_sent_with(client, operation).await? {
            Some(Ok(txid)) => {
                let found = payouts_at(api, txid, &contracts).await?;
                let balance = client.get_balance_for_btc().await.map(|b| b.msats).unwrap_or(0);
                println!("{}", serde_json::json!({ "mode": "pay", "txid": txid.to_string(), "payouts": found, "balance_after_msat": balance, "key": key, "again": true }));
                return Ok(());
            }
            Some(Err(why)) => bail!("the keyed payout {} was refused by the guardians ({why}): nothing was paid under that key - pay it under a new key", key.clone().unwrap_or_default()),
            None => {}
        }
    }
    let outputs = contracts
        .iter()
        .map(|c| ClientOutput { output: LightningOutput::V0(LightningOutputV0::Outgoing(c.clone())), amounts: Amounts::new_bitcoin(c.amount) })
        .collect::<Vec<_>>();
    let bundle = ClientOutputBundle::new_no_sm(outputs).into_dyn(lnv2);
    let named = key.clone();
    let change = client
        .finalize_and_submit_transaction(operation, "arena-slash-payouts",
            move |range| serde_json::json!({ "arena_payout": named.clone(), "txid": range.txid().to_string() }),
            TransactionBuilder::new().with_outputs(bundle))
        .await?;
    let txid = change.txid();
    client
        .transaction_updates(operation)
        .await
        .await_tx_accepted(txid)
        .await
        .map_err(|e| anyhow!("the guardians did not accept the payout transaction: {e}"))?;
    let found = payouts_at(api, txid, &contracts).await?;
    let balance = client.get_balance_for_btc().await.map(|b| b.msats).unwrap_or(0);
    println!("{}", serde_json::json!({ "mode": "pay", "txid": txid.to_string(), "payouts": found, "balance_after_msat": balance, "key": key }));
    Ok(())
}

/// --mode pay-sent --payouts PK:MSAT[,...] --key K (kanban #1174): {"mode", "key", "found", "txid", "payouts"} - the payout a keyed pay made,
/// with each payout's outpoint; found false: this client never paid under that key, and a pay may be made; "rejected": the guardians refused it.
async fn pay_sent(a: &Args, client: &ClientHandle, api: &DynModuleApi) -> anyhow::Result<()> {
    let key = need(a, "key")?;
    let contracts = payout_contracts(a)?;
    match payout_sent_with(client, payout_operation(key)).await? {
        Some(Ok(txid)) => {
            let found = payouts_at(api, txid, &contracts).await?;
            println!("{}", serde_json::json!({ "mode": "pay-sent", "key": key, "found": true, "txid": txid.to_string(), "payouts": found }));
        }
        Some(Err(why)) => println!("{}", serde_json::json!({ "mode": "pay-sent", "key": key, "found": false, "rejected": true, "why": why })),
        None => println!("{}", serde_json::json!({ "mode": "pay-sent", "key": key, "found": false })),
    }
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

/// --mode send-claimed --data-dir D --outpoint TXID:IDX [--wait-ms N] (kanban #1185): did a gateway claim the outgoing contract
/// at this outpoint? {"mode", "outpoint", "claimed", "state", "block_count", ...} with state
///   "claimed"  the guardians hold the preimage the gateway's claim revealed ("preimage", "payment_hash"; stock LNv2
///              await_preimage asked with expiration 0 - the guardians store it at the outpoint when a Claim(preimage)
///              input spends the contract, lnv2-server lib.rs);
///   "stored"   the contract is still held there, unspent: neither claimed nor refunded yet ("stored");
///   "gone"     neither: the contract was refunded, or no accepted transaction ever made that outpoint - the guardians
///              keep nothing that tells the two apart, and neither is a landed, paid send ("preimage_read").
/// The guardians' await_preimage waits up to 10 s for a preimage before it looks at the expiration, so with none it would
/// hold the caller 10 s; one that exists is answered at once. --wait-ms (default 2500) bounds that wait, under the seats'
/// 10 s for a serve answer; "preimage_read" says whether the guardians answered none or did not answer in time.
async fn send_claimed(a: &Args, api: &DynModuleApi) -> anyhow::Result<serde_json::Value> {
    let op = outpoint(need(a, "outpoint")?)?;
    let wait_ms: u64 = a.get("wait-ms").map_or(Ok(2500), |s| s.parse())?;
    let count = block_count(api).await?;
    let base = |state: &str, claimed: bool| serde_json::json!({ "mode": "send-claimed", "outpoint": format!("{}:{}", op.txid, op.out_idx),
        "claimed": claimed, "state": state, "block_count": count });
    if let Some(s) = stored_at(api, op).await? {
        let mut j = base("stored", false);
        j["stored"] = stored_json(Some(s));
        return Ok(j);
    }
    let asked = tokio::time::timeout(Duration::from_millis(wait_ms), api.request_current_consensus::<Option<[u8; 32]>>(
        AWAIT_PREIMAGE_ENDPOINT.to_string(), ApiRequestErased::new((op, 0u64)))).await;
    Ok(match asked {
        Ok(Ok(Some(preimage))) => {
            let mut j = base("claimed", true);
            j["preimage"] = hex(&preimage).into();
            j["payment_hash"] = hex(&sha256::Hash::hash(&preimage).to_byte_array()).into();
            j
        }
        Ok(Ok(None)) => { let mut j = base("gone", false); j["preimage_read"] = "none".into(); j }
        Ok(Err(e)) => bail!("the guardians did not agree on a preimage at {}:{}: {e}", op.txid, op.out_idx),
        Err(_) => { let mut j = base("gone", false); j["preimage_read"] = format!("no answer in {wait_ms} ms").into(); j }
    })
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
    // `invoice:HASH:GATEWAY_PK:REFUND_PK:EXPIRATION:MSAT` is WINNINGS ALWAYS SENT (2026-09-21, ruled for
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

// ALL AT ONCE, IN THE ORDER GIVEN (measured 2026-10-11 on the regtest Up/Down market: a book round's settle read
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
///
/// --outpoint TXID:VOUT [--sats N] (kanban #1093): the claim of THAT deposit. A walletv2 client has one peg-in address and claims
/// every deposit on it in the background, so "the balance grew" read another escrow's deposit as this one's (the real-Fedimint
/// liquidation run: 700,583,936 msat read against 900,000,000 owed). Here the module's own record of each receive names its
/// outpoint (ReceivePaymentEvent); the newest receive of this outpoint is awaited to its end (an aborted one is retried by the
/// client as a new operation), its e-cash awaited, and the claim is what the federation credited it - its value less the peg-in
/// fee - less the client's own fees on the claim transaction (get_operation_fees: module fees and note dust). Prints claimed_msat,
/// value_sat, pegin_fee_sat and claim_fees_msat beside the balances. The legacy wallet gives each deposit its own address, so there
/// the address names it and the claim is the balance's rise, as before.
async fn pegin_claim(a: &Args, client: &ClientHandle) -> anyhow::Result<()> {
    let before = client.get_balance_for_btc().await?;
    let timeout = std::time::Duration::from_secs(a.get("timeout-s").map_or(Ok(900), |t| t.parse())?);
    let outpoint = a.get("outpoint").map(|o| fedimint_core::bitcoin::OutPoint::from_str(o)).transpose().context("--outpoint is TXID:VOUT")?;
    let sats = a.get("sats").map(|s| s.parse::<u64>()).transpose().context("--sats is a whole number")?;
    let address = a.get("address").map(|x| fedimint_core::bitcoin::Address::<fedimint_core::bitcoin::address::NetworkUnchecked>::from_str(x)).transpose()?;
    if let (Some(op), Ok(w)) = (outpoint, client.get_first_module::<fedimint_walletv2_client::WalletClientModule>()) {
        let got = tokio::time::timeout(timeout, walletv2_claim_of(client, &w, op, sats, address.as_ref())).await.map_err(|_| anyhow!("no claim of {op} within {timeout:?}"))??;
        let (ev, fees) = got;
        let credited = Amount::from_sats(ev.value.to_sat().saturating_sub(ev.fee.to_sat()));
        let claim_fees = fees.unwrap_or(Amount::ZERO);
        let after = client.get_balance_for_btc().await?;
        println!("{}", serde_json::json!({ "mode": "pegin-claim", "kind": "walletv2", "outpoint": op.to_string(), "value_sat": ev.value.to_sat(), "pegin_fee_sat": ev.fee.to_sat(),
            "claim_fees_msat": claim_fees.msats, "claim_fees_known": fees.is_some(), "claimed_msat": credited.msats.saturating_sub(claim_fees.msats),
            "operation_id": ev.operation_id.fmt_full().to_string(), "balance_before_msat": before.msats, "balance_after_msat": after.msats }));
        return Ok(());
    }
    let waited = async {
        if let Ok(w) = client.get_first_module::<fedimint_wallet_client::WalletClientModule>() {
            let address = fedimint_core::bitcoin::Address::<fedimint_core::bitcoin::address::NetworkUnchecked>::from_str(need(a, "address")?)?;
            // CHECKED NOW, NOT AT ITS NEXT TURN (kanban #326 rehearsal 17, 2026-10-26: the escrow's peg-in had 100+ confirmations and the
            // federation's height was past it, and still "no claim within 840s" - the client checks an address again only after a tenth of
            // its age, so an address allocated two days before waited ~5 h for its next look, past every claim's timeout)
            w.recheck_pegin_address_by_address(address.clone()).await?;
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

/// THE WALLETV2 RECEIVE OF ONE OUTPOINT, ended in success with its e-cash issued: the module's ReceivePaymentEvent and the client's fees on
/// its claim transaction (None when the client kept none). A record that names no outpoint (a federation that did not report it) is taken
/// only by this address and exactly --sats. Waits for the scanner to find and claim it; the caller bounds the wait.
async fn walletv2_claim_of(client: &ClientHandle, w: &fedimint_walletv2_client::WalletClientModule, op: fedimint_core::bitcoin::OutPoint, sats: Option<u64>,
    address: Option<&fedimint_core::bitcoin::Address<fedimint_core::bitcoin::address::NetworkUnchecked>>)
    -> anyhow::Result<(fedimint_walletv2_client::events::ReceivePaymentEvent, Option<Amount>)> {
    use fedimint_walletv2_client::events::ReceivePaymentEvent;
    loop {
        let mut mine: Vec<ReceivePaymentEvent> = Vec::new();
        let mut pos = None;
        loop {
            let page = client.get_event_log(pos, 1000).await;
            let Some(last) = page.last() else { break };
            pos = Some(last.id().saturating_add(1));
            for e in &page {
                if e.module_kind() != Some(&fedimint_walletv2_client::common::KIND) || e.kind.to_string() != "payment-receive" { continue; }
                let Some(ev) = e.to_event::<ReceivePaymentEvent>() else { continue };
                let named = match ev.outpoint {
                    Some(o) => o == op,
                    None => address.is_some_and(|x| *x == ev.address) && sats.is_some_and(|s| s == ev.value.to_sat()),
                };
                if named { mine.push(ev); }
            }
        }
        // THE NEWEST RECEIVE FIRST: an aborted one is retried as a new operation; a receive still funding is awaited to its end
        for ev in mine.iter().rev() {
            if w.await_final_receive_operation_state(ev.operation_id).await? != fedimint_walletv2_client::FinalReceiveOperationState::Success { continue; }
            let meta = client.operation_log().get_operation(ev.operation_id).await.context("the receive's operation is not in the log")?;
            if let fedimint_walletv2_client::WalletOperationMeta::Receive(m) = meta.meta::<fedimint_walletv2_client::WalletOperationMeta>() {
                client.await_primary_bitcoin_module_outputs(ev.operation_id, m.change_outpoint_range.into_iter().collect()).await?;
            }
            let fees = client.get_operation_fees(ev.operation_id).await?.map(|f| f.get_bitcoin());
            return Ok((ev.clone(), fees));
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

/// --mode receive-to-key --data-dir D --claim-pk HEX --amount-msat N --seed HEX32 --gateway URL [--expiry-secs S] [--description T]
/// (the drained-federation move): an LNv2 incoming contract of THIS federation, as the stock client's receive builds
/// one (lnv2-client create_contract_and_fetch_invoice), with three differences: its `claim_pk` is the given key - the destination's
/// 5-of-7 reserve key, not a tweak of this client's own key; its encryption seed is given (the move's own, so every seat rebuilds
/// the same contract) and its preimage is that seed's hash; its ephemeral key is the claim key (no ECDH: nobody derives a key from
/// it). The gateway is asked for the invoice of exactly --amount-msat; the contract carries that less the gateway's receive fee.
/// Prints the invoice, its payment hash, the contract id and the contract itself (consensus-encoded hex) for --mode claim-incoming.
/// E-CASH OUT (kanban #614): exactly --amount-msat of this client's notes as the prefixed base32 string another wallet of the same
/// federation receives. Prints {"mode", "msat", "ecash"}; spent here, the string is the only copy - the caller keeps it until it is received.
/// KEYED (kanban #1160): with --key K the send is named K in the operation log (its custom meta {"arena_exchange": K}), and a send of
/// that key made before is answered again instead of spending a second time ("again": true). The answer echoes "key".
async fn ecash_send(a: &Args, client: &ClientHandle) -> anyhow::Result<()> {
    let mint = client.get_first_module::<fedimint_mintv2_client::MintClientModule>()?;
    let amount = Amount::from_msats(need(a, "amount-msat")?.parse()?);
    let key = a.get("key").cloned();
    if let Some(k) = &key {
        if let Some(found) = ecash_sent_with(client, k).await? {
            println!("{}", serde_json::json!({ "mode": "ecash-send", "msat": ecash_msat(&found)?, "ecash": found, "key": k, "again": true }));
            return Ok(());
        }
    }
    let meta = match &key { Some(k) => serde_json::json!({ "arena_exchange": k }), None => serde_json::Value::Null };
    let (_, ecash) = mint.send(amount, meta, false).await?;
    println!("{}", serde_json::json!({ "mode": "ecash-send", "msat": amount.msats,
        "ecash": fedimint_core::base32::encode_prefixed(fedimint_core::base32::FEDIMINT_PREFIX, &ecash), "key": key }));
    Ok(())
}

/// THE AMOUNT AN E-CASH STRING CARRIES, msat.
fn ecash_msat(s: &str) -> anyhow::Result<u64> {
    let e: fedimint_mintv2_client::ECash = fedimint_core::base32::decode_prefixed(fedimint_core::base32::FEDIMINT_PREFIX, s.trim())?;
    Ok(e.amount().msats)
}

/// THE NEWEST mintv2 SEND whose custom meta names `key` ("arena_exchange"), its e-cash string; None when this client never made one.
async fn ecash_sent_with(client: &ClientHandle, key: &str) -> anyhow::Result<Option<String>> {
    let mut last = None;
    loop {
        let page = client.operation_log().paginate_operations_rev(100, last).await;
        if page.is_empty() { return Ok(None); }
        for (_, entry) in &page {
            if let Ok(fedimint_mintv2_client::MintOperationMeta::Send { ecash, custom_meta }) = entry.try_meta::<fedimint_mintv2_client::MintOperationMeta>() {
                if custom_meta.get("arena_exchange").and_then(|v| v.as_str()) == Some(key) { return Ok(Some(ecash)); }
            }
        }
        last = page.last().map(|(k, _)| *k);
    }
}

/// --mode ecash-sent --data-dir D --key K (kanban #1160): {"mode", "key", "found", "ecash", "msat"} - the e-cash a keyed ecash-send made,
/// or found false: this client never spent for that key, and a send may be made.
async fn ecash_sent(a: &Args, client: &ClientHandle) -> anyhow::Result<()> {
    let key = need(a, "key")?;
    match ecash_sent_with(client, key).await? {
        Some(e) => println!("{}", serde_json::json!({ "mode": "ecash-sent", "key": key, "found": true, "msat": ecash_msat(&e)?, "ecash": e })),
        None => println!("{}", serde_json::json!({ "mode": "ecash-sent", "key": key, "found": false })),
    }
    Ok(())
}

/// E-CASH IN (kanban #614): --ecash reissued into this client; prints {"mode", "state", "msat"} once the federation reissued it -
/// "Success", "Rejected" (already spent) or "AlreadyReceived" - and the amount the string carried.
async fn ecash_receive(a: &Args, client: &ClientHandle) -> anyhow::Result<()> {
    let mint = client.get_first_module::<fedimint_mintv2_client::MintClientModule>()?;
    let bytes = fedimint_core::base32::decode_prefixed(fedimint_core::base32::FEDIMINT_PREFIX, need(a, "ecash")?.trim())?;
    let before = client.get_balance_for_btc().await?.msats;
    let operation = match mint.receive(bytes, serde_json::Value::Null).await {
        Ok(op) => op,
        Err(fedimint_mintv2_client::ReceiveECashError::AlreadyReceived) => {
            // kanban #1160: received here before - by this client's own earlier receive of it (the operation is the string's own id):
            // its final state awaited, and the amount the string carries, so a caller that wrote its record first can finish
            let e: fedimint_mintv2_client::ECash = fedimint_core::base32::decode_prefixed(fedimint_core::base32::FEDIMINT_PREFIX, need(a, "ecash")?.trim())?;
            let earlier = fedimint_core::core::OperationId::from_encodable(&e);
            let state = mint.await_final_receive_operation_state(earlier).await.map(|s| format!("{s:?}")).unwrap_or_else(|err| format!("unknown: {err}"));
            println!("{}", serde_json::json!({ "mode": "ecash-receive", "state": "AlreadyReceived", "msat": 0, "earlier": state, "carried_msat": e.amount().msats }));
            return Ok(());
        }
        Err(e) => return Err(anyhow!("{e}")),
    };
    let state = mint.await_final_receive_operation_state(operation).await?;
    // THE AMOUNT IT CARRIED, AS THE BALANCE SAYS IT (measured 2026-10-24 on test host seat 1: read at once, the balance had not yet risen -
    // "msat": 0 after a Success of 1,000 sat): read again for up to 10 s until it has; the exchange pays what this says, never what was claimed
    let mut after = client.get_balance_for_btc().await?.msats;
    for _ in 0..100 {
        if after > before { break; }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        after = client.get_balance_for_btc().await?.msats;
    }
    println!("{}", serde_json::json!({ "mode": "ecash-receive", "state": format!("{state:?}"), "msat": after.saturating_sub(before) }));
    Ok(())
}

async fn receive_to_key(a: &Args, client: &ClientHandle, lnv2: ModuleInstanceId) -> anyhow::Result<()> {
    use fedimint_core::encoding::Encodable;
    use fedimint_lnv2_common::Bolt11InvoiceDescription;
    use fedimint_lnv2_common::contracts::IncomingContract;
    use fedimint_lnv2_common::gateway_api::{GatewayConnection, RealGatewayConnection};
    let claim_pk = PublicKey::from_str(need(a, "claim-pk")?)?;
    let amount = Amount::from_msats(need(a, "amount-msat")?.parse()?);
    let seed: [u8; 32] = hex_bytes(need(a, "seed")?)?.try_into().map_err(|_| anyhow!("--seed is 32 bytes"))?;
    let expiry_secs: u32 = a.get("expiry-secs").map_or(Ok(86400), |s| s.parse())?;
    let gateway = fedimint_core::util::SafeUrl::parse(need(a, "gateway")?)?;
    let config = client.config().await;
    let cfg = config.modules.get(&lnv2).context("no lnv2 config")?.cast::<LightningClientConfig>()?;
    let lnv2c = client.get_first_module::<fedimint_lnv2_client::LightningClientModule>()?;
    let info = lnv2c.routing_info(&gateway).await.map_err(|e| anyhow!("the gateway did not answer: {e:?}"))?
        .context("the gateway answered that it does not serve this federation")?;
    let contract_amount = info.receive_fee.subtract_from(amount.msats);
    if contract_amount < fedimint_lnv2_common::MINIMUM_INCOMING_CONTRACT_AMOUNT {
        bail!("{} msat less the gateway's receive fee is below the federation's smallest incoming contract", amount.msats);
    }
    let preimage: [u8; 32] = seed.consensus_hash::<sha256::Hash>().to_byte_array();
    let payment_hash: sha256::Hash = preimage.consensus_hash();
    let expiration = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs().saturating_add(u64::from(expiry_secs));
    let contract = IncomingContract::new(cfg.tpe_agg_pk, seed, preimage, PaymentImage::Hash(payment_hash), contract_amount, expiration,
        claim_pk, info.module_public_key, claim_pk);
    let connectors = ConnectorRegistry::build_from_client_defaults().with_env_var_overrides()?.bind().await?;
    let conn = RealGatewayConnection { api: fedimint_lnv2_common::GatewayApi::new(None, connectors) };
    let description = a.get("description").cloned().unwrap_or_else(|| "Bitcoin Arena protocol reserves".to_owned());
    let invoice = conn.bolt11_invoice(gateway.clone(), client.federation_id(), contract.clone(), amount, Bolt11InvoiceDescription::Direct(description), expiry_secs)
        .await.map_err(|e| anyhow!("the gateway made no invoice: {e:?}"))?;
    if invoice.payment_hash().to_byte_array() != payment_hash.to_byte_array() { bail!("the gateway's invoice names another payment hash"); }
    if invoice.amount_milli_satoshis() != Some(amount.msats) { bail!("the gateway's invoice asks another amount"); }
    println!("{}", serde_json::json!({
        "mode": "receive-to-key", "federation_id": client.federation_id().to_string(), "gateway": gateway.to_string(),
        "invoice": invoice.to_string(), "payment_hash": payment_hash.to_string(), "amount_msat": amount.msats,
        "contract_amount_msat": contract_amount.msats, "receive_fee_msat": amount.msats - contract_amount.msats,
        "expiration": expiration, "claim_pk": claim_pk.to_string(), "contract_id": contract.contract_id().0.to_string(),
        "contract_hex": hex(&contract.consensus_encode_to_vec()),
    }));
    Ok(())
}

/// --mode claim-incoming --data-dir D --contract HEX --seed HEX32 --payout-pk HEX --nonce HEX8 [--signature HEX] [--wait-s S]
///: the incoming contract --mode receive-to-key made, once a gateway funded it (the guardians answer its outpoint),
/// claimed into ONE pre-expired output to --payout-pk (the destination's reserve key: only its 5-of-7 ever moves it), the largest the
/// contract pays for after the guardians' fees. The guardians want the decryption key - derived here from the seed, checked against
/// the contract - and the transaction signed by the contract's claim key. Without --signature this prints the 32 bytes to sign (the
/// txid) and the payout; with one it submits, as --mode settle does.
async fn claim_incoming(a: &Args, client: &ClientHandle, lnv2: ModuleInstanceId, api: &DynModuleApi) -> anyhow::Result<()> {
    use fedimint_core::encoding::Decodable;
    use fedimint_core::module::registry::ModuleDecoderRegistry;
    use fedimint_lnv2_common::contracts::IncomingContract;
    use fedimint_lnv2_common::endpoint_constants::AWAIT_INCOMING_CONTRACT_ENDPOINT;
    let contract = IncomingContract::consensus_decode_whole(&hex_bytes(need(a, "contract")?)?, &ModuleDecoderRegistry::default())
        .map_err(|e| anyhow!("that is no incoming contract: {e}"))?;
    let seed: [u8; 32] = hex_bytes(need(a, "seed")?)?.try_into().map_err(|_| anyhow!("--seed is 32 bytes"))?;
    let payout_pk = PublicKey::from_str(need(a, "payout-pk")?)?;
    let nonce: [u8; 8] = hex_bytes(need(a, "nonce")?)?.try_into().map_err(|_| anyhow!("--nonce is 8 bytes"))?;
    let config = client.config().await;
    let cfg = config.modules.get(&lnv2).context("no lnv2 config")?.cast::<LightningClientConfig>()?;
    let fee = cfg.fee_consensus.clone();
    let agg_dk = tpe::derive_agg_dk(&cfg.tpe_agg_pk, &seed);
    if !contract.verify_agg_decryption_key(&cfg.tpe_agg_pk, &agg_dk) { bail!("that seed is not the one this contract was made with"); }
    let preimage = contract.decrypt_preimage(&agg_dk).context("the contract's preimage does not decrypt with that seed")?;
    // WHAT THE CONTRACT COMMITS TO, for a signer that checks a move before it pays the invoice: whose key claims it, its payment hash
    let commitment = serde_json::json!({ "claim_pk": contract.commitment.claim_pk.to_string(), "refund_pk": contract.commitment.refund_pk.to_string(),
        "payment_hash": match &contract.commitment.payment_image { PaymentImage::Hash(h) => h.to_string(), PaymentImage::Point(p) => p.to_string() },
        "amount_msat": contract.commitment.amount.msats, "expiration": contract.commitment.expiration_or_fee });
    // FUNDED? the guardians answer the contract's outpoint once a gateway funded it (they wait until its expiration; this waits --wait-s)
    let wait = Duration::from_secs(a.get("wait-s").map_or(Ok(30), |s| s.parse())?);
    let req = api.request_current_consensus::<Option<OutPoint>>(AWAIT_INCOMING_CONTRACT_ENDPOINT.to_string(),
        ApiRequestErased::new((contract.contract_id(), contract.commitment.expiration_or_fee)));
    let outpoint = match tokio::time::timeout(wait, req).await {
        Err(_) => { println!("{}", serde_json::json!({ "mode": "claim-incoming", "funded": false, "contract_id": contract.contract_id().0.to_string(),
            "commitment": commitment, "why": format!("no gateway funded it within {}s", wait.as_secs()) })); return Ok(()); }
        Ok(got) => got?.context("the contract expired unfunded")?,
    };
    let amount = contract.commitment.amount;
    let spendable = amount.msats - fee.fee(amount).msats;
    let mut out = spendable;
    while out > 0 && out + fee.fee(Amount::from_msats(out)).msats > spendable { out -= 1; }
    if out == 0 { bail!("the contract pays for no output after the guardians' fees"); }
    let payout = OutgoingContract {
        payment_image: PaymentImage::Hash(sha256::Hash::from_byte_array([0u8; 32])),
        amount: Amount::from_msats(out), expiration: 0, claim_pk: payout_pk, refund_pk: payout_pk, ephemeral_pk: payout_pk,
    };
    let inputs = vec![LightningInput::V0(LightningInputV0::Incoming(outpoint, agg_dk)).into_dyn(lnv2)];
    let outputs = vec![LightningOutput::V0(LightningOutputV0::Outgoing(payout.clone())).into_dyn(lnv2)];
    let txid = Transaction::tx_hash_from_parts(&inputs, &outputs, nonce);
    let mut report = serde_json::json!({
        "mode": "claim-incoming", "funded": true, "contract_id": contract.contract_id().0.to_string(), "commitment": commitment,
        "outpoint": format!("{}:{}", outpoint.txid, outpoint.out_idx), "contract_amount_msat": amount.msats,
        "preimage": hex(&preimage), "txid": txid.to_string(), "message_hex": hex(&txid[..]),
        "payout": { "out_idx": 0, "pk": payout_pk.to_string(), "msat": out, "contract_id": payout.contract_id().0.to_string() },
        "fee_ppm": fee.parts_per_million, "fee_base_msat": fee.base.msats,
    });
    let Some(sig_hex) = a.get("signature") else { println!("{report}"); return Ok(()); };
    let signature = Signature::from_slice(&hex_bytes(sig_hex)?)?;
    let verifies = SECP256K1.verify_schnorr(&signature, &Message::from_digest_slice(&txid[..])?, &contract.commitment.claim_pk.x_only_public_key().0).is_ok();
    if !verifies { bail!("that signature is not the contract's claim key's over this claim"); }
    let tx = Transaction { inputs, outputs, nonce, signatures: TransactionSignature::NaiveMultisig(vec![signature]) };
    let outcome = client.api().submit_transaction(tx).await.try_into_inner(client.decoders())
        .map_err(|e| anyhow!("the guardians' answer did not decode: {e}"))?;
    let (accepted, error) = match outcome.0 { Ok(_) => (true, None), Err(e) => (false, Some(e.to_string())) };
    let at = OutPoint { txid, out_idx: 0 };
    let mut stored = stored_at(api, at).await?;
    let started = std::time::Instant::now();
    while accepted && stored.is_none() && started.elapsed() < Duration::from_secs(60) { tokio::time::sleep(Duration::from_millis(500)).await; stored = stored_at(api, at).await?; }
    let obj = report.as_object_mut().expect("an object");
    obj.insert("accepted".into(), accepted.into());
    obj.insert("error".into(), error.into());
    obj.insert("payout_stored".into(), stored_json(stored));
    println!("{report}");
    Ok(())
}

/// A PEG-OUT (kanban #1108 rehearsal: the honest history's withdrawal): --sats to --address through the stock wallet client,
/// at the fee the guardians quote. Prints the bitcoin txid the federation signed.
async fn pegout(a: &Args, client: &ClientHandle) -> anyhow::Result<()> {
    use futures::StreamExt as _;
    let w = client.get_first_module::<fedimint_wallet_client::WalletClientModule>()?;
    let address = fedimint_core::bitcoin::Address::from_str(need(a, "address")?)?.assume_checked();
    let amount = fedimint_core::bitcoin::Amount::from_sat(need(a, "sats")?.parse()?);
    let fees = w.get_withdraw_fees(&address, amount).await?;
    let fee_sats = fees.amount().to_sat();
    let op = w.withdraw(&address, amount, fees, ()).await?;
    let mut updates = w.subscribe_withdraw_updates(op).await?.into_stream();
    while let Some(u) = updates.next().await {
        match u {
            fedimint_wallet_client::WithdrawState::Succeeded(txid) => {
                println!("{}", serde_json::json!({ "mode": "pegout", "txid": txid.to_string(), "sats": amount.to_sat(), "feeSats": fee_sats }));
                return Ok(());
            }
            fedimint_wallet_client::WithdrawState::Failed(e) => bail!("the peg-out failed: {e}"),
            fedimint_wallet_client::WithdrawState::Created => {}
        }
    }
    bail!("the peg-out's updates ended without an outcome")
}
