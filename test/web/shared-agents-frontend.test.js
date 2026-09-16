// @vitest-environment happy-dom
import { mount } from '@vue/test-utils';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Vue from 'vue';

let useSharedAgentsStore;
let YeaftSidebar;
let YeaftPage;
let AgentSettingsPanel;

const chatStore = Vue.reactive({
  agents: [],
  currentAgent: null,
  currentView: 'yeaft',
  connectionState: 'connected',
  sessionCatalogLoaded: true,
  sessionCatalog: [],
  activeSessionRoute: null,
  processingConversations: new Set(),
  agentOperations: {},
  agentDreamState: {},
  pinnedSessions: [],
  hiddenSessionCatalog: [],
  workCenterOpen: false,
  sendWsMessage: vi.fn(() => true),
  leaveWorkCenter: vi.fn(),
  setActiveSessionFilter: vi.fn(),
  selectAgent: vi.fn(),
  isYeaftSessionProcessing: () => false,
  isYeaftSessionUnread: () => false,
  getUpgradableAgents: () => [],
});
const sessionsStore = Vue.reactive({
  sessions: {}, activeSessionId: null, activeSessionKey: null, sessionList: [],
  setActive: vi.fn(),
  sessionById(id) { return Object.values(this.sessions).find(row => row.id === id) || null; },
  hasLoadedSnapshot: true,
  isEmpty: true,
});
const authStore = Vue.reactive({ role: 'pro' });

let activeSharedStore = null;
const defineStore = (_id, options) => () => {
  if (activeSharedStore) return activeSharedStore;
  const state = Vue.reactive(options.state());
  const store = state;
  for (const [name, getter] of Object.entries(options.getters || {})) {
    Object.defineProperty(store, name, { enumerable: true, get: () => getter.call(store, store) });
  }
  for (const [name, action] of Object.entries(options.actions || {})) store[name] = action.bind(store);
  activeSharedStore = store;
  return store;
};

beforeAll(async () => {
  globalThis.Vue = Vue;
  globalThis.Pinia = {
    defineStore,
    useChatStore: () => chatStore,
    useSessionsStore: () => sessionsStore,
    useAuthStore: () => authStore,
    useVpStore: () => ({ vpList: [], vpLabel: id => id }),
  };
  window.Pinia = globalThis.Pinia;
  ({ useSharedAgentsStore } = await import('../../web/stores/shared-agents.js'));
  globalThis.Pinia.useSharedAgentsStore = useSharedAgentsStore;
  ({ default: YeaftSidebar } = await import('../../web/components/YeaftSidebar.js'));
  ({ default: YeaftPage } = await import('../../web/components/YeaftPage.js'));
  ({ default: AgentSettingsPanel } = await import('../../web/components/AgentSettingsPanel.js'));
});

beforeEach(() => {
  activeSharedStore = null;
  chatStore.sendWsMessage.mockClear();
  chatStore.setActiveSessionFilter.mockClear();
  chatStore.leaveWorkCenter.mockClear();
  chatStore.selectAgent.mockClear();
  sessionsStore.setActive.mockClear();
  authStore.role = 'pro';
  globalThis.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ version: '' }) }));
});

