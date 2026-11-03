//! THE FEDERATION'S SIGNED HISTORY, READ AND CHECKED BY A SEAT (kanban #1093 part 2, #1108, ruling #1106).
//!
//! Every session as one guardian's API serves it (`await_signed_session_outcome`, no auth), decoded with the client's
//! own module decoders and verified with `SignedSessionOutcome::verify` against the config's broadcast keys - a
//! threshold of the guardians' Schnorr signatures over the session's index and the merkle root of its items, so a
//! single guardian cannot hand out a history the threshold did not sign. One client, one connection pool for every
//! session; with --cursor FILE the totals and the next session are kept between runs, and --follow S keeps the process
//! and its connections open, reading only the sessions that finished since the last pass.
//!
//! What it sums, through the stock client crates (no Fedimint change): e-cash issued (mint outputs) and redeemed (mint
//! inputs), in total and per denomination; peg-ins with their outpoints (wallet inputs: the federation's reserve UTXOs);
//! peg-outs with recipient and fee (wallet outputs); and the bitcoin txids the guardians signed as peg-outs (wallet
//! `PegOutSignature` items).
//!
//! THE TWO MARKS:
//!   inflation      redeemed so far > issued so far (the carry included), in total or in any one denomination
//!   unbacked spend a reserve UTXO the signed history pegged in, spent on the chain 6 deep by a transaction whose txid
//!                  no PegOutSignature in the signed history names (needs --bitcoind URL, user:pass in the URL)
//! With --proof-out FILE a mark is written as self-checking bytes: the federation's broadcast keys, the signed sessions
//! involved (consensus-encoded hex), the carry they start from, and for an unbacked spend the spending transaction with
//! its merkle proof (`gettxoutproof`) - ruling #1109's format, see `Proof`. --mode session-proof-verify re-verifies such
//! bytes offline (no client, no guardian, no bitcoind) and answers { ok, mark, why }.
//!
//! Read-only toward the guardians and the chain: nothing is posted.
use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;
use std::time::Duration;

use anyhow::{Context, anyhow, bail};
use fedimint_api_client::api::DynGlobalApi;
use fedimint_client::ClientHandle;
use fedimint_core::PeerId;
use fedimint_core::bitcoin;
use fedimint_core::core::ModuleInstanceId;
use fedimint_core::bitcoin::hashes::Hash as _;
use fedimint_core::encoding::Decodable;
use fedimint_core::endpoint_constants::AWAIT_SIGNED_SESSION_OUTCOME_ENDPOINT;
use fedimint_core::epoch::ConsensusItem;
use fedimint_core::module::ApiRequestErased;
use fedimint_core::module::registry::ModuleDecoderRegistry;
use fedimint_core::secp256k1::PublicKey;
use fedimint_core::session_outcome::SignedSessionOutcome;
use fedimint_lnv2_common::{LightningOutput, LightningOutputV0};
use serde::{Deserialize, Serialize};

use crate::{Args, hex, hex_bytes};

/// A reserve UTXO the signed history names: a peg-in's outpoint, or the change of a signed peg-out.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Reserve {
    pub sats: u64,
    pub session: u64,
    /// the block of its peg-in proof (a peg-in) or none (a change output)
    pub block: Option<String>,
    pub script: String,
    /// a change output: the signed peg-out transaction that created it (hex)
    #[serde(default)]
    pub creating_tx: Option<String>,
    /// "unspent" | "pegout:<txid>" | "unbacked:<txid>" | "pending:<txid>" (spent, not yet 6 deep) | "missing"
    pub state: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Unbacked {
    pub outpoint: String,
    pub sats: u64,
    pub pegin_session: u64,
    pub spender: String,
    pub height: u64,
    pub block: String,
    pub depth: u64,
    pub tx_hex: String,
    pub txoutproof_hex: String,
    /// for a change output: the signed peg-out transaction that created it
    #[serde(default)]
    pub creating_tx_hex: Option<String>,
}

/// The cursor: everything a later pass needs to judge the whole history from where this one stopped.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct State {
    pub federation: String,
    pub next: u64,
    pub issued_msat: u64,
    pub redeemed_msat: u64,
    /// outstanding notes per denomination (log2 of the msat amount): issued - redeemed
    pub denominations: BTreeMap<u8, i64>,
    pub first_inflation_session: Option<u64>,
    pub inflation_denomination: Option<u8>,
    pub peg_ins: u64,
    pub peg_ins_sats: u64,
    pub peg_outs_sats: u64,
    pub peg_out_fees_sats: u64,
    pub lnv2_funded_msat: u64,
    pub transactions: u64,
    pub reserves: BTreeMap<String, Reserve>,
    /// each peg-out the signed history names: (session, fedimint txid, recipient script hex, sats)
    pub peg_outs: Vec<(u64, String, String, u64)>,
    /// bitcoin txid -> the session whose PegOutSignature named it first
    pub signed_peg_out_txids: BTreeMap<String, u64>,
    pub unbacked: Vec<Unbacked>,
    pub items_by_kind: BTreeMap<String, u64>,
}

