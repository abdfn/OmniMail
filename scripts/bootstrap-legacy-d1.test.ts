import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bootstrap = readFileSync(join(root, 'scripts/bootstrap-legacy-d1.sql'), 'utf8')
const migrationNames = readdirSync(join(root, 'migrations'))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort()

function applyMigrations(db: DatabaseSync, firstPosition: number): void {
  const sql = migrationNames.slice(firstPosition - 1).map((name) => {
    const migration = readFileSync(join(root, 'migrations', name), 'utf8').trimEnd()
    return `${migration}\nINSERT INTO d1_migrations (name) VALUES ('${name}');`
  }).join('\n\n')
  db.exec(sql)
}

function legacyDatabase(position: number, version: string): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (let current = 1; current <= position; current += 1) {
    db.exec(readFileSync(join(root, 'migrations', migrationNames[current - 1]), 'utf8'))
  }
  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ('schema_version', ?, unixepoch())`,
  ).run(version)
  return db
}

describe('legacy D1 deployment bootstrap', () => {
  it('keeps a new database ready to start at migration 0001', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(bootstrap)

    expect(db.prepare('SELECT COUNT(*) AS count FROM d1_migrations').get()).toEqual({ count: 0 })
    applyMigrations(db, 1)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'users'").get()).toEqual({
      name: 'users',
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM d1_migrations').get()).toEqual({ count: 22 })
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'icloud_accounts'",
    ).get()).toEqual({ name: 'icloud_accounts' })
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mailbox_public_links'",
    ).get()).toEqual({ name: 'mailbox_public_links' })
  })

  it.each([
    [14, '2026-07-29-p5-outbound-rate-limit-admin'],
    [16, '2026-08-01-p2-translation-permissions'],
    [17, '2026-08-03-p3-multiple-drafts'],
  ])('baselines legacy migration %i and applies through 0022', (position, version) => {
    const db = legacyDatabase(position, version)
    db.exec(bootstrap)

    expect(db.prepare('SELECT COUNT(*) AS count FROM d1_migrations').get()).toEqual({
      count: position,
    })
    applyMigrations(db, position + 1)
    expect(db.prepare('SELECT COUNT(*) AS count FROM d1_migrations').get()).toEqual({ count: 22 })
    expect(db.prepare(
      "SELECT name FROM pragma_table_info('device_sessions') WHERE name = 'scopes'",
    ).get()).toEqual({ name: 'scopes' })
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'icloud_accounts'",
    ).get()).toEqual({ name: 'icloud_accounts' })
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mailbox_public_links'",
    ).get()).toEqual({ name: 'mailbox_public_links' })
  })

  it('creates the public-link index and cascades links when a mailbox is deleted', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(bootstrap)
    applyMigrations(db, 1)
    db.exec(`
      INSERT INTO users (id, email, display_name, password_hash)
      VALUES ('owner-1', 'owner@example.com', 'Owner', 'hash');
      INSERT INTO mailboxes (address, user_id)
      VALUES ('code@example.com', 'owner-1');
      INSERT INTO mailbox_public_links (mailbox_address, token_hash, created_by)
      VALUES ('code@example.com', 'token-hash', 'owner-1');
      DELETE FROM mailboxes WHERE address = 'code@example.com';
    `)

    expect(db.prepare(
      "SELECT name FROM pragma_index_list('mailbox_public_links') WHERE name = 'idx_mailbox_public_links_token' AND \"unique\" = 1",
    ).get()).toEqual({ name: 'idx_mailbox_public_links_token' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM mailbox_public_links').get())
      .toEqual({ count: 0 })
  })

  it('does not baseline an unknown legacy schema', () => {
    const db = legacyDatabase(14, 'unknown-schema')
    db.exec(bootstrap)

    expect(db.prepare('SELECT COUNT(*) AS count FROM d1_migrations').get()).toEqual({ count: 0 })
  })
})
