-- WHO MARKED A KEY (audit 6, kanban #1420): a mark made by address (POST /api/mark-ip) names the address, so it can be found and undone; a mark with the
-- admin code or a bot's has none
ALTER TABLE marked ADD COLUMN by_ip TEXT;
