import { describe, expect, it } from 'vitest'
import {
  randomMailboxLocalPart,
  sortMailboxesNewestFirst,
  validMailboxLocalPart,
} from './mailboxAddress'

describe('mailbox local parts', () => {
  it('accepts supported custom local parts', () => {
    expect(validMailboxLocalPart('hello')).toBe(true)
    expect(validMailboxLocalPart('hello.world+news')).toBe(true)
    expect(validMailboxLocalPart('-hello')).toBe(false)
    expect(validMailboxLocalPart('hello-')).toBe(false)
  })

  it('generates readable word pairs with a short random suffix', () => {
    const generated = randomMailboxLocalPart()
    expect(generated).toMatch(/^[a-z0-9]+[._-][a-z0-9]+(?:[._-][0-9][a-z])?$/)
    expect(generated).toMatch(/[a-z]{3,}/)
    expect(randomMailboxLocalPart('alias-')).toMatch(/^alias-[a-z0-9._-]+$/)
  })

  it('sorts mailbox addresses by creation time without mutating the source', () => {
    const mailboxes = [
      { address: 'old@example.com', domain: 'example.com', isPrimary: true, isActive: true, createdAt: 10 },
      { address: 'new@example.com', domain: 'example.com', isPrimary: false, isActive: true, createdAt: 30 },
      { address: 'middle@example.com', domain: 'example.com', isPrimary: false, isActive: true, createdAt: 20 },
    ]

    expect(sortMailboxesNewestFirst(mailboxes).map((mailbox) => mailbox.address)).toEqual([
      'new@example.com', 'middle@example.com', 'old@example.com',
    ])
    expect(mailboxes[0].address).toBe('old@example.com')
  })
})
