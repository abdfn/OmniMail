import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  apiEndpointCurl,
  apiEndpointKey,
  apiEndpoints,
} from './apiCatalog'

const routeFiles = [
  'email-worker/src/api.ts',
  'email-worker/src/admin-mailbox-routes.ts',
  'email-worker/src/extension-authorization-routes.ts',
  'email-worker/src/icloud-routes.ts',
  'email-worker/src/mail-feature-routes.ts',
  'email-worker/src/outbound-rate-limit-routes.ts',
  'email-worker/src/system-version-routes.ts',
]

const routePattern = /(?:app|adminMailboxRoutes|iCloudRoutes|mailFeatureRoutes|outboundRateLimitRoutes|systemVersionRoutes)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g

function sourceRouteKeys(): string[] {
  return routeFiles.flatMap((filename) => {
    const source = readFileSync(filename, 'utf8')
    return [...source.matchAll(routePattern)].map((match) => {
      const path = match[2].startsWith('/api/') ? match[2] : `/api${match[2]}`
      return `${match[1].toUpperCase()} ${path}`
    })
  }).sort()
}

describe('API catalog', () => {
  it('documents every Worker HTTP route exactly once', () => {
    const source = sourceRouteKeys()
    const documented = apiEndpoints.map(apiEndpointKey).sort()

    expect(new Set(source).size).toBe(source.length)
    expect(new Set(documented).size).toBe(documented.length)
    expect(documented).toEqual(source)
    expect(documented).toHaveLength(108)
  })

  it('provides usage details and a callable example for every endpoint', () => {
    for (const endpoint of apiEndpoints) {
      expect(endpoint.title.zh).not.toBe('')
      expect(endpoint.title.en).not.toBe('')
      expect(endpoint.description.zh).not.toBe('')
      expect(endpoint.description.en).not.toBe('')
      expect(endpoint.request).not.toBe('')
      expect(endpoint.response).not.toBe('')
      const example = apiEndpointCurl(endpoint, 'https://mail.example.com/api')
      expect(example).toContain(`curl --request ${endpoint.method}`)
      expect(example).toContain('https://mail.example.com/api')
    }
  })
})
