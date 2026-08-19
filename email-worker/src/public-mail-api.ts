import { normalizeEmail, validEmail } from './api-helpers'
import { createSessionToken, sha256 } from './auth'
import { writeAudit } from './audit'
import { pageResult, parsePageRequest } from './pagination'
import { searchLikePattern } from './message-search'
import type { Env, SessionUser, StoredBody } from './types'

const PUBLIC_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const PUBLIC_RATE_LIMIT = 60
const PUBLIC_RATE_WINDOW_SECONDS = 60
const MAX_BATCH_MAILBOXES = 100
const MESSAGE_SCAN_LIMIT = 10
const LINK_STATUSES = new Set(['all', 'enabled', 'disabled'])
const BATCH_ACTIONS = new Set(['issue', 'revoke'])
const CODE_PATTERN = /\b(\d{6})\b/g
const CONTEXT_PATTERNS = [
  /(?:verification|security|login|one[ -]?time|temporary|confirm|code|otp|验证码|驗證碼|校验码|確認碼|登录代码|登入代碼|認証コード|確認コード)\D{0,80}(\d{6})/gi,
  /(\d{6})\D{0,80}(?:verification|security|login|one[ -]?time|temporary|confirm|code|otp|验证码|驗證碼|校验码|確認碼|登录代码|登入代碼|認証コード|確認コード)/gi,
]

type PublicLinkRow = {
  mailbox_address: string
  is_active: number
  owner_id: string
  owner_email: string
  owner_name: string
  token_hash: string | null
  link_created_at: number | null
}

type PublicMessageRow = {
  id: string
  sender_address: string
  subject: string
  preview: string
  received_at: number | null
  created_at: number
  body_key: string | null
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(body, { status, headers })
}

function requireSuperAdmin(user: SessionUser): Response | null {
  return user.role === 'super_admin'
    ? null
    : json({ error: '只有主管理员可以管理公开取码链接。' }, 403)
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

function publicHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra)
  headers.set('Cache-Control', 'no-store')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('X-Robots-Tag', 'noindex, nofollow')
  headers.set('X-Content-Type-Options', 'nosniff')
  return headers
}