impl State {
    /// Apply one verified session.
    pub fn apply(&mut self, idx: u64, sso: &SignedSessionOutcome, kinds: &BTreeMap<ModuleInstanceId, String>) {
        for item in &sso.session_outcome.items {
            match &item.item {
                ConsensusItem::Transaction(tx) => {
                    self.transactions += 1;
                    *self.items_by_kind.entry("transaction".into()).or_default() += 1;
                    let txid = tx.tx_hash().to_string();
                    for input in &tx.inputs {
                        let kind = kinds.get(&input.module_instance_id()).cloned().unwrap_or_else(|| "unknown".into());
                        *self.items_by_kind.entry(format!("input:{kind}")).or_default() += 1;
                        let any = input.as_any();
                        let note = if let Some(fedimint_mintv2_client::common::MintInput::V0(v)) =
                            any.downcast_ref::<fedimint_mintv2_client::common::MintInput>() { Some(v.note.amount().msats) }
                            else if let Some(fedimint_mint_client::MintInput::V0(v)) = any.downcast_ref::<fedimint_mint_client::MintInput>() { Some(v.amount.msats) }
                            else { None };
                        if let Some(m) = note {
                            self.redeemed_msat += m;
                            *self.denominations.entry(m.trailing_zeros() as u8).or_default() -= 1;
                            continue;
                        }
                        if let Some(w) = any.downcast_ref::<fedimint_wallet_client::WalletInput>() {
                            let got = match w {
                                fedimint_wallet_client::WalletInput::V0(p) => Some((p.0.outpoint(), p.0.tx_output(), Some(p.0.proof_block().to_string()))),
                                fedimint_wallet_client::WalletInput::V1(v) => Some((v.outpoint, v.tx_out.clone(), None)),
                                _ => None,
                            };
                            if let Some((op, out, block)) = got {
                                self.peg_ins += 1;
                                self.peg_ins_sats += out.value.to_sat();
                                self.reserves.insert(op.to_string(), Reserve { sats: out.value.to_sat(), session: idx, block,
                                    script: hex(out.script_pubkey.as_bytes()), state: "unspent".into(), creating_tx: None });
                            }
                        }
                    }
                    for output in &tx.outputs {
                        let kind = kinds.get(&output.module_instance_id()).cloned().unwrap_or_else(|| "unknown".into());
                        *self.items_by_kind.entry(format!("output:{kind}")).or_default() += 1;
                        let any = output.as_any();
                        let note = if let Some(fedimint_mintv2_client::common::MintOutput::V0(v)) =
                            any.downcast_ref::<fedimint_mintv2_client::common::MintOutput>() { Some(v.amount().msats) }
                            else if let Some(fedimint_mint_client::MintOutput::V0(v)) = any.downcast_ref::<fedimint_mint_client::MintOutput>() { Some(v.amount.msats) }
                            else { None };
                        if let Some(m) = note {
                            self.issued_msat += m;
                            *self.denominations.entry(m.trailing_zeros() as u8).or_default() += 1;
                        } else if let Some(fedimint_wallet_client::WalletOutput::V0(w)) = any.downcast_ref::<fedimint_wallet_client::WalletOutput>() {
                            match w {
                                fedimint_wallet_client::WalletOutputV0::PegOut(p) => {
                                    let (sats, fee) = (p.amount.to_sat(), p.fees.amount().to_sat());
                                    self.peg_outs_sats += sats;
                                    self.peg_out_fees_sats += fee;
                                    self.peg_outs.push((idx, txid.clone(), hex(p.recipient.assume_checked_ref().script_pubkey().as_bytes()), sats));
                                }
                                fedimint_wallet_client::WalletOutputV0::Rbf(r) => self.peg_out_fees_sats += r.fees.amount().to_sat(),
                            }
                        } else if let Some(fedimint_walletv2_client::common::WalletOutput::V0(v)) = any.downcast_ref::<fedimint_walletv2_client::common::WalletOutput>() {
                            self.peg_outs_sats += v.value.to_sat();
                            self.peg_out_fees_sats += v.fee.to_sat();
                            self.peg_outs.push((idx, txid.clone(), format!("{:?}", v.destination), v.value.to_sat()));
                        } else if let Some(LightningOutput::V0(l)) = any.downcast_ref::<LightningOutput>() {
                            self.lnv2_funded_msat += match l { LightningOutputV0::Outgoing(c) => c.amount.msats, LightningOutputV0::Incoming(c) => c.commitment.amount.msats };
                        }
                    }
                }
                ConsensusItem::Module(m) => {
                    let kind = kinds.get(&m.module_instance_id()).cloned().unwrap_or_else(|| "unknown".into());
                    *self.items_by_kind.entry(format!("module:{kind}")).or_default() += 1;
                    if let Some(fedimint_wallet_client::WalletConsensusItem::PegOutSignature(s)) =
                        m.as_any().downcast_ref::<fedimint_wallet_client::WalletConsensusItem>()
                    {
                        self.signed_peg_out_txids.entry(s.txid.to_string()).or_insert(idx);
                    }
                }
                ConsensusItem::Default { variant, .. } => { *self.items_by_kind.entry(format!("default:{variant}")).or_default() += 1; }
            }
        }
        if self.first_inflation_session.is_none() {
            if self.redeemed_msat > self.issued_msat {
                self.first_inflation_session = Some(idx);
            } else if let Some((d, _)) = self.denominations.iter().find(|(_, n)| **n < 0) {
                self.first_inflation_session = Some(idx);
                self.inflation_denomination = Some(*d);
            }
        }
        self.next = idx + 1;
    }
}

/// The federation's module kinds by instance, and its broadcast keys.
pub async fn federation_view(client: &ClientHandle) -> (BTreeMap<ModuleInstanceId, String>, BTreeMap<PeerId, PublicKey>) {
    let config = client.config().await;
    let kinds = config.modules.iter().map(|(id, m)| (*id, m.kind.to_string())).collect();
    (kinds, client.get_guardian_public_keys_blocking().await)
}

/// One session's bytes from the first guardian of `peers` that answers within 30 s. The answer is a
/// SerdeModuleEncoding: `["<hex>"]`, the hex being the consensus encoding of the Vec<u8> (a BigSize length first).
async fn fetch(api: DynGlobalApi, peers: Vec<PeerId>, idx: u64) -> (u64, Result<(PeerId, Vec<u8>), String>) {
    let mut errors = Vec::new();
    for peer in peers {
        let said = tokio::time::timeout(Duration::from_secs(30),
            api.request_raw(peer, AWAIT_SIGNED_SESSION_OUTCOME_ENDPOINT, &ApiRequestErased::new(idx))).await;
        let value = match said {
            Err(_) => { errors.push(format!("peer {peer}: no answer in 30 s")); continue; }
            Ok(Err(e)) => { errors.push(format!("peer {peer}: {e}")); continue; }
            Ok(Ok(v)) => v,
        };
        let text = value.as_str().or_else(|| value.get(0).and_then(|v| v.as_str())).map(str::to_owned);
        let inner = |t: &str| -> anyhow::Result<Vec<u8>> {
            Ok(Vec::<u8>::consensus_decode_whole(&hex_bytes(t)?, &ModuleDecoderRegistry::default())?)
        };
        match text.map(|t| inner(&t)) {
            Some(Ok(bytes)) => return (idx, Ok((peer, bytes))),
            Some(Err(e)) => errors.push(format!("peer {peer}: not an encoding: {e}")),
            None => errors.push(format!("peer {peer}: not an encoding: {}", value.to_string().chars().take(120).collect::<String>())),
        }
    }
    (idx, Err(errors.join("; ")))
}

