import { afterEach, describe, expect, it, vi } from 'vitest';

const forwardToAgent = vi.fn(async () => true);
const sendToWebClient = vi.fn(async (client, message) => { client.sent ??= []; client.sent.push(message); });
vi.mock('../../server/ws-utils.js', () => ({
  forwardToAgent,
  sendToWebClient,
  broadcastAgentList: vi.fn(),
  broadcastSessionCatalog: vi.fn(),
  buildSessionCatalog: vi.fn(() => []),
  buildHiddenSessionCatalog: vi.fn(() => []),
  verifyConversationOwnership: vi.fn(() => true),
  verifyAgentOwnership: vi.fn(() => true),
  forwardToClients: vi.fn(),
  sendToAgent: vi.fn(),
}));
vi.mock('../../server/database.js', () => ({
  sessionDb: { get: vi.fn(() => null) }, messageDb: {}, userDb: {},
  yeaftProjectDb: { list: vi.fn(() => []), listForAgent: vi.fn(() => []) },
  yeaftSessionDb: { getByUser: vi.fn(() => []), getByAgent: vi.fn(() => []) },
  sessionUiMetadataDb: {}, userStatsDb: {},
}));
vi.mock('../../server/handlers/session-pin-router.js', () => ({ routeSessionPin: vi.fn(() => false) }));

const { agents, webClients } = await import('../../server/context.js');
const { handleClientConversation } = await import('../../server/handlers/client-conversation.js');
const { handleAgentOutput } = await import('../../server/handlers/agent-output.js');
const allow = async () => true;

function client(role = 'user', userId = 'owner-1') {
  return { authenticated: true, role, userId, currentAgent: 'agent-1', sent: [] };
}

afterEach(() => {
  forwardToAgent.mockClear();
  sendToWebClient.mockClear();
  agents.clear();
  webClients.clear();
});

describe('Shared Agent Server relay', () => {
  it('requires admin for mutations and request-scopes allowed reads', async () => {
    const ordinary = client('user');
    webClients.set('client-1', ordinary);
    await handleClientConversation('client-1', ordinary, {
      type: 'yeaft_shared_agent_definition', agentId: 'agent-1', op: 'save', requestId: 'save-1', definition: {},
    }, allow);
    expect(forwardToAgent).not.toHaveBeenCalled();
    expect(ordinary.sent.at(-1)).toMatchObject({ ok: false, error: { code: 'admin_required' } });

    await handleClientConversation('client-1', ordinary, {
      type: 'yeaft_shared_agent_definition', agentId: 'agent-1', op: 'list', requestId: 'list-1',
    }, allow);
    expect(forwardToAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      type: 'yeaft_shared_agent_definition', op: 'list', _requestClientId: 'client-1',
    }));

    forwardToAgent.mockClear();
    const admin = client('admin');
    webClients.set('admin-1', admin);
    await handleClientConversation('admin-1', admin, {
      type: 'yeaft_shared_agent_definition', agentId: 'agent-1', op: 'publish', id: 'team', requestId: 'pub-1',
    }, allow);
    expect(forwardToAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      op: 'publish', _requestClientId: 'admin-1',
    }));
  });

  it('delivers definition payloads only to the correlated owner client', async () => {
    const requested = client('user', 'owner-1');
    const otherOwnerTab = client('user', 'owner-1');
    const foreign = client('user', 'owner-2');
    webClients.set('requested', requested);
    webClients.set('other', otherOwnerTab);
    webClients.set('foreign', foreign);
    const agent = { ownerId: 'owner-1' };

    await handleAgentOutput('agent-1', agent, {
      type: 'yeaft_shared_agent_definition_result',
      _requestClientId: 'requested',
      requestId: 'read-1', op: 'read', ok: true,
      definition: { id: 'team', instruction: 'sensitive instruction' },
    });
    expect(requested.sent).toEqual([expect.objectContaining({ definition: expect.objectContaining({ id: 'team' }) })]);
    expect(otherOwnerTab.sent).toEqual([]);
    expect(foreign.sent).toEqual([]);
  });
});
