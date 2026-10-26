-- THE EXPLORER'S OWN STATE IN D1, NOT KV (2026-10-26, Cloudflare: "You have exceeded the daily Workers KV free tier limit of 1,000 put
-- operations"; the owner: build it): the walks' positions and the kept figures were written every minute (up to ~3,200 KV puts a day).
-- D1's free tier takes 100,000 writes a day. One row per key; the Health copy (~0.9 MB, pushed from a machine of ours) stays in KV.
CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
