import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createTestVuetify } from './setup'
import { createRouter, createWebHashHistory } from 'vue-router'
import { defineComponent } from 'vue'
import SettingsPage from '@/components/SettingsPage.vue'

const mockFetchSettings = vi.fn()
const mockUpdateSettings = vi.fn()
const mockFetchRepos = vi.fn()
const mockAddRepo = vi.fn()
const mockUpdateRepo = vi.fn()
const mockDeleteRepo = vi.fn()
const mockRebuildDatabase = vi.fn()
const mockFetchGithubRepos = vi.fn()
const mockFetchDbStats = vi.fn()
const mockFetchRepoStats = vi.fn()
const mockFetchRepoWorkflows = vi.fn()
const mockSetWorkflowStatusMode = vi.fn()

vi.mock('@/services/api', () => ({
  fetchSettings: (...args) => mockFetchSettings(...args),
  updateSettings: (...args) => mockUpdateSettings(...args),
  fetchRepos: (...args) => mockFetchRepos(...args),
  addRepo: (...args) => mockAddRepo(...args),
  updateRepo: (...args) => mockUpdateRepo(...args),
  deleteRepo: (...args) => mockDeleteRepo(...args),
  rebuildDatabase: (...args) => mockRebuildDatabase(...args),
  fetchGithubRepos: (...args) => mockFetchGithubRepos(...args),
  fetchDbStats: (...args) => mockFetchDbStats(...args),
  fetchRepoStats: (...args) => mockFetchRepoStats(...args),
  // RepoWorkflowSettings (#6)
  fetchRepoWorkflows: (...args) => mockFetchRepoWorkflows(...args),
  setWorkflowStatusMode: (...args) => mockSetWorkflowStatusMode(...args),
  // ApiTokensCard (#9): auth disabled here, so the card stays hidden.
  fetchConfig: () => Promise.resolve({ authRequired: false }),
  fetchApiTokens: () => Promise.resolve({ tokens: [] }),
  createApiToken: vi.fn(),
  revokeApiToken: vi.fn(),
}))

function createTestRouter() {
  return createRouter({
    history: createWebHashHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/settings', name: 'Settings', component: { template: '<div />' } },
    ],
  })
}

// Wrap in v-app for Vuetify layout
const SettingsWrapper = defineComponent({
  components: { SettingsPage },
  template: '<v-app><SettingsPage /></v-app>',
})

function mountSettings() {
  return mount(SettingsWrapper, {
    global: {
      plugins: [createTestVuetify(), createTestRouter()],
    },
  })
}