fn bitcoind(url: &str) -> anyhow::Result<bitcoincore_rpc::Client> {
    let u = fedimint_core::util::SafeUrl::parse(url)?;
    let auth = match (u.username(), u.password()) {
        ("", _) => bitcoincore_rpc::Auth::None,
        (user, pass) => bitcoincore_rpc::Auth::UserPass(user.to_owned(), pass.unwrap_or("").to_owned()),
    };
    let bare = format!("{}://{}:{}{}", u.scheme(), u.host_str().unwrap_or("127.0.0.1"), u.port().unwrap_or(8332), u.path());
    Ok(bitcoincore_rpc::Client::new(&bare, auth)?)
}

/// THE CHAIN SIDE OF THE UNBACKED-SPEND MARK. Each reserve the history names is asked of bitcoind (`gettxout`, the
/// confirmed set): unspent stays; a signed peg-out's inputs are the reserves it spent legitimately and its outputs
/// other than a peg-out's recipient are the federation's change - new reserves; any other spent reserve is looked up
/// block by block from its peg-in's block, and its spender, 6 deep and named by no PegOutSignature, is the mark.
pub fn chain_check(state: &mut State, url: &str, depth_needed: u64, pending: &mut Vec<serde_json::Value>) -> anyhow::Result<serde_json::Value> {
    use bitcoincore_rpc::RpcApi;
    let rpc = bitcoind(url)?;
    let tip = rpc.get_block_count()?;
    let recipients: BTreeSet<String> = state.peg_outs.iter().map(|p| p.2.clone()).collect();
    // the signed peg-outs first: what they spent, and their change
    let mut fetched = 0u64;
    for (txid, session) in state.signed_peg_out_txids.clone() {
        let t = bitcoin::Txid::from_str(&txid)?;
        let Ok(tx) = rpc.get_raw_transaction(&t, None) else { continue };
        fetched += 1;
        for i in &tx.input {
            if let Some(r) = state.reserves.get_mut(&i.previous_output.to_string()) { r.state = format!("pegout:{txid}"); }
        }
        for (vout, o) in tx.output.iter().enumerate() {
            let script = hex(o.script_pubkey.as_bytes());
            if recipients.contains(&script) { continue; }
            let op = format!("{txid}:{vout}");
            state.reserves.entry(op).or_insert(Reserve { sats: o.value.to_sat(), session, block: None, script, state: "unspent".into(),
                creating_tx: Some(hex(&bitcoin::consensus::encode::serialize(&tx))) });
        }
    }
    let mut unspent = 0u64;
    let mut scanned_blocks = 0u64;
    let keys: Vec<String> = state.reserves.keys().cloned().collect();
    for op in keys {
        let r = state.reserves[&op].clone();
        if r.state.starts_with("pegout:") || r.state.starts_with("unbacked:") { continue; }
        let o = bitcoin::OutPoint::from_str(&op)?;
        if rpc.get_tx_out(&o.txid, o.vout, Some(false))?.is_some() {
            state.reserves.get_mut(&op).expect("listed").state = "unspent".into();
            unspent += 1;
            continue;
        }
        // spent (or never confirmed here): find the spender, from the reserve's own block on
        let from = match &r.block {
            Some(b) => rpc.get_block_header_info(&bitcoin::BlockHash::from_str(b)?).map(|h| h.height as u64).unwrap_or(0),
            None => rpc.get_raw_transaction_info(&o.txid, None).ok().and_then(|i| i.blockhash)
                .and_then(|h| rpc.get_block_header_info(&h).ok()).map_or(0, |h| h.height as u64),
        };
        let mut found = None;
        let mut h = from;
        while h <= tip && found.is_none() {
            let hash = rpc.get_block_hash(h)?;
            let block = rpc.get_block(&hash)?;
            scanned_blocks += 1;
            for tx in &block.txdata {
                if tx.input.iter().any(|i| i.previous_output == o) { found = Some((tx.clone(), h, hash)); break; }
            }
            h += 1;
        }
        let Some((tx, height, hash)) = found else {
            state.reserves.get_mut(&op).expect("listed").state = "missing".into();
            continue;
        };
        let spender = tx.compute_txid().to_string();
        let depth = tip - height + 1;
        if state.signed_peg_out_txids.contains_key(&spender) {
            state.reserves.get_mut(&op).expect("listed").state = format!("pegout:{spender}");
        } else if depth < depth_needed {
            state.reserves.get_mut(&op).expect("listed").state = format!("pending:{spender}");
            pending.push(serde_json::json!({ "outpoint": op, "spender": spender, "height": height, "depth": depth }));
        } else {
            let proof = rpc.get_tx_out_proof(&[tx.compute_txid()], Some(&hash))?;
            state.reserves.get_mut(&op).expect("listed").state = format!("unbacked:{spender}");
            state.unbacked.push(Unbacked { outpoint: op.clone(), sats: r.sats, pegin_session: r.session, spender, height,
                block: hash.to_string(), depth, tx_hex: hex(&fedimint_core::bitcoin::consensus::encode::serialize(&tx)), txoutproof_hex: hex(&proof),
                creating_tx_hex: r.creating_tx.clone() });
        }
    }
    Ok(serde_json::json!({ "tip": tip, "reserves": state.reserves.len(), "unspent": unspent, "signedPegOutsFound": fetched,
        "scannedBlocks": scanned_blocks }))
}

