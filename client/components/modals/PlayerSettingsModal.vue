<template>
  <modals-modal v-model="show" name="player-settings" :width="500" :height="'unset'">
    <div ref="container" class="w-full rounded-lg bg-bg box-shadow-md overflow-y-auto overflow-x-hidden p-4" style="max-height: 80vh; min-height: 40vh">
      <h3 class="text-xl font-semibold mb-8">{{ $strings.HeaderPlayerSettings }}</h3>
      <div class="flex items-center mb-4">
        <ui-toggle-switch v-model="useChapterTrack" @input="setUseChapterTrack" />
        <div class="pl-4">
          <span>{{ $strings.LabelUseChapterTrack }}</span>
        </div>
      </div>
      <div class="flex items-center mb-4">
        <ui-toggle-switch v-model="readAlongMediaSession" @input="setReadAlongMediaSession" />
        <div class="pl-4">
          <span>{{ $strings.LabelReadAlongMediaSession }}</span>
        </div>
      </div>
      <div class="flex items-center mb-4">
        <ui-select-input v-model="jumpForwardAmount" :label="$strings.LabelJumpForwardAmount" menuMaxHeight="250px" :items="jumpValues" @input="setJumpForwardAmount" />
      </div>
      <div class="flex items-center mb-4">
        <ui-select-input v-model="jumpBackwardAmount" :label="$strings.LabelJumpBackwardAmount" menuMaxHeight="250px" :items="jumpValues" @input="setJumpBackwardAmount" />
      </div>
      <div class="flex items-center mb-4">
        <ui-select-input v-model="playbackRateIncrementDecrement" :label="$strings.LabelPlaybackRateIncrementDecrement" menuMaxHeight="250px" :items="playbackRateIncrementDecrementValues" @input="setPlaybackRateIncrementDecrementAmount" />
      </div>
      <div class="flex items-center mb-4">
        <ui-select-input v-model="transcriptEngine" :label="$strings.LabelTranscriptEngine" :items="transcriptEngineValues" @input="setTranscriptEngine" />
      </div>
      <div v-if="transcriptEngine === 'helper'" class="mb-4">
        <div class="flex items-end">
          <ui-text-input-with-label v-model.trim="transcriptHelperUrl" :label="$strings.LabelTranscriptHelperUrl" :note="$strings.LabelTranscriptHelperUrlNote" class="grow" @blur="setTranscriptHelperUrl" />
          <ui-btn small class="ml-2 h-9" :loading="transcriptHelper.checking" @click="setTranscriptHelperUrl">{{ $strings.ButtonTest }}</ui-btn>
        </div>
        <p v-if="transcriptHelper.url" class="text-xs px-1 pt-1" :class="transcriptHelperStatus.error ? 'text-error' : 'text-success'">{{ transcriptHelperStatus.text }}</p>
      </div>
    </div>
  </modals-modal>
</template>

<script>
import { normalizeHelperUrl } from '@/players/transcriptUtils'

export default {
  props: {
    value: Boolean
  },
  data() {
    return {
      useChapterTrack: false,
      readAlongMediaSession: true,
      jumpValues: [
        { text: this.$getString('LabelTimeDurationXSeconds', ['10']), value: 10 },
        { text: this.$getString('LabelTimeDurationXSeconds', ['15']), value: 15 },
        { text: this.$getString('LabelTimeDurationXSeconds', ['30']), value: 30 },
        { text: this.$getString('LabelTimeDurationXSeconds', ['60']), value: 60 },
        { text: this.$getString('LabelTimeDurationXMinutes', ['2']), value: 120 },
        { text: this.$getString('LabelTimeDurationXMinutes', ['5']), value: 300 }
      ],
      jumpForwardAmount: 10,
      jumpBackwardAmount: 10,
      playbackRateIncrementDecrementValues: [0.1, 0.05],
      playbackRateIncrementDecrement: 0.1,
      transcriptEngine: 'browser',
      transcriptEngineValues: [
        { text: this.$strings.LabelTranscriptEngineBrowser, value: 'browser' },
        { text: this.$strings.LabelTranscriptEngineHelper, value: 'helper' }
      ],
      transcriptHelperUrl: ''
    }
  },
  watch: {
    show(val) {
      if (val && this.transcriptEngine === 'helper') this.$store.dispatch('transcripts/checkHelper')
    }
  },
  computed: {
    show: {
      get() {
        return this.value
      },
      set(val) {
        this.$emit('input', val)
      }
    },
    transcriptHelper() {
      return this.$store.state.transcripts.helper
    },
    transcriptHelperStatus() {
      const helper = this.transcriptHelper
      if (!helper.available) return { error: true, text: this.$getString('MessageTranscriptHelperNotReachable', [helper.url]) }
      const health = helper.health || {}
      if (health.modelState === 'error') return { error: true, text: this.$getString('ToastTranscriptHelperGpuUnavailable', [health.modelError]) }
      const gpuName = health.gpu?.name || health.device || ''
      return { error: false, text: this.$getString('LabelTranscriptHelperConnected', [[gpuName, health.model].filter(Boolean).join(', ')]) }
    }
  },
  methods: {
    setReadAlongMediaSession() {
      this.$store.dispatch('user/updateUserSettings', { readAlongMediaSession: this.readAlongMediaSession })
    },
    setUseChapterTrack() {
      this.$store.dispatch('user/updateUserSettings', { useChapterTrack: this.useChapterTrack })
    },
    setJumpForwardAmount(val) {
      this.jumpForwardAmount = val
      this.$store.dispatch('user/updateUserSettings', { jumpForwardAmount: val })
    },
    setJumpBackwardAmount(val) {
      this.jumpBackwardAmount = val
      this.$store.dispatch('user/updateUserSettings', { jumpBackwardAmount: val })
    },
    setPlaybackRateIncrementDecrementAmount(val) {
      this.playbackRateIncrementDecrement = val
      this.$store.dispatch('user/updateUserSettings', { playbackRateIncrementDecrement: val })
    },
    setTranscriptEngine(val) {
      this.transcriptEngine = val
      this.$store.dispatch('user/updateUserSettings', { transcriptEngine: val })
      if (val === 'helper') this.$store.dispatch('transcripts/checkHelper', true)
    },
    async setTranscriptHelperUrl() {
      const url = normalizeHelperUrl(this.transcriptHelperUrl)
      this.transcriptHelperUrl = url
      await this.$store.dispatch('user/updateUserSettings', { transcriptHelperUrl: url })
      this.$store.dispatch('transcripts/checkHelper', true)
    },
    settingsUpdated() {
      this.useChapterTrack = this.$store.getters['user/getUserSetting']('useChapterTrack')
      this.readAlongMediaSession = this.$store.getters['user/getUserSetting']('readAlongMediaSession') !== false
      this.jumpForwardAmount = this.$store.getters['user/getUserSetting']('jumpForwardAmount')
      this.jumpBackwardAmount = this.$store.getters['user/getUserSetting']('jumpBackwardAmount')
      this.playbackRateIncrementDecrement = this.$store.getters['user/getUserSetting']('playbackRateIncrementDecrement')
      this.transcriptEngine = this.$store.getters['transcripts/getEngine']
      this.transcriptHelperUrl = this.$store.getters['transcripts/getHelperUrl']
    }
  },
  mounted() {
    this.settingsUpdated()
    this.$eventBus.$on('user-settings', this.settingsUpdated)
  },
  beforeDestroy() {
    this.$eventBus.$off('user-settings', this.settingsUpdated)
  }
}
</script>
