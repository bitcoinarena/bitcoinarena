# The state machine audit: a release gate

Daniel, 2026-11-06 (kanban #1205): "Füege diesen implizieren state machine test vor jedem Release ein. Alle auftretenden Bugs muessen davor gefixt werden."

**No release is tagged before this audit has run on its commit and every finding it reports is fixed.**
A finding that only a protocol release can fix is not skipped quietly: it goes to Daniel for a ruling, and the release waits for that ruling.

## The audit

Run on the release commit, over every package that ships (`packages/arena-node`, `arena-protocol`, `arena-client`, `arena-web`, `arena-sdk`, `arena-installer`, `arena-attestor`, `arena-donor`):

> Find the app's explicit and implicit state machines and document their states, invariants, and transition tables in one file.
> Identify invalid states or transitions the code can actually reach, with evidence, including through retries and concurrency.
> Prioritize confirmed bugs by impact, group related fixes into issues, then fix them with regression tests.

- **The one file** is `docs/STATE-MACHINES.md`. The audit brings it up to date with the commit: new state machines added, changed ones rewritten, removed ones deleted.
- **Implicit** state machines count as much as explicit ones. These are a status column, a nullable field meaning "done", an in-memory map or set used as a guard, a file on disk, or an "already paid" check.
- **The paths to try:** a crash between two writes, or between an external effect (payment, broadcast, signature, e-cash send) and its record; retries and re-sends; two concurrent requests (each `await` is an interleaving point); an unauthenticated door that moves a state; a reorg; a restart that loses an in-memory guard; two seats that disagree; a timer firing after the state moved on.
- **Evidence:** a finding names `file:line`, the sequence of events and the bad state reached, and a regression test fails before its fix.
- **No duplicates:** every finding is checked against the earlier audits' tickets (#1148-#1194, #1204 and later). One that only restates an open ticket goes on that ticket.

## The gate

1. Run the audit on the release commit (the scope above, on every line the release ships from).
2. File each confirmed new finding as a ticket ("State machine (area, severity): …"), grouped by fix.
3. Fix every one with a regression test. Deploy to the seats and merge, as for any ticket.
4. Re-run the audit's checks on the fixed commit. The release is built from that commit.
5. The release card carries the result: the commit audited, the findings and their tickets, and that each is fixed.

This comes before the other release gates (games must settle live, test the package before the tag); it does not replace them.
