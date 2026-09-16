export default {
  name: 'SharedAgentsSettings',
  props: {
    agentId: { type: String, default: null },
    canManage: { type: Boolean, default: false },
  },
  emits: ['saved'],
  template: `
    <section class="agent-settings-section shared-agents-manager">
      <div class="agent-settings-section-heading">
        <div>
          <h4>{{ $t('sharedAgents.manager.title') }}</h4>
          <p>{{ $t('sharedAgents.manager.description') }}</p>
        </div>
        <button type="button" class="btn-ghost" :disabled="loading || !agentId" @click="load(true)">{{ $t('common.refresh') }}</button>
      </div>
      <div v-if="loading" class="agent-settings-loading"><span class="spinner-mini"></span> {{ $t('common.loading') }}</div>
      <div v-else class="shared-agents-manager-list">
        <button
          v-for="definition in definitions"
          :key="definition.id"
          type="button"
          class="shared-agents-manager-row"
          :class="{ active: draft.id === definition.id }"
          @click="edit(definition)"
        >
          <span>{{ definition.name || definition.id }}</span>
          <small>{{ $t('sharedAgents.revision', { revision: definition.revision }) }}</small>
        </button>
        <p v-if="definitions.length === 0" class="agent-settings-inline-message">{{ $t('sharedAgents.empty') }}</p>
      </div>

      <form v-if="canManage" class="shared-agents-editor" @submit.prevent="save">
        <label><span>{{ $t('sharedAgents.manager.id') }}</span><input v-model.trim="draft.id" required></label>
        <label><span>{{ $t('sharedAgents.manager.name') }}</span><input v-model.trim="draft.name" required></label>
        <label class="shared-agents-editor-instruction"><span>{{ $t('sharedAgents.manager.instruction') }}</span><textarea v-model="draft.instruction" rows="8" required></textarea></label>
        <div class="agent-settings-save-row">
          <span v-if="message" :class="{ error: messageError }">{{ message }}</span>
          <button type="submit" class="btn-secondary" :disabled="saving || !draft.id || !draft.name || !draft.instruction">{{ saving ? $t('common.saving') : $t('sharedAgents.manager.saveDraft') }}</button>
          <button type="button" class="btn-primary" :disabled="saving || !draft.id" @click="publish">{{ $t('sharedAgents.manager.publish') }}</button>
        </div>
      </form>
      <p v-else class="agent-settings-inline-message">{{ $t('sharedAgents.manager.readOnly') }}</p>
    </section>
  `,
  data() {
    return {
      draft: { id: '', name: '', instruction: '' },
      saving: false,
      message: '',
      messageError: false,
    };
  },
  computed: {
    store() { return Pinia.useSharedAgentsStore(); },
    definitions() { return (this.store.definitionList || []).filter(row => row.agentId === this.agentId); },
    loading() { return !!this.store.loadingByAgent?.[this.agentId]; },
  },
  watch: {
    agentId: {
      immediate: true,
      handler() { this.load(); },
    },
  },
  methods: {
    load(force = false) {
      if (this.agentId) return this.store.loadCatalog(this.agentId, { force });
      return null;
    },
    edit(definition) {
      this.draft = {
        id: definition?.id || '',
        name: definition?.name || '',
        instruction: definition?.instruction || '',
      };
      this.message = '';
    },
    async save() {
      if (!this.canManage || !this.agentId || this.saving) return;
      this.saving = true;
      this.message = '';
      const result = await this.store.saveDraft(this.agentId, { ...this.draft });
      this.saving = false;
      this.messageError = !result?.ok;
      this.message = result?.ok ? this.$t('sharedAgents.manager.saved') : (result?.error?.message || this.$t('sharedAgents.manager.saveFailed'));
      if (result?.ok) this.$emit('saved', this.agentId);
    },
    async publish() {
      if (!this.canManage || !this.agentId || !this.draft.id || this.saving) return;
      this.saving = true;
      this.message = '';
      const result = await this.store.publish(this.agentId, this.draft.id);
      this.saving = false;
      this.messageError = !result?.ok;
      this.message = result?.ok ? this.$t('sharedAgents.manager.published') : (result?.error?.message || this.$t('sharedAgents.manager.publishFailed'));
      if (result?.ok) this.$emit('saved', this.agentId);
    },
  },
};
