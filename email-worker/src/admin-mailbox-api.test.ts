import { describe, expect, it, vi } from 'vitest'
import {
  bulkManageAdminMailboxes,
  createAdminMailboxes,
  listAdminMailboxes,
} from './admin-mailbox-api'
import { randomMailboxLocalPart } from './mailbox-generator'
import type { Env, SessionUser } from './types'

const superAdmin: SessionUser = {
  id: 'super-1',
  email: 'owner@example.com',
  displayName: 'Owner',
  role: 'super_admin',
  mailboxLimit: 100,
  storageQuotaBytes: 0,
  storageUsedBytes: 0,
  canCreateMailboxes: true,
  canReply: true,
  canTranslate: true,
  temporaryExpiresAt: null,
}

describe('admin mailbox listing', () => {
  it('rejects non-owner administrators before querying D1', async () => {
    const prepare = vi.fn()
    const response = await listAdminMailboxes(
      { DB: { prepare } } as unknown as Env,
      { ...superAdmin, role: 'admin' },
      new Request('https://mail.example/api/admin/mailboxes'),
    )

    expect(response.status).toBe(403)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('lists newest mailboxes first with totals and link status', async () => {
    const statements: string[] = []
    const database = {
      prepare(sql: string) {
        statements.push(sql)
        const statement = {
          bind() { return statement },
          all: async () => ({ results: [{
            address: 'new@example.com', user_id: 'user-1', is_primary: 0,
            is_active: 1, created_at: 20, owner_email: 'user@example.com',
            owner_name: 'User', owner_role: 'user', owner_status: 'active',
            link_enabled: 1,
          }] }),
          first: async () => ({ total: 3, active: 2, disabled: 1, public_links: 1 }),
        }
        return statement
      },
    }
    const response = await listAdminMailboxes(
      { DB: database } as unknown as Env,
      superAdmin,
      new Request('https://mail.example/api/admin/mailboxes?status=all&limit=50'),
    )

    expect(statements[0]).toContain('ORDER BY mb.created_at DESC, mb.address ASC')
    await expect(response.json()).resolves.toMatchObject({
      mailboxes: [{ address: 'new@example.com', createdAt: 20_000, linkEnabled: true }],
      totals: { total: 3, active: 2, disabled: 1, publicLinks: 1 },
    })
  })
})

describe('admin mailbox bulk creation', () => {
  it('validates every required request field', async () => {
    const response = await createAdminMailboxes(
      { DB: { prepare: vi.fn() } } as unknown as Env,
      superAdmin,
      new Request('https://mail.example/api/admin/mailboxes', {
        method: 'POST',
        body: JSON.stringify({ ownerEmail: '', domain: '', count: 0 }),
      }),
      '127.0.0.1',
    )

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('ownerEmail 必填'),
    })
  })

  it('creates natural-word mailboxes and records one bulk audit event', async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = []
    const database = {
      prepare(sql: string) {
        const entry = { sql, bindings: [] as unknown[] }
        statements.push(entry)
        const statement = {
          sql,
          bind(...bindings: unknown[]) { entry.bindings = bindings; return statement },
          first: async () => {
            if (sql.includes('FROM users u')) return {
              id: 'user-1', email: 'user@example.com', display_name: 'User',
              role: 'user', status: 'active', mailbox_limit: 10,
              temporary_expires_at: null, mailbox_count: 0,
            }
            if (sql.includes('FROM domains')) return { is_active: 1 }
            if (sql.includes("key = 'random_mailbox_prefix'")) return { value: '' }
            return null
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        }
        return statement
      },
      batch: async (prepared: Array<{ sql: string }>) => prepared.map(() => ({
        success: true,
        meta: { changes: 1 },
        results: [],
      })),
    }
    const response = await createAdminMailboxes(
      { DB: database } as unknown as Env,
      superAdmin,
      new Request('https://mail.example/api/admin/mailboxes', {
        method: 'POST',
        body: JSON.stringify({ ownerEmail: 'user@example.com', domain: 'example.com', count: 2 }),
      }),
      '127.0.0.1',
    )
    const body = await response.json() as { createdCount: number; mailboxes: Array<{ address: string }> }

    expect(response.status).toBe(201)
    expect(body.createdCount).toBe(2)
    expect(body.mailboxes.every((item) => /^[a-z0-9._-]+@example\.com$/.test(item.address))).toBe(true)
    expect(statements.some((item) => item.bindings.includes('mailbox.bulk_create'))).toBe(true)
    expect(statements.some((item) => item.sql.includes('NOT EXISTS') && item.sql.includes('is_primary = 1'))).toBe(true)
  })

  it('uses the same readable local-part shape as quick generation', () => {
    expect(randomMailboxLocalPart()).toMatch(/^[a-z0-9]+[._-][a-z0-9]+(?:[._-][0-9][a-z])?$/)
  })
})

