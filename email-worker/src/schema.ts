const REQUIRED_MIGRATION = '0022_mailbox_public_links.sql'
const schemaChecks = new WeakMap<D1Database, Promise<void>>()

const WRANGLER_MIGRATION_NAMES = [
  '0001_initial.sql',
  '0002_domains.sql',
  '0003_temporary_invites.sql',
  '0004_device_sessions.sql',
  '0005_audit_log_index.sql',
  '0006_external_registration.sql',
  '0007_registration_security.sql',
  '0008_storage_policy.sql',
  '0009_mail_operations.sql',
  '0010_account_invites.sql',
  '0011_unassigned_mail.sql',
  '0012_mail_safety.sql',
  '0013_mail_features.sql',
  '0014_outbound_rate_limits.sql',
  '0015_message_translations.sql',
  '0016_translation_permissions.sql',
  '0017_multiple_drafts.sql',
  '0018_schema_baseline_and_message_indexes.sql',
  '0019_extension_authorization.sql',
  '0020_device_token_scopes.sql',
  '0021_icloud_accounts.sql',
  REQUIRED_MIGRATION,
] as const

const LEGACY_BASELINES: Record<string, number> = {
  '2026-07-29-p5-outbound-rate-limit-admin': 14,
  '2026-08-01-p2-translation-permissions': 16,
  '2026-08-03-p3-multiple-drafts': 17,
}

