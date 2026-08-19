CREATE TABLE mailbox_public_links (
  mailbox_address TEXT PRIMARY KEY COLLATE NOCASE
    REFERENCES mailboxes(address) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX idx_mailbox_public_links_token
  ON mailbox_public_links(token_hash);

CREATE TABLE public_mail_rate_limits (
  token_hash TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_public_mail_rate_limits_updated
  ON public_mail_rate_limits(updated_at);
