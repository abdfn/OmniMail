import type {
  AdminMailbox,
  AdminMailboxBulkAction,
  AdminMailboxBulkResult,
  AdminMailboxStatusFilter,
  AdminMailboxTotals,
  PageInfo,
} from './api-types'

type RequestFunction = <T>(path: string, init?: RequestInit) => Promise<T>

/** 构建主管理员邮箱管理 API 客户端 */
export function createAdminMailboxApi(
  request: RequestFunction,
  jsonBody: (value: unknown) => string,
) {
  return {
    adminMailboxes: (input: {
      query: string
      status: AdminMailboxStatusFilter
      limit: number
      cursor?: string
    }) => {
      const search = new URLSearchParams({
        limit: String(input.limit),
        status: input.status,
      })
      if (input.query.trim()) search.set('q', input.query.trim())
      if (input.cursor) search.set('cursor', input.cursor)
      return request<{
        mailboxes: AdminMailbox[]
        page: PageInfo
        totals: AdminMailboxTotals
      }>(`/api/admin/mailboxes?${search}`)
    },
    createAdminMailboxes: (input: {
      ownerEmail: string
      domain: string
      count: number
    }) => request<{ createdCount: number; mailboxes: Array<{ address: string }> }>(
      '/api/admin/mailboxes', {
        method: 'POST',
        body: jsonBody(input),
      },
    ),
    manageAdminMailboxes: (
      action: AdminMailboxBulkAction,
      mailboxes: string[],
    ) => request<{ results: AdminMailboxBulkResult[]; updatedCount: number }>(
      '/api/admin/mailboxes/bulk', {
        method: 'POST',
        body: jsonBody({ action, mailboxes }),
      },
    ),
  }
}
