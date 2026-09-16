import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSharedAgentSkillDiagnostics,
  listSharedAgentDefinitions,
  readSharedAgentDefinition,
  resolveSharedAgentSkillDirs,
  saveSharedAgentDefinition,
} from '../../../agent/yeaft/shared-agents/definition-store.js';
import { createSkillManager } from '../../../agent/yeaft/skills.js';
import { copySession, createSessionFromSpec, sessionsRoot } from '../../../agent/yeaft/sessions/session-crud.js';
import { createSession, loadSessionMeta } from '../../../agent/yeaft/sessions/session-store.js';

const roots = [];
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'yeaft-shared-agent-'));
  roots.push(root);
  return root;
}
function write(root, relativePath, content) {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}
function skill(name, body) {
  return `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}\n`;
}
function definition(repositoryPath) {
  return {
    id: 'gcs-oncall',
    name: 'GCS Shared On-call Agent',
    description: 'Shared teammate for Graph Connectors on-call.',
    instruction: 'Receive on-call questions, investigate with evidence, and remain read-only by default.',
    skillSources: [{
      repository: 'https://dev.azure.com/O365Exchange/O365%20Core/_git/GraphConnectors',
      repositoryPath,
      revision: '0a96251d50f0cca48bb5e3cb0145fe8b8f84433c',
      include: ['**/SKILL.md'],
    }],
    toolPolicy: {
      icm: 'read',
      kusto: 'read',
      monitoring: 'read',
      redis: 'approval-required',
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('SharedAgentDefinition store', () => {
  it('persists Agent-owned definitions with optimistic revisions', () => {
    const yeaftDir = tempRoot();
    const repository = tempRoot();
    write(repository, '.github/skills/triage/SKILL.md', skill('triage', 'Investigate the incident.'));

    const created = saveSharedAgentDefinition(yeaftDir, definition(repository), {
      expectedRevision: 0,
      now: '2026-09-16T00:00:00.000Z',
    });
    expect(created).toMatchObject({ id: 'gcs-oncall', revision: 1 });
    expect(readSharedAgentDefinition(yeaftDir, 'gcs-oncall')).toEqual(created);
    expect(listSharedAgentDefinitions(yeaftDir)).toEqual([created]);

    const updated = saveSharedAgentDefinition(yeaftDir, {
      ...created,
      description: 'Updated description',
    }, { expectedRevision: 1, now: '2026-09-17T00:00:00.000Z' });
    expect(updated).toMatchObject({ revision: 2, description: 'Updated description' });
    expect(readSharedAgentDefinition(yeaftDir, 'gcs-oncall', 1)).toEqual(created);
    expect(readSharedAgentDefinition(yeaftDir, 'gcs-oncall', 2)).toEqual(updated);
    expect(() => saveSharedAgentDefinition(yeaftDir, updated, { expectedRevision: 1 }))
      .toThrow('changed since it was read');
  });

  it('discovers every nested SKILL.md and reports same-name sources', () => {
    const yeaftDir = tempRoot();
    const repository = tempRoot();
    write(repository, '.github/skills/gcs-oncall/SKILL.md', skill('gcs-oncall', 'GITHUB_VERSION'));
    write(repository, '.agents/skills/gcs-oncall/SKILL.md', skill('gcs-oncall', 'AGENTS_VERSION'));
    write(repository, 'Tools/metrics/skills/monitor/SKILL.md', skill('monitor', 'MONITOR_VERSION'));
    const saved = saveSharedAgentDefinition(yeaftDir, definition(repository));

    const resolved = resolveSharedAgentSkillDirs(saved);
    expect(resolved.errors).toEqual([]);
    expect(resolved.sources).toHaveLength(3);
    const manager = createSkillManager(yeaftDir, '', { sharedAgentSources: resolved.sources });

    expect(manager.get('gcs-oncall').content).toBe('GITHUB_VERSION');
    expect(manager.get('monitor').content).toBe('MONITOR_VERSION');
    expect(manager.getPromptContent('monitor')).toContain(`Source repository root: ${repository}`);
    expect(manager.list().find(row => row.name === 'monitor')).toMatchObject({ tier: 'shared-agent', managed: false });
    expect(buildSharedAgentSkillDiagnostics(manager).conflicts).toEqual([
      expect.objectContaining({ name: 'gcs-oncall' }),
    ]);
  });

  it('keeps existing Sessions compatible and binds new Sessions to a definition revision', () => {
    const yeaftDir = tempRoot();
    const repository = tempRoot();
    write(repository, '.github/skills/triage/SKILL.md', skill('triage', 'TRIAGE'));
    saveSharedAgentDefinition(yeaftDir, definition(repository));

    const legacy = createSession(sessionsRoot(yeaftDir), {
      id: 'legacy-session', name: 'Legacy', roster: [], defaultVpId: null,
    });
    legacy.close();
    expect(loadSessionMeta(join(sessionsRoot(yeaftDir), 'legacy-session'))).toMatchObject({
      sharedAgentDefinitionId: '',
      sharedAgentDefinitionRevision: null,
    });

    const created = createSessionFromSpec(yeaftDir, {
      name: 'GCS incident',
      roster: [],
      sharedAgentDefinitionId: 'gcs-oncall',
    }, { preserveEmptyRoster: true, libDir: join(yeaftDir, 'virtual-persons') });
    expect(created).toMatchObject({
      sharedAgentDefinitionId: 'gcs-oncall',
      sharedAgentDefinitionRevision: 1,
    });

    saveSharedAgentDefinition(yeaftDir, {
      ...definition(repository),
      description: 'Newer definition revision',
    }, { expectedRevision: 1 });

    const copied = copySession(yeaftDir, created.id, {
      preserveEmptyRoster: true,
      libDir: join(yeaftDir, 'virtual-persons'),
    });
    expect(copied).toMatchObject({
      sharedAgentDefinitionId: 'gcs-oncall',
      sharedAgentDefinitionRevision: 1,
    });
  });
});
