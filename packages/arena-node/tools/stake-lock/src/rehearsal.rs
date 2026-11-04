//! THE SESSION AUDIT'S REHEARSAL ON A PRIVATE REGTEST FEDERATION (kanban #1108): what a colluding threshold of
//! guardians can do OUTSIDE consensus with their own secret keys, so the audit can be shown to mark it. Every mode
//! refuses a federation whose wallet network is not regtest. The secret keys are read from the guardians' own
//! private.json files (a throwaway regtest federation's).
//!
//!   --mode rehearsal-forge --data-dir D --private P1,P2,P3 --denomination N [--count K] [--submit false]
//!       blind-signs K notes of 2^N msat with the given guardians' tbs key shares (no consensus), checks each against
//!       the federation's aggregate key, and redeems them in ONE transaction into an LNv2 outgoing contract (refundable
//!       only by a fresh key): submitted to the guardians as any client would.
//!   --mode rehearsal-resign --data-dir D --private P1,P2,P3 --replay-dir DIR --denomination N
//!       a threshold signs a session of its own: the session after the last one in DIR, holding one transaction that
//!       redeems a forged 2^N msat note, signed with the given guardians' broadcast keys exactly as the federation signs
//!       a session; written to DIR as the next <index>.bin (what a colluding threshold could serve from its API)
//!   --mode rehearsal-rogue-spend --data-dir D --private P1,P2,P3 --replay-dir DIR --outpoint TXID:VOUT
//!       --address ADDR --fee-sats N --bitcoind URL
//!       spends a reserve UTXO the signed history pegged in (its tweak read from that peg-in) with the given guardians'
//!       wallet keys, tweaked as the federation tweaks them, and broadcasts it: no peg-out, no PegOutSignature.
//!       On a walletv2 federation (the fork's regtest federations, the devnet's) the reserve is the one output a threshold
//!       names (`federation_wallet`: outpoint, value, tweak); --replay-dir is not read, --outpoint (optional) must be that
//!       output, and the guardians' `bitcoin_sk` are tweaked as walletv2 tweaks them (sign_tx): no `Signatures` item names it.
use std::collections::BTreeMap;
use std::str::FromStr;

use anyhow::{Context, anyhow, bail};
use fedimint_client::ClientHandle;
use fedimint_core::bitcoin;
use fedimint_core::core::IntoDynInstance;
use fedimint_core::encoding::{Decodable, Encodable};
use fedimint_core::epoch::ConsensusItem;
use fedimint_core::module::registry::ModuleDecoderRegistry;
use fedimint_core::secp256k1::{Keypair, Message, PublicKey, SECP256K1, SecretKey};
use fedimint_core::session_outcome::{AcceptedItem, SessionOutcome, SignedSessionOutcome};
use fedimint_core::transaction::{Transaction, TransactionSignature};
use fedimint_core::{Amount, PeerId};
use fedimint_lnv2_common::contracts::{OutgoingContract, PaymentImage};
use fedimint_lnv2_common::{LightningOutput, LightningOutputV0};
use fedimint_mintv2_client::common::config::MintClientConfig;
use fedimint_mintv2_client::common::{Denomination, MintInput, Note, nonce_message, verify_note};
use fedimint_wallet_client::common::tweakable::Tweakable;

use crate::{Args, hex, hex_bytes, need};

fn random32() -> anyhow::Result<[u8; 32]> {
    let mut b = [0u8; 32];
    std::io::Read::read_exact(&mut std::fs::File::open("/dev/urandom")?, &mut b)?;
    Ok(b)
}

/// The module JSON of each given guardian's private.json, by kind.
fn privates(a: &Args) -> anyhow::Result<Vec<serde_json::Value>> {
    need(a, "private")?.split(',').map(|p| {
        Ok(serde_json::from_slice::<serde_json::Value>(&std::fs::read(p).with_context(|| format!("no {p}"))?)?)
    }).collect()
}

