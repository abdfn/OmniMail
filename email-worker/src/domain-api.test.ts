import { describe, expect, it, vi } from 'vitest'
import { deleteDomain, listDomains, normalizeDomain, validDomainName } from './domain-api'
import type { Env, SessionUser } from './types'

describe('domain validation', () => {
  it('normalizes case and a trailing dot', () => {
    expect(normalizeDomain(' Example.COM. ')).toBe('example.com')
  })

  it('accepts regular and local test domains', () => {
    expect(validDomainName('example.com')).toBe(true)
    expect(validDomainName('mail.omni.test')).toBe(true)
  })

  it('rejects email addresses and invalid labels', () => {
    expect(validDomainName('owner@example.com')).toBe(false)
    expect(validDomainName('-mail.example.com')).toBe(false)
    expect(validDomainName('localhost')).toBe(false)
  })

  it('域名邮箱数量不包含异步删除中的隐藏邮箱', async () => {
    let query = ''
    const database = {
      prepare(sql: string) {
        query = sql
        return {
          all: async () => ({ results: [] }),
        }
      },
    }

    const response = await listDomains(
      { DB: database } as unknown as Env,
      { id: 'admin-1', role: 'admin' } as SessionUser,
    )

    expect(response.status).toBe(200)
    expect(query).toContain('AND m.is_hidden = 0')
  })

  it('有关联邮箱时隐藏邮箱并提交域名清理任务', async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = []
    const create = vi.fn(async () => ({}))
    const database = {
      prepare(sql: string) {
        const item = { sql, bindings: [] as unknown[] }
        statements.push(item)
        const statement = {
          bind(...bindings: unknown[]) {
            item.bindings = bindings
            return statement
          },
          first: async () => sql.includes('FROM domains d') ? ({
            name: 'example.com', is_active: 1, is_deleting: 0,
            mailbox_count: 2, created_at: 1, updated_at: 1,
          }) : ({ count: 2 }),
          all: async () => ({
            results: [
              { address: 'first@example.com', is_active: 1 },
              { address: 'second@example.com', is_active: 0 },
            ],
          }),
          run: async () => ({ meta: { changes: 1 } }),
        }
        return statement
      },
      batch: vi.fn(async () => []),
    }

    const response = await deleteDomain(
      { DB: database, CLEANUP_WORKFLOW: { create } } as unknown as Env,
      { id: 'admin-1', role: 'admin' } as SessionUser,
      'example.com',
      '127.0.0.1',
    )

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({ scheduledMailboxCount: 2 })
    expect(statements.some((item) => item.sql.includes('SET is_hidden = 1'))).toBe(true)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({
        domainDeletion: { domain: 'example.com', requestedBy: 'admin-1' },
      }),
    }))
  })

  it('有关联邮箱但未绑定清理服务时保留域名', async () => {
    const batch = vi.fn()
    const database = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement },
          first: async () => sql.includes('FROM domains d') ? ({
            name: 'example.com', is_active: 1, is_deleting: 0,
            mailbox_count: 1, created_at: 1, updated_at: 1,
          }) : ({ count: 1 }),
        }
        return statement
      },
      batch,
    }

    const response = await deleteDomain(
      { DB: database } as unknown as Env,
      { id: 'admin-1', role: 'admin' } as SessionUser,
      'example.com',
      '127.0.0.1',
    )

    expect(response.status).toBe(503)
    expect(batch).not.toHaveBeenCalled()
  })

  it('域名清理任务启动失败时恢复原邮箱状态', async () => {
    const statements: string[] = []
    const batch = vi.fn(async () => [])
    const database = {
      prepare(sql: string) {
        statements.push(sql)
        const statement = {
          bind() { return statement },
          first: async () => sql.includes('FROM domains d') ? ({
            name: 'example.com', is_active: 1, is_deleting: 0,
            mailbox_count: 1, created_at: 1, updated_at: 1,
          }) : ({ count: 1 }),
          all: async () => ({
            results: [{ address: 'disabled@example.com', is_active: 0 }],
          }),
          run: async () => ({ meta: { changes: 1 } }),
        }
        return statement
      },
      batch,
    }

    const response = await deleteDomain(
      {
        DB: database,
        CLEANUP_WORKFLOW: { create: vi.fn(async () => { throw new Error('unavailable') }) },
      } as unknown as Env,
      { id: 'admin-1', role: 'admin' } as SessionUser,
      'example.com',
      '127.0.0.1',
    )

    expect(response.status).toBe(503)
    expect(batch).toHaveBeenCalledTimes(2)
    expect(statements.some((sql) => sql.includes('SET is_hidden = 0, is_active = ?'))).toBe(true)
  })
})
