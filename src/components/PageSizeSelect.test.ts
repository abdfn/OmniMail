import { describe, expect, it } from 'vitest'
import { PAGE_SIZE_OPTIONS } from './PageSizeSelect'

describe('page size options', () => {
  it('provides the same supported choices for every paginated list', () => {
    expect(PAGE_SIZE_OPTIONS).toEqual([20, 30, 50, 100])
  })
})
