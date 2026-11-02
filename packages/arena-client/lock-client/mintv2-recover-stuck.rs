
// BLWP (kanban #910, "95 sat arriving" for hours on an iPhone whose store had been full): ends the output machines stuck on a transaction -
// mintv2-stuck-output.txt asks the federation for each, a known one goes on to its signatures, an unknown one aborts - then re-issues
// what mintv2's own recovery scan says this seed was issued and neither holds nor has spent, as `recover` does (a machine with no range).
// What a machine still pending will finish itself is left out; a restore's machine still running means nothing is added.
// Appended to fedimint-mintv2-client/src/lib.rs by blwp-lock-client's build-wasm.sh.
pub(crate) static BLWP_GIVEN_UP: std::sync::Mutex<BTreeSet<fedimint_core::TransactionId>> = std::sync::Mutex::new(BTreeSet::new());

impl MintClientModule {
    pub async fn blwp_recover_stuck(&self) -> anyhow::Result<(usize, Amount)> {
        use fedimint_core::encoding::Decodable as _;
        let pending = || async {
            self.client_ctx.get_own_active_states().await.into_iter()
                .filter_map(|(s, _)| match s {
                    MintClientStateMachines::Output(m) if matches!(m.state, crate::output::OutputSMState::Pending) => Some(m),
                    _ => None,
                }).collect::<Vec<_>>()
        };
        let named: Vec<_> = pending().await.into_iter().filter_map(|m| m.common.range.map(|r| r.txid)).collect();
        BLWP_GIVEN_UP.lock().unwrap().extend(named.iter().copied());
        for _ in 0..16 {
            if !pending().await.iter().any(|m| m.common.range.is_some_and(|r| named.contains(&r.txid))) { break; }
            fedimint_core::runtime::sleep(Duration::from_secs(2)).await;
        }
        let still = pending().await;
        if still.iter().any(|m| m.common.range.is_none()) { return Ok((named.len(), Amount::ZERO)); }
        let busy: BTreeSet<_> = still.iter().flat_map(|m| m.common.issuance_requests.iter().map(|r| r.keypair.public_key())).collect();
        let mut requests = Vec::new();
        for (key, _, hex) in self.blwp_pending_outputs().await? {
            if busy.contains(&key) { continue; }
            requests.push(NoteIssuanceRequest::consensus_decode_hex(&hex, &Default::default())?);
        }
        let amount = requests.iter().map(|r| r.denomination.amount()).sum::<Amount>();
        if requests.is_empty() { return Ok((named.len(), Amount::ZERO)); }
        let machines = self.client_ctx.map_dyn(vec![MintClientStateMachines::Output(MintOutputStateMachine {
            common: OutputSMCommon { operation_id: OperationId::new_random(), range: None, issuance_requests: requests },
            state: OutputSMState::Pending,
        })]).collect();
        let mut dbtx = self.client_ctx.module_db().begin_transaction().await;
        self.client_ctx.add_state_machines_dbtx(&mut dbtx.to_ref_nc(), machines).await.map_err(|e| anyhow!("{e:?}"))?;
        dbtx.commit_tx().await;
        Ok((named.len(), amount))
    }
}
