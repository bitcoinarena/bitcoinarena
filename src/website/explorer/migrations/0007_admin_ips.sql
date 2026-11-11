-- THE ADDRESSES THE ADMIN PLAYS FROM (kanban #1414, Daniel 2026-11-10: "Wenn ich einen anonymen browser aufmache von einer IP die davor einen admin key
-- hatte müssen wir das auch erkennen und ihn als admin flaggen obwohl die session neu ist"): each address (an IPv6 address by its /64) that sent a mark
-- with the admin code, and when it last did; a browser from one of them is the admin's, a fresh session too
CREATE TABLE IF NOT EXISTS admin_ips (ip TEXT PRIMARY KEY, at_ms INTEGER NOT NULL);