fn module_of<'a>(private: &'a serde_json::Value, kind: &str) -> anyhow::Result<&'a serde_json::Value> {
    private["modules"].as_object().context("private.json has no modules")?
        .values().find(|m| m["kind"] == kind).with_context(|| format!("private.json has no {kind} module"))
}

/// Refuse anything but a regtest federation; the instances of its mintv2, lnv2 and wallet modules, and whether the wallet
/// is walletv2 (the fork's regtest federations run walletv2, not the stock wallet module).
async fn regtest_only(client: &ClientHandle) -> anyhow::Result<(u16, u16, u16, bool)> {
    let config = client.config().await;
    let find = |kind: &str| config.modules.iter().find(|(_, m)| m.kind.as_str() == kind).map(|(id, _)| *id)
        .with_context(|| format!("this federation has no {kind} module"));
    let (wallet, v2, network) = match find("wallet") {
        Ok(w) => (w, false, config.get_module::<fedimint_wallet_client::config::WalletClientConfig>(w)?.network.0),
        Err(_) => {
            let w = find("walletv2").context("this federation has no wallet or walletv2 module")?;
            (w, true, config.get_module::<fedimint_walletv2_client::common::config::WalletClientConfig>(w)?.network)
        }
    };
    if network != bitcoin::Network::Regtest { bail!("a rehearsal runs on regtest only; this federation is {network:?}") }
    Ok((find("mintv2")?, find("lnv2")?, wallet, v2))
}

/// K notes of 2^N msat, each blind-signed by the given guardians' tbs shares and aggregated outside consensus.
async fn forge_notes(a: &Args, client: &ClientHandle, mint: u16, d: u8, count: usize) -> anyhow::Result<Vec<(Note, Keypair)>> {
    let config = client.config().await;
    let mcfg = config.get_module::<MintClientConfig>(mint)?.clone();
    let denomination = Denomination(d);
    let agg = *mcfg.tbs_agg_pks.get(&denomination).with_context(|| format!("no denomination {d}"))?;
    let pks = mcfg.tbs_pks.get(&denomination).context("no key shares")?;
    let sks: Vec<tbs::SecretKeyShare> = privates(a)?.iter().map(|p| {
        let m = module_of(p, "mintv2")?;
        Ok(serde_json::from_value(m["tbs_sks"][d.to_string()].clone())?)
    }).collect::<anyhow::Result<_>>()?;
    let mut notes = Vec::new();
    for _ in 0..count {
        let spend = Keypair::from_secret_key(SECP256K1, &SecretKey::from_slice(&random32()?)?);
        let nonce = spend.public_key();
        let bk = tbs::BlindingKey::random();
        let blinded = tbs::blind_message(nonce_message(nonce), bk);
        let mut shares = BTreeMap::new();
        for sk in &sks {
            let share = tbs::sign_message(blinded, *sk);
            // whose share it is: the peer whose public share verifies it
            let peer = pks.iter().find(|(_, pk)| tbs::verify_signature_share(blinded, share, **pk)).map(|(p, _)| *p)
                .context("a key share matches no guardian of this federation")?;
            shares.insert(peer.to_usize() as u64, share);
        }
        let note = Note { denomination, nonce, signature: tbs::unblind_signature(bk, tbs::aggregate_signature_shares(&shares)) };
        if !verify_note(note, agg) { bail!("the forged note does not verify: fewer shares than the threshold?") }
        notes.push((note, spend));
    }
    Ok(notes)
}

