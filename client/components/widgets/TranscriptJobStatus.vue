<template>
  <div class="px-4 py-2 mt-4 text-sm font-semibold rounded-md text-gray-100 relative max-w-max mx-auto md:mx-0" :class="isError ? 'bg-error/20' : 'bg-primary'">
    <div class="flex items-center">
      <widgets-loading-spinner v-if="!isError" />
      <span v-else class="material-symbols text-lg text-error">error</span>
      <div class="pl-3 pr-2 min-w-0">
        <p class="text-sm py-0.5">{{ statusText }}</p>
        <p v-if="detailText" class="text-xs text-gray-300 font-normal">{{ detailText }}</p>
        <div v-if="showProgressBar" class="w-56 sm:w-72 h-1 bg-black-300 rounded-full mt-1 overflow-hidden">
          <div class="h-full bg-success transition-all duration-500" :style="{ width: progressPercent + '%' }" />
        </div>
      </div>
      <ui-tooltip v-if="isError" :text="$strings.ButtonClose" direction="top">
        <button class="material-symbols text-xl hover:text-white text-gray-300 ml-2" :aria-label="$strings.ButtonClose" @click="$emit('dismiss')">close</button>
      </ui-tooltip>
      <ui-tooltip v-else-if="canCancel" :text="$strings.ButtonCancel" direction="top">
        <button class="material-symbols text-xl hover:text-error text-gray-300 ml-2" :aria-label="$strings.ButtonCancel" @click="$emit('cancel')">cancel</button>
      </ui-tooltip>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    job: {
      type: Object,
      required: true
    }
  },
  computed: {
    isError() {
      return this.job.status === 'error'
    },
    canCancel() {
      return ['downloading', 'queued', 'transcribing'].includes(this.job.status)
    },
    progressPercent() {
      const value = this.job.status === 'downloading' ? this.job.downloadProgress : this.job.progress
      return Math.round(Math.min(1, Math.max(0, value || 0)) * 100)
    },
    showProgressBar() {
      return ['downloading', 'transcribing'].includes(this.job.status)
    },
    statusText() {
      switch (this.job.status) {
        case 'submitting':
          return this.$strings.LabelTranscriptStatusStarting
        case 'downloading':
          return `${this.$strings.LabelTranscriptStatusDownloading} ${this.progressPercent}%`
        case 'queued':
          return this.$strings.LabelTranscriptStatusQueued
        case 'transcribing':
          return `${this.$strings.LabelTranscriptStatusTranscribing} ${this.progressPercent}%`
        case 'aligning':
          return this.$strings.LabelTranscriptStatusAligning
        case 'uploading':
          return this.$strings.LabelTranscriptStatusUploading
        case 'error':
          return this.$getString('ToastTranscriptFailed', [this.job.error || this.job.errorCode || this.$strings.LabelUnknown])
        default:
          return this.job.status
      }
    },
    detailText() {
      if (this.job.helperUnreachable) return this.$strings.MessageTranscriptHelperUnreachableRetrying
      if (this.job.status !== 'transcribing') return null
      const parts = []
      if (this.job.numFiles > 1 && this.job.currentFileIndex !== null && this.job.currentFileIndex !== undefined) {
        parts.push(this.$getString('LabelTranscriptFileXOfY', [this.job.currentFileIndex + 1, this.job.numFiles]))
      }
      if (this.job.etaSec) {
        parts.push(this.$getString('LabelTimeRemaining', [this.$elapsedPretty(this.job.etaSec)]))
      }
      return parts.join(' · ') || null
    }
  }
}
</script>
