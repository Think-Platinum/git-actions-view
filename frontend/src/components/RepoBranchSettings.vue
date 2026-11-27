<template>
  <!-- Default branch for repository status (#5). -->
  <div class="mt-3" data-testid="repo-branch-settings">
    <div class="text-caption text-medium-emphasis mb-1">Default branch</div>
    <div class="text-body-2 mb-2">
      Detected from GitHub:
      <code v-if="repo.defaultBranch" data-testid="detected-branch">{{ repo.defaultBranch }}</code>
      <span v-else class="text-medium-emphasis" data-testid="detected-branch">not detected yet</span>
      <span class="mx-2">&middot;</span>
      Status uses:
      <code v-if="repo.effectiveDefaultBranch" data-testid="effective-branch">{{ repo.effectiveDefaultBranch }}</code>
      <span v-else class="text-warning" data-testid="effective-branch">unknown</span>
      <span v-if="repo.defaultBranchOverride" class="text-caption text-medium-emphasis ml-1">(override)</span>
    </div>
    <div class="d-flex flex-wrap ga-2 align-center">
      <v-text-field
        v-model="draft"
        label="Override branch"
        :placeholder="repo.defaultBranch || 'e.g. main'"
        density="compact"
        variant="outlined"
        hide-details
        style="max-width: 260px"
        data-testid="branch-override-input"
        @click.stop
        @keyup.enter="save"
      />
      <v-btn
        size="small"
        color="primary"
        variant="tonal"
        :loading="saving"
        :disabled="!draft.trim() || draft.trim() === repo.defaultBranchOverride"
        data-testid="save-branch-override"
        @click.stop="save"
      >
        Save
      </v-btn>
      <v-btn
        v-if="repo.defaultBranchOverride"
        size="small"
        variant="text"
        :loading="saving"
        data-testid="clear-branch-override"
        @click.stop="clear"
      >
        Use GitHub's
      </v-btn>
    </div>
    <div v-if="error" class="text-caption text-error mt-1" data-testid="branch-override-error">{{ error }}</div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { updateRepo } from '@/services/api'

const props = defineProps({
  repo: { type: Object, required: true },
})
const emit = defineEmits(['updated'])

const draft = ref(props.repo.defaultBranchOverride || '')
const saving = ref(false)
const error = ref('')

watch(
  () => props.repo.defaultBranchOverride,
  (value) => {
    draft.value = value || ''
  },
)

async function apply(value) {
  saving.value = true
  error.value = ''
  try {
    const data = await updateRepo(props.repo.id, { defaultBranchOverride: value })
    emit('updated', data.repo)
  } catch (err) {
    error.value = err.message || 'Could not save the branch'
  } finally {
    saving.value = false
  }
}

function save() {
  const value = draft.value.trim()
  if (!value || value === props.repo.defaultBranchOverride) return
  apply(value)
}

function clear() {
  apply(null)
}
</script>