fn load_state(path: &str) -> anyhow::Result<Option<State>> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(Some(serde_json::from_str(&s).with_context(|| format!("{path} is no cursor"))?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn save_json(path: &str, v: &impl Serialize) -> anyhow::Result<()> {
    let tmp = format!("{path}.tmp");
    std::fs::write(&tmp, serde_json::to_vec(v)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// --mode session-audit (see the module's head).
pub async fn session_audit(a: &Args, client: &ClientHandle) -> anyhow::Result<()> {
    let (kinds, keys) = federation_view(client).await;
    let federation = client.federation_id().to_string();
    let peers: Vec<PeerId> = match a.get("peer") {
        Some(p) => vec![PeerId::from(p.parse::<u16>()?)],
        None => keys.keys().copied().collect(),
    };
    let parallel: u64 = a.get("parallel").map_or(Ok(8), |v| v.parse::<u64>())?.max(1);
    let tamper = a.get("tamper").is_none_or(|v| v != "false");
    let max_sessions: Option<u64> = a.get("max-sessions").map(|v| v.parse::<u64>()).transpose()?;
    let explicit_to: Option<u64> = a.get("to").map(|v| v.parse::<u64>()).transpose()?;
    let follow: Option<u64> = a.get("follow").map(|v| v.parse::<u64>()).transpose()?;
    let cursor = a.get("cursor").cloned();
    let sessions_dir = a.get("sessions-dir").cloned();
    if let Some(d) = &sessions_dir { std::fs::create_dir_all(d)?; }
    let chain = a.get("bitcoind").cloned();
    let depth_needed: u64 = a.get("depth").map_or(Ok(6), |v| v.parse::<u64>())?;
    // A HISTORY ALREADY HELD (--replay-dir DIR, <index>.bin files as --sessions-dir writes them): checked offline, nobody asked
    let replay = a.get("replay-dir").cloned();

    // where to start: the cursor's next session and totals, else --from with the carry given
    let mut state = match cursor.as_deref().map(load_state).transpose()?.flatten() {
        Some(s) => {
            if s.federation != federation { bail!("the cursor is federation {}, this client {federation}", s.federation) }
            s
        }
        None => {
            let from: u64 = a.get("from").map_or(Ok(0), |v| v.parse::<u64>())?;
            State {
                federation: federation.clone(), next: from,
                issued_msat: a.get("carry-issued-msat").map_or(Ok(0), |v| v.parse::<u64>())?,
                redeemed_msat: a.get("carry-redeemed-msat").map_or(Ok(0), |v| v.parse::<u64>())?,
                ..State::default()
            }
        }
    };
    let carry = (state.issued_msat, state.redeemed_msat, state.next);
    let decoders = client.decoders().clone();
    let api = client.api_clone();
    // the sessions kept for a proof: from the sessions dir, else those read in this process
    let mut held: BTreeMap<u64, Vec<u8>> = BTreeMap::new();
    let keep_in_memory = a.contains_key("proof-out") && sessions_dir.is_none();
    let mut tamper_report = serde_json::Value::Null;

    loop {
        let started = std::time::Instant::now();
        let from = state.next;
        // never past the last finished session: await_signed_session_outcome waits for one that does not exist yet
        let to: Option<u64> = if let Some(dir) = &replay {
            let last = std::fs::read_dir(dir)?.filter_map(|e| e.ok()?.file_name().to_str()?.strip_suffix(".bin")?.parse::<u64>().ok()).max();
            last.map(|l| explicit_to.map_or(l, |t| l.min(t))).filter(|l| *l >= from)
        } else if explicit_to.is_some() && max_sessions.is_none() && follow.is_none() {
            explicit_to
        } else {
            let count = client.fetch_session_count().await.map_err(|e| anyhow!("no session count: {e}"))?;
            let mut last = count.checked_sub(1);
            if let Some(t) = explicit_to { last = last.map(|l| l.min(t)); }
            if let Some(n) = max_sessions { last = if n == 0 { None } else { last.map(|l| l.min(from.saturating_add(n - 1))) }; }
            last.filter(|l| *l >= from)
        };
        let (mut sessions, mut verified, mut bytes_total) = (0u64, 0u64, 0u64);
        let mut unverified: Vec<u64> = Vec::new();
        let mut failed: Vec<serde_json::Value> = Vec::new();
        let mut answered_by: BTreeMap<String, u64> = BTreeMap::new();
        let mut next = from;
        'range: while let Some(to) = to.filter(|t| next <= *t) {
            let end = (next + parallel - 1).min(to);
            let mut set = tokio::task::JoinSet::new();
            let mut got: BTreeMap<u64, Result<(PeerId, Vec<u8>), String>> = BTreeMap::new();
            for idx in next..=end {
                match &replay {
                    Some(dir) => { got.insert(idx, std::fs::read(format!("{dir}/{idx}.bin")).map(|b| (PeerId::from(u16::MAX), b)).map_err(|e| format!("{dir}/{idx}.bin: {e}"))); }
                    None => { set.spawn(fetch(api.clone(), peers.clone(), idx)); }
                }
            }
            while let Some(r) = set.join_next().await { let (idx, r) = r?; got.insert(idx, r); }
            next = end + 1;
            for (idx, r) in got {
                sessions += 1;
                let checked = r.and_then(|(peer, bytes)| {
                    let sso = SignedSessionOutcome::consensus_decode_whole(&bytes, &decoders).map_err(|e| format!("decode: {e}"))?;
                    if !sso.verify(&keys, idx) { return Err("signatures do not verify".to_owned()); }
                    Ok((peer, bytes, sso))
                });
                let (peer, bytes, sso) = match checked {
                    Ok(x) => x,
                    // the totals are a prefix: a session that does not verify stops the pass there; the cursor waits on it
                    Err(e) => { unverified.push(idx); failed.push(serde_json::json!({ "session": idx, "error": e })); break 'range; }
                };
                verified += 1;
                bytes_total += bytes.len() as u64;
                *answered_by.entry(peer.to_string()).or_default() += 1;
                if tamper && tamper_report.is_null() && !sso.session_outcome.items.is_empty() {
                    tamper_report = tamper_check(&sso, &bytes, idx, &keys, &decoders);
                }
                state.apply(idx, &sso, &kinds);
                if let Some(d) = &sessions_dir { std::fs::write(format!("{d}/{idx}.bin"), &bytes)?; }
                if keep_in_memory { held.insert(idx, bytes); }
            }
        }
        let read_ms = started.elapsed().as_millis() as u64;
        let mut pending: Vec<serde_json::Value> = Vec::new();
        let chain_report = match &chain {
            Some(url) => {
                let url = url.clone();
                let mut s = std::mem::take(&mut state);
                let (s, r) = tokio::task::spawn_blocking(move || {
                    let mut p = Vec::new();
                    let r = chain_check(&mut s, &url, depth_needed, &mut p);
                    (s, r.map(|v| (v, p)))
                }).await?;
                state = s;
                match r { Ok((v, p)) => { pending = p; v } Err(e) => serde_json::json!({ "error": format!("{e:#}") }) }
            }
            None => serde_json::Value::Null,
        };
        if let Some(c) = &cursor { save_json(c, &state)?; }
        let proof_written = match a.get("proof-out") {
            Some(path) if state.first_inflation_session.is_some() || !state.unbacked.is_empty() =>
                Some(write_proof(path, &state, &keys, &kinds, carry, sessions_dir.as_deref(), &held)?),
            _ => None,
        };
        let peg_out_txids: Vec<serde_json::Value> = state.peg_outs.iter()
            .map(|(s, t, r, sats)| serde_json::json!({ "session": s, "txid": t, "recipientScript": r, "sats": sats })).collect();
        let outstanding_by_denomination: BTreeMap<String, i64> = state.denominations.iter().map(|(d, n)| (d.to_string(), *n)).collect();
        println!("{}", serde_json::json!({
            "mode": "session-audit", "federation": federation,
            "from": from, "to": to, "peers": peers.iter().map(ToString::to_string).collect::<Vec<_>>(), "parallel": parallel,
            "sessions": sessions, "verified": verified, "unverified": unverified, "failed": failed, "answeredBy": answered_by,
            "lastSession": state.next.checked_sub(1),
            "carryIssuedMsat": carry.0, "carryRedeemedMsat": carry.1, "carryFrom": carry.2,
            "cumulativeIssuedMsat": state.issued_msat, "cumulativeRedeemedMsat": state.redeemed_msat,
            "outstandingMsat": state.issued_msat as i64 - state.redeemed_msat as i64,
            "outstandingByDenomination": outstanding_by_denomination,
            "inflation": state.first_inflation_session.is_some(), "firstInflationSession": state.first_inflation_session,
            "inflationDenomination": state.inflation_denomination,
            "pegIns": state.peg_ins, "pegInsSats": state.peg_ins_sats,
            "pegOuts": state.peg_outs.len(), "pegOutsSats": state.peg_outs_sats, "pegOutFeesSats": state.peg_out_fees_sats,
            "pegOutTxids": peg_out_txids,
            "signedPegOutTxids": state.signed_peg_out_txids.keys().collect::<Vec<_>>(),
            "reserves": state.reserves.iter().map(|(op, r)| serde_json::json!({ "outpoint": op, "sats": r.sats, "session": r.session, "state": r.state })).collect::<Vec<_>>(),
            "unbackedSpend": !state.unbacked.is_empty(),
            "unbacked": state.unbacked.iter().map(|u| serde_json::json!({ "outpoint": u.outpoint, "sats": u.sats, "peginSession": u.pegin_session,
                "spender": u.spender, "height": u.height, "depth": u.depth })).collect::<Vec<_>>(),
            "pendingSpends": pending, "chain": chain_report,
            "lnv2FundedMsat": state.lnv2_funded_msat, "transactions": state.transactions, "itemsByKind": state.items_by_kind,
            "tamper": tamper_report, "proof": proof_written,
            "ms": started.elapsed().as_millis() as u64, "readMs": read_ms,
            "msPerSession": if sessions > 0 { read_ms as f64 / sessions as f64 } else { 0.0 }, "bytes": bytes_total,
        }));
        match follow {
            Some(s) => tokio::time::sleep(Duration::from_secs(s.max(1))).await,
            None => return Ok(()),
        }
    }
}

/// The same session, changed in memory: each change must fail the check.
fn tamper_check(sso: &SignedSessionOutcome, bytes: &[u8], idx: u64, keys: &BTreeMap<PeerId, PublicKey>, decoders: &ModuleDecoderRegistry) -> serde_json::Value {
    let mut fewer = sso.clone();
    if let Some(first) = fewer.signatures.keys().next().copied() { fewer.signatures.remove(&first); }
    let mut flipped = bytes.to_vec();
    let last = flipped.len() - 1;
    flipped[last] ^= 1;
    let flipped_verifies = SignedSessionOutcome::consensus_decode_whole(&flipped, decoders).map(|s| s.verify(keys, idx));
    let mut dropped = sso.clone();
    dropped.session_outcome.items.pop();
    serde_json::json!({
        "session": idx, "items": sso.session_outcome.items.len(), "signatures": sso.signatures.len(),
        "original": sso.verify(keys, idx), "oneSignatureRemoved": fewer.verify(keys, idx), "wrongIndex": sso.verify(keys, idx + 1),
        "signatureByteFlipped": match flipped_verifies { Ok(v) => serde_json::json!(v), Err(e) => serde_json::json!(format!("decode: {e}")) },
        "lastItemDropped": dropped.verify(keys, idx),
    })
}

/// THE PROOF BYTES (ruling #1109, #1065: the bytes under H(fraud_proof) are everything a checker needs, signatures included).
///   inflation  every signed session from 0 up to the mark
///   unbacked   the reserve outpoint, the spending transaction with its merkle proof, and every signed session from the
///              outpoint's creation (its peg-in, or the signed peg-out whose change it is - that transaction included) up to
///              the last session read after the spend, none of which names the spender in a PegOutSignature
/// The federation's broadcast keys and its module kinds by instance ride along, so a checker needs no client: it compares
/// the keys with the federation's config it already holds (--keys), re-verifies every session, and recomputes the mark.
#[derive(Serialize, Deserialize)]
pub struct Proof {
    pub version: u32,
    pub kind: String,
    pub federation: String,
    pub keys: BTreeMap<String, String>,
    pub modules: BTreeMap<String, String>,
    pub first_inflation_session: Option<u64>,
    pub unbacked: Option<Unbacked>,
    /// (index, consensus-encoded SignedSessionOutcome hex), contiguous
    pub sessions: Vec<(u64, String)>,
}

fn write_proof(path: &str, state: &State, keys: &BTreeMap<PeerId, PublicKey>, kinds: &BTreeMap<ModuleInstanceId, String>,
    carry: (u64, u64, u64), sessions_dir: Option<&str>, held: &BTreeMap<u64, Vec<u8>>) -> anyhow::Result<serde_json::Value> {
    let (kind, first, last, unbacked) = match (state.first_inflation_session, state.unbacked.first()) {
        (Some(s), _) => {
            if sessions_dir.is_none() && carry.2 != 0 {
                bail!("an inflation proof is every session from 0: read from 0 with --sessions-dir (this pass began at {})", carry.2)
            }
            ("inflation", 0, s, None)
        }
        (None, Some(u)) => ("unbacked", u.pegin_session, state.next - 1, Some(u.clone())),
        (None, None) => bail!("no mark"),
    };
    let mut sessions = Vec::new();
    for idx in first..=last {
        let bytes = match held.get(&idx) {
            Some(b) => b.clone(),
            None => {
                let d = sessions_dir.with_context(|| format!("session {idx} was not read in this process (give --sessions-dir)"))?;
                std::fs::read(format!("{d}/{idx}.bin")).with_context(|| format!("session {idx} is not in {d}"))?
            }
        };
        sessions.push((idx, hex(&bytes)));
    }
    let proof = Proof {
        version: 1, kind: kind.into(), federation: state.federation.clone(),
        keys: keys.iter().map(|(p, k)| (p.to_string(), k.to_string())).collect(),
        modules: kinds.iter().map(|(i, k)| (i.to_string(), k.clone())).collect(),
        first_inflation_session: state.first_inflation_session, unbacked, sessions,
    };
    save_json(path, &proof)?;
    let bytes = std::fs::read(path)?;
    let hash = fedimint_core::bitcoin::hashes::sha256::Hash::hash(&bytes);
    Ok(serde_json::json!({ "path": path, "kind": kind, "sessions": [first, last], "bytes": bytes.len(), "sha256": hash.to_string() }))
}

/// The module decoders a proof names, built from the stock common crates: no client, no config download.
fn offline_decoders(kinds: &BTreeMap<ModuleInstanceId, String>) -> ModuleDecoderRegistry {
    use fedimint_core::module::CommonModuleInit;
    ModuleDecoderRegistry::new(kinds.iter().filter_map(|(id, k)| {
        let d = match k.as_str() {
            "mintv2" => fedimint_mintv2_client::common::MintCommonInit::decoder(),
            "mint" => fedimint_mint_client::common::MintCommonInit::decoder(),
            "wallet" => fedimint_wallet_client::common::WalletCommonInit::decoder(),
            "walletv2" => fedimint_walletv2_client::common::WalletCommonInit::decoder(),
            "lnv2" => fedimint_lnv2_common::LightningCommonInit::decoder(),
            "ln" => fedimint_ln_client::common::LightningCommonInit::decoder(),
            "meta" => fedimint_meta_client::common::MetaCommonInit::decoder(),
            _ => return None,
        };
        Some((*id, fedimint_core::core::ModuleKind::clone_from_str(k), d))
    })).with_fallback()
}

/// --mode session-proof-verify --proof FILE|- [--keys JSON|@FILE]: the theft judge's check, offline (no client, no
/// guardian, no bitcoind). Every session's threshold signature re-verified against the keys (which must equal --keys
/// when given: the federation's broadcast keys from the config the checker holds), the sessions contiguous and, for
/// inflation, from 0; then the mark recomputed. One line: { ok, mark, why, ... }.
pub fn proof_verify(a: &Args) -> anyhow::Result<()> {
    let started = std::time::Instant::now();
    let src = crate::need(a, "proof")?;
    let bytes = if src == "-" { let mut b = Vec::new(); std::io::Read::read_to_end(&mut std::io::stdin(), &mut b)?; b } else { std::fs::read(src)? };
    let sha = fedimint_core::bitcoin::hashes::sha256::Hash::hash(&bytes).to_string();
    let out = |ok: bool, mark: Option<&str>, why: String, extra: serde_json::Value| {
        let mut v = serde_json::json!({ "mode": "session-proof-verify", "ok": ok, "mark": mark, "why": why, "sha256": sha,
            "bytes": bytes.len(), "ms": started.elapsed().as_millis() as u64 });
        if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) { for (k, x) in e { o.insert(k.clone(), x.clone()); } }
        println!("{v}");
    };
    let proof: Proof = match serde_json::from_slice(&bytes) { Ok(p) => p, Err(e) => { out(false, None, format!("not a proof: {e}"), serde_json::json!({})); return Ok(()); } };
    let given_keys: Option<BTreeMap<String, String>> = match a.get("keys") {
        Some(k) => Some(serde_json::from_str(&match k.strip_prefix('@') { Some(f) => std::fs::read_to_string(f)?, None => k.clone() })?),
        None => None,
    };
    if let Some(g) = &given_keys { if *g != proof.keys { out(false, None, "the proof's broadcast keys are not the federation's".into(), serde_json::json!({})); return Ok(()); } }
    let keys: BTreeMap<PeerId, PublicKey> = proof.keys.iter()
        .map(|(p, k)| Ok((PeerId::from(p.parse::<u16>()?), PublicKey::from_str(k)?))).collect::<anyhow::Result<_>>()?;
    let kinds: BTreeMap<ModuleInstanceId, String> = proof.modules.iter().map(|(i, k)| Ok((i.parse::<u16>()?, k.clone()))).collect::<anyhow::Result<_>>()?;
    let decoders = offline_decoders(&kinds);
    let first = proof.sessions.first().map(|s| s.0);
    if proof.sessions.iter().enumerate().any(|(i, (idx, _))| Some(*idx) != first.map(|f| f + i as u64)) {
        out(false, None, "the sessions are not contiguous".into(), serde_json::json!({})); return Ok(());
    }
    let mut state = State { federation: proof.federation.clone(), ..State::default() };
    for (idx, h) in &proof.sessions {
        let sso = match hex_bytes(h).map_err(|e| e.to_string()).and_then(|b| SignedSessionOutcome::consensus_decode_whole(&b, &decoders).map_err(|e| e.to_string())) {
            Ok(s) => s,
            Err(e) => { out(false, None, format!("session {idx} does not decode: {e}"), serde_json::json!({})); return Ok(()); }
        };
        if !sso.verify(&keys, *idx) { out(false, None, format!("session {idx}: the threshold signature does not verify"), serde_json::json!({})); return Ok(()); }
        state.apply(*idx, &sso, &kinds);
    }
    let base = serde_json::json!({ "federation": proof.federation, "keysGiven": given_keys.is_some(), "sessions": proof.sessions.len(),
        "firstSession": first, "lastSession": state.next.checked_sub(1) });
    match proof.kind.as_str() {
        "inflation" => {
            if first != Some(0) { out(false, None, "an inflation proof starts at session 0".into(), base); return Ok(()); }
            let mut extra = base;
            extra["issuedMsat"] = state.issued_msat.into();
            extra["redeemedMsat"] = state.redeemed_msat.into();
            extra["denomination"] = serde_json::json!(state.inflation_denomination);
            extra["recomputedSession"] = serde_json::json!(state.first_inflation_session);
            match state.first_inflation_session {
                Some(s) if Some(s) == proof.first_inflation_session && state.next == s + 1 => out(true, Some("inflation"),
                    match state.inflation_denomination {
                        Some(d) => format!("after session {s} more notes of 2^{d} msat were redeemed than issued"),
                        None => format!("after session {s} redeemed {} msat > issued {} msat", state.redeemed_msat, state.issued_msat),
                    }, extra),
                Some(s) => out(false, None, format!("the mark is at session {s}, the proof claims {:?} and ends at {:?}", proof.first_inflation_session, state.next.checked_sub(1)), extra),
                None => out(false, None, "redeemed never passes issued in these sessions".into(), extra),
            }
        }
        "unbacked" => {
            let u = proof.unbacked.as_ref().context("an unbacked proof names its spend")?;
            let tx: bitcoin::Transaction = bitcoin::consensus::deserialize(&hex_bytes(&u.tx_hex)?)?;
            let txid = tx.compute_txid();
            let op = bitcoin::OutPoint::from_str(&u.outpoint)?;
            let spends = tx.input.iter().any(|i| i.previous_output == op);
            // created in the first session: pegged in there, or the change of a peg-out signed there (its transaction carried)
            let created = match &u.creating_tx_hex {
                None => state.reserves.get(&u.outpoint).is_some_and(|r| Some(r.session) == first),
                Some(h) => {
                    let c: bitcoin::Transaction = bitcoin::consensus::deserialize(&hex_bytes(h)?)?;
                    c.compute_txid() == op.txid && (op.vout as usize) < c.output.len()
                        && state.signed_peg_out_txids.get(&op.txid.to_string()).is_some_and(|s| Some(*s) == first)
                }
            };
            let signed = state.signed_peg_out_txids.contains_key(&txid.to_string());
            let mb: bitcoin::MerkleBlock = bitcoin::consensus::deserialize(&hex_bytes(&u.txoutproof_hex)?)?;
            let (mut matches, mut index) = (Vec::new(), Vec::new());
            let in_block = mb.extract_matches(&mut matches, &mut index).is_ok()
                && matches.contains(&txid) && mb.header.block_hash().to_string() == u.block;
            let mut extra = base;
            extra["outpoint"] = u.outpoint.clone().into();
            extra["spender"] = txid.to_string().into();
            extra["block"] = u.block.clone().into();
            extra["height"] = u.height.into();
            extra["depthClaimed"] = u.depth.into();
            let why = if !spends { "the transaction does not spend the outpoint".to_owned() }
                else if !created { "the first session does not create the outpoint".to_owned() }
                else if signed { "a PegOutSignature in the sessions names the spender: a peg-out".to_owned() }
                else if !in_block { "the merkle proof does not put the spender in the named block".to_owned() }
                else if txid.to_string() != u.spender { "the spender is not the one named".to_owned() }
                else { format!("{} pegged in at session {} is spent by {} in block {} and no signed session names it", u.outpoint, u.pegin_session, txid, u.block) };
            let ok = spends && created && !signed && in_block && txid.to_string() == u.spender;
            out(ok, ok.then_some("unbacked"), why, extra);
        }
        other => out(false, None, format!("no proof kind {other}"), base),
    }
    Ok(())
}

/// THE CONSENSUS BLOCK COUNT THE SESSIONS AGREE, as the wallet module computes it (wallet-server consensus_block_count):
/// each peer's highest BlockCount vote, missing ones as 0, sorted, the one at total/2.
fn agreed_block_count(votes: &BTreeMap<PeerId, u32>, peers: usize) -> u32 {
    let mut counts: Vec<u32> = votes.values().copied().collect();
    while counts.len() < peers { counts.push(0); }
    counts.sort_unstable();
    counts.get(peers / 2).copied().unwrap_or(0)
}

/// --mode theft-verify (packages/arena-protocol/src/theft-slash.js, SESSION VERIFIER): stdin one JSON object
/// { federationId, config (hex, the client config's consensus bytes), firstSession, sessions: [hex], spendTxid?, reserve? };
/// reads no guardian, no client and no chain. Each session is verified at its index against the config's broadcast keys and
/// decoded with the stock common crates of the config's modules; one JSON line back (see theft-slash.js).
///
/// NOTE what federationMatches binds: Fedimint's federation id is the hash of the config's API endpoints
/// (GlobalClientConfig::calculate_federation_id), not of its broadcast keys - so a config that names the same endpoints with
/// other keys has the same id. The line also gives broadcastKeysHash and configHash for a caller that holds either.
pub fn theft_verify() -> anyhow::Result<()> {
    use fedimint_core::config::ClientConfig;
    use fedimint_core::encoding::Encodable as _;
    let started = std::time::Instant::now();
    let mut raw = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut raw)?;
    let input: serde_json::Value = serde_json::from_str(&raw).context("stdin is no JSON object")?;
    let s = |k: &str| input.get(k).and_then(|v| v.as_str()).map(str::to_owned);
    let fail = |why: String| -> anyhow::Result<()> { println!("{}", serde_json::json!({ "mode": "theft-verify", "ok": false, "why": why, "federationMatches": false })); Ok(()) };
    let Some(config_hex) = s("config") else { return fail("no config".into()) };
    let config = match hex_bytes(&config_hex).map_err(|e| e.to_string()).and_then(|b|
        ClientConfig::consensus_decode_whole(&b, &ModuleDecoderRegistry::default().with_fallback()).map_err(|e| e.to_string())) {
        Ok(c) => c,
        Err(e) => return fail(format!("the config does not decode: {e}")),
    };
    let federation = config.calculate_federation_id().to_string();
    let federation_matches = s("federationId").is_some_and(|f| f.eq_ignore_ascii_case(&federation));
    let Some(keys) = config.global.broadcast_public_keys.clone() else { return fail("the config names no broadcast keys".into()) };
    let kinds: BTreeMap<ModuleInstanceId, String> = config.modules.iter().map(|(id, m)| (*id, m.kind.to_string())).collect();
    let decoders = offline_decoders(&kinds);
    let first = input.get("firstSession").and_then(serde_json::Value::as_u64).context("no firstSession")?;
    let sessions: Vec<String> = input.get("sessions").and_then(|v| v.as_array()).context("no sessions")?
        .iter().map(|v| v.as_str().map(str::to_owned).context("a session is not hex")).collect::<anyhow::Result<_>>()?;
    let reserve = s("reserve").map(|r| bitcoin::OutPoint::from_str(&r)).transpose()?;
    let wallet = kinds.iter().find(|(_, k)| k.as_str() == "wallet").map(|(id, _)| *id);
    let mut state = State { federation: federation.clone(), next: first, ..State::default() };
    let (mut verified, mut unverified, mut bytes) = (0u64, Vec::<u64>::new(), 0u64);
    let mut votes: BTreeMap<PeerId, u32> = BTreeMap::new();
    let mut created_at: Option<u64> = None;
    for (i, h) in sessions.iter().enumerate() {
        let idx = first + i as u64;
        let sso = match hex_bytes(h).ok().and_then(|b| { bytes += b.len() as u64; SignedSessionOutcome::consensus_decode_whole(&b, &decoders).ok() }) {
            Some(sso) if sso.verify(&keys, idx) => sso,
            _ => { unverified.push(idx); continue; }
        };
        verified += 1;
        state.apply(idx, &sso, &kinds);
        for item in &sso.session_outcome.items {
            match &item.item {
                ConsensusItem::Module(m) if Some(m.module_instance_id()) == wallet => {
                    match m.as_any().downcast_ref::<fedimint_wallet_client::WalletConsensusItem>() {
                        Some(fedimint_wallet_client::WalletConsensusItem::BlockCount(c)) => {
                            let v = votes.entry(item.peer).or_default();
                            *v = (*v).max(*c);
                        }
                        Some(fedimint_wallet_client::WalletConsensusItem::PegOutSignature(p)) =>
                            if reserve.is_some_and(|r| r.txid == p.txid) && created_at.is_none() { created_at = Some(idx); },
                        _ => {}
                    }
                }
                ConsensusItem::Transaction(tx) if created_at.is_none() => {
                    if let Some(r) = reserve {
                        for i in &tx.inputs {
                            if let Some(fedimint_wallet_client::WalletInput::V0(p)) = i.as_any().downcast_ref::<fedimint_wallet_client::WalletInput>() {
                                if p.0.outpoint() == r { created_at = Some(idx); }
                            }
                            if let Some(fedimint_wallet_client::WalletInput::V1(v)) = i.as_any().downcast_ref::<fedimint_wallet_client::WalletInput>() {
                                if v.outpoint == r { created_at = Some(idx); }
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    let count = agreed_block_count(&votes, keys.len());
    let spend_named = s("spendTxid").map(|t| state.signed_peg_out_txids.contains_key(&t.to_lowercase()));
    println!("{}", serde_json::json!({
        "mode": "theft-verify", "federationMatches": federation_matches, "federation": federation,
        "broadcastKeysHash": keys.consensus_hash_sha256().to_string(), "configHash": config.consensus_hash_sha256().to_string(),
        "sessions": sessions.len(), "verified": verified, "unverified": unverified,
        "firstSession": first, "lastSession": (first + sessions.len() as u64).checked_sub(1).filter(|_| !sessions.is_empty()),
        "firstInflationSession": state.first_inflation_session, "inflationDenomination": state.inflation_denomination,
        "cumulativeIssuedMsat": state.issued_msat, "cumulativeRedeemedMsat": state.redeemed_msat,
        "signedPegOutTxids": state.signed_peg_out_txids.keys().collect::<Vec<_>>(),
        "spendNamedBySignedHistory": spend_named,
        "outpointCreatedAt": created_at,
        "consensusBlockCount": count, "coversHeight": count.checked_sub(1),
        "bytes": bytes, "ms": started.elapsed().as_millis() as u64,
    }));
    Ok(())
}

/// --mode session-export --data-dir D --from N --to M --out F [--peer ID]: the client config's consensus bytes and the signed
/// sessions from..=to, as theft-verify reads them on stdin (the bytes a theft proof carries).
pub async fn session_export(a: &Args, client: &ClientHandle) -> anyhow::Result<()> {
    use fedimint_core::encoding::Encodable as _;
    let started = std::time::Instant::now();
    let (_, keys) = federation_view(client).await;
    let peers: Vec<PeerId> = match a.get("peer") { Some(p) => vec![PeerId::from(p.parse::<u16>()?)], None => keys.keys().copied().collect() };
    let from: u64 = a.get("from").map_or(Ok(0), |v| v.parse::<u64>())?;
    let last = client.fetch_session_count().await.map_err(|e| anyhow!("no session count: {e}"))?.checked_sub(1).context("no finished session")?;
    let to: u64 = a.get("to").map_or(Ok(last), |v| v.parse::<u64>())?.min(last);
    if to < from { bail!("--to {to} is before --from {from}") }
    let api = client.api_clone();
    let mut sessions = Vec::new();
    let mut next = from;
    while next <= to {
        let end = (next + 7).min(to);
        let mut set = tokio::task::JoinSet::new();
        for idx in next..=end { set.spawn(fetch(api.clone(), peers.clone(), idx)); }
        let mut got = BTreeMap::new();
        while let Some(r) = set.join_next().await { let (idx, r) = r?; got.insert(idx, r.map_err(|e| anyhow!("session {idx}: {e}"))?.1); }
        sessions.extend(got.into_values().map(|b| hex(&b)));
        next = end + 1;
    }
    let out = serde_json::json!({ "federationId": client.federation_id().to_string(),
        "config": hex(&client.config().await.consensus_encode_to_vec()), "firstSession": from, "sessions": sessions });
    let path = need_out(a)?;
    save_json(&path, &out)?;
    println!("{}", serde_json::json!({ "mode": "session-export", "out": path, "from": from, "to": to,
        "bytes": std::fs::metadata(&path)?.len(), "ms": started.elapsed().as_millis() as u64 }));
    Ok(())
}

fn need_out(a: &Args) -> anyhow::Result<String> { Ok(crate::need(a, "out")?.to_owned()) }
