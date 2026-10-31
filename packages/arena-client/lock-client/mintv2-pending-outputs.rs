
// BLWP (spec 23A.5 "Notes still in issuance at the halt", RULED 2026-10-14): every output the consensus issued to
// this wallet's seed - the recovery items of ONE answering guardian, scanned as `recover` scans them - that is neither held as a
// note nor spent, each with its consensus-encoded issuance request: the secret of a pending-output claim. Appended to
// fedimint-mintv2-client/src/lib.rs by blwp-lock-client's build-wasm.sh; the fork's CLI `mintv2 pending-outputs` is the same scan.
impl MintClientModule {
    pub async fn blwp_pending_outputs(&self) -> anyhow::Result<Vec<(fedimint_core::secp256k1::PublicKey, Amount, String)>> {
        use fedimint_core::encoding::Encodable as _;
        use futures::StreamExt as _;
        let api = self.client_ctx.module_api();
        // IN PAGES (kanban #910): the whole list in one answer is refused, "Response is too big", on federations A and B
        const PAGE: u64 = 5000;
        let mut items = Vec::new();
        loop {
            let (start, mut page, mut said) = (items.len() as u64, None, Vec::new());
            for peer in self.client_ctx.global_api().all_peers().iter().copied() {
                match api.fetch_recovery_slice(peer, Duration::from_secs(20), start, start + PAGE).await {
                    Ok(v) => { page = Some(v); break; }
                    Err(e) => said.push(format!("{peer}: {e}")),
                }
            }
            let page = page.ok_or_else(|| anyhow!("no guardian served its recovery items: {}", said.join("; ")))?;
            let last = (page.len() as u64) < PAGE;
            items.extend(page);
            if last { break; }
        }
        let filter = issuance::tweak_filter(&self.root_secret);
        let mut requests: BTreeMap<bitcoin_hashes::hash160::Hash, NoteIssuanceRequest> = BTreeMap::new();
        for item in items {
            match item {
                RecoveryItem::Output { denomination, nonce_hash, tweak } => {
                    if !issuance::check_tweak(tweak, filter) { continue; }
                    let secret = issuance::output_secret(denomination, tweak, &self.root_secret);
                    if !issuance::check_nonce(&secret, nonce_hash) { continue; }
                    let h = issuance::nonce(&secret).consensus_hash::<bitcoin_hashes::hash160::Hash>();
                    requests.insert(h, NoteIssuanceRequest::new(denomination, tweak, &self.root_secret));
                }
                RecoveryItem::Input { nonce_hash } => { requests.remove(&nonce_hash); }
            }
        }
        let held: BTreeSet<bitcoin_hashes::hash160::Hash> = {
            let mut dbtx = self.client_ctx.module_db().begin_transaction_nc().await;
            dbtx.find_by_prefix(&SpendableNotePrefix).await
                .map(|(k, ())| k.0.keypair.public_key().consensus_hash::<bitcoin_hashes::hash160::Hash>())
                .collect::<BTreeSet<_>>().await
        };
        Ok(requests.into_iter().filter(|(h, _)| !held.contains(h))
            .map(|(_, r)| (r.keypair.public_key(), r.denomination.amount(), r.consensus_encode_to_hex())).collect())
    }
}
