// BLWP (the join that never started): the e-cash this wallet is being issued right now - the denominations of every
// output state machine still Pending (waiting for the guardians' blind signatures). A recovered wallet's notes are re-issued by
// one such machine AFTER `recover` returns, a deposit's notes by another after its claim, a payment's change by a third; until
// each finishes, the balance does not count them. Measured on a page (pinned seed 6b360bd8, a fresh profile): the balance read
// 0 sat for minutes while the wallet held 3000, and a deposit "Claimed" at 78 s still read 0 - a quote in that window called a
// funded wallet "insufficient". Appended to fedimint-mintv2-client/src/lib.rs by blwp-lock-client's build-wasm.sh.
impl MintClientModule {
    pub async fn blwp_issuing_msat(&self) -> Amount {
        self.client_ctx.get_own_active_states().await.into_iter()
            .filter_map(|(s, _)| match s {
                MintClientStateMachines::Output(m) if matches!(m.state, crate::output::OutputSMState::Pending) =>
                    Some(m.common.issuance_requests.iter().map(|r| r.denomination.amount()).sum::<Amount>()),
                _ => None,
            })
            .sum()
    }
}
