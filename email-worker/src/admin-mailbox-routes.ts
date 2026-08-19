import type { Hono } from 'hono'
import {
  bulkManageAdminMailboxes,
  createAdminMailboxes,
  listAdminMailboxes,
} from './admin-mailbox-api'
import { clientIp } from './api-helpers'
import type { AppContext } from './api'

/** 注册主管理员邮箱管理路由 */
export function adminMailboxRoutes(app: Hono<AppContext>): void {
  app.get('/api/admin/mailboxes', (context) => listAdminMailboxes(
    context.env,
    context.get('user'),
    context.req.raw,
  ))
  app.post('/api/admin/mailboxes', (context) => createAdminMailboxes(
    context.env,
    context.get('user'),
    context.req.raw,
    clientIp(context.req.raw.headers),
  ))
  app.post('/api/admin/mailboxes/bulk', (context) => bulkManageAdminMailboxes(
    context.env,
    context.get('user'),
    context.req.raw,
    clientIp(context.req.raw.headers),
  ))
}
