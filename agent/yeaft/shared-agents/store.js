// Compatibility facade for the Shared Agent management API.
// Persistence and validation are owned by definition-store.js.
export {
  SharedAgentDefinitionError as SharedAgentStoreError,
  listSharedAgentDefinitions,
  normalizeSharedAgentDefinition,
  publishSharedAgentDefinition,
  readSharedAgentDefinition,
  saveSharedAgentDraft,
} from './definition-store.js';
