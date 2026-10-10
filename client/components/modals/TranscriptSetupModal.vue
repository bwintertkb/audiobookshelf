<template>
  <modals-modal ref="modal" v-model="show" name="transcript-setup" :width="640" :height="'unset'" :processing="downloading">
    <template #outer>
      <div class="absolute top-0 left-0 p-5 w-2/3 overflow-hidden">
        <p class="text-3xl text-white truncate">{{ mode === 'ebook' ? $strings.ButtonCreateTranscriptFromEbook : $strings.ButtonCreateTranscript }}</p>
      </div>
    </template>
    <div id="transcript-setup" class="px-6 py-6 w-full text-sm rounded-lg bg-bg shadow-lg border border-black-300 overflow-y-auto overflow-x-hidden" style="max-height: 80vh">
      <p class="text-gray-200 mb-4">{{ $strings.MessageTranscriptSetupIntro }}</p>

      <div v-if="checking" class="flex items-center py-6 justify-center">
        <widgets-loading-spinner />
        <p class="pl-3 text-gray-300">{{ $strings.MessageTranscriptSetupChecking }}</p>
      </div>
      <ul v-else class="space-y-3">
        <li v-for="check in checks" :key="check.id" class="flex items-start" :data-check="check.id" :data-ok="String(check.ok)">
          <span class="material-symbols text-xl mr-2" :class="check.ok ? 'text-success' : check.pending ? 'text-warning' : 'text-error'">{{ check.ok ? 'check_circle' : check.pending ? 'download' : 'cancel' }}</span>
          <div class="min-w-0 grow">
            <p class="text-gray-100">{{ check.label }}</p>
            <p v-if="check.detail" class="text-xs text-gray-400">{{ check.detail }}</p>
            <div v-if="check.id === 'model' && !check.ok && support && support.webgpu" class="mt-2">
              <div v-if="downloading" class="w-full max-w-sm">
                <div class="h-1.5 bg-black-300 rounded-full overflow-hidden">
                  <div class="h-full bg-success transition-all duration-300" :style="{ width: Math.round(downloadProgress * 100) + '%' }" />
                </div>
                <p class="text-xs text-gray-400 mt-1">{{ $getString('LabelTranscriptModelDownloading', [Math.round(downloadProgress * 100)]) }}</p>
              </div>
              <ui-btn v-else small color="bg-primary" :disabled="!storageOk" @click="downloadModel">{{ $getString('ButtonDownloadSpeechModel', [modelSizeText]) }}</ui-btn>
            </div>
          </div>
        </li>
      </ul>

      <p v-if="error" class="mt-4 text-error text-sm">{{ error }}</p>

      <div v-if="!checking && ready" class="mt-6 flex items-center">
        <p class="text-gray-200 pr-3">{{ $strings.LabelLanguage }}</p>
        <select v-model="language" aria-label="Language" class="bg-primary border border-gray-600 rounded-sm px-2 py-1 text-sm text-gray-100">
          <option value="">{{ $strings.LabelTranscriptLanguageAuto }}</option>
          <option v-for="option in languageOptions" :key="option.code" :value="option.code">{{ option.name }}</option>
        </select>
      </div>
      <p v-if="!checking && ready" class="mt-4 text-xs text-gray-400">{{ $strings.MessageTranscriptKeepPageOpen }}</p>

      <div class="flex justify-end mt-6">
        <ui-btn color="bg-primary" class="mr-2" @click="show = false">{{ $strings.ButtonCancel }}</ui-btn>
        <ui-btn color="bg-success" :disabled="!ready || checking || downloading" @click="start">{{ $strings.ButtonStartTranscript }}</ui-btn>
      </div>
    </div>
  </modals-modal>
</template>

<script>
import { checkTranscriberSupport, downloadModel } from '@/players/browserTranscriber'
import { WHISPER_LANGUAGES, whisperLanguageCode } from '@/players/transcriberLanguages'

/** Room left in the browser's storage after the model (bytes) */
const STORAGE_MARGIN = 200 * 1024 * 1024

