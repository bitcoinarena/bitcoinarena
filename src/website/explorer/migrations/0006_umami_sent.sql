-- kanban #1110: what the explorer told Umami - each real entry ('e:' + its id) and each round with a real player ('r:' + the round) once
CREATE TABLE IF NOT EXISTS umami_sent (key TEXT PRIMARY KEY, at_ms INTEGER NOT NULL);
