import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listSharedAgentDefinitions,
  publishSharedAgentDefinition,
  readSharedAgentDefinition,
  saveSharedAgentDraft,
} from '../../../agent/yeaft/shared-agents/store.js';

const roots = [];
function root() {
  const value = mkdtempSync(join(tmpdir(), 'yeaft-shared-agent-'));
  roots.push(value);
  return value;
}
afterEach(() => roots.splice(0).forEach(value => rmSync(value, { recursive: true, force: true })));

const valid = {
  id: 'review-team',
  name: 'Review Team',
  description: 'Reviews changes',
  instruction: 'Review correctness and security.',
  roster: ['omni', 'reviewer'],
  defaultVpId: 'omni',
  workDir: 'C:\\work\\repo',
};

describe('Shared Agent definition store', () => {
  it('keeps drafts out of the catalog and published revisions immutable', () => {
    const dir = root();
    saveSharedAgentDraft(dir, valid);
    expect(listSharedAgentDefinitions(dir)).toEqual([]);

    const first = publishSharedAgentDefinition(dir, valid.id);
    expect(first.revision).toBe(1);
    saveSharedAgentDraft(dir, { ...valid, instruction: 'New instruction.' });
    const second = publishSharedAgentDefinition(dir, valid.id);

    expect(second.revision).toBe(2);
    expect(readSharedAgentDefinition(dir, valid.id, 1).instruction).toBe(valid.instruction);
    expect(readSharedAgentDefinition(dir, valid.id, 'latest').instruction).toBe('New instruction.');
    expect(JSON.parse(readFileSync(join(dir, 'shared-agents', valid.id, 'revisions', '1.json'), 'utf8')).instruction)
      .toBe(valid.instruction);
    expect(listSharedAgentDefinitions(dir)).toEqual([
      expect.objectContaining({ id: valid.id, revision: 2, name: valid.name }),
    ]);
  });

  it.each([
    [{ ...valid, id: '../escape' }, 'invalid_id'],
    [{ ...valid, name: '' }, 'invalid_name'],
    [{ ...valid, instruction: '' }, 'invalid_instruction'],
    [{ ...valid, roster: ['all'] }, 'invalid_vp_id'],
    [{ ...valid, roster: ['omni'], defaultVpId: 'reviewer' }, 'invalid_default_vp_id'],
  ])('rejects invalid definitions', (definition, code) => {
    expect(() => saveSharedAgentDraft(root(), definition)).toThrow(expect.objectContaining({ code }));
  });
});
