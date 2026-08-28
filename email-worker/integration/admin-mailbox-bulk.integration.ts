import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { createAdminMailboxes } from '../src/admin-mailbox-api'
import type { Env as OmniMailEnv, SessionUser } from '../src/types'

declare global {
  namespace Cloudflare {
    interface Env extends OmniMailEnv {
      TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>
    }
  }
}

const owner: SessionUser = {
  id: 'bulk-owner',
  email: 'bulk-owner@example.com',
  displayName: 'Bulk Owner',
  role: 'super_admin',
  mailboxLimit: 100,
  storageQuotaBytes: 0,
  storageUsedBytes: 0,
  canCreateMailboxes: true,
  canReply: true,
  canTranslate: true,
  temporaryExpiresAt: null,
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.prepare(
    `INSERT INTO users (
      id, email, display_name, password_hash, role, mailbox_limit,
      storage_quota_bytes, can_create_mailboxes, can_reply, can_translate
    ) VALUES (?, ?, ?, 'test', 'super_admin', 100, 0, 1, 1, 1)`,
  ).bind(owner.id, owner.email, owner.displayName).run()
  await env.DB.prepare(
    'INSERT INTO domains (name, is_active, created_by) VALUES (?, 1, ?)',
  ).bind('example.com', owner.id).run()
})

describe('admin mailbox bulk creation with D1', () => {
  it('creates twenty mailboxes without exceeding the D1 parameter limit', async () => {
    const response = await createAdminMailboxes(
      env,
      owner,
      new Request('https://mail.example.com/api/admin/mailboxes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerEmail: owner.email,
          domain: 'example.com',
          count: 20,
        }),
      }),
      '127.0.0.1',
    )
    const body = await response.json<{ createdCount: number }>()
    const stored = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM mailboxes WHERE user_id = ?',
    ).bind(owner.id).first<{ count: number }>()

    expect(response.status).toBe(201)
    expect(body.createdCount).toBe(20)
    expect(stored?.count).toBe(20)
  })
})