/// The notes redeemed into one outgoing contract refundable by a fresh key: inputs and outputs, and the signatures.
async fn redeem_tx(client: &ClientHandle, mint: u16, lnv2: u16, notes: &[(Note, Keypair)]) -> anyhow::Result<Transaction> {
    let config = client.config().await;
    let mcfg = config.get_module::<MintClientConfig>(mint)?;
    let lcfg = config.get_module::<fedimint_lnv2_common::config::LightningClientConfig>(lnv2)?;
    let total: u64 = notes.iter().map(|(n, _)| n.amount().msats).sum();
    let mint_fee: u64 = notes.iter().map(|(n, _)| mcfg.fee_consensus.fee(n.amount()).msats).sum();
    let c0 = total.checked_sub(mint_fee).context("fees above the notes")?;
    let amount = c0.checked_sub(lcfg.fee_consensus.fee(Amount::from_msats(c0)).msats).context("fees above the notes")?;
    let refund = PublicKey::from_secret_key(SECP256K1, &SecretKey::from_slice(&random32()?)?);
    let contract = OutgoingContract {
        payment_image: PaymentImage::Hash(bitcoin::hashes::sha256::Hash::from_slice(&random32()?)?),
        amount: Amount::from_msats(amount), expiration: 1_000_000, claim_pk: refund, refund_pk: refund, ephemeral_pk: refund,
    };
    let inputs: Vec<_> = notes.iter().map(|(n, _)| MintInput::new_v0(*n).into_dyn(mint)).collect();
    let outputs = vec![LightningOutput::V0(LightningOutputV0::Outgoing(contract)).into_dyn(lnv2)];
    let nonce: [u8; 8] = random32()?[..8].try_into()?;
    let txid = Transaction::tx_hash_from_parts(&inputs, &outputs, nonce);
    let msg = Message::from_digest_slice(&txid[..])?;
    let sigs = notes.iter().map(|(_, k)| SECP256K1.sign_schnorr_no_aux_rand(&msg, k)).collect();
    Ok(Transaction { inputs, outputs, nonce, signatures: TransactionSignature::NaiveMultisig(sigs) })
}

use fedimint_core::bitcoin::hashes::Hash as _;

pub async fn forge(a: &Args, client: &ClientHandle) -> anyhow::Result<()> {
    let (mint, lnv2, _, _) = regtest_only(client).await?;
    let d: u8 = need(a, "denomination")?.parse()?;
    let count: usize = a.get("count").map_or(Ok(1), |v| v.parse())?;
    let notes = forge_notes(a, client, mint, d, count).await?;
    let tx = redeem_tx(client, mint, lnv2, &notes).await?;
    let txid = tx.tx_hash();
    let mut report = serde_json::json!({ "mode": "rehearsal-forge", "denomination": d, "count": count,
        "msat": notes.iter().map(|(n, _)| n.amount().msats).sum::<u64>(), "notesVerify": true, "txid": txid.to_string() });
    if a.get("submit").is_some_and(|v| v == "false") { println!("{report}"); return Ok(()); }
    let said = tokio::time::timeout(std::time::Duration::from_secs(60), client.api().submit_transaction(tx)).await;
    match said {
        Err(_) => { report["accepted"] = false.into(); report["error"] = "no answer in 60 s".into(); }
        Ok(enc) => match enc.try_into_inner(client.decoders()) {
            Ok(outcome) => match outcome.0 {
                Ok(_) => { report["accepted"] = true.into(); }
                Err(e) => { report["accepted"] = false.into(); report["error"] = e.to_string().into(); }
            },
            Err(e) => { report["accepted"] = false.into(); report["error"] = format!("answer did not decode: {e}").into(); }
        },
    }
    println!("{report}");
    Ok(())
}

fn last_in(dir: &str) -> anyhow::Result<Option<u64>> {
    Ok(std::fs::read_dir(dir)?.filter_map(|e| e.ok()?.file_name().to_str()?.strip_suffix(".bin")?.parse::<u64>().ok()).max())
}

