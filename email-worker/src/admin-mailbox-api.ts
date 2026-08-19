import { normalizeEmail, validEmail } from './api-helpers'
import { normalizeDomain, validDomainName } from './domain-api'
import { randomMailboxLocalPart } from './mailbox-generator'
import { pageResult, parsePageRequest } from './pagination'
import { searchLikePattern } from './message-search'
import { writeAudit } from './audit'
import type { Env, SessionUser, UserRole } from './types'

const STATUS_FILTERS = new Set(['all', 'enabled', 'disabled'])
const BULK_ACTIONS = new Set(['enable', 'disable', 'delete'])
const MAX_BATCH_MAILBOXES = 100

type AdminMailboxRow = {
  address: string
  user_id: string
  is_primary: number
  is_active: number
  created_at: number
  owner_email: string
  owner_name: string
  owner_role: UserRole
  owner_status: 'active' | 'disabled'
  link_enabled: number
}

type TargetUserRow = {
  id: string
  email: string
  display_name: string
  role: UserRole
  status: 'active' | 'disabled'
  mailbox_limit: number
  temporary_expires_at: number | null
  mailbox_count: number
}

type BulkResultStatus =
  | 'updated'
  | 'unchanged'
  | 'scheduled'
  | 'not_found'
  | 'primary_protected'
  | 'domain_disabled'
  | 'workflow_failed'

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function requireSuperAdmin(user: SessionUser): Response | null {
  return user.role === 'super_admin'
    ? null
    : json({ error: '只有主管理员可以管理全部邮箱。' }, 403)
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

function mailboxDomain(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase()
}

function mailboxJson(row: AdminMailboxRow) {
  return {
    address: row.address,
    domain: mailboxDomain(row.address),
    isPrimary: Boolean(row.is_primary),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at * 1000,
    linkEnabled: Boolean(row.link_enabled),
    owner: {
      id: row.user_id,
      email: row.owner_email,
      displayName: row.owner_name,
      role: row.owner_role,
      status: row.owner_status,
    },
  }
}

/** 分页查询全站邮箱，结果固定按创建时间倒序 */
export async function listAdminMailboxes(
  env: Env,
  actor: SessionUser,
  request: Request,
): Promise<Response> {
  const denied = requireSuperAdmin(actor)
  if (denied) return denied
  const pagination = parsePageRequest(request, 2, 50, 100)
  if (!pagination) return json({ error: '分页参数无效，limit 需要在 1–100 之间。' }, 400)

  const params = new URL(request.url).searchParams
  const query = (params.get('q') || '').trim().slice(0, 120)
  const status = params.get('status') || 'all'
  if (!STATUS_FILTERS.has(status)) return json({ error: '邮箱管理筛选条件无效。' }, 400)

  const conditions = ['mb.is_hidden = 0', 'u.deleted_at IS NULL']
  const bindings: Array<string | number> = []
  if (query) {
    const pattern = searchLikePattern(query)
    conditions.push(
      `(mb.address LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')`,
    )
    bindings.push(pattern, pattern, pattern)
  }
  if (status === 'enabled') conditions.push('mb.is_active = 1')
  if (status === 'disabled') conditions.push('mb.is_active = 0')
  if (pagination.cursor) {
    const [createdAt, address] = pagination.cursor.values
    if (
      typeof createdAt !== 'number'
      || !Number.isSafeInteger(createdAt)
      || createdAt < 0
      || typeof address !== 'string'
      || !validEmail(address)
    ) return json({ error: '邮箱分页游标无效。' }, 400)
    conditions.push('(mb.created_at < ? OR (mb.created_at = ? AND mb.address > ?))')
    bindings.push(createdAt, createdAt, address)
  }

  const { results } = await env.DB.prepare(
    `SELECT mb.address, mb.user_id, mb.is_primary, mb.is_active, mb.created_at,
            u.email AS owner_email, u.display_name AS owner_name,
            u.role AS owner_role, u.status AS owner_status,
            CASE WHEN l.token_hash IS NULL THEN 0 ELSE 1 END AS link_enabled
       FROM mailboxes mb
       JOIN users u ON u.id = mb.user_id
       LEFT JOIN mailbox_public_links l ON l.mailbox_address = mb.address
      WHERE ${conditions.join(' AND ')}
      ORDER BY mb.created_at DESC, mb.address ASC
      LIMIT ?`,
  ).bind(...bindings, pagination.limit + 1).all<AdminMailboxRow>()
  const result = pageResult(results, pagination.limit, (row) => [row.created_at, row.address])
  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN mb.is_active = 1 THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN mb.is_active = 0 THEN 1 ELSE 0 END) AS disabled,
            SUM(CASE WHEN l.token_hash IS NOT NULL THEN 1 ELSE 0 END) AS public_links
       FROM mailboxes mb
       JOIN users u ON u.id = mb.user_id AND u.deleted_at IS NULL
       LEFT JOIN mailbox_public_links l ON l.mailbox_address = mb.address
      WHERE mb.is_hidden = 0`,
  ).first<{ total: number; active: number; disabled: number; public_links: number }>()
  return json({
    mailboxes: result.items.map(mailboxJson),
    page: result.page,
    totals: {
      total: Number(totals?.total || 0),
      active: Number(totals?.active || 0),
      disabled: Number(totals?.disabled || 0),
      publicLinks: Number(totals?.public_links || 0),
    },
  })
}

async function targetUser(env: Env, ownerEmail: string): Promise<TargetUserRow | null> {
  return env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.role, u.status, u.mailbox_limit,
            u.temporary_expires_at, COUNT(m.address) AS mailbox_count
       FROM users u
       LEFT JOIN mailboxes m ON m.user_id = u.id AND m.is_hidden = 0
      WHERE u.email = ? AND u.deleted_at IS NULL
      GROUP BY u.id`,
  ).bind(ownerEmail).first<TargetUserRow>()
}

