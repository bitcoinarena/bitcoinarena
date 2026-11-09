
// BLWP kanban #1391 (Daniel 2026-11-09: "Yes fork it"): a new wallet's first locks waited 18-37 s for change-note tweaks - the grinder
// above runs on the page's one wasm thread, about one tweak a second, and a lock takes 7-22. The page grinds more in Web Workers, on every
// core, and hands them in here. Each one is checked against this wallet's filter exactly as the grinder's own (check_tweak), so a
// tweak from outside is never one the recovery scan would not find; one that does not pass is dropped, and the queue's bound holds.
impl MintClientModule {
    /// The 32 bytes a tweak is checked against: SHA-256(tweak || filter) starting with two zero bytes.
    pub fn blwp_tweak_filter(&self) -> [u8; 32] {
        issuance::tweak_filter(&self.root_secret)
    }

    /// Tweaks ground elsewhere into the queue; answers how many were taken (checked and room for them).
    pub fn blwp_add_tweaks(&self, tweaks: &[[u8; 16]]) -> usize {
        let filter = issuance::tweak_filter(&self.root_secret);
        let mut taken = 0;
        for t in tweaks {
            if issuance::check_tweak(*t, filter) && self.blwp_tweak_sender.try_send(*t).is_ok() {
                taken += 1;
            }
        }
        taken
    }
}