pub async fn resign(a: &Args, client: &ClientHandle) -> anyhow::Result<()> {
    let (mint, lnv2, _, _) = regtest_only(client).await?;
    let dir = need(a, "replay-dir")?;
    let idx = last_in(dir)?.map_or(0, |l| l + 1);
    let d: u8 = need(a, "denomination")?.parse()?;
    let notes = forge_notes(a, client, mint, d, a.get("count").map_or(Ok(1), |v| v.parse())?).await?;
    let tx = redeem_tx(client, mint, lnv2, &notes).await?;
    let session = SessionOutcome { items: vec![AcceptedItem { item: ConsensusItem::Transaction(tx.clone()), peer: PeerId::from(0) }] };
    // the message every guardian signs at a session's end (session_outcome.rs verify): H(H(keys) || header(index))
    let keys = client.get_guardian_public_keys_blocking().await;
    let message = {
        let mut engine = bitcoin::hashes::sha256::Hash::engine();
        std::io::Write::write_all(&mut engine, keys.consensus_hash_sha256().as_ref())?;
        std::io::Write::write_all(&mut engine, &session.header(idx))?;
        Message::from_digest(bitcoin::hashes::sha256::Hash::from_engine(engine).to_byte_array())
    };
    let mut signatures = BTreeMap::new();
    for p in privates(a)? {
        let sk = SecretKey::from_str(p["broadcast_secret_key"].as_str().context("no broadcast_secret_key")?)?;
        let kp = Keypair::from_secret_key(SECP256K1, &sk);
        let peer = keys.iter().find(|(_, k)| **k == kp.public_key()).map(|(p, _)| *p).context("a broadcast key of no guardian")?;
        signatures.insert(peer, SECP256K1.sign_schnorr_no_aux_rand(&message, &kp));
    }
    let signed = SignedSessionOutcome { session_outcome: session, signatures };
    let verifies = signed.verify(&keys, idx);
    let bytes = signed.consensus_encode_to_vec();
    std::fs::write(format!("{dir}/{idx}.bin"), &bytes)?;
    println!("{}", serde_json::json!({ "mode": "rehearsal-resign", "session": idx, "signers": signed.signatures.len(),
        "verifies": verifies, "txid": tx.tx_hash().to_string(), "denomination": d, "bytes": bytes.len() }));
    Ok(())
}