const RECOVERABLE_MIGRATIONS = [
  {
    name: '0015_message_translations.sql',
    statements: [
      `CREATE TABLE IF NOT EXISTS message_translations (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        target_language TEXT NOT NULL,
        source_language TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        r2_key TEXT NOT NULL UNIQUE,
        size INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (message_id, target_language)
      )`,
      `CREATE TABLE IF NOT EXISTS translation_rate_limits (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        window_started_at INTEGER NOT NULL,
        request_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    name: '0016_translation_permissions.sql',
    statements: [
      `ALTER TABLE users
       ADD COLUMN can_translate INTEGER NOT NULL DEFAULT 1
       CHECK (can_translate IN (0, 1))`,
      `ALTER TABLE temporary_invites
       ADD COLUMN can_translate INTEGER NOT NULL DEFAULT 1
       CHECK (can_translate IN (0, 1))`,
    ],
  },
  {
    name: '0017_multiple_drafts.sql',
    statements: [
      `CREATE TABLE IF NOT EXISTS mail_drafts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mailbox_address TEXT NOT NULL COLLATE NOCASE
          REFERENCES mailboxes(address) ON DELETE CASCADE,
        recipient_address TEXT NOT NULL DEFAULT '',
        subject TEXT NOT NULL DEFAULT '',
        body_text TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_mail_drafts_user_updated
       ON mail_drafts(user_id, updated_at DESC, id DESC)`,
      `INSERT OR IGNORE INTO mail_drafts (
        id, user_id, mailbox_address, recipient_address, subject, body_text,
        created_at, updated_at
      )
      SELECT 'legacy:' || user_id, user_id, mailbox_address, recipient_address,
             subject, body_text, updated_at * 1000, updated_at * 1000
        FROM drafts`,
      `CREATE TABLE IF NOT EXISTS mail_draft_attachments (
        id TEXT PRIMARY KEY,
        draft_id TEXT NOT NULL REFERENCES mail_drafts(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size > 0),
        r2_key TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_mail_draft_attachments_draft
       ON mail_draft_attachments(draft_id, created_at, id)`,
      `INSERT OR IGNORE INTO mail_draft_attachments (
        id, draft_id, filename, content_type, size, r2_key, created_at
      )
      SELECT id, 'legacy:' || user_id, filename, content_type, size, r2_key,
             created_at * 1000
        FROM draft_attachments`,
      'DROP TABLE draft_attachments',
      'DROP TABLE drafts',
    ],
  },
  {
    name: '0018_schema_baseline_and_message_indexes.sql',
    statements: [
      `CREATE TABLE IF NOT EXISTS oauth_identities (
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        avatar_url TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (provider, subject),
        UNIQUE (provider, user_id)
      )`,
      'CREATE INDEX IF NOT EXISTS idx_oauth_identities_user ON oauth_identities(user_id)',
      `CREATE TABLE IF NOT EXISTS admin_totp (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        encrypted_secret TEXT NOT NULL,
        enabled_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL UNIQUE,
        used_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE INDEX IF NOT EXISTS idx_mfa_recovery_user
       ON mfa_recovery_codes(user_id, used_at)`,
      `CREATE TABLE IF NOT EXISTS mfa_challenges (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel TEXT NOT NULL CHECK (channel IN ('browser', 'linuxdo')),
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE INDEX IF NOT EXISTS idx_mfa_challenges_expiry
       ON mfa_challenges(expires_at)`,
      `CREATE TABLE IF NOT EXISTS resend_webhook_events (
        event_id TEXT PRIMARY KEY,
        message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE INDEX IF NOT EXISTS idx_resend_webhook_events_created
       ON resend_webhook_events(created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_resend_webhook_events_provider
       ON resend_webhook_events(provider_id, created_at DESC)`,
      'DROP TRIGGER IF EXISTS trg_messages_mail_state_update',
      `CREATE TRIGGER trg_messages_mail_state_update
       AFTER UPDATE OF status, folder, sender_name, sender_address, subject, preview,
         received_at, sent_at, attachment_count, is_read, is_starred, processing_error,
         delivery_status
       ON messages BEGIN
         INSERT INTO mail_state_versions (user_id, version, updated_at)
         SELECT mb.user_id, 1, unixepoch() FROM mailboxes mb
          WHERE mb.address = NEW.mailbox_address
         ON CONFLICT(user_id) DO UPDATE SET
           version = mail_state_versions.version + 1,
           updated_at = excluded.updated_at;
       END`,
      `ALTER TABLE messages ADD COLUMN sort_at INTEGER
       GENERATED ALWAYS AS (COALESCE(received_at, sent_at, created_at)) VIRTUAL`,
      `CREATE INDEX IF NOT EXISTS idx_messages_folder_sort
       ON messages(folder, sort_at DESC, id DESC, direction, mailbox_address)`,
      `CREATE INDEX IF NOT EXISTS idx_messages_starred_sort
       ON messages(is_starred, sort_at DESC, id DESC, folder, mailbox_address)`,
      `INSERT OR IGNORE INTO settings (key, value, updated_at)
       VALUES ('backup_database_identity', lower(hex(randomblob(16))), unixepoch())`,
      "DELETE FROM settings WHERE key = 'schema_version'",
      'PRAGMA optimize',
    ],
  },
  {
    name: '0019_extension_authorization.sql',
    statements: [
      `CREATE TABLE extension_authorization_codes (
        code_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE INDEX idx_extension_authorization_expiry
       ON extension_authorization_codes(expires_at, used_at)`,
    ],
  },
  {
    name: '0020_device_token_scopes.sql',
    statements: [
      "ALTER TABLE device_sessions ADD COLUMN scopes TEXT NOT NULL DEFAULT '*'",
    ],
  },
  {
    name: '0021_icloud_accounts.sql',
    statements: [
      `CREATE TABLE IF NOT EXISTS icloud_accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        real_email TEXT NOT NULL DEFAULT '',
        icloud_email TEXT NOT NULL DEFAULT '',
        cookies_cipher TEXT NOT NULL DEFAULT '',
        host TEXT NOT NULL DEFAULT 'icloud.com'
          CHECK (host IN ('icloud.com', 'icloud.com.cn')),
        app_password_cipher TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('active', 'pending', 'error')),
        alias_total INTEGER NOT NULL DEFAULT 0 CHECK (alias_total >= 0),
        alias_active INTEGER NOT NULL DEFAULT 0 CHECK (alias_active >= 0),
        last_validated TEXT NOT NULL DEFAULT '',
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_icloud_accounts_user
       ON icloud_accounts(user_id, created_at)`,
    ],
  },
  {
    name: REQUIRED_MIGRATION,
    statements: [
      `CREATE TABLE mailbox_public_links (
        mailbox_address TEXT PRIMARY KEY COLLATE NOCASE
          REFERENCES mailboxes(address) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`,
      `CREATE UNIQUE INDEX idx_mailbox_public_links_token
       ON mailbox_public_links(token_hash)`,
      `CREATE TABLE public_mail_rate_limits (
        token_hash TEXT PRIMARY KEY,
        window_started_at INTEGER NOT NULL,
        request_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE INDEX idx_public_mail_rate_limits_updated
       ON public_mail_rate_limits(updated_at)`,
    ],
  },
] as const

function migrationTableExists(db: D1Database) {
  return db.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations' LIMIT 1",
  ).first<{ found: number }>()
}

function appliedMigration(db: D1Database, name: string) {
  return db.prepare(
    'SELECT 1 AS applied FROM d1_migrations WHERE name = ? LIMIT 1',
  ).bind(name).first<{ applied: number }>()
}

function migrationError(cause?: unknown, migration = REQUIRED_MIGRATION): Error {
  const detail = cause instanceof Error && cause.message ? ` ${cause.message}` : ''
  return new Error(
    `D1 数据库迁移未完成，请在部署前运行 npm run db:migrate。`
      + ` 缺少迁移：${migration}。${detail}`,
  )
}

async function bootstrapLegacyMigrations(db: D1Database): Promise<void> {
  const hasMigrationTable = Boolean(await migrationTableExists(db))

  let legacyVersion: string | undefined
  try {
    legacyVersion = (await db.prepare(
      "SELECT value FROM settings WHERE key = 'schema_version' LIMIT 1",
    ).first<{ value: string }>())?.value
  } catch (error) {
    if (hasMigrationTable || await migrationTableExists(db)) return
    throw migrationError(error)
  }

  if (!legacyVersion && hasMigrationTable) return

  const baseline = legacyVersion ? LEGACY_BASELINES[legacyVersion] : undefined
  if (!baseline) {
    if (!hasMigrationTable && await migrationTableExists(db)) return
    throw migrationError(new Error(
      `无法识别旧版数据库结构标记：${legacyVersion ?? '缺失'}`,
    ))
  }

  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`),
    ...WRANGLER_MIGRATION_NAMES.slice(0, baseline).map((name) => (
      db.prepare(
        `INSERT INTO d1_migrations (name)
         SELECT ? WHERE NOT EXISTS (
           SELECT 1 FROM d1_migrations WHERE name = ?
         )`,
      ).bind(name, name)
    )),
  ])
}

async function applyRecoverableMigration(
  db: D1Database,
  migration: typeof RECOVERABLE_MIGRATIONS[number],
): Promise<void> {
  if (await appliedMigration(db, migration.name)) return

  if (migration.name === '0020_device_token_scopes.sql') {
    const column = await db.prepare(
      "SELECT 1 AS present FROM pragma_table_info('device_sessions') WHERE name = 'scopes' LIMIT 1",
    ).first<{ present: number }>()
    if (column?.present === 1) {
      await recordMigration(db, migration.name).run()
      return
    }
  }

  try {
    await db.batch([
      ...migration.statements.map((sql) => db.prepare(sql)),
      recordMigration(db, migration.name),
    ])
  } catch (error) {
    // Another isolate may have completed the migration after our first check.
    if (await appliedMigration(db, migration.name)) return
    throw error
  }
}

function recordMigration(db: D1Database, migration: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO d1_migrations (name)
     SELECT ? WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ?)`,
  ).bind(migration, migration)
}

async function ensureRequiredMigrations(db: D1Database): Promise<void> {
  await bootstrapLegacyMigrations(db)
  for (const migration of RECOVERABLE_MIGRATIONS) {
    try {
      await applyRecoverableMigration(db, migration)
    } catch (error) {
      throw migrationError(error, migration.name)
    }
  }
}

export function ensureSchema(db: D1Database): Promise<void> {
  const current = schemaChecks.get(db)
  if (current) return current

  const check = ensureRequiredMigrations(db)
  schemaChecks.set(db, check)
  check.catch(() => {
    if (schemaChecks.get(db) === check) schemaChecks.delete(db)
  })
  return check
}