function cleanHtml(value: string): string {
  return value
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/#[0-9a-f]{6}\b/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractPublicMailCode(...values: Array<string | null | undefined>): string | null {
  const text = values.filter(Boolean).join('\n').replace(/#[0-9a-f]{6}\b/gi, ' ')
  for (const pattern of CONTEXT_PATTERNS) {
    pattern.lastIndex = 0
    const matches = [...text.matchAll(pattern)]
    if (matches.length) return matches.at(-1)?.[1] || null
  }
  const candidates = [...text.matchAll(CODE_PATTERN)].map((match) => match[1])
  const unique = [...new Set(candidates)]
  return unique.length === 1 ? unique[0] : null
}

function publicUrl(request: Request, token: string): string {
  return `${new URL(request.url).origin}/api/public/mail/${encodeURIComponent(token)}`
}

export async function listMailboxPublicLinks(
  env: Env,
  user: SessionUser,
  request: Request,
): Promise<Response> {
  const denied = requireSuperAdmin(user)
  if (denied) return denied
  const pagination = parsePageRequest(request, 1, 50, 100)
  if (!pagination) return json({ error: '分页参数无效，limit 需要在 1–100 之间。' }, 400)

  const params = new URL(request.url).searchParams
  const query = (params.get('q') || '').trim().slice(0, 120)
  const status = params.get('status') || 'all'
  if (!LINK_STATUSES.has(status)) return json({ error: '取码链接筛选条件无效。' }, 400)

  const conditions = ['mb.is_hidden = 0']
  const bindings: Array<string | number> = []
  if (query) {
    const pattern = searchLikePattern(query)
    conditions.push(
      `(mb.address LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')`,
    )
    bindings.push(pattern, pattern, pattern)
  }
  if (status === 'enabled') conditions.push('l.token_hash IS NOT NULL')
  if (status === 'disabled') conditions.push('l.token_hash IS NULL')
  if (pagination.cursor) {
    const [address] = pagination.cursor.values
    if (typeof address !== 'string' || !validEmail(address)) {
      return json({ error: '邮箱分页游标无效。' }, 400)
    }
    conditions.push('mb.address > ?')
    bindings.push(address)
  }

  const { results } = await env.DB.prepare(
    `SELECT mb.address AS mailbox_address, mb.is_active,
            u.id AS owner_id, u.email AS owner_email, u.display_name AS owner_name,
            l.token_hash, l.created_at AS link_created_at
       FROM mailboxes mb
       JOIN users u ON u.id = mb.user_id
       LEFT JOIN mailbox_public_links l ON l.mailbox_address = mb.address
      WHERE ${conditions.join(' AND ')}
      ORDER BY mb.address
      LIMIT ?`,
  ).bind(...bindings, pagination.limit + 1).all<PublicLinkRow>()
  const result = pageResult(results, pagination.limit, (row) => [row.mailbox_address])
  return json({
    mailboxes: result.items.map((row) => ({
      email: row.mailbox_address,
      isActive: Boolean(row.is_active),
      linkEnabled: Boolean(row.token_hash),
      linkCreatedAt: row.link_created_at ? row.link_created_at * 1000 : null,
      owner: {
        id: row.owner_id,
        email: row.owner_email,
        displayName: row.owner_name,
      },
    })),
    page: result.page,
  })
}

export async function bulkManageMailboxPublicLinks(
  env: Env,
  user: SessionUser,
  request: Request,
  ip: string,
): Promise<Response> {
  const denied = requireSuperAdmin(user)
  if (denied) return denied
  const body = await request.json<{ action?: unknown; mailboxes?: unknown }>()
    .catch(() => ({} as { action?: unknown; mailboxes?: unknown }))
  if (typeof body.action !== 'string' || !BATCH_ACTIONS.has(body.action)) {
    return json({ error: 'action 必填且只能是 issue 或 revoke。' }, 400)
  }
  if (
    !Array.isArray(body.mailboxes)
    || body.mailboxes.length < 1
    || body.mailboxes.length > MAX_BATCH_MAILBOXES
  ) {
    return json({ error: 'mailboxes 必填，且单次需要选择 1–100 个邮箱。' }, 400)
  }
  if (body.mailboxes.some((email) => (
    typeof email !== 'string' || !validEmail(normalizeEmail(email))
  ))) {
    return json({ error: 'mailboxes 包含无效邮箱地址。' }, 400)
  }
  const mailboxes = [...new Set(body.mailboxes.map((email) => normalizeEmail(String(email))))]
  const { results: existing } = await env.DB.prepare(
    `SELECT address FROM mailboxes
      WHERE is_hidden = 0 AND address IN (${placeholders(mailboxes.length)})`,
  ).bind(...mailboxes).all<{ address: string }>()
  const existingSet = new Set(existing.map((row) => normalizeEmail(row.address)))
  const selected = mailboxes.filter((email) => existingSet.has(email))
  const missing = mailboxes.filter((email) => !existingSet.has(email))

  const output: Array<{ email: string; status: string; publicUrl?: string }> = missing.map((email) => ({
    email,
    status: 'not_found',
  }))
  if (body.action === 'issue' && selected.length) {
    const issued = await Promise.all(selected.map(async (email) => {
      const token = createSessionToken()
      return { email, token, tokenHash: await sha256(token) }
    }))
    await env.DB.batch(issued.map(({ email, tokenHash }) => env.DB.prepare(
      `INSERT INTO mailbox_public_links (
         mailbox_address, token_hash, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, unixepoch(), unixepoch())
       ON CONFLICT(mailbox_address) DO UPDATE SET
         token_hash = excluded.token_hash,
         created_by = excluded.created_by,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
    ).bind(email, tokenHash, user.id)))
    for (const item of issued) {
      output.push({ email: item.email, status: 'issued', publicUrl: publicUrl(request, item.token) })
    }
  }
  if (body.action === 'revoke' && selected.length) {
    await env.DB.prepare(
      `DELETE FROM mailbox_public_links
        WHERE mailbox_address IN (${placeholders(selected.length)})`,
    ).bind(...selected).run()
    output.push(...selected.map((email) => ({ email, status: 'revoked' })))
  }
  await writeAudit(
    env,
    user.id,
    body.action === 'issue' ? 'mailbox.public_link.issue' : 'mailbox.public_link.revoke',
    null,
    ip,
    { mailboxes: selected, missingCount: missing.length },
  )
  return json({ results: output })
}

async function consumePublicRateLimit(
  env: Env,
  tokenHash: string,
  now: number,
): Promise<{ allowed: boolean; retryAfter: number }> {
  const windowStartedAt = Math.floor(now / PUBLIC_RATE_WINDOW_SECONDS) * PUBLIC_RATE_WINDOW_SECONDS
  const row = await env.DB.prepare(
    `INSERT INTO public_mail_rate_limits (
       token_hash, window_started_at, request_count, updated_at
     ) VALUES (?, ?, 1, ?)
     ON CONFLICT(token_hash) DO UPDATE SET
       window_started_at = excluded.window_started_at,
       request_count = CASE
         WHEN public_mail_rate_limits.window_started_at = excluded.window_started_at
           THEN public_mail_rate_limits.request_count + 1
         ELSE 1
       END,
       updated_at = excluded.updated_at
     RETURNING window_started_at, request_count`,
  ).bind(tokenHash, windowStartedAt, now).first<{
    window_started_at: number
    request_count: number
  }>()
  return {
    allowed: Boolean(row && row.request_count <= PUBLIC_RATE_LIMIT),
    retryAfter: Math.max(1, windowStartedAt + PUBLIC_RATE_WINDOW_SECONDS - now),
  }
}

async function codeFromMessage(env: Env, message: PublicMessageRow): Promise<string | null> {
  const summaryCode = extractPublicMailCode(message.subject, message.preview)
  if (summaryCode) return summaryCode
  if (!message.body_key) return null
  try {
    const object = await env.MAIL_BUCKET.get(message.body_key)
    if (!object) return null
    const body = await object.json<StoredBody>()
    return extractPublicMailCode(message.subject, message.preview, body.text, cleanHtml(body.html || ''))
  } catch (error) {
    console.error('Unable to read public mailbox message body', { messageId: message.id }, error)
    return null
  }
}

export async function publicMailboxCode(
  env: Env,
  request: Request,
  token: string,
): Promise<Response> {
  const startedAt = Date.now()
  const traceId = request.headers.get('CF-Ray') || crypto.randomUUID()
  const finish = (response: Response, mailbox?: string): Response => {
    console.info('Public mailbox code request', {
      method: request.method,
      url: '/api/public/mail/[redacted]',
      traceId,
      mailbox: mailbox || null,
      status: response.status,
      durationMs: Date.now() - startedAt,
    })
    return response
  }
  if (!PUBLIC_TOKEN_PATTERN.test(token)) {
    return finish(json({ error: '取码地址不存在或已失效。' }, 404, publicHeaders()))
  }

  const tokenHash = await sha256(token)
  const now = Math.floor(Date.now() / 1000)
  const mailbox = await env.DB.prepare(
    `SELECT l.mailbox_address
       FROM mailbox_public_links l
       JOIN mailboxes mb ON mb.address = l.mailbox_address
       JOIN users u ON u.id = mb.user_id
      WHERE l.token_hash = ?
        AND mb.is_active = 1 AND mb.is_hidden = 0
        AND u.status = 'active' AND u.deleted_at IS NULL
        AND (u.temporary_expires_at IS NULL OR u.temporary_expires_at > ?)`,
  ).bind(tokenHash, now).first<{ mailbox_address: string }>()
  if (!mailbox) {
    return finish(json({ error: '取码地址不存在或已失效。' }, 404, publicHeaders()))
  }

  const rate = await consumePublicRateLimit(env, tokenHash, now)
  if (!rate.allowed) {
    return finish(json(
      { error: '取码请求过于频繁，请稍后重试。' },
      429,
      publicHeaders({ 'Retry-After': String(rate.retryAfter) }),
    ), mailbox.mailbox_address)
  }

  const { results: messages } = await env.DB.prepare(
    `SELECT m.id, m.sender_address, m.subject, m.preview,
            m.received_at, m.created_at, m.body_key
       FROM messages m
      WHERE COALESCE(m.delivered_to, m.mailbox_address) = ?
        AND m.direction = 'incoming'
        AND m.folder = 'inbox'
        AND m.status = 'ready'
      ORDER BY m.sort_at DESC, m.id DESC
      LIMIT ?`,
  ).bind(mailbox.mailbox_address, MESSAGE_SCAN_LIMIT).all<PublicMessageRow>()
  for (const message of messages) {
    const code = await codeFromMessage(env, message)
    if (!code) continue
    const timestamp = message.received_at ?? message.created_at
    return finish(json({
      email: mailbox.mailbox_address,
      code,
      from: message.sender_address,
      subject: message.subject,
      time: new Date(timestamp * 1000).toISOString(),
    }, 200, publicHeaders()), mailbox.mailbox_address)
  }
  return finish(json({
    email: mailbox.mailbox_address,
    code: null,
    from: null,
    subject: null,
    time: null,
  }, 200, publicHeaders()), mailbox.mailbox_address)
}