async function availableAddresses(
  env: Env,
  domain: string,
  prefix: string,
  count: number,
): Promise<string[]> {
  const candidates = new Set<string>()
  while (candidates.size < count * 3 + 10) {
    candidates.add(`${randomMailboxLocalPart(prefix)}@${domain}`)
  }
  const addresses = [...candidates]
  const marks = placeholders(addresses.length)
  const { results } = await env.DB.prepare(
    `SELECT address AS value FROM mailboxes WHERE address IN (${marks})
     UNION
     SELECT assigned_address AS value FROM temporary_invites
      WHERE assigned_address IN (${marks}) AND address_mode = 'assigned'
        AND revoked_at IS NULL AND expires_at > unixepoch() AND use_count = 0`,
  ).bind(...addresses, ...addresses).all<{ value: string }>()
  const unavailable = new Set(results.map((row) => normalizeEmail(row.value)))
  return addresses.filter((address) => !unavailable.has(address)).slice(0, count)
}

/** 为指定用户批量生成随机邮箱 */
export async function createAdminMailboxes(
  env: Env,
  actor: SessionUser,
  request: Request,
  ip: string,
): Promise<Response> {
  const denied = requireSuperAdmin(actor)
  if (denied) return denied
  const body = await request.json<{ ownerEmail?: unknown; domain?: unknown; count?: unknown }>()
    .catch(() => ({} as { ownerEmail?: unknown; domain?: unknown; count?: unknown }))
  const ownerEmail = typeof body.ownerEmail === 'string' ? normalizeEmail(body.ownerEmail) : ''
  const domain = typeof body.domain === 'string' ? normalizeDomain(body.domain) : ''
  const count = typeof body.count === 'number' ? body.count : Number.NaN
  if (!ownerEmail || !validEmail(ownerEmail)) {
    return json({ error: 'ownerEmail 必填且必须是有效的登录邮箱。' }, 400)
  }
  if (!domain || !validDomainName(domain)) {
    return json({ error: 'domain 必填且必须是有效域名。' }, 400)
  }
  if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH_MAILBOXES) {
    return json({ error: 'count 必填且需要在 1–100 之间。' }, 400)
  }

  const now = Math.floor(Date.now() / 1000)
  const owner = await targetUser(env, ownerEmail)
  if (!owner) return json({ error: '所属用户不存在。' }, 404)
  if (
    owner.status !== 'active'
    || (owner.temporary_expires_at !== null && owner.temporary_expires_at <= now)
  ) return json({ error: '只能为有效用户生成邮箱。' }, 409)
  const domainRow = await env.DB.prepare(
    'SELECT is_active FROM domains WHERE name = ?',
  ).bind(domain).first<{ is_active: number }>()
  if (!domainRow?.is_active) return json({ error: '请选择已启用的域名。' }, 409)
  if (owner.role !== 'super_admin' && owner.mailbox_count + count > owner.mailbox_limit) {
    return json({ error: '该用户的邮箱额度不足。' }, 409)
  }

  const setting = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'random_mailbox_prefix'",
  ).first<{ value: string }>()
  const addresses = await availableAddresses(env, domain, setting?.value || '', count)
  if (addresses.length !== count) return json({ error: '随机邮箱生成冲突，请重试。' }, 409)

  const insertResults = await env.DB.batch(addresses.map((address) => env.DB.prepare(
    `INSERT OR IGNORE INTO mailboxes (address, user_id, is_primary, is_active, created_at)
     VALUES (?, ?, 0, 1, ?)`,
  ).bind(address, owner.id, now)))
  const created = addresses.filter((_, index) => Number(insertResults[index]?.meta.changes || 0) > 0)
  if (!created.length) return json({ error: '随机邮箱生成冲突，请重试。' }, 409)

  // 首次批量创建时确保用户始终有且只有一个主邮箱
  await env.DB.prepare(
    `UPDATE mailboxes
        SET is_primary = CASE WHEN address = (
          SELECT address FROM mailboxes
           WHERE user_id = ? AND is_hidden = 0
           ORDER BY created_at ASC, rowid ASC LIMIT 1
        ) THEN 1 ELSE is_primary END
      WHERE user_id = ? AND is_hidden = 0
        AND NOT EXISTS (
          SELECT 1 FROM mailboxes WHERE user_id = ? AND is_hidden = 0 AND is_primary = 1
        )`,
  ).bind(owner.id, owner.id, owner.id).run()
  await writeAudit(env, actor.id, 'mailbox.bulk_create', owner.id, ip, {
    ownerEmail,
    domain,
    requestedCount: count,
    created,
  })
  return json({
    createdCount: created.length,
    mailboxes: created.map((address) => ({ address })),
  }, 201)
}

