import { getAgentInstallerCommand } from '../utils/agentSetup.js';

const COPY_RESET_MS = 2000;

export default {
  props: {
    agentSecret: { type: String, default: '' },
    loading: { type: Boolean, default: false },
    error: { type: String, default: '' },
    showSettingsLink: { type: Boolean, default: true },
  },
  emits: ['open-settings'],
  data() {
    return {
      platform: 'posix',
      copyState: 'idle',
      copyTimer: null,
    };
  },
  computed: {
    command() {
      if (!this.agentSecret) return '';
      return getAgentInstallerCommand({
        platform: this.platform,
        agentSecret: this.agentSecret,
        locationLike: globalThis.location,
      });
    },
    copyLabel() {
      if (this.copyState === 'copying') return this.$t('installer.copying');
      if (this.copyState === 'copied') return this.$t('common.copied');
      if (this.copyState === 'error') return this.$t('installer.copyFailed');
      return this.$t('common.copy');
    },
    statusText() {
      if (this.loading) return this.$t('installer.secretLoading');
      if (this.error) return this.$t('installer.secretError');
      if (!this.agentSecret) return this.$t('installer.secretRequired');
      if (this.copyState === 'error') return this.$t('installer.copyError');
      if (this.copyState === 'copied') return this.$t('installer.copySuccess');
      return '';
    },
  },
  beforeUnmount() {
    if (this.copyTimer) clearTimeout(this.copyTimer);
  },
  methods: {
    selectPlatform(platform) {
      this.platform = platform;
      this.copyState = 'idle';
    },
    async copyCommand() {
      if (!this.command || this.loading || this.copyState === 'copying') return;
      this.copyState = 'copying';
      try {
        await navigator.clipboard.writeText(this.command);
        this.copyState = 'copied';
      } catch {
        this.copyState = 'error';
      }
      if (this.copyTimer) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => { this.copyState = 'idle'; }, COPY_RESET_MS);
    },
  },
  template: `
    <div class="agent-installer">
      <div class="agent-installer-tabs" role="tablist" :aria-label="$t('installer.platformLabel')">
        <button
          type="button"
          class="agent-installer-tab"
          :class="{ active: platform === 'posix' }"
          role="tab"
          :aria-selected="platform === 'posix'"
          @click="selectPlatform('posix')"
        >{{ $t('installer.posix') }}</button>
        <button
          type="button"
          class="agent-installer-tab"
          :class="{ active: platform === 'powershell' }"
          role="tab"
          :aria-selected="platform === 'powershell'"
          @click="selectPlatform('powershell')"
        >{{ $t('installer.powershell') }}</button>
      </div>
      <div class="agent-installer-command" :class="{ 'is-unavailable': !command }">
        <code>{{ command || $t('installer.commandUnavailable') }}</code>
        <button
          type="button"
          class="btn-secondary agent-installer-copy"
          :disabled="!command || loading || copyState === 'copying'"
          @click="copyCommand"
        >{{ copyLabel }}</button>
      </div>
      <p class="agent-installer-status" :class="{ 'is-error': error || copyState === 'error' }" aria-live="polite">
        {{ statusText }}
        <button v-if="showSettingsLink && !loading && !agentSecret" type="button" class="agent-installer-settings" @click="$emit('open-settings')">
          {{ $t('installer.openSecurity') }}
        </button>
      </p>
      <p class="agent-installer-note">{{ $t('installer.note') }}</p>
    </div>
  `,
};
