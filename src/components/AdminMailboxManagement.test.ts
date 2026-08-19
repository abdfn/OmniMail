import { describe, expect, it } from 'vitest'
import { adminMailboxResultSummary } from './AdminMailboxManagement'

describe('admin mailbox bulk result summary', () => {
  it('counts successful, unchanged, and scheduled operations as completed', () => {
    expect(adminMailboxResultSummary([
      { address: 'a@example.com', status: 'updated' },
      { address: 'b@example.com', status: 'unchanged' },
      { address: 'c@example.com', status: 'scheduled' },
      { address: 'd@example.com', status: 'primary_protected' },
      { address: 'e@example.com', status: 'workflow_failed' },
    ])).toEqual({ completed: 3, skipped: 2 })
  })
})