export default {
  props: {
    value: Boolean,
    libraryItem: {
      type: Object,
      default: () => null
    },
    mode: {
      type: String,
      default: 'whisper'
    }
  },
  data() {
    return {
      checking: false,
      support: null,
      downloading: false,
      downloadProgress: 0,
      error: null,
      language: ''
    }
  },
  watch: {
    show(value) {
      if (value) this.runChecks()
    }
  },
  computed: {
    show: {
      get() {
        return this.value
      },
      set(value) {
        this.$emit('input', value)
      }
    },
    languageOptions() {
      return Object.entries(WHISPER_LANGUAGES)
        .map(([code, name]) => ({ code, name }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    modelSizeText() {
      return this.$bytesPretty(this.support?.modelBytes || 0)
    },
    freeBytes() {
      const storage = this.support?.storage
      return storage ? storage.quota - storage.usage : null
    },
    storageOk() {
      if (!this.support) return false
      if (this.support.modelCached || this.freeBytes === null) return true
      return this.freeBytes >= this.support.modelBytes + STORAGE_MARGIN
    },
    gpuName() {
      const adapter = this.support?.adapter
      if (!adapter) return ''
      return [adapter.description || adapter.vendor, adapter.architecture].filter(Boolean).join(' ') || this.$strings.LabelUnknown
    },
    checks() {
      const support = this.support
      if (!support) return []
      const checks = [
        {
          id: 'secure',
          ok: support.secureContext,
          label: support.secureContext ? this.$strings.LabelTranscriptCheckSecure : this.$strings.LabelTranscriptCheckNotSecure,
          detail: support.secureContext ? null : this.$getString('MessageTranscriptNeedsHttps', [window.location.origin])
        },
        {
          id: 'gpu',
          ok: support.webgpu,
          label: support.webgpu ? this.$getString('LabelTranscriptCheckGpu', [this.gpuName]) : this.$strings.LabelTranscriptCheckNoGpu,
          detail: support.webgpu ? (support.precision === 'q4' ? this.$strings.MessageTranscriptGpuNoF16 : null) : support.secureContext ? this.$strings.MessageTranscriptNeedsWebGpu : null
        }
      ]
      if (support.webgpu) {
        checks.push({
          id: 'model',
          ok: support.modelCached,
          pending: !support.modelCached,
          label: support.modelCached ? this.$strings.LabelTranscriptCheckModelReady : this.$getString('LabelTranscriptCheckModelMissing', [this.modelSizeText]),
          detail: support.modelCached ? null : this.$strings.MessageTranscriptModelDownload
        })
        if (!support.modelCached && !this.storageOk) {
          checks.push({ id: 'storage', ok: false, label: this.$strings.LabelTranscriptCheckNoStorage, detail: this.$getString('MessageTranscriptStorageFree', [this.$bytesPretty(Math.max(0, this.freeBytes))]) })
        }
      }
      return checks
    },
    ready() {
      return !!this.support && this.support.secureContext && this.support.webgpu && this.support.modelCached
    }
  },
  methods: {
    async runChecks() {
      this.checking = true
      this.error = null
      this.language = whisperLanguageCode(this.libraryItem?.media?.metadata?.language) || ''
      try {
        this.support = await checkTranscriberSupport()
      } catch (error) {
        console.error('[TranscriptSetupModal] Checks failed', error)
        this.error = error.message
      } finally {
        this.checking = false
      }
    },
    async downloadModel() {
      this.downloading = true
      this.downloadProgress = 0
      this.error = null
      try {
        await downloadModel({
          workerUrl: `${this.$config.routerBasePath}/transcriber/worker.js`,
          precision: this.support.precision,
          onProgress: (fraction) => (this.downloadProgress = fraction)
        })
        this.support = await checkTranscriberSupport()
      } catch (error) {
        console.error('[TranscriptSetupModal] Model download failed', error)
        this.error = this.$getString('MessageTranscriptModelFailed', [error.message])
      } finally {
        this.downloading = false
      }
    },
    start() {
      this.$emit('start', { mode: this.mode, language: this.language || null, precision: this.support.precision })
      this.show = false
    }
  }
}
</script>