describe('SettingsPage', () => {
  beforeEach(() => {
    mockFetchSettings.mockReset()
    mockUpdateSettings.mockReset()
    mockFetchRepos.mockReset()
    mockAddRepo.mockReset()
    mockUpdateRepo.mockReset()
    mockDeleteRepo.mockReset()
    mockRebuildDatabase.mockReset()
    mockFetchGithubRepos.mockReset()
    mockFetchDbStats.mockReset()
    mockFetchRepoStats.mockReset()
    mockFetchRepoWorkflows.mockReset()
    mockSetWorkflowStatusMode.mockReset()
    mockFetchRepoWorkflows.mockResolvedValue({ workflows: [] })

    mockFetchSettings.mockResolvedValue({ discoveryPollSeconds: 60, activePollSeconds: 10 })
    mockFetchDbStats.mockResolvedValue({
      fileSizeBytes: 1048576,
      filePath: '/data/gitactionsview.db',
      rowCounts: { workflows: 5, workflowRuns: 100, workflowJobs: 500, repos: 3 },
      dataAge: { oldest: '2025-01-01T00:00:00Z', newest: '2026-02-01T00:00:00Z' },
    })
    mockFetchRepos.mockResolvedValue({ repos: [] })
    mockFetchGithubRepos.mockResolvedValue({
      repos: [
        { owner: 'test-org', name: 'my-repo', fullName: 'test-org/my-repo' },
        { owner: 'test-org', name: 'other-repo', fullName: 'test-org/other-repo' },
      ],
    })
  })

  it('renders the settings heading', async () => {
    const wrapper = mountSettings()
    await flushPromises()
    expect(wrapper.text()).toContain('Settings')
  })

  it('displays polling interval section', async () => {
    const wrapper = mountSettings()
    await flushPromises()
    expect(wrapper.text()).toContain('Polling Intervals')
  })

  it('displays database section', async () => {
    const wrapper = mountSettings()
    await flushPromises()
    expect(wrapper.text()).toContain('Database')
    expect(wrapper.text()).toContain('Rebuild Cache')
  })

  it('displays repositories section', async () => {
    const wrapper = mountSettings()
    await flushPromises()
    expect(wrapper.text()).toContain('Repositories')
  })

  it('loads settings on mount', async () => {
    mountSettings()
    await flushPromises()
    expect(mockFetchSettings).toHaveBeenCalledTimes(1)
  })

  it('loads repos on mount', async () => {
    mountSettings()
    await flushPromises()
    expect(mockFetchRepos).toHaveBeenCalledTimes(1)
  })

  it('displays repos in table when present', async () => {
    mockFetchRepos.mockResolvedValue({
      repos: [
        { id: 1, owner: 'test-org', name: 'my-repo', hidden: 0, created_at: '2026-01-01' },
      ],
    })
    const wrapper = mountSettings()
    await flushPromises()
    expect(wrapper.text()).toContain('test-org/my-repo')
  })

  it('shows empty message when no repos', async () => {
    mockFetchRepos.mockResolvedValue({ repos: [] })
    const wrapper = mountSettings()
    await flushPromises()
    expect(wrapper.text()).toContain('No repositories configured')
  })

  it('calls updateSettings when save is clicked', async () => {
    mockUpdateSettings.mockResolvedValue({ discoveryPollSeconds: 90, activePollSeconds: 20, restarted: true })
    const wrapper = mountSettings()
    await flushPromises()

    // Find and click Save button
    const saveBtn = wrapper.findAll('.v-btn').find(b => b.text().includes('Save'))
    expect(saveBtn).toBeDefined()
    await saveBtn.trigger('click')
    await flushPromises()
    expect(mockUpdateSettings).toHaveBeenCalledTimes(1)
  })

  it('shows rebuild confirmation dialog', async () => {
    const wrapper = mountSettings()
    await flushPromises()

    const rebuildBtn = wrapper.findAll('.v-btn').find(b => b.text().includes('Rebuild Cache'))
    expect(rebuildBtn).toBeDefined()
    await rebuildBtn.trigger('click')
    await flushPromises()
    // VDialog teleports its content to document.body, so check there
    expect(document.body.textContent).toContain('Rebuild Database Cache?')
  })

  it('shows autocomplete when GitHub repos are available', async () => {
    const wrapper = mountSettings()
    await flushPromises()
    const autocomplete = wrapper.findComponent({ name: 'v-autocomplete' })
    expect(autocomplete.exists()).toBe(true)
    expect(mockFetchGithubRepos).toHaveBeenCalledTimes(1)
  })

  it('falls back to manual input when GitHub repos fetch fails', async () => {
    mockFetchGithubRepos.mockRejectedValue(new Error('No token'))
    const wrapper = mountSettings()
    await flushPromises()
    const autocomplete = wrapper.findComponent({ name: 'v-autocomplete' })
    expect(autocomplete.exists()).toBe(false)
    // Manual input fields should be visible
    expect(wrapper.text()).toContain('Owner')
  })

  it('filters out already configured repos from autocomplete', async () => {
    mockFetchRepos.mockResolvedValue({
      repos: [{ id: 1, owner: 'test-org', name: 'my-repo', hidden: 0 }],
    })
    mockFetchGithubRepos.mockResolvedValue({
      repos: [
        { owner: 'test-org', name: 'my-repo', fullName: 'test-org/my-repo' },
        { owner: 'test-org', name: 'other-repo', fullName: 'test-org/other-repo' },
      ],
    })
    const wrapper = mountSettings()
    await flushPromises()
    const autocomplete = wrapper.findComponent({ name: 'v-autocomplete' })
    expect(autocomplete.exists()).toBe(true)
    // The autocomplete should only show 'other-repo' (my-repo is already configured)
    const items = autocomplete.props('items')
    expect(items).toHaveLength(1)
    expect(items[0].fullName).toBe('test-org/other-repo')
  })

  describe('default branch (#5)', () => {
    const repoRow = (over = {}) => ({
      id: 1, owner: 'test-org', name: 'my-repo', hidden: 0, created_at: '2026-01-01',
      defaultBranch: 'develop', defaultBranchOverride: null, effectiveDefaultBranch: 'develop',
      ...over,
    })

    async function expandRepo(wrapper) {
      const row = wrapper.findAll('tr').find(r => r.text().includes('test-org/my-repo'))
      await row.trigger('click')
      await flushPromises()
    }

    beforeEach(() => {
      mockFetchRepoStats.mockResolvedValue({
        runCount: 1, workflowCount: 1, jobCount: 1, estimatedSizeBytes: 0, latestRun: null,
      })
    })

    it('shows the branch used for status on the repo row, and unknown when there is none', async () => {
      mockFetchRepos.mockResolvedValue({
        repos: [repoRow(), repoRow({ id: 2, name: 'new-repo', defaultBranch: null, effectiveDefaultBranch: null })],
      })
      const wrapper = mountSettings()
      await flushPromises()
      const chips = wrapper.findAll('[data-testid="repo-branch-chip"]').map(c => c.text())
      expect(chips).toEqual(['develop', 'unknown'])
    })

    it('renders the detected branch when a repo is expanded', async () => {
      mockFetchRepos.mockResolvedValue({ repos: [repoRow()] })
      const wrapper = mountSettings()
      await flushPromises()
      await expandRepo(wrapper)
      expect(wrapper.find('[data-testid="detected-branch"]').text()).toBe('develop')
      expect(wrapper.find('[data-testid="effective-branch"]').text()).toBe('develop')
    })

    it('saves an override and shows it as the branch in use', async () => {
      mockFetchRepos.mockResolvedValue({ repos: [repoRow()] })
      mockUpdateRepo.mockResolvedValue({
        repo: repoRow({ defaultBranchOverride: 'release', effectiveDefaultBranch: 'release' }),
      })
      const wrapper = mountSettings()
      await flushPromises()
      await expandRepo(wrapper)

      await wrapper.find('[data-testid="branch-override-input"] input').setValue('  release  ')
      await wrapper.find('[data-testid="save-branch-override"]').trigger('click')
      await flushPromises()

      expect(mockUpdateRepo).toHaveBeenCalledWith(1, { defaultBranchOverride: 'release' })
      expect(wrapper.find('[data-testid="effective-branch"]').text()).toBe('release')
      expect(wrapper.findAll('[data-testid="repo-branch-chip"]')[0].text()).toBe('release')
    })

    it('clears an override back to GitHub\'s branch', async () => {
      mockFetchRepos.mockResolvedValue({
        repos: [repoRow({ defaultBranchOverride: 'release', effectiveDefaultBranch: 'release' })],
      })
      mockUpdateRepo.mockResolvedValue({ repo: repoRow() })
      const wrapper = mountSettings()
      await flushPromises()
      await expandRepo(wrapper)

      await wrapper.find('[data-testid="clear-branch-override"]').trigger('click')
      await flushPromises()

      expect(mockUpdateRepo).toHaveBeenCalledWith(1, { defaultBranchOverride: null })
      expect(wrapper.find('[data-testid="effective-branch"]').text()).toBe('develop')
    })
  })

  describe('workflows that count (#6)', () => {
    const repo = {
      id: 1, owner: 'test-org', name: 'my-repo', hidden: 0, created_at: '2026-01-01',
      defaultBranch: 'main', defaultBranchOverride: null, effectiveDefaultBranch: 'main',
    }
    const wfs = [
      { id: 10, name: 'CI', path: '.github/workflows/ci.yml', state: 'active', statusMode: null, countsTowardStatus: true, reason: 'default:push' },
      { id: 11, name: 'Launch Production', path: '.github/workflows/launch.yml', state: 'active', statusMode: null, countsTowardStatus: false, reason: 'default:excluded-manual' },
      { id: 12, name: 'Copilot', path: 'dynamic/agents/copilot', state: 'active', statusMode: null, countsTowardStatus: false, reason: 'default:excluded-managed' },
    ]

    async function expandRepo(wrapper) {
      const row = wrapper.findAll('tr').find(r => r.text().includes('test-org/my-repo'))
      await row.trigger('click')
      await flushPromises()
    }

    beforeEach(() => {
      mockFetchRepos.mockResolvedValue({ repos: [repo] })
      mockFetchRepoStats.mockResolvedValue({ runCount: 1, workflowCount: 3, jobCount: 1, estimatedSizeBytes: 0, latestRun: null })
      mockFetchRepoWorkflows.mockResolvedValue({ effectiveDefaultBranch: 'main', workflows: wfs.map(w => ({ ...w })) })
    })

    it('shows each workflow with the reason it does or does not count', async () => {
      const wrapper = mountSettings()
      await flushPromises()
      await expandRepo(wrapper)
      expect(mockFetchRepoWorkflows).toHaveBeenCalledWith(1)
      const reasons = wrapper.findAll('[data-testid="workflow-reason"]').map(c => c.text())
      expect(reasons).toEqual(['Runs on push', 'Manual or scheduled', 'GitHub-managed'])
    })

    it('saves a change and shows the new reason', async () => {
      mockSetWorkflowStatusMode.mockResolvedValue({
        workflow: { ...wfs[1], statusMode: 'include', countsTowardStatus: true, reason: 'explicit:include' },
      })
      const wrapper = mountSettings()
      await flushPromises()
      await expandRepo(wrapper)

      const select = wrapper.findComponent('[data-testid="workflow-mode-11"]')
      select.vm.$emit('update:modelValue', 'include')
      await flushPromises()

      expect(mockSetWorkflowStatusMode).toHaveBeenCalledWith(1, 11, 'include')
      expect(wrapper.find('[data-testid="workflow-row-11"]').text()).toContain('Included')
    })

    it('resetting to the default rule sends null', async () => {
      mockFetchRepoWorkflows.mockResolvedValue({
        workflows: [{ ...wfs[0], statusMode: 'exclude', countsTowardStatus: false, reason: 'explicit:exclude' }],
      })
      mockSetWorkflowStatusMode.mockResolvedValue({ workflow: { ...wfs[0] } })
      const wrapper = mountSettings()
      await flushPromises()
      await expandRepo(wrapper)

      wrapper.findComponent('[data-testid="workflow-mode-10"]').vm.$emit('update:modelValue', 'default')
      await flushPromises()
      expect(mockSetWorkflowStatusMode).toHaveBeenCalledWith(1, 10, null)
      expect(wrapper.find('[data-testid="workflow-row-10"]').text()).toContain('Runs on push')
    })
  })
})
