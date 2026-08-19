import { describe, expect, it, vi } from 'vitest'
import { ensureSchema } from './schema'

interface MockStatement {
  sql: string
  bindings: unknown[]
  bind: (...values: unknown[]) => MockStatement
  first: () => Promise<unknown>
  run: () => Promise<unknown>
}

function database(options: {
  migrationTable?: boolean
  legacyVersion?: string
  applied?: string[]
  concurrentMigration?: string
  scopesPresent?: boolean
  failBatchOnce?: boolean
} = {}) {
  let migrationTable = options.migrationTable ?? true
  const applied = new Set(options.applied ?? [])
  const batches: MockStatement[][] = []
  let concurrentMigration = options.concurrentMigration
  let failBatchOnce = options.failBatchOnce ?? false

  const prepare = vi.fn((sql: string) => {
    const statement: MockStatement = {
      sql,
      bindings: [],
      bind: vi.fn((...values: unknown[]) => {
        statement.bindings = values
        return statement
      }),
      first: vi.fn(async () => {
        if (sql.includes("name = 'd1_migrations'")) {
          return migrationTable ? { found: 1 } : null
        }
        if (sql.includes("key = 'schema_version'")) {
          return options.legacyVersion ? { value: options.legacyVersion } : null
        }
        if (sql.includes('SELECT 1 AS applied FROM d1_migrations')) {
          return applied.has(String(statement.bindings[0])) ? { applied: 1 } : null
        }
        if (sql.includes("pragma_table_info('device_sessions')")) {
          return options.scopesPresent ? { present: 1 } : null
        }
        return null
      }),
      run: vi.fn(async () => {
        if (sql.includes('d1_migrations (name)')) {
          applied.add(String(statement.bindings[0]))
        }
        return { success: true }
      }),
    }
    return statement
  })
  const batch = vi.fn(async (statements: MockStatement[]) => {
    batches.push(statements)
    if (failBatchOnce) {
      failBatchOnce = false
      throw new Error('temporary D1 failure')
    }
    if (statements.some(({ sql }) => sql.includes('CREATE TABLE IF NOT EXISTS d1_migrations'))) {
      migrationTable = true
    }
    for (const statement of statements) {
      if (statement.sql.includes('d1_migrations (name)')) {
        applied.add(String(statement.bindings[0]))
      }
    }
    if (concurrentMigration && applied.has(concurrentMigration)) {
      concurrentMigration = undefined
      throw new Error('migration completed by another isolate')
    }
    return []
  })

  return {
    db: { prepare, batch } as unknown as D1Database,
    applied,
    batches,
    prepare,
    batch,
  }
}

const FINAL_MIGRATIONS = [
  '0015_message_translations.sql',
  '0016_translation_permissions.sql',
  '0017_multiple_drafts.sql',
  '0018_schema_baseline_and_message_indexes.sql',
  '0019_extension_authorization.sql',
  '0020_device_token_scopes.sql',
  '0021_icloud_accounts.sql',
  '0022_mailbox_public_links.sql',
]

describe('D1 migration check', () => {
  it('checks the required Wrangler migrations once per binding', async () => {
    const fixture = database({ applied: FINAL_MIGRATIONS })
    await ensureSchema(fixture.db)
    await ensureSchema(fixture.db)

    expect(fixture.batch).not.toHaveBeenCalled()
    for (const name of FINAL_MIGRATIONS) {
      expect(fixture.prepare.mock.results.some(({ value }) => (
        (value as MockStatement).bindings[0] === name
      ))).toBe(true)
    }
  })

  it.each([
    ['2026-07-29-p5-outbound-rate-limit-admin', 14, 9],
    ['2026-08-01-p2-translation-permissions', 16, 7],
    ['2026-08-03-p3-multiple-drafts', 17, 6],
  ])('recovers legacy schema %s through migration 0022', async (
    legacyVersion,
    baseline,
    batchCount,
  ) => {
    const fixture = database({ migrationTable: false, legacyVersion })
    await ensureSchema(fixture.db)

    expect(fixture.batch).toHaveBeenCalledTimes(batchCount)
    expect(fixture.batches[0]).toHaveLength(baseline + 1)
    expect(fixture.applied.size).toBe(22)
    expect(fixture.applied.has('0020_device_token_scopes.sql')).toBe(true)
    expect(fixture.applied.has('0021_icloud_accounts.sql')).toBe(true)
    expect(fixture.applied.has('0022_mailbox_public_links.sql')).toBe(true)
    expect(fixture.prepare).toHaveBeenCalledWith(
      "ALTER TABLE device_sessions ADD COLUMN scopes TEXT NOT NULL DEFAULT '*'",
    )
    expect(fixture.prepare.mock.calls.some(([sql]) => (
      String(sql).includes('CREATE TABLE IF NOT EXISTS icloud_accounts')
    ))).toBe(true)
    expect(fixture.prepare.mock.calls.some(([sql]) => (
      String(sql).includes('CREATE TABLE mailbox_public_links')
    ))).toBe(true)
  })

  it('repairs migration records left empty by an earlier failed Wrangler run', async () => {
    const fixture = database({
      migrationTable: true,
      legacyVersion: '2026-08-03-p3-multiple-drafts',
    })

    await ensureSchema(fixture.db)

    expect(fixture.applied.size).toBe(22)
    expect(fixture.batches[0]).toHaveLength(18)
  })

  it('does not guess a baseline for an unknown legacy database', async () => {
    const fixture = database({
      migrationTable: false,
      legacyVersion: 'unknown-schema',
    })

    await expect(ensureSchema(fixture.db)).rejects.toThrow(
      '无法识别旧版数据库结构标记：unknown-schema',
    )
    expect(fixture.batch).not.toHaveBeenCalled()
  })

  it('records an existing scopes column before applying the iCloud migration', async () => {
    const fixture = database({
      applied: FINAL_MIGRATIONS.slice(0, -3),
      scopesPresent: true,
    })

    await ensureSchema(fixture.db)

    expect(fixture.applied.has('0020_device_token_scopes.sql')).toBe(true)
    expect(fixture.applied.has('0021_icloud_accounts.sql')).toBe(true)
    expect(fixture.applied.has('0022_mailbox_public_links.sql')).toBe(true)
    expect(fixture.prepare).not.toHaveBeenCalledWith(
      "ALTER TABLE device_sessions ADD COLUMN scopes TEXT NOT NULL DEFAULT '*'",
    )
    expect(fixture.batch).toHaveBeenCalledTimes(2)
  })

  it('accepts a concurrent migration completed by another isolate', async () => {
    const fixture = database({
      applied: FINAL_MIGRATIONS.slice(0, -1),
      concurrentMigration: '0022_mailbox_public_links.sql',
    })

    await expect(ensureSchema(fixture.db)).resolves.toBeUndefined()
    expect(fixture.batch).toHaveBeenCalledOnce()
  })

  it('drops a rejected cached check so the next request can retry', async () => {
    const fixture = database({
      applied: FINAL_MIGRATIONS.slice(0, -1),
      failBatchOnce: true,
    })

    await expect(ensureSchema(fixture.db)).rejects.toThrow('0022_mailbox_public_links.sql')
    await expect(ensureSchema(fixture.db)).resolves.toBeUndefined()
    expect(fixture.batch).toHaveBeenCalledTimes(2)
  })
})