describe('Shared Agents frontend', () => {
  it('keys definitions by Agent and only accepts exactly correlated replies', async () => {
    const store = useSharedAgentsStore();
    store.applyCatalog('agent-a', [{ id: 'reviewer', name: 'A', revision: 2 }]);
    store.applyCatalog('agent-b', [{ id: 'reviewer', name: 'B', revision: 7 }]);
    expect(store.definitionList.map(row => `${row.agentId}:${row.name}`)).toEqual(['agent-a:A', 'agent-b:B']);

    const request = store.loadCatalog('agent-a', { force: true });
    const frame = chatStore.sendWsMessage.mock.calls.at(-1)[0];
    expect(store.handleResult({ ...frame, type: 'yeaft_shared_agent_definition_result', agentId: 'agent-b', ok: true, definitions: [] })).toBe(false);
    expect(store.pending[frame.requestId]).toBeTruthy();
    expect(store.handleResult({ type: 'yeaft_shared_agent_definition_result', agentId: 'agent-a', requestId: frame.requestId, op: 'publish', ok: true })).toBe(false);
    expect(store.handleResult({ type: 'yeaft_shared_agent_definition_result', agentId: 'agent-a', requestId: frame.requestId, op: 'list', ok: true, definitions: [{ id: 'writer', revision: 3 }] })).toBe(true);
    await expect(request).resolves.toMatchObject({ ok: true, op: 'list' });
    expect(store.definitionList.find(row => row.agentId === 'agent-a').id).toBe('writer');
  });

  it('loads online inventories and sidebar selection enters pending Yeaft state', async () => {
    const shared = useSharedAgentsStore();
    shared.applyCatalog('agent-a', [{ id: 'reviewer', name: 'Reviewer', revision: 4 }]);
    chatStore.agents = [{ id: 'agent-a', name: 'A', online: true }];
    chatStore.currentAgent = 'agent-b';
    const wrapper = mount(YeaftSidebar, {
      props: { collapsed: false },
      global: {
        mocks: { $t: (key, vars) => vars?.revision != null ? `rev ${vars.revision}` : key },
        stubs: {
          SessionSidebarShell: { template: '<div><slot/><slot name="collapsed"/></div>' },
          SidebarAgentHeader: true,
          UnifiedSessionList: { template: '<div><slot name="before-recents"/></div>' },
          SessionCreateModal: true, SidebarModeToggle: true, SidebarWorkCenter: true,
        },
      },
    });
    expect(wrapper.text()).toContain('Reviewer');
    await wrapper.get('.shared-agent-sidebar-row').trigger('click');
    expect(shared.selected).toEqual({ agentId: 'agent-a', definitionId: 'reviewer', revision: 4, name: 'Reviewer' });
    expect(chatStore.selectAgent).toHaveBeenCalledWith('agent-a');
    expect(chatStore.setActiveSessionFilter).toHaveBeenCalledWith(null, { force: true });
    wrapper.unmount();
  });

  it('creates and activates once before first send, dedupes, and locks header to bound revision', async () => {
    const shared = useSharedAgentsStore();
    shared.applyCatalog('agent-a', [{ id: 'reviewer', name: 'Reviewer', revision: 4 }]);
    shared.selectDefinition(shared.definitionList[0]);
    let release;
    chatStore.createYeaftSession = vi.fn(() => new Promise(resolve => { release = resolve; }));
    chatStore.sendYeaftSessionMessage = vi.fn(() => true);
    chatStore.yeaftActiveSessionFilter = null;
    chatStore.yeaftVisibleMessages = [];
    chatStore.inputDrafts = {};
    chatStore._hasHandledAgentList = true;
    chatStore._hasHandledYeaftSessionHydrate = true;
    chatStore.getYeaftHistoryOutlineState = () => ({ results: [] });
    chatStore.yeaftHistorySearchState = {};
    chatStore.hasCapability = () => false;
    chatStore.yeaftAvailableModels = [];
    chatStore.yeaftActiveTasksBySession = {};
    const page = YeaftPage.setup();
    expect(page.topbarSessionTitle.value).toBe('Reviewer · rev 4');
    const first = page.sendMessage('hello');
    await Vue.nextTick();
    await expect(page.sendMessage('hello')).resolves.toBe(false);
    expect(chatStore.createYeaftSession).toHaveBeenCalledTimes(1);
    expect(chatStore.sendYeaftSessionMessage).not.toHaveBeenCalled();
    release({ ok: true, session: { id: 'session-new', agentId: 'agent-a', name: 'Reviewer', sharedAgentDefinitionId: 'reviewer', sharedAgentDefinitionRevision: 4 } });
    await expect(first).resolves.toBe(true);
    expect(sessionsStore.setActive).toHaveBeenCalledWith('session-new', 'agent-a');
    expect(chatStore.sendYeaftSessionMessage).toHaveBeenCalledTimes(1);
    expect(shared.selected).toBeNull();

    sessionsStore.sessions = { bound: { id: 'session-new', agentId: 'agent-a', name: 'Reviewer', sharedAgentDefinitionId: 'reviewer', sharedAgentDefinitionRevision: 4 } };
    chatStore.yeaftActiveSessionFilter = 'session-new';
    shared.applyCatalog('agent-a', [{ id: 'reviewer', name: 'Renamed latest', revision: 9 }]);
    expect(page.topbarSessionTitle.value).toBe('Reviewer · rev 4');
  });

  it('shows read access to non-admins but hides mutation controls', async () => {
    chatStore.agents = [{ id: 'agent-a', name: 'A', online: true }];
    chatStore.currentAgent = 'agent-a';
    const shared = useSharedAgentsStore();
    shared.applyCatalog('agent-a', [{ id: 'reviewer', name: 'Reviewer', revision: 1 }]);
    const mountPanel = () => mount(AgentSettingsPanel, {
      props: { initialAgentId: 'agent-a', initialCategory: 'shared-agents' },
      global: { mocks: { $t: key => key }, stubs: { ModernSelect: true, LlmTab: true, QuickSendSettings: true } },
    });
    let wrapper = mountPanel();
    await Vue.nextTick();
    expect(wrapper.text()).toContain('Reviewer');
    expect(wrapper.find('.shared-agents-editor').exists()).toBe(false);
    wrapper.unmount();
    authStore.role = 'admin';
    wrapper = mountPanel();
    await Vue.nextTick();
    expect(wrapper.find('.shared-agents-editor').exists()).toBe(true);
    wrapper.unmount();
  });
});
