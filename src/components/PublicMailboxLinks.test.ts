import { describe, expect, it } from 'vitest'
import { publicLinkResultText } from './PublicMailboxLinks'

describe('public mailbox link export', () => {
  it('uses the requested mailbox separator and skips results without a new token', () => {
    expect(publicLinkResultText([
      { email: 'a@example.com', status: 'issued', publicUrl: 'https://mail.example.com/api/public/mail/token-a' },
      { email: 'b@example.com', status: 'not_found' },
      { email: 'c@example.com', status: 'revoked' },
      { email: 'd@example.com', status: 'issued', publicUrl: 'https://mail.example.com/api/public/mail/token-d' },
    ])).toBe([
      'a@example.com----https://mail.example.com/api/public/mail/token-a',
      'd@example.com----https://mail.example.com/api/public/mail/token-d',
    ].join('\n'))
  })
})
