
// BLWP (kanban #908, "95 arriving", unchanged for hours): each output state machine still Pending, with the transaction it waits on and
// whether the federation has accepted that transaction - asked now, for at most 12 s each. Accepted: the guardians' signatures are what is
// outstanding. Not accepted long after it was sent: the federation does not know it, and await_tx_accepted in the machine waits for ever.
// No transaction: a restore's re-issue. Appended to fedimint-mintv2-client/src/lib.rs by blwp-lock-client's build-wasm.sh.
impl MintClientModule {
    pub async fn blwp_issuing_detail(&self) -> Vec<(Option<String>, Amount, bool)> {
        use fedimint_api_client::api::IGlobalFederationApi as _;
        let mut out = Vec::new();
        for (s, _) in self.client_ctx.get_own_active_states().await {
            let MintClientStateMachines::Output(m) = s else { continue };
            if !matches!(m.state, crate::output::OutputSMState::Pending) { continue; }
            let msat = m.common.issuance_requests.iter().map(|r| r.denomination.amount()).sum::<Amount>();
            let txid = m.common.range.map(|r| r.txid);
            let accepted = match txid {
                Some(t) => fedimint_core::runtime::timeout(Duration::from_secs(12), self.client_ctx.global_api().await_transaction(t)).await.is_ok(),
                None => false,
            };
            out.push((txid.map(|t| t.to_string()), msat, accepted));
        }
        out
    }
}
