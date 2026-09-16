import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveBundledGcsOncallRepository,
  seedBundledSharedAgentDefinitions,
} from '../../../agent/yeaft/shared-agents/bundled-definitions.js';
import {
  listSharedAgentDefinitions,
  resolveSharedAgentSkillDirs,
} from '../../../agent/yeaft/shared-agents/definition-store.js';

const roots = [];

function tempRoot(prefix = 'yeaft-gcs-seed-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function write(root, relativePath, content) {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return file;
}

function git(repositoryPath, ...args) {
  return execFileSync('git', ['-C', repositoryPath, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function createRepository() {
  const repositoryPath = tempRoot('yeaft-gcs-repository-');
  git(repositoryPath, 'init');
  git(repositoryPath, 'config', 'user.email', 'shared-agent@example.test');
  git(repositoryPath, 'config', 'user.name', 'Shared Agent Test');
  write(repositoryPath, '.github/skills/triage/SKILL.md', '---\nname: triage\ndescription: Triage\n---\n\nTracked skill.\n');
  git(repositoryPath, 'add', '.');
  git(repositoryPath, 'commit', '-m', 'fixture');
  return { repositoryPath, revision: git(repositoryPath, 'rev-parse', 'HEAD') };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bundled GCS On-call definition', () => {
  it('seeds from the pinned checkout while ignoring untracked files and Skills', () => {
    const yeaftDir = tempRoot();
    const { repositoryPath, revision } = createRepository();
    write(repositoryPath, 'notes.txt', 'local note');
    const untrackedSkill = write(
      repositoryPath,
      '.agents/skills/untracked/SKILL.md',
      '---\nname: untracked\ndescription: Untracked\n---\n\nMust not load.\n',
    );

    expect(resolveBundledGcsOncallRepository('', {
      YEAFT_GCS_ONCALL_REPOSITORY: repositoryPath,
    }, revision)).toBe(repositoryPath);

    const result = seedBundledSharedAgentDefinitions(yeaftDir, {
      env: { YEAFT_GCS_ONCALL_REPOSITORY: repositoryPath },
      repositoryRevision: revision,
      now: '2026-09-16T00:00:00.000Z',
    });

    expect(result.created).toEqual([
      expect.objectContaining({ id: 'gcs-oncall', name: 'GCS On-call', revision: 1 }),
    ]);
    expect(listSharedAgentDefinitions(yeaftDir)).toHaveLength(1);
    expect(existsSync(join(yeaftDir, 'shared-agents', 'gcs-oncall', 'definition.json'))).toBe(true);
    expect(existsSync(join(yeaftDir, 'shared-agents', 'gcs-oncall', 'revisions', '1.json'))).toBe(true);

    const resolved = resolveSharedAgentSkillDirs(result.created[0]);
    expect(resolved.errors).toEqual([]);
    expect(resolved.dirs).toEqual([join(repositoryPath, '.github', 'skills', 'triage')]);
    expect(resolved.dirs).not.toContain(dirname(untrackedSkill));
  });

  it('rejects a pinned checkout with tracked changes', () => {
    const yeaftDir = tempRoot();
    const { repositoryPath, revision } = createRepository();
    write(repositoryPath, '.github/skills/triage/SKILL.md', 'modified tracked skill');

    const result = seedBundledSharedAgentDefinitions(yeaftDir, {
      env: { YEAFT_GCS_ONCALL_REPOSITORY: repositoryPath },
      repositoryRevision: revision,
    });

    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 'gcs-oncall', reason: 'pinned GraphConnectors checkout not found or not clean' },
    ]);
    expect(listSharedAgentDefinitions(yeaftDir)).toEqual([]);
  });

  it('preserves an existing definition without creating another revision', () => {
    const yeaftDir = tempRoot();
    const { repositoryPath, revision } = createRepository();
    const options = {
      env: { YEAFT_GCS_ONCALL_REPOSITORY: repositoryPath },
      repositoryRevision: revision,
    };

    expect(seedBundledSharedAgentDefinitions(yeaftDir, options).created[0].revision).toBe(1);
    expect(seedBundledSharedAgentDefinitions(yeaftDir, options)).toEqual({
      created: [],
      preserved: ['gcs-oncall'],
      skipped: [],
    });
    expect(existsSync(join(yeaftDir, 'shared-agents', 'gcs-oncall', 'revisions', '2.json'))).toBe(false);
  });
});
