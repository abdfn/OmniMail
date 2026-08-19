import { describe, expect, it, vi } from 'vitest'
import { sha256 } from './auth'
import {
  bulkManageMailboxPublicLinks,
  extractPublicMailCode,
  listMailboxPublicLinks,
  publicMailboxCode,
} from './public-mail-api'
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

describe('public mailbox code extraction', () => {
  it('prefers a contextual code and ignores CSS values', () => {
    expect(extractPublicMailCode(
      'Your temporary login code',
      '<style>.button{color:#353740}</style>Your code is 654321',
    )).toBe('654321')
  })

  it('only falls back when there is one unique six-digit value', () => {
    expect(extractPublicMailCode('Reference 123456')).toBe('123456')
    expect(extractPublicMailCode('References 123456 and 654321')).toBeNull()
  })
})

describe('public mailbox link administration', () => {
  it('rejects ordinary administrators before querying D1', async () => {
    const prepare = vi.fn()
    const response = await listMailboxPublicLinks(
      { DB: { prepare } } as unknown as Env,
      { ...superAdmin, role: 'admin' },
      new Request('https://mail.example.com/api/admin/mailbox-public-links'),
    )

    expect(response.status).toBe(403)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('validates required batch fields', async () => {
    const response = await bulkManageMailboxPublicLinks(
      { DB: { prepare: vi.fn() } } as unknown as Env,
      superAdmin,
      new Request('https://mail.example.com/api/admin/mailbox-public-links/bulk', {
        method: 'POST',
        body: JSON.stringify({ action: 'issue', mailboxes: [] }),
      }),
      '127.0.0.1',
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('mailboxes 必填') })
  })

  it('returns plaintext links once and only stores token hashes', async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = []
    const db = {
      prepare(sql: string) {
        const entry = { sql, bindings: [] as unknown[] }
        statements.push(entry)
        const statement = {
          sql,
          bind(...bindings: unknown[]) {
            entry.bindings = bindings
            return statement
          },
          all: async () => ({ results: [{ address: 'code@example.com' }] }),
          run: async () => ({ meta: { changes: 1 } }),
        }
        return statement
      },
      batch: async () => [],
    }
    const response = await bulkManageMailboxPublicLinks(
      { DB: db } as unknown as Env,
      superAdmin,
      new Request('https://mail.example.com/api/admin/mailbox-public-links/bulk', {
        method: 'POST',
        body: JSON.stringify({ action: 'issue', mailboxes: ['code@example.com'] }),
      }),
      '127.0.0.1',
    )
    const body = await response.json() as {
      results: Array<{ publicUrl: string }>
    }
    const token = body.results[0].publicUrl.split('/').at(-1) || ''
    const insert = statements.find(({ sql }) => sql.includes('INSERT INTO mailbox_public_links'))

    expect(response.status).toBe(200)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(insert?.bindings[1]).toBe(await sha256(token))
    expect(insert?.bindings).not.toContain(token)
    expect(insert?.sql).toContain('ON CONFLICT(mailbox_address) DO UPDATE')
    expect(insert?.sql).toContain('created_at = excluded.created_at')
    expect(statements.some(({ bindings }) => bindings.includes('mailbox.public_link.issue'))).toBe(true)
  })
})

describe('public mailbox access', () => {
  it('returns the same 404 response for invalid and unavailable links', async () => {
    const prepare = vi.fn(() => {
      const statement = {
        bind() { return statement },
        first: async () => null,
      }
      return statement
    })
    const env = { DB: { prepare } } as unknown as Env
    const malformed = await publicMailboxCode(
      env,
      new Request('https://mail.example.com/api/public/mail/invalid'),
      'invalid',
    )
    const unavailable = await publicMailboxCode(
      env,
      new Request(`https://mail.example.com/api/public/mail/${'d'.repeat(43)}`),
      'd'.repeat(43),
    )

    expect(malformed.status).toBe(404)
    expect(unavailable.status).toBe(404)
    await expect(malformed.clone().json()).resolves.toEqual(await unavailable.clone().json())
    expect(unavailable.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(unavailable.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
  })

  it('uses the token-bound mailbox and extracts the newest body code', async () => {
    const token = 'a'.repeat(43)
    const statements: Array<{ sql: string; bindings: unknown[] }> = []
    const db = {
      prepare(sql: string) {
        const entry = { sql, bindings: [] as unknown[] }
        statements.push(entry)
        const statement = {
          bind(...bindings: unknown[]) {
            entry.bindings = bindings
            return statement
          },
          first: async () => {
            if (sql.includes('FROM mailbox_public_links l')) {
              return { mailbox_address: 'only@example.com' }
            }
            if (sql.includes('public_mail_rate_limits')) {
              return { window_started_at: 1, request_count: 1 }
            }
            return null
          },
          all: async () => ({
            results: sql.includes('FROM messages m') ? [{
              id: 'message-1', sender_address: 'sender@example.net',
              subject: 'Security message', preview: '', received_at: 100,
              created_at: 90, body_key: 'body/message-1.json',
            }] : [],
          }),
        }
        return statement
      },
    }
    const response = await publicMailboxCode(
      {
        DB: db,
        MAIL_BUCKET: {
          get: async () => ({
            json: async () => ({
              text: 'Your verification code is 765432',
              html: '<style>.x{color:#353740}</style>',
            }),
          }),
        },
      } as unknown as Env,
      new Request(`https://mail.example.com/api/public/mail/${token}`),
      token,
    )
    const body = await response.json() as { email: string; code: string }
    const messageQuery = statements.find(({ sql }) => sql.includes('FROM messages m'))

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ email: 'only@example.com', code: '765432' })
    expect(messageQuery?.sql).toContain('COALESCE(m.delivered_to, m.mailbox_address) = ?')
    expect(messageQuery?.bindings[0]).toBe('only@example.com')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const linkQuery = statements.find(({ sql }) => sql.includes('FROM mailbox_public_links l'))
    expect(linkQuery?.sql).toContain("u.status = 'active'")
    expect(linkQuery?.sql).toContain('mb.is_active = 1 AND mb.is_hidden = 0')
  })

  it('returns null fields while a valid mailbox has no code', async () => {
    const token = 'b'.repeat(43)
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement },
          first: async () => sql.includes('public_mail_rate_limits')
            ? { window_started_at: 1, request_count: 1 }
            : { mailbox_address: 'empty@example.com' },
          all: async () => ({ results: [] }),
        }
        return statement
      },
    }
    const response = await publicMailboxCode(
      { DB: db } as unknown as Env,
      new Request(`https://mail.example.com/api/public/mail/${token}`),
      token,
    )
    await expect(response.json()).resolves.toEqual({
      email: 'empty@example.com', code: null, from: null, subject: null, time: null,
    })
  })

  it('returns 429 on the sixty-first request without reading messages', async () => {
    const token = 'c'.repeat(43)
    const all = vi.fn(async () => ({ results: [] }))
    const db = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement },
          first: async () => sql.includes('public_mail_rate_limits')
            ? { window_started_at: Math.floor(Date.now() / 1000), request_count: 61 }
            : { mailbox_address: 'limited@example.com' },
          all,
        }
        return statement
      },
    }
    const response = await publicMailboxCode(
      { DB: db } as unknown as Env,
      new Request(`https://mail.example.com/api/public/mail/${token}`),
      token,
    )

    expect(response.status).toBe(429)
    expect(response.headers.get('Retry-After')).toBeTruthy()
    expect(all).not.toHaveBeenCalled()
  })
})
