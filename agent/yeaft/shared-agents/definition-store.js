import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
import { execFileSync } from 'node:child_process';
import { writeAtomic } from '../storage/atomic.js';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const DEFINITION_FILE = 'definition.json';
const DRAFT_FILE = 'draft.json';

export class SharedAgentDefinitionError extends Error {
  constructor(code, message, definitionId = null) {
    super(message || code);
    this.name = 'SharedAgentDefinitionError';
    this.code = code;
    this.definitionId = definitionId;
  }
}

export function sharedAgentDefinitionsRoot(yeaftDir) {
  return join(yeaftDir, 'shared-agents');
}

function definitionPath(yeaftDir, definitionId) {
  return join(sharedAgentDefinitionsRoot(yeaftDir), definitionId, DEFINITION_FILE);
}

function definitionRevisionPath(yeaftDir, definitionId, revision) {
  return join(sharedAgentDefinitionsRoot(yeaftDir), definitionId, 'revisions', `${revision}.json`);
}

function definitionDraftPath(yeaftDir, definitionId) {
  return join(sharedAgentDefinitionsRoot(yeaftDir), definitionId, DRAFT_FILE);
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeToolPolicy(input) {
  const policy = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const allowed = new Set(['disabled', 'read', 'approval-required', 'write']);
  const out = {};
  for (const [name, mode] of Object.entries(policy)) {
    const key = normalizeString(name);
    if (!key || !allowed.has(mode)) {
      throw new SharedAgentDefinitionError('invalid_tool_policy', `Invalid tool policy entry: ${name}`);
    }
    out[key] = mode;
  }
  return out;
}

function normalizeStringArray(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new SharedAgentDefinitionError(`invalid_${field}`, `${field} must be an array`);
  }
  return [...new Set(value.map(normalizeString).filter(Boolean))];
}

function normalizePermissions(input) {
  if (input == null) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SharedAgentDefinitionError('invalid_permissions', 'permissions must be an object');
  }
  return structuredClone(input);
}

function normalizeSkillSource(source, index) {
  const repositoryPath = normalizeString(source?.repositoryPath);
  if (!repositoryPath) {
    throw new SharedAgentDefinitionError('invalid_skill_source', `skillSources[${index}].repositoryPath is required`);
  }
  const include = Array.isArray(source?.include)
    ? source.include.map(normalizeString).filter(Boolean)
    : ['**/SKILL.md'];
  if (include.length === 0 || include.some(pattern => pattern !== '**/SKILL.md')) {
    throw new SharedAgentDefinitionError(
      'invalid_skill_source',
      `skillSources[${index}].include currently supports only **/SKILL.md`,
    );
  }
  return {
    repository: normalizeString(source?.repository),
    repositoryPath: resolve(repositoryPath),
    revision: normalizeString(source?.revision),
    include: ['**/SKILL.md'],
  };
}

export function normalizeSharedAgentDefinition(input, { previous = null, now = new Date().toISOString() } = {}) {
  const id = normalizeString(input?.id);
  if (!ID_RE.test(id)) {
    throw new SharedAgentDefinitionError('invalid_id', 'Shared Agent id must use lowercase letters, digits, and dashes', id || null);
  }
  const name = normalizeString(input?.name);
  if (!name) throw new SharedAgentDefinitionError('invalid_name', 'Shared Agent name is required', id);
  const instruction = normalizeString(input?.instruction);
  if (!instruction) throw new SharedAgentDefinitionError('invalid_instruction', 'Shared Agent instruction is required', id);
  const skillSources = Array.isArray(input?.skillSources)
    ? input.skillSources.map(normalizeSkillSource)
    : [];
  const previousRevision = Number(previous?.revision) || 0;
  return {
    id,
    name,
    description: normalizeString(input?.description),
    instruction,
    revision: previousRevision + 1,
    roster: normalizeStringArray(input?.roster, 'roster'),
    defaultVpId: normalizeString(input?.defaultVpId),
    workDir: normalizeString(input?.workDir),
    skills: normalizeStringArray(input?.skills, 'skills'),
    skillSources,
    toolPolicy: normalizeToolPolicy(input?.toolPolicy),
    permissions: normalizePermissions(input?.permissions),
    createdAt: previous?.createdAt || now,
    updatedAt: now,
  };
}

export function readSharedAgentDefinition(yeaftDir, definitionId, revision = null) {
  const id = normalizeString(definitionId);
  if (!ID_RE.test(id)) return null;
  const file = Number.isInteger(revision) && revision > 0
    ? definitionRevisionPath(yeaftDir, id, revision)
    : definitionPath(yeaftDir, id);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed?.id !== id || !Number.isInteger(parsed?.revision) || parsed.revision < 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function listSharedAgentDefinitions(yeaftDir) {
  const root = sharedAgentDefinitionsRoot(yeaftDir);
  if (!existsSync(root)) return [];
  const definitions = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
    const definition = readSharedAgentDefinition(yeaftDir, entry.name);
    if (definition) definitions.push(definition);
  }
  return definitions.sort((a, b) => a.name.localeCompare(b.name));
}

