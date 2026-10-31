    /// THE DEPOSITS THIS CLIENT'S DATABASE LOST (kanban #883): a batch of the federation's incoming contracts from
    /// `start`, each tried against this client's own key, and a receive begun for every one it can open. A client whose
    /// storage refused the write has no operation for a deposit it was paid: the contract stands, and only its key opens it.
    /// Idempotent: an operation already there is left. Answers (next index, whether the stream was read to its end, found).
    pub async fn scan_receives(&self, start: u64, n: usize) -> (u64, bool, Vec<(OperationId, Amount)>) {
        let (contracts, next) = self.module_api.await_incoming_contracts(start, n).await;
        let mut found = Vec::new();
        for contract in &contracts {
            if self.recover_contract_keys(self.keypair.secret_key(), contract).is_none() {
                continue;
            }
            let meta = LightningOperationMeta::LnurlReceive(LnurlReceiveOperationMeta {
                contract: contract.clone(),
                custom_meta: Value::Null,
            });
            if let Some(op) = self.receive_incoming_contract(self.keypair.secret_key(), contract.clone(), meta).await {
                found.push((op, contract.commitment.amount));
            }
        }
        (next, contracts.len() < n, found)
    }

