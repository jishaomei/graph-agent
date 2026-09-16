const { defineStore } = Pinia;

const REQUEST_TIMEOUT_MS = 10_000;
const SEP = '\u001f';

export function sharedAgentDefinitionKey(agentId, definitionId) {
  return `${agentId || ''}${SEP}${definitionId || ''}`;
}

function revisionOf(definition) {
  const value = Number(definition?.revision);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeDefinition(definition, agentId) {
  if (!definition || !definition.id) return null;
  return {
    ...definition,
    id: String(definition.id),
    agentId: definition.agentId || agentId || null,
    revision: revisionOf(definition),
  };
}

function errorMessage(error, fallback) {
  if (typeof error === 'string' && error) return error;
  if (error?.message) return error.message;
  if (error?.code) return error.code;
  return fallback;
}

export const useSharedAgentsStore = defineStore('sharedAgents', {
  state: () => ({
    definitions: {},
    definitionOrderByAgent: {},
    loadingByAgent: {},
    errorByAgent: {},
    loadedAgents: {},
    selected: null,
    pending: {},
    _requestSequence: 0,
  }),

  getters: {
    definitionList(state) {
      return Object.entries(state.definitionOrderByAgent).flatMap(([agentId, keys]) => (
        keys.map(key => state.definitions[key]).filter(row => row?.agentId === agentId)
      ));
    },
    selectedDefinition(state) {
      const selected = state.selected;
      if (!selected) return null;
      const row = state.definitions[sharedAgentDefinitionKey(selected.agentId, selected.definitionId)];
      return row ? { ...row, revision: selected.revision, name: selected.name || row.name } : { ...selected, id: selected.definitionId };
    },
    isLoading(state) {
      return Object.values(state.loadingByAgent).some(Boolean);
    },
  },

  actions: {
    _chatStore() {
      try { return window.Pinia?.useChatStore?.() || null; }
      catch { return null; }
    },

    _requestId() {
      this._requestSequence += 1;
      return `sad_${Date.now().toString(36)}_${this._requestSequence.toString(36)}`;
    },

    request(op, data = {}, { agentId, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
      if (!agentId) return Promise.resolve({ ok: false, op, error: { code: 'agent_required', message: 'Agent is required' } });
      const chat = this._chatStore();
      if (!chat?.sendWsMessage) return Promise.resolve({ ok: false, op, error: { code: 'offline', message: 'WebSocket is unavailable' } });
      const requestId = this._requestId();
      const message = { type: 'yeaft_shared_agent_definition', agentId, requestId, op, ...data };
      if (op === 'list') {
        this.loadingByAgent[agentId] = true;
        this.errorByAgent[agentId] = null;
      }
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          const pending = this.pending[requestId];
          if (!pending) return;
          delete this.pending[requestId];
          if (op === 'list') {
            this.loadingByAgent[agentId] = false;
            this.errorByAgent[agentId] = 'Shared Agents request timed out';
          }
          resolve({ ok: false, op, error: { code: 'timeout', message: 'Shared Agents request timed out' } });
        }, timeoutMs);
        this.pending[requestId] = { requestId, agentId, op, timer, resolve };
        if (!chat.sendWsMessage(message)) {
          clearTimeout(timer);
          delete this.pending[requestId];
          if (op === 'list') this.loadingByAgent[agentId] = false;
          resolve({ ok: false, op, error: { code: 'offline', message: 'WebSocket is unavailable' } });
        }
      });
    },

    handleResult(message) {
      if (!message?.requestId) return false;
      const pending = this.pending[message.requestId];
      if (!pending || pending.agentId !== message.agentId || pending.op !== message.op) return false;
      clearTimeout(pending.timer);
      delete this.pending[message.requestId];
      const result = {
        ok: message.ok === true,
        op: message.op,
        definitions: message.definitions,
        definition: message.definition,
        error: message.error || null,
      };
      if (pending.op === 'list') {
        this.loadingByAgent[pending.agentId] = false;
        if (result.ok) {
          this.applyCatalog(pending.agentId, result.definitions || []);
          this.loadedAgents[pending.agentId] = true;
          this.errorByAgent[pending.agentId] = null;
        } else {
          this.errorByAgent[pending.agentId] = errorMessage(result.error, 'Failed to load Shared Agents');
        }
      } else if (result.ok && result.definition) {
        this.upsertDefinition(pending.agentId, result.definition);
      }
      pending.resolve(result);
      return true;
    },

    applyCatalog(agentId, definitions) {
      const rows = (Array.isArray(definitions) ? definitions : [])
        .map(row => normalizeDefinition(row, agentId))
        .filter(Boolean);
      const next = { ...this.definitions };
      for (const key of this.definitionOrderByAgent[agentId] || []) delete next[key];
      const keys = [];
      for (const row of rows) {
        const key = sharedAgentDefinitionKey(agentId, row.id);
        next[key] = row;
        keys.push(key);
      }
      this.definitions = next;
      this.definitionOrderByAgent = { ...this.definitionOrderByAgent, [agentId]: keys };
      this.loadedAgents[agentId] = true;
    },

    upsertDefinition(agentId, definition) {
      const row = normalizeDefinition(definition, agentId);
      if (!row) return null;
      const key = sharedAgentDefinitionKey(agentId, row.id);
      this.definitions = { ...this.definitions, [key]: row };
      if (!(this.definitionOrderByAgent[agentId] || []).includes(key)) {
        this.definitionOrderByAgent = {
          ...this.definitionOrderByAgent,
          [agentId]: [...(this.definitionOrderByAgent[agentId] || []), key],
        };
      }
      return row;
    },

    async loadCatalog(agentId, { force = false } = {}) {
      if (!agentId || this.loadingByAgent[agentId]) return null;
      if (!force && this.loadedAgents[agentId]) return this.definitionOrderByAgent[agentId] || [];
      return this.request('list', {}, { agentId });
    },

    loadOnlineCatalogs(agents, options = {}) {
      const onlineIds = (Array.isArray(agents) ? agents : [])
        .filter(agent => agent?.online && agent.id)
        .map(agent => agent.id);
      return Promise.all(onlineIds.map(agentId => this.loadCatalog(agentId, options)));
    },

    selectDefinition(definition) {
      if (!definition?.agentId || !definition?.id) return false;
      const revision = revisionOf(definition);
      this.selected = {
        agentId: definition.agentId,
        definitionId: definition.id,
        revision,
        name: definition.name || definition.id,
      };
      return true;
    },

    clearSelection() {
      this.selected = null;
    },

    saveDraft(agentId, definition) {
      return this.request('save', { definition }, { agentId });
    },

    publish(agentId, definitionId) {
      return this.request('publish', { definitionId }, { agentId });
    },
  },
});