export function saveSharedAgentDefinition(yeaftDir, input, { expectedRevision = null, now } = {}) {
  const id = normalizeString(input?.id);
  const previous = readSharedAgentDefinition(yeaftDir, id);
  if (expectedRevision !== null && Number(expectedRevision) !== Number(previous?.revision || 0)) {
    throw new SharedAgentDefinitionError('revision_conflict', 'Shared Agent definition changed since it was read', id || null);
  }
  const definition = normalizeSharedAgentDefinition(input, { previous, now });
  const dir = join(sharedAgentDefinitionsRoot(yeaftDir), definition.id);
  const revisionsDir = join(dir, 'revisions');
  mkdirSync(revisionsDir, { recursive: true });
  const serialized = `${JSON.stringify(definition, null, 2)}\n`;
  const revisionFile = definitionRevisionPath(yeaftDir, definition.id, definition.revision);
  if (existsSync(revisionFile)) {
    throw new SharedAgentDefinitionError('revision_exists', 'Shared Agent revision already exists', definition.id);
  }
  writeAtomic(revisionFile, serialized);
  writeAtomic(join(dir, DEFINITION_FILE), serialized);
  return definition;
}

function readDraft(yeaftDir, definitionId) {
  const id = normalizeString(definitionId);
  if (!ID_RE.test(id)) return null;
  const file = definitionDraftPath(yeaftDir, id);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed?.id === id ? parsed : null;
  } catch {
    return null;
  }
}

/** Save an unpublished draft without changing the catalog's published revision. */
export function saveSharedAgentDraft(yeaftDir, input, { expectedRevision = null, now = new Date().toISOString() } = {}) {
  const id = normalizeString(input?.id);
  const published = readSharedAgentDefinition(yeaftDir, id);
  if (expectedRevision !== null && Number(expectedRevision) !== Number(published?.revision || 0)) {
    throw new SharedAgentDefinitionError('revision_conflict', 'Shared Agent definition changed since it was read', id || null);
  }
  const existingDraft = readDraft(yeaftDir, id);
  const merged = { ...(published || {}), ...(existingDraft || {}), ...(input || {}), id };
  const normalized = normalizeSharedAgentDefinition(merged, { previous: published, now });
  const draft = {
    ...normalized,
    baseRevision: Number(published?.revision || 0),
    revision: Number(published?.revision || 0) + 1,
  };
  const file = definitionDraftPath(yeaftDir, id);
  mkdirSync(dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify(draft, null, 2)}\n`);
  return draft;
}

/** Publish the current draft as the next immutable revision. */
export function publishSharedAgentDefinition(yeaftDir, definitionId, { expectedRevision = null, now } = {}) {
  const id = normalizeString(definitionId);
  const draft = readDraft(yeaftDir, id);
  if (!draft) throw new SharedAgentDefinitionError('draft_not_found', 'Shared Agent draft not found', id || null);
  const baseRevision = expectedRevision ?? draft.baseRevision ?? 0;
  return saveSharedAgentDefinition(yeaftDir, draft, { expectedRevision: baseRevision, now });
}

const IGNORED_SOURCE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.cache']);
const MAX_SOURCE_DIRECTORIES = 100_000;
const MAX_SOURCE_SKILLS = 2_000;

function collectSkillFiles(root) {
  const files = [];
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (++visited > MAX_SOURCE_DIRECTORIES) throw new Error('shared Skill source exceeds directory scan budget');
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = join(current, entry.name);
      if (entry.isFile() && entry.name === 'SKILL.md') {
        files.push(entryPath);
        if (files.length > MAX_SOURCE_SKILLS) throw new Error('shared Skill source exceeds Skill count budget');
      } else if (entry.isDirectory() && !IGNORED_SOURCE_DIRS.has(entry.name)) {
        pending.push(entryPath);
      }
    }
  }
  return files;
}

/** Resolve read-only repository roots containing directory-based Skills. */
export function resolveSharedAgentSkillDirs(definition) {
  const dirs = [];
  const sources = [];
  const errors = [];
  for (const source of definition?.skillSources || []) {
    const requestedRoot = resolve(source.repositoryPath || '');
    try {
      const stat = lstatSync(requestedRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('repositoryPath is not a regular directory');
      const repositoryRoot = realpathSync(requestedRoot);
      if (source.revision) {
        const head = execFileSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], {
          encoding: 'utf8', windowsHide: true, timeout: 10_000,
        }).trim();
        if (head !== source.revision) {
          throw new Error(`repository HEAD ${head} does not match pinned revision ${source.revision}`);
        }
        const dirty = execFileSync('git', ['-C', repositoryRoot, 'status', '--porcelain'], {
          encoding: 'utf8', windowsHide: true, timeout: 10_000,
        }).trim();
        if (dirty) throw new Error('repository checkout has uncommitted changes');
      }
      const files = collectSkillFiles(repositoryRoot);
      if (files.length === 0) {
        errors.push(`No SKILL.md files found under ${repositoryRoot}`);
      }
      for (const skillFile of files.sort()) {
        // SkillManager expects a root whose children are Skill directories.
        // Registering each SKILL.md parent independently also prevents a top-level
        // SKILL.md from suppressing discovery of nested sibling Skills.
        const skillDir = dirname(skillFile);
        if (!dirs.includes(skillDir)) {
          dirs.push(skillDir);
          sources.push({ dir: skillDir, repositoryRoot, exactSkillDir: true });
        }
      }
    } catch (error) {
      errors.push(`Cannot load shared Skill source ${requestedRoot}: ${error?.message || error}`);
    }
  }
  return { dirs, sources, errors };
}

export function buildSharedAgentSkillDiagnostics(skillManager) {
  const byName = new Map();
  for (const source of skillManager?.listSources?.() || []) {
    if (source.tier !== 'shared-agent') continue;
    const paths = byName.get(source.name) || new Set();
    paths.add(source.id);
    byName.set(source.name, paths);
  }
  const conflicts = [];
  for (const [name, paths] of byName) {
    if (paths.size > 1) conflicts.push({ name, sources: [...paths].sort() });
  }
  return { conflicts: conflicts.sort((a, b) => a.name.localeCompare(b.name)) };
}