pub async fn rogue_spend(a: &Args, client: &ClientHandle) -> anyhow::Result<()> {
    use bitcoincore_rpc::RpcApi;
    let (_, _, wallet, v2) = regtest_only(client).await?;
    if v2 { return rogue_spend_v2(a, client, wallet).await; }
    let dir = need(a, "replay-dir")?;
    let outpoint = bitcoin::OutPoint::from_str(need(a, "outpoint")?)?;
    // the peg-in that named this outpoint, from the signed history held in DIR: its tweak and its output
    let decoders: ModuleDecoderRegistry = client.decoders().clone();
    let mut found = None;
    for idx in 0..=last_in(dir)?.context("no sessions in the replay dir")? {
        let Ok(bytes) = std::fs::read(format!("{dir}/{idx}.bin")) else { continue };
        let sso = SignedSessionOutcome::consensus_decode_whole(&bytes, &decoders)?;
        for item in sso.session_outcome.items {
            let ConsensusItem::Transaction(tx) = item.item else { continue };
            for i in &tx.inputs {
                if let Some(fedimint_wallet_client::WalletInput::V0(p)) = i.as_any().downcast_ref::<fedimint_wallet_client::WalletInput>() {
                    if p.0.outpoint() == outpoint { found = Some((idx, p.0.tweak_key(), p.0.tx_output())); }
                }
            }
        }
    }
    let (session, tweak, txout) = found.context("no peg-in of that outpoint in the signed history")?;
    let config = client.config().await;
    let wcfg = config.get_module::<fedimint_wallet_client::config::WalletClientConfig>(wallet)?;
    let descriptor = wcfg.peg_in_descriptor.tweak(&tweak, SECP256K1);
    if descriptor.script_pubkey() != txout.script_pubkey { bail!("the tweaked descriptor is not the peg-in's script") }
    let witness_script = descriptor.explicit_script().map_err(|e| anyhow!("{e}"))?;
    let address = bitcoin::Address::from_str(need(a, "address")?)?.require_network(bitcoin::Network::Regtest)?;
    let fee: u64 = need(a, "fee-sats")?.parse()?;
    let mut tx = bitcoin::Transaction {
        version: bitcoin::transaction::Version::TWO, lock_time: bitcoin::absolute::LockTime::ZERO,
        input: vec![bitcoin::TxIn { previous_output: outpoint, script_sig: bitcoin::ScriptBuf::new(),
            sequence: bitcoin::Sequence::ENABLE_RBF_NO_LOCKTIME, witness: bitcoin::Witness::new() }],
        output: vec![bitcoin::TxOut { value: bitcoin::Amount::from_sat(txout.value.to_sat() - fee), script_pubkey: address.script_pubkey() }],
    };
    let sighash = bitcoin::sighash::SighashCache::new(&tx)
        .p2wsh_signature_hash(0, &witness_script, txout.value, bitcoin::EcdsaSighashType::All)?;
    let msg = Message::from_digest(sighash.to_byte_array());
    // each guardian's wallet key tweaked as the federation tweaks it for this peg-in; signatures in the script's key order
    let mut sigs: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    for p in privates(a)? {
        let sk = SecretKey::from_str(module_of(&p, "wallet")?["peg_in_key"].as_str().context("no peg_in_key")?)?;
        let tweaked = sk.tweak(&tweak, SECP256K1);
        let pk = PublicKey::from_secret_key(SECP256K1, &tweaked).serialize().to_vec();
        if !witness_script.as_bytes().windows(33).any(|w| w == pk.as_slice()) { bail!("a wallet key of no guardian of this peg-in") }
        let sig = bitcoin::ecdsa::Signature::sighash_all(SECP256K1.sign_ecdsa(&msg, &tweaked));
        sigs.push((pk, sig.to_vec()));
    }
    sigs.sort();
    let mut witness = bitcoin::Witness::new();
    witness.push(Vec::<u8>::new());
    for (_, s) in &sigs { witness.push(s); }
    witness.push(witness_script.as_bytes());
    tx.input[0].witness = witness;
    let raw = hex(&bitcoin::consensus::encode::serialize(&tx));
    let url = need(a, "bitcoind")?.to_owned();
    let txid = tokio::task::spawn_blocking(move || -> anyhow::Result<bitcoin::Txid> {
        let u = fedimint_core::util::SafeUrl::parse(&url)?;
        let rpc = bitcoincore_rpc::Client::new(&format!("{}://{}:{}", u.scheme(), u.host_str().unwrap_or("127.0.0.1"), u.port().unwrap_or(8332)),
            bitcoincore_rpc::Auth::UserPass(u.username().to_owned(), u.password().unwrap_or("").to_owned()))?;
        Ok(rpc.send_raw_transaction(raw.as_str())?)
    }).await??;
    println!("{}", serde_json::json!({ "mode": "rehearsal-rogue-spend", "outpoint": outpoint.to_string(), "peginSession": session,
        "sats": txout.value.to_sat(), "signers": sigs.len(), "txid": txid.to_string(), "to": address.to_string() }));
    let _ = hex_bytes;
    Ok(())
}

