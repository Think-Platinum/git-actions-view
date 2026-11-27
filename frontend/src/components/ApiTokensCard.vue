<template>
  <!-- API tokens (#9). Only meaningful when authentication is enabled. -->
  <v-card v-if="authRequired" class="mb-4" variant="outlined" data-testid="api-tokens-card">
    <v-card-title class="text-subtitle-1 d-flex align-center">
      <v-icon class="mr-2">mdi-key-variant</v-icon>
      API tokens
      <v-spacer />
      <v-btn size="small" variant="tonal" prepend-icon="mdi-plus" data-testid="create-token" @click="openCreate">
        Create token
      </v-btn>
    </v-card-title>
    <v-card-text>
      <p class="text-body-2 text-medium-emphasis mb-3">
        Read-only tokens for headless clients. Send as <code>Authorization: Bearer gav_...</code>.
      </p>

      <v-progress-linear v-if="loading" indeterminate class="mb-2" />
      <v-alert v-if="loadError" type="error" variant="tonal" density="compact" class="mb-2">
        {{ loadError }}
        <template #append>
          <v-btn size="small" variant="text" @click="load">Retry</v-btn>
        </template>
      </v-alert>

      <v-table v-if="tokens.length" density="compact">
        <thead>
          <tr>
            <th>Name</th>
            <th>Prefix</th>
            <th>Created</th>
            <th>Last used</th>
            <th>Status</th>
            <th class="text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="t in tokens"
            :key="t.id"
            :class="{ 'text-disabled': t.revokedAt }"
            :data-testid="`token-row-${t.id}`"
          >
            <td>{{ t.name }}</td>
            <td><code>{{ t.prefix }}...</code></td>
            <td>{{ formatDate(t.createdAt) }}</td>
            <td>{{ t.lastUsedAt ? formatDate(t.lastUsedAt) : 'Never' }}</td>
            <td>
              <v-chip size="small" :color="t.revokedAt ? undefined : 'success'" variant="tonal">
                {{ t.revokedAt ? 'Revoked' : 'Active' }}
              </v-chip>
            </td>
            <td class="text-right">
              <v-btn
                v-if="!t.revokedAt"
                size="small"
                variant="text"
                color="error"
                :aria-label="`Revoke token ${t.name}`"
                :data-testid="`revoke-${t.id}`"
                @click="askRevoke(t)"
              >
                Revoke
              </v-btn>
            </td>
          </tr>
        </tbody>
      </v-table>
      <p v-else-if="!loading && !loadError" class="text-body-2 text-medium-emphasis" data-testid="tokens-empty">
        No API tokens yet.
      </p>
    </v-card-text>

    <!-- Create: step 1 asks for a name, step 2 shows the value once. -->
    <v-dialog v-model="showCreate" max-width="520" :persistent="!!createdToken">
      <v-card>
        <v-card-title>{{ createdToken ? 'Token created' : 'Create API token' }}</v-card-title>
        <v-card-text v-if="!createdToken">
          <v-text-field
            v-model="newName"
            label="Name"
            hint="What will use it, for example the WLED agent"
            :counter="100"
            maxlength="100"
            autofocus
            data-testid="token-name"
            @keyup.enter="submitCreate"
          />
          <v-alert v-if="createError" type="error" variant="tonal" density="compact">{{ createError }}</v-alert>
        </v-card-text>
        <v-card-text v-else>
          <v-alert type="warning" variant="tonal" density="compact" class="mb-3" id="token-warning">
            This is the only time the full token is shown. Store it now.
          </v-alert>
          <v-text-field
            :model-value="createdToken"
            readonly
            variant="outlined"
            class="token-value"
            aria-describedby="token-warning"
            data-testid="token-value"
          />
          <div aria-live="polite" class="text-caption" data-testid="copy-status">{{ copyStatus }}</div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <template v-if="!createdToken">
            <v-btn variant="text" @click="closeCreate">Cancel</v-btn>
            <v-btn
              color="primary"
              variant="flat"
              :loading="creating"
              :disabled="!newName.trim()"
              data-testid="submit-create"
              @click="submitCreate"
            >
              Create
            </v-btn>
          </template>
          <template v-else>
            <v-btn variant="tonal" prepend-icon="mdi-content-copy" data-testid="copy-token" @click="copyToken">Copy</v-btn>
            <v-btn color="primary" variant="flat" data-testid="done-create" @click="closeCreate">Done</v-btn>
          </template>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Revoke confirmation -->
    <v-dialog v-model="showRevoke" max-width="420">
      <v-card>
        <v-card-title>Revoke token?</v-card-title>
        <v-card-text>
          <strong>{{ tokenToRevoke?.name }}</strong> will stop working immediately, and any event streams it holds
          will close. This cannot be undone.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="showRevoke = false">Cancel</v-btn>
          <v-btn color="error" variant="flat" :loading="revoking" data-testid="confirm-revoke" @click="confirmRevoke">
            Revoke
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { fetchConfig, fetchApiTokens, createApiToken, revokeApiToken } from '@/services/api'

const authRequired = ref(false)
const tokens = ref([])
const loading = ref(false)
const loadError = ref('')

const showCreate = ref(false)
const newName = ref('')
const creating = ref(false)
const createError = ref('')
// Held only while the dialog shows; cleared on close and never re-fetchable.
const createdToken = ref('')
const copyStatus = ref('')

const showRevoke = ref(false)
const tokenToRevoke = ref(null)
const revoking = ref(false)

function formatDate(iso) {
  return iso ? new Date(iso).toLocaleString() : ''
}

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const data = await fetchApiTokens()
    tokens.value = data.tokens || []
  } catch (err) {
    loadError.value = err.message || 'Could not load tokens'
  } finally {
    loading.value = false
  }
}

function openCreate() {
  newName.value = ''
  createError.value = ''
  createdToken.value = ''
  copyStatus.value = ''
  showCreate.value = true
}

async function submitCreate() {
  if (!newName.value.trim() || creating.value) return
  creating.value = true
  createError.value = ''
  try {
    const created = await createApiToken(newName.value.trim())
    createdToken.value = created.token
    await load()
  } catch (err) {
    createError.value = err.message || 'Could not create token'
  } finally {
    creating.value = false
  }
}

async function copyToken() {
  try {
    await navigator.clipboard.writeText(createdToken.value)
    copyStatus.value = 'Copied'
  } catch {
    copyStatus.value = 'Copy failed. Select the token and copy it manually.'
  }
}

function closeCreate() {
  createdToken.value = ''
  copyStatus.value = ''
  newName.value = ''
  showCreate.value = false
}

function askRevoke(token) {
  tokenToRevoke.value = token
  showRevoke.value = true
}

async function confirmRevoke() {
  if (!tokenToRevoke.value) return
  revoking.value = true
  try {
    await revokeApiToken(tokenToRevoke.value.id)
    showRevoke.value = false
    tokenToRevoke.value = null
    await load()
  } catch (err) {
    loadError.value = err.message || 'Could not revoke token'
  } finally {
    revoking.value = false
  }
}

onMounted(async () => {
  try {
    const config = await fetchConfig()
    authRequired.value = !!config.authRequired
  } catch {
    authRequired.value = false
  }
  if (authRequired.value) await load()
})
</script>

<style scoped>
.token-value :deep(input) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  user-select: all;
}
</style>
