<template>
  <!-- Which workflows determine this repository's status (#6). -->
  <div class="mt-4" data-testid="repo-workflow-settings">
    <div class="text-caption text-medium-emphasis mb-1">Workflows that count toward status</div>
    <v-progress-linear v-if="loading" indeterminate class="mb-2" />
    <div v-else-if="error" class="text-caption text-error" data-testid="workflows-error">{{ error }}</div>
    <div v-else-if="!workflows.length" class="text-body-2 text-medium-emphasis" data-testid="workflows-empty">
      No workflows synced yet.
    </div>
    <v-table v-else density="compact" class="bg-transparent">
      <tbody>
        <tr v-for="wf in workflows" :key="wf.id" :data-testid="`workflow-row-${wf.id}`">
          <td class="text-body-2" style="width: 40%">
            <v-icon size="small" :color="wf.countsTowardStatus ? 'success' : undefined" class="mr-1">
              {{ wf.countsTowardStatus ? 'mdi-check-circle' : 'mdi-minus-circle-outline' }}
            </v-icon>
            {{ wf.name }}
          </td>
          <td>
            <v-chip size="x-small" variant="tonal" :title="reasonHelp[wf.reason] || wf.reason" data-testid="workflow-reason">
              {{ reasonLabel[wf.reason] || wf.reason }}
            </v-chip>
          </td>
          <td style="width: 170px">
            <v-select
              :model-value="wf.statusMode || 'default'"
              :items="modeItems"
              density="compact"
              variant="outlined"
              hide-details
              :disabled="savingId === wf.id"
              :data-testid="`workflow-mode-${wf.id}`"
              @click.stop
              @update:model-value="(value) => changeMode(wf, value)"
            />
          </td>
        </tr>
      </tbody>
    </v-table>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue'
import { fetchRepoWorkflows, setWorkflowStatusMode } from '@/services/api'

const props = defineProps({
  repo: { type: Object, required: true },
})

const workflows = ref([])
const loading = ref(false)
const error = ref('')
const savingId = ref(null)

const modeItems = [
  { title: 'Default rule', value: 'default' },
  { title: 'Always count', value: 'include' },
  { title: 'Never count', value: 'exclude' },
]

const reasonLabel = {
  'default:push': 'Runs on push',
  'default:excluded-manual': 'Manual or scheduled',
  'default:excluded-managed': 'GitHub-managed',
  'default:unknown-branch': 'Branch unknown',
  disabled: 'Disabled',
  'explicit:include': 'Included',
  'explicit:exclude': 'Excluded',
}

const reasonHelp = {
  'default:push': 'Counts: it has run on push to the default branch',
  'default:excluded-manual': 'Not counted: no push run on the default branch seen yet',
  'default:excluded-managed': 'Not counted: a GitHub-managed workflow (Copilot, Dependabot, CodeQL)',
  'default:unknown-branch': 'Not counted: the default branch is not known yet',
  disabled: 'Never counts: disabled on GitHub',
  'explicit:include': 'Counts: included by hand',
  'explicit:exclude': 'Not counted: excluded by hand',
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await fetchRepoWorkflows(props.repo.id)
    workflows.value = data.workflows || []
  } catch (err) {
    error.value = err.message || 'Could not load workflows'
  } finally {
    loading.value = false
  }
}

async function changeMode(wf, value) {
  const statusMode = value === 'default' ? null : value
  if (statusMode === (wf.statusMode || null)) return
  savingId.value = wf.id
  error.value = ''
  try {
    const data = await setWorkflowStatusMode(props.repo.id, wf.id, statusMode)
    Object.assign(wf, data.workflow)
  } catch (err) {
    error.value = err.message || 'Could not save'
  } finally {
    savingId.value = null
  }
}

onMounted(load)
// A branch override changes which workflows count under the default rule.
watch(() => props.repo.effectiveDefaultBranch, load)
</script>
