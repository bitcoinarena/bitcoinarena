-- MARKS FOR ENTRIES NOT HERE YET (kanban #1466, Daniel 2026-11-11: "fix it in code so it won't happen again"): an entry id an admin address sent before the
-- explorer's next read held it - a test browser that closed within the minute - kept here and marked when the entry arrives (applyPendingMarks), for 2 days
CREATE TABLE IF NOT EXISTS mark_pending (key TEXT PRIMARY KEY, kind TEXT NOT NULL, at_ms INTEGER NOT NULL, by_ip TEXT);