describe('admin mailbox bulk updates', () => {
  it('protects primary mailboxes while disabling secondary mailboxes', async () => {
    const database = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement },
          all: async () => ({ results: sql.includes('FROM mailboxes mb') ? [{
            address: 'primary@example.com', user_id: 'user-1', is_primary: 1,
            is_active: 1, created_at: 1, owner_email: 'user@example.com',
            owner_name: 'User', owner_role: 'user', owner_status: 'active', link_enabled: 0,
          }, {
            address: 'alias@example.com', user_id: 'user-1', is_primary: 0,
            is_active: 1, created_at: 2, owner_email: 'user@example.com',
            owner_name: 'User', owner_role: 'user', owner_status: 'active', link_enabled: 0,
          }] : [] }),
          run: async () => ({ meta: { changes: 1 } }),
        }
        return statement
      },
      batch: async (prepared: unknown[]) => prepared.map(() => ({
        success: true,
        meta: { changes: 1 },
        results: [],
      })),
    }
    const response = await bulkManageAdminMailboxes(
      { DB: database } as unknown as Env,
      superAdmin,
      new Request('https://mail.example/api/admin/mailboxes/bulk', {
        method: 'POST',
        body: JSON.stringify({
          action: 'disable',
          mailboxes: ['primary@example.com', 'alias@example.com'],
        }),
      }),
      '127.0.0.1',
    )

    await expect(response.json()).resolves.toMatchObject({
      updatedCount: 1,
      results: expect.arrayContaining([
        { address: 'primary@example.com', status: 'primary_protected' },
        { address: 'alias@example.com', status: 'updated' },
      ]),
    })
  })

  it('hides secondary mailboxes before scheduling their cleanup workflow', async () => {
    const create = vi.fn(async () => ({}))
    const database = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement },
          all: async () => ({ results: sql.includes('FROM mailboxes mb') ? [{
            address: 'alias@example.com', user_id: 'user-1', is_primary: 0,
            is_active: 1, created_at: 2, owner_email: 'user@example.com',
            owner_name: 'User', owner_role: 'user', owner_status: 'active', link_enabled: 1,
          }] : [] }),
          run: async () => ({ meta: { changes: 1 } }),
        }
        return statement
      },
    }
    const response = await bulkManageAdminMailboxes(
      { DB: database, CLEANUP_WORKFLOW: { create } } as unknown as Env,
      superAdmin,
      new Request('https://mail.example/api/admin/mailboxes/bulk', {
        method: 'POST',
        body: JSON.stringify({ action: 'delete', mailboxes: ['alias@example.com'] }),
      }),
      '127.0.0.1',
    )

    await expect(response.json()).resolves.toMatchObject({
      updatedCount: 1,
      results: [{ address: 'alias@example.com', status: 'scheduled' }],
    })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({
        mailboxDeletion: expect.objectContaining({
          address: 'alias@example.com',
          userId: 'user-1',
          requestedBy: 'super-1',
        }),
      }),
    }))
  })
})
