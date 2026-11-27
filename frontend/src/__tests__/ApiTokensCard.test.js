import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createTestVuetify } from './setup'
import ApiTokensCard from '@/components/ApiTokensCard.vue'

// #9 acceptance criterion 7: the Settings "API tokens" card.

const mockFetchConfig = vi.fn()
const mockFetchApiTokens = vi.fn()
const mockCreateApiToken = vi.fn()
const mockRevokeApiToken = vi.fn()

vi.mock('@/services/api', () => ({
  fetchConfig: (...a) => mockFetchConfig(...a),
  fetchApiTokens: (...a) => mockFetchApiTokens(...a),
  createApiToken: (...a) => mockCreateApiToken(...a),
  revokeApiToken: (...a) => mockRevokeApiToken(...a),
}))

const FULL_TOKEN = 'gav_' + 'S3cr3tPart'.repeat(4) + 'abc'

const tokenRow = (over = {}) => ({
  id: 1,
  name: 'wled',
  prefix: 'gav_AbCd',
  createdBy: 'owner',
  createdAt: '2026-11-27T01:00:00Z',
  lastUsedAt: null,
  revokedAt: null,
  ...over,
})

const Wrapper = defineComponent({
  components: { ApiTokensCard },
  template: '<v-app><ApiTokensCard /></v-app>',
})

let wrapper

async function mountCard() {
  wrapper = mount(Wrapper, { global: { plugins: [createTestVuetify()] }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

const bodyButton = text =>
  [...document.body.querySelectorAll('button')].find(b => b.textContent.trim() === text)
const byTestId = id => document.body.querySelector(`[data-testid="${id}"]`)

describe('ApiTokensCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchConfig.mockResolvedValue({ authRequired: true })
    mockFetchApiTokens.mockResolvedValue({ tokens: [] })
  })

  afterEach(() => {
    wrapper?.unmount()
    document.body.innerHTML = ''
  })

  it('is hidden when auth is disabled, and does not fetch tokens', async () => {
    mockFetchConfig.mockResolvedValue({ authRequired: false })
    await mountCard()
    expect(byTestId('api-tokens-card')).toBeNull()
    expect(mockFetchApiTokens).not.toHaveBeenCalled()
  })

  it('shows the empty state when there are no tokens', async () => {
    await mountCard()
    expect(byTestId('tokens-empty').textContent).toContain('No API tokens yet')
  })

  it('lists tokens by prefix only, with last used and status; revoked rows have no revoke action', async () => {
    mockFetchApiTokens.mockResolvedValue({
      tokens: [
        tokenRow({ id: 1, name: 'wled', lastUsedAt: '2026-11-27T02:00:00Z' }),
        tokenRow({ id: 2, name: 'old', prefix: 'gav_ZzYy', revokedAt: '2026-11-26T00:00:00Z' }),
      ],
    })
    await mountCard()
    const active = byTestId('token-row-1')
    const revoked = byTestId('token-row-2')
    expect(active.textContent).toContain('gav_AbCd...')
    expect(active.textContent).toContain('Active')
    expect(byTestId('token-row-1').textContent).not.toContain('Never')
    expect(revoked.textContent).toContain('Revoked')
    expect(revoked.classList.contains('text-disabled')).toBe(true)
    expect(byTestId('revoke-1')).not.toBeNull()
    expect(byTestId('revoke-2')).toBeNull()
  })

  it('shows "Never" when a token has not been used', async () => {
    mockFetchApiTokens.mockResolvedValue({ tokens: [tokenRow()] })
    await mountCard()
    expect(byTestId('token-row-1').textContent).toContain('Never')
  })

  it('create shows the full value once, and it is gone from the DOM after Done', async () => {
    mockCreateApiToken.mockResolvedValue({ ...tokenRow(), token: FULL_TOKEN })
    await mountCard()
    mockFetchApiTokens.mockResolvedValue({ tokens: [tokenRow()] })

    byTestId('create-token').click()
    await flushPromises()
    const input = byTestId('token-name').querySelector('input')
    input.value = '  wled  '
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    byTestId('submit-create').click()
    await flushPromises()

    expect(mockCreateApiToken).toHaveBeenCalledWith('wled')
    expect(byTestId('token-value').querySelector('input').value).toBe(FULL_TOKEN)
    expect(document.body.textContent).toContain('only time the full token is shown')

    byTestId('done-create').click()
    await flushPromises()
    await new Promise(r => setTimeout(r, 350)) // let the dialog transition finish
    await flushPromises()

    expect(document.body.innerHTML).not.toContain(FULL_TOKEN)
    // The list never carries the value either.
    expect(byTestId('token-row-1').textContent).not.toContain(FULL_TOKEN)
  })

  it('copy writes the value to the clipboard and announces it', async () => {
    const writeText = vi.fn().mockResolvedValue()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mockCreateApiToken.mockResolvedValue({ ...tokenRow(), token: FULL_TOKEN })
    await mountCard()
    byTestId('create-token').click()
    await flushPromises()
    const input = byTestId('token-name').querySelector('input')
    input.value = 'wled'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    byTestId('submit-create').click()
    await flushPromises()

    byTestId('copy-token').click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(FULL_TOKEN)
    expect(byTestId('copy-status').textContent).toBe('Copied')
  })

  it('shows a create error inline and keeps the dialog open', async () => {
    mockCreateApiToken.mockRejectedValue(new Error('name must be 1-100 characters'))
    await mountCard()
    byTestId('create-token').click()
    await flushPromises()
    const input = byTestId('token-name').querySelector('input')
    input.value = 'x'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    byTestId('submit-create').click()
    await flushPromises()
    expect(document.body.textContent).toContain('name must be 1-100 characters')
    expect(byTestId('token-name')).not.toBeNull()
  })

  it('revoke asks for confirmation, then calls the API and reloads', async () => {
    mockFetchApiTokens.mockResolvedValue({ tokens: [tokenRow()] })
    mockRevokeApiToken.mockResolvedValue(null)
    await mountCard()

    byTestId('revoke-1').click()
    await flushPromises()
    expect(document.body.textContent).toContain('Revoke token?')
    expect(mockRevokeApiToken).not.toHaveBeenCalled()

    mockFetchApiTokens.mockResolvedValue({ tokens: [tokenRow({ revokedAt: '2026-11-27T03:00:00Z' })] })
    byTestId('confirm-revoke').click()
    await flushPromises()
    expect(mockRevokeApiToken).toHaveBeenCalledWith(1)
    expect(byTestId('token-row-1').textContent).toContain('Revoked')
  })

  it('cancelling the revoke dialog calls nothing', async () => {
    mockFetchApiTokens.mockResolvedValue({ tokens: [tokenRow()] })
    await mountCard()
    byTestId('revoke-1').click()
    await flushPromises()
    bodyButton('Cancel').click()
    await flushPromises()
    expect(mockRevokeApiToken).not.toHaveBeenCalled()
  })
})