/// The walletv2 rogue spend: the federation's one wallet output, as a threshold names it, spent with the given guardians'
/// `bitcoin_sk` tweaked by the output's tweak (walletv2 sign_tx), to --address, and broadcast. No consensus is asked.
async fn rogue_spend_v2(a: &Args, client: &ClientHandle, wallet: u16) -> anyhow::Result<()> {
    use bitcoincore_rpc::RpcApi;
    use fedimint_api_client::api::FederationApiExt;
    use fedimint_core::module::ApiRequestErased;
    use fedimint_walletv2_client::common::{FederationWallet, descriptor, endpoint_constants::FEDERATION_WALLET_ENDPOINT};
    let fw: Option<FederationWallet> = client.api().with_module(wallet)
        .request_current_consensus(FEDERATION_WALLET_ENDPOINT.to_string(), ApiRequestErased::new(())).await
        .map_err(|e| anyhow!("federation_wallet: {e}"))?;
    let fw = fw.context("the federation holds no wallet output yet: peg in first")?;
    if let Some(o) = a.get("outpoint") {
        if bitcoin::OutPoint::from_str(o)? != fw.outpoint { bail!("{o} is not the federation's wallet output {}", fw.outpoint) }
    }
    let config = client.config().await;
    let wcfg = config.get_module::<fedimint_walletv2_client::common::config::WalletClientConfig>(wallet)?;
    let desc = descriptor(&wcfg.bitcoin_pks, &fw.tweak);
    let witness_script = desc.inner_script();
    let threshold = { use fedimint_core::NumPeersExt; wcfg.bitcoin_pks.to_num_peers().threshold() };
    let address = bitcoin::Address::from_str(need(a, "address")?)?.require_network(bitcoin::Network::Regtest)?;
    let fee: u64 = need(a, "fee-sats")?.parse()?;
    let mut tx = bitcoin::Transaction {
        version: bitcoin::transaction::Version::TWO, lock_time: bitcoin::absolute::LockTime::ZERO,
        input: vec![bitcoin::TxIn { previous_output: fw.outpoint, script_sig: bitcoin::ScriptBuf::new(),
            sequence: bitcoin::Sequence::ENABLE_RBF_NO_LOCKTIME, witness: bitcoin::Witness::new() }],
        output: vec![bitcoin::TxOut { value: fw.value - bitcoin::Amount::from_sat(fee), script_pubkey: address.script_pubkey() }],
    };
    let sighash = bitcoin::sighash::SighashCache::new(&tx)
        .p2wsh_signature_hash(0, &witness_script, fw.value, bitcoin::EcdsaSighashType::All)?;
    let msg = Message::from_digest(sighash.to_byte_array());
    let scalar = fedimint_core::secp256k1::Scalar::from_be_bytes(fw.tweak.to_byte_array()).map_err(|_| anyhow!("the tweak is out of range"))?;
    let mut sigs: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    for p in privates(a)? {
        let sk = SecretKey::from_str(module_of(&p, "walletv2")?["bitcoin_sk"].as_str().context("no bitcoin_sk")?)?;
        let tweaked = sk.add_tweak(&scalar)?;
        let pk = PublicKey::from_secret_key(SECP256K1, &tweaked).serialize().to_vec();
        if !witness_script.as_bytes().windows(33).any(|w| w == pk.as_slice()) { bail!("a bitcoin key of no guardian of this federation") }
        sigs.push((pk, bitcoin::ecdsa::Signature::sighash_all(SECP256K1.sign_ecdsa(&msg, &tweaked)).to_vec()));
    }
    if sigs.len() < threshold { bail!("{} keys given, the wallet needs {threshold}", sigs.len()) }
    // OP_CHECKMULTISIG takes exactly the threshold's signatures, in the script's (sorted) key order
    sigs.sort();
    sigs.truncate(threshold);
    let mut witness = bitcoin::Witness::new();
    witness.push(Vec::<u8>::new());
    for (_, s) in &sigs { witness.push(s); }
    witness.push(witness_script.as_bytes());
    tx.input[0].witness = witness;
    let raw = hex(&bitcoin::consensus::encode::serialize(&tx));
    let url = need(a, "bitcoind")?.to_owned();
    let txid = tokio::task::spawn_blocking(move || -> anyhow::Result<bitcoin::Txid> {
        let u = fedimint_core::util::SafeUrl::parse(&url)?;
        let rpc = bitcoincore_rpc::Client::new(&format!("{}://{}:{}", u.scheme(), u.host_str().unwrap_or("127.0.0.1"), u.port().unwrap_or(8332)),
            bitcoincore_rpc::Auth::UserPass(u.username().to_owned(), u.password().unwrap_or("").to_owned()))?;
        Ok(rpc.send_raw_transaction(raw.as_str())?)
    }).await??;
    println!("{}", serde_json::json!({ "mode": "rehearsal-rogue-spend", "wallet": "walletv2", "outpoint": fw.outpoint.to_string(),
        "sats": fw.value.to_sat(), "signers": sigs.len(), "txid": txid.to_string(), "to": address.to_string() }));
    Ok(())
}