function normalizeMailboxSelection(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BATCH_MAILBOXES) return null
  if (value.some((item) => typeof item !== 'string' || !validEmail(normalizeEmail(item)))) return null
  return [...new Set(value.map((item) => normalizeEmail(String(item))))]
}

async function scheduleDeletion(
  env: Env,
  actor: SessionUser,
  row: AdminMailboxRow,
): Promise<BulkResultStatus> {
  const hidden = await env.DB.prepare(
    `UPDATE mailboxes SET is_active = 0, is_hidden = 1
      WHERE address = ? AND user_id = ? AND is_primary = 0 AND is_hidden = 0`,
  ).bind(row.address, row.user_id).run()
  if (!hidden.meta.changes) return 'not_found'
  try {
    await env.CLEANUP_WORKFLOW!.create({
      id: `mailbox-delete-${crypto.randomUUID()}`,
      params: {
        startedAt: Math.floor(Date.now() / 1000),
        mailboxDeletion: {
          address: row.address,
          userId: row.user_id,
          requestedBy: actor.id,
        },
      },
      retention: { successRetention: '3 days', errorRetention: '7 days' },
    })
    return 'scheduled'
  } catch {
    await env.DB.prepare(
      `UPDATE mailboxes SET is_active = ?, is_hidden = 0
        WHERE address = ? AND user_id = ? AND is_primary = 0`,
    ).bind(row.is_active, row.address, row.user_id).run()
    return 'workflow_failed'
  }
}

/** 批量启用、停用或删除全站邮箱 */
export async function bulkManageAdminMailboxes(
  env: Env,
  actor: SessionUser,
  request: Request,
  ip: string,
): Promise<Response> {
  const denied = requireSuperAdmin(actor)
  if (denied) return denied
  const body = await request.json<{ action?: unknown; mailboxes?: unknown }>()
    .catch(() => ({} as { action?: unknown; mailboxes?: unknown }))
  if (typeof body.action !== 'string' || !BULK_ACTIONS.has(body.action)) {
    return json({ error: 'action 必填且只能是 enable、disable 或 delete。' }, 400)
  }
  const selected = normalizeMailboxSelection(body.mailboxes)
  if (!selected) return json({ error: 'mailboxes 必填，且单次需要选择 1–100 个有效邮箱。' }, 400)
  if (body.action === 'delete' && !env.CLEANUP_WORKFLOW) {
    return json({ error: '邮箱删除服务暂时不可用，请稍后重试。' }, 503)
  }

  const { results: rows } = await env.DB.prepare(
    `SELECT mb.address, mb.user_id, mb.is_primary, mb.is_active, mb.created_at,
            u.email AS owner_email, u.display_name AS owner_name,
            u.role AS owner_role, u.status AS owner_status,
            CASE WHEN l.token_hash IS NULL THEN 0 ELSE 1 END AS link_enabled
       FROM mailboxes mb
       JOIN users u ON u.id = mb.user_id
       LEFT JOIN mailbox_public_links l ON l.mailbox_address = mb.address
      WHERE mb.is_hidden = 0 AND mb.address IN (${placeholders(selected.length)})`,
  ).bind(...selected).all<AdminMailboxRow>()
  const rowByAddress = new Map(rows.map((row) => [normalizeEmail(row.address), row]))
  const domains = [...new Set(rows.map((row) => mailboxDomain(row.address)))]
  const activeDomains = new Set<string>()
  if (body.action === 'enable' && domains.length) {
    const { results } = await env.DB.prepare(
      `SELECT name FROM domains WHERE is_active = 1 AND name IN (${placeholders(domains.length)})`,
    ).bind(...domains).all<{ name: string }>()
    results.forEach((row) => activeDomains.add(row.name))
  }

  const output: Array<{ address: string; status: BulkResultStatus }> = []
  const updates: Array<{ row: AdminMailboxRow; active: number }> = []
  for (const address of selected) {
    const row = rowByAddress.get(address)
    if (!row) {
      output.push({ address, status: 'not_found' })
      continue
    }
    if ((body.action === 'disable' || body.action === 'delete') && row.is_primary) {
      output.push({ address, status: 'primary_protected' })
      continue
    }
    if (body.action === 'enable' && !activeDomains.has(mailboxDomain(address))) {
      output.push({ address, status: 'domain_disabled' })
      continue
    }
    if (body.action === 'delete') {
      output.push({ address, status: await scheduleDeletion(env, actor, row) })
      continue
    }
    const active = body.action === 'enable' ? 1 : 0
    if (row.is_active === active) output.push({ address, status: 'unchanged' })
    else updates.push({ row, active })
  }
  if (updates.length) {
    const primaryGuard = body.action === 'disable' ? 'AND is_primary = 0' : ''
    const updateResults = await env.DB.batch(updates.map(({ row, active }) => env.DB.prepare(
      `UPDATE mailboxes SET is_active = ?
        WHERE address = ? AND user_id = ? AND is_hidden = 0 ${primaryGuard}`,
    ).bind(active, row.address, row.user_id)))
    updates.forEach(({ row }, index) => output.push({
      address: row.address,
      status: updateResults[index]?.meta.changes ? 'updated' : 'not_found',
    }))
  }

  const successStatuses = new Set<BulkResultStatus>(['updated', 'unchanged', 'scheduled'])
  const updatedCount = output.filter((item) => successStatuses.has(item.status)).length
  await writeAudit(env, actor.id, `mailbox.bulk_${body.action}`, null, ip, {
    mailboxes: selected,
    updatedCount,
    skipped: output.filter((item) => !successStatuses.has(item.status)),
  })
  return json({ results: output, updatedCount })
}
