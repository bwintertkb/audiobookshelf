import Vue from 'vue'
import { BrowserTranscription, clearCachedParts } from '@/players/browserTranscriber'
import { buildHelperJobFiles, normalizeHelperUrl } from '@/players/transcriptUtils'

/**
 * Read-along transcripts: created in this page on the user's GPU (engine "browser", players/browserTranscriber.js)
 * or by the local transcribe helper (engine "helper", tools/transcribe-helper), then uploaded to the server.
 * Jobs live here (not in a page) so they keep running while navigating. Helper jobs are reconnected after a
 * page reload (job ids are kept in localStorage); browser jobs continue from their cached parts when started again.
 */

const JOBS_STORAGE_KEY = 'transcriptJobs'
const POLL_INTERVAL_MS = 1500
const HEALTH_CACHE_MS = 10000
const ACTIVE_STATUSES = ['submitting', 'preparing', 'loading', 'downloading', 'queued', 'transcribing', 'aligning', 'uploading']
const HELPER_STATUSES = ['downloading', 'queued', 'transcribing', 'aligning']

let pollTimer = null
let pollInFlight = false
/** libraryItemId -> BrowserTranscription running in this page */
const browserJobs = new Map()

function warnBeforeLeaving(event) {
  if (!browserJobs.size) return
  // Closing the page stops transcription in the browser
  event.preventDefault()
  event.returnValue = ''
}

class HelperError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

async function helperFetch(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal, credentials: 'omit', cache: 'no-store' })
  } catch (error) {
    throw new HelperError(error.name === 'AbortError' ? 'Request timed out' : error.message, 'helper_unreachable')
  } finally {
    clearTimeout(timer)
  }
}

async function readHelperError(response) {
  try {
    const body = await response.json()
    return new HelperError(body.error || body.detail || `HTTP ${response.status}`, body.errorCode || `http_${response.status}`)
  } catch {
    return new HelperError(`HTTP ${response.status}`, `http_${response.status}`)
  }
}

async function submitHelperJob(helperUrl, request, token) {
  const response = await helperFetch(`${helperUrl}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...request, token })
  })
  if (!response.ok) throw await readHelperError(response)
  const body = await response.json()
  return body.jobId
}

async function gzipText(text) {
  if (typeof CompressionStream === 'undefined') {
    return { blob: new Blob([text], { type: 'application/json' }), filename: 'transcript.json' }
  }
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  const compressed = await new Response(stream).blob()
  return { blob: new Blob([compressed], { type: 'application/gzip' }), filename: 'transcript.json.gz' }
}

function persistJobs(state) {
  const persisted = {}
  for (const [libraryItemId, job] of Object.entries(state.jobs)) {
    if (!ACTIVE_STATUSES.includes(job.status) || !job.jobId) continue
    // The token is never persisted; it is sent to the helper only when a job is submitted
    persisted[libraryItemId] = { jobId: job.jobId, helperUrl: job.helperUrl, title: job.title, request: job.request, retriedAuth: !!job.retriedAuth }
  }
  try {
    if (Object.keys(persisted).length) localStorage.setItem(JOBS_STORAGE_KEY, JSON.stringify(persisted))
    else localStorage.removeItem(JOBS_STORAGE_KEY)
  } catch (error) {
    console.error('[transcripts] Failed to persist jobs', error)
  }
}

function toast(type, message) {
  Vue.prototype.$toast?.[type](message)
}

function getString(key, subs) {
  return Vue.prototype.$getString ? Vue.prototype.$getString(key, subs) : key
}

export const state = () => ({
  helper: {
    url: null,
    available: false,
    checking: false,
    checkedAt: 0,
    health: null,
    error: null
  },
  jobs: {}
})

export const getters = {
  getEngine: (state, getters, rootState, rootGetters) => (rootGetters['user/getUserSetting']('transcriptEngine') === 'helper' ? 'helper' : 'browser'),
  getHelperUrl: (state, getters, rootState, rootGetters) => normalizeHelperUrl(rootGetters['user/getUserSetting']('transcriptHelperUrl')),
  getIsHelperAvailable: (state) => state.helper.available,
  /** In the browser the setup dialog checks the GPU; the helper must be reachable with its model loaded (or loading) */
  getCanCreateTranscripts: (state, getters) => getters.getEngine === 'browser' || (state.helper.available && state.helper.health?.modelState !== 'error'),
  getJob: (state) => (libraryItemId) => state.jobs[libraryItemId] || null,
  getIsJobActive: (state) => (libraryItemId) => ACTIVE_STATUSES.includes(state.jobs[libraryItemId]?.status)
}

export const actions = {
  init({ commit, dispatch, getters }) {
    let persisted = {}
    try {
      persisted = JSON.parse(localStorage.getItem(JOBS_STORAGE_KEY) || '{}') || {}
    } catch {
      persisted = {}
    }
    for (const [libraryItemId, job] of Object.entries(persisted)) {
      commit('setJob', { libraryItemId, ...job, status: 'downloading', progress: 0, downloadProgress: 0, reconnecting: true })
    }
    // Only ping the helper when it is used (browsers may ask permission to reach this computer)
    if (getters.getEngine === 'helper' || Object.keys(persisted).length) dispatch('checkHelper', true)
    if (Object.keys(persisted).length) dispatch('startPolling')
  },
  async checkHelper({ state, commit, getters }, force = false) {
    const url = getters.getHelperUrl
    if (!force && state.helper.url === url && Date.now() - state.helper.checkedAt < HEALTH_CACHE_MS) {
      return state.helper.available
    }
    commit('setHelper', { url, checking: true })
    try {
      const response = await helperFetch(`${url}/health`, {}, 4000)
      if (!response.ok) throw await readHelperError(response)
      const health = await response.json()
      commit('setHelper', { url, available: true, checking: false, checkedAt: Date.now(), health, error: null })
    } catch (error) {
      commit('setHelper', { url, available: false, checking: false, checkedAt: Date.now(), health: null, error: error.message })
    }
    return state.helper.available
  },
  /**
   * @param {{ libraryItem: Object, absBaseUrl: string, mode?: 'whisper' | 'ebook' }} payload
   * mode "ebook" uses the item's EPUB text, aligned to the audio (an existing Whisper transcript is reused if possible)
   */
  async startJob({ state, commit, dispatch, getters, rootGetters }, { libraryItem, absBaseUrl, mode = 'whisper', language = null, precision = 'fp16' }) {
    if (getters.getEngine === 'browser') return dispatch('startBrowserJob', { libraryItem, mode, language, precision })
    const helperUrl = getters.getHelperUrl
    const libraryItemId = libraryItem.id
    const request = {
      absBaseUrl,
      libraryItemId,
      files: buildHelperJobFiles(libraryItem, absBaseUrl),
      mode
    }
    if (mode === 'ebook') {
      request.ebookUrl = `${absBaseUrl}/api/items/${libraryItemId}/ebook`
      if (libraryItem.hasTranscript) request.baseTranscriptUrl = `${absBaseUrl}/api/items/${libraryItemId}/transcript`
    }
    const title = libraryItem.media?.metadata?.title || ''
    commit('setJob', { libraryItemId, helperUrl, title, request, status: 'submitting', progress: 0, downloadProgress: 0 })
    try {
      const jobId = await submitHelperJob(helperUrl, request, rootGetters['user/getToken'])
      commit('updateJob', { libraryItemId, jobId, status: 'downloading' })
      persistJobs(state)
      dispatch('startPolling')
    } catch (error) {
      commit('removeJob', libraryItemId)
      if (error.code === 'helper_unreachable') {
        dispatch('checkHelper', true)
        throw new HelperError(getString('MessageTranscriptHelperNotReachable', [helperUrl]), error.code)
      }
      if (error.code === 'gpu_unavailable') {
        throw new HelperError(getString('ToastTranscriptHelperGpuUnavailable', [error.message]), error.code)
      }
      throw error
    }
  },
  /**
   * Transcribe in this page on the GPU (runs while the page stays open, also when navigating in it)
   * @param {{ libraryItem: Object, mode: 'whisper' | 'ebook', language: string|null, precision: string }} payload
   */
  startBrowserJob({ commit, dispatch }, { libraryItem, mode, language, precision }) {
    const libraryItemId = libraryItem.id
    if (browserJobs.has(libraryItemId)) return
    const title = libraryItem.media?.metadata?.title || ''
    commit('setJob', { libraryItemId, engine: 'browser', title, status: 'preparing', progress: 0 })
    const job = new BrowserTranscription({
      libraryItem,
      mode,
      language,
      precision,
      workerUrl: `${this.$config.routerBasePath}/transcriber/worker.js`,
      axios: this.$axios,
      version: this.$config.version,
      onUpdate: (values) => commit('updateJob', { libraryItemId, ...values })
    })
    browserJobs.set(libraryItemId, job)
    if (browserJobs.size === 1) window.addEventListener('beforeunload', warnBeforeLeaving)
    const finished = () => {
      browserJobs.delete(libraryItemId)
      if (!browserJobs.size) window.removeEventListener('beforeunload', warnBeforeLeaving)
    }
    job
      .run()
      .then(async (transcript) => {
        finished()
        if (await dispatch('uploadTranscript', { libraryItemId, text: JSON.stringify(transcript), title })) clearCachedParts(libraryItemId)
      })
      .catch((error) => {
        finished()
        if (error.code === 'cancelled') return
        console.error('[transcripts] Transcription in the browser failed', error)
        commit('updateJob', { libraryItemId, status: 'error', error: error.message, errorCode: error.code })
        toast('error', getString('ToastTranscriptFailed', [error.message]))
      })
  },
  async cancelJob({ state, commit }, libraryItemId) {
    const job = state.jobs[libraryItemId]
    if (!job) return
    if (job.engine === 'browser') {
      browserJobs.get(libraryItemId)?.cancel()
    } else if (job.jobId && job.status !== 'uploading') {
      try {
        await helperFetch(`${job.helperUrl}/jobs/${job.jobId}`, { method: 'DELETE' })
      } catch (error) {
        console.error('[transcripts] Failed to cancel job', error)
      }
    }
    commit('removeJob', libraryItemId)
    persistJobs(state)
    toast('info', getString('ToastTranscriptJobCancelled'))
  },
  dismissJob({ state, commit }, libraryItemId) {
    commit('removeJob', libraryItemId)
    persistJobs(state)
  },
  startPolling({ dispatch }) {
    if (pollTimer) return
    pollTimer = setInterval(() => dispatch('pollJobs'), POLL_INTERVAL_MS)
    dispatch('pollJobs')
  },
  async pollJobs({ state, commit, dispatch }) {
    const active = Object.entries(state.jobs).filter(([, job]) => job.jobId && HELPER_STATUSES.includes(job.status))
    if (!active.length && !Object.values(state.jobs).some((job) => ACTIVE_STATUSES.includes(job.status))) {
      clearInterval(pollTimer)
      pollTimer = null
      return
    }
    if (pollInFlight) return
    pollInFlight = true
    try {
      await Promise.all(active.map(([libraryItemId, job]) => dispatch('pollJob', { libraryItemId, job })))
    } finally {
      pollInFlight = false
    }
  },
  async pollJob({ state, commit, dispatch }, { libraryItemId, job }) {
    let status
    try {
      const response = await helperFetch(`${job.helperUrl}/jobs/${job.jobId}`, {}, 5000)
      if (response.status === 404) {
        commit('updateJob', { libraryItemId, status: 'error', errorCode: 'job_lost', error: getString('MessageTranscriptJobLost') })
        persistJobs(state)
        return
      }
      if (!response.ok) throw await readHelperError(response)
      status = await response.json()
    } catch (error) {
      // Helper restarting or briefly unreachable: keep polling
      commit('updateJob', { libraryItemId, helperUnreachable: true })
      return
    }

    commit('updateJob', {
      libraryItemId,
      helperUnreachable: false,
      reconnecting: false,
      status: status.status === 'done' ? 'uploading' : status.status,
      progress: status.progress,
      downloadProgress: status.downloadProgress,
      currentFileIndex: status.currentFileIndex,
      numFiles: status.numFiles,
      etaSec: status.etaSec,
      error: status.error,
      errorCode: status.errorCode
    })

    if (status.status === 'done') {
      dispatch('uploadResult', libraryItemId)
    } else if (status.status === 'error' && status.errorCode === 'auth_expired' && !job.retriedAuth) {
      dispatch('retryWithFreshToken', libraryItemId)
    } else if (status.status === 'error') {
      persistJobs(state)
      toast('error', getString('ToastTranscriptFailed', [status.error || status.errorCode]))
    } else if (status.status === 'cancelled') {
      commit('removeJob', libraryItemId)
      persistJobs(state)
    }
  },
  async retryWithFreshToken({ state, commit, dispatch, rootGetters }, libraryItemId) {
    const job = state.jobs[libraryItemId]
    if (!job) return
    try {
      await dispatch('user/refreshToken', null, { root: true })
      const jobId = await submitHelperJob(job.helperUrl, job.request, rootGetters['user/getToken'])
      commit('updateJob', { libraryItemId, jobId, retriedAuth: true, status: 'downloading', error: null, errorCode: null })
      persistJobs(state)
    } catch (error) {
      commit('updateJob', { libraryItemId, status: 'error', error: error.message, errorCode: error.code || 'auth_expired' })
      persistJobs(state)
      toast('error', getString('ToastTranscriptFailed', [error.message]))
    }
  },
  async uploadResult({ state, commit, dispatch }, libraryItemId) {
    const job = state.jobs[libraryItemId]
    if (!job || job.uploadStarted) return
    commit('updateJob', { libraryItemId, status: 'uploading', uploadStarted: true })
    let text
    try {
      const response = await helperFetch(`${job.helperUrl}/jobs/${job.jobId}/result`, {}, 120000)
      if (!response.ok) throw await readHelperError(response)
      text = await response.text()
    } catch (error) {
      console.error('[transcripts] Failed to get the transcript from the helper', error)
      commit('updateJob', { libraryItemId, status: 'error', errorCode: 'upload_failed', error: error.message, uploadStarted: false })
      persistJobs(state)
      toast('error', getString('ToastTranscriptUploadFailed', [error.message]))
      return
    }
    await dispatch('uploadTranscript', { libraryItemId, text, title: job.title })
  },
  /** @returns {Promise<boolean>} uploaded */
  async uploadTranscript({ state, commit }, { libraryItemId, text, title }) {
    commit('updateJob', { libraryItemId, status: 'uploading', uploadStarted: true })
    try {
      const { blob, filename } = await gzipText(text)
      const formData = new FormData()
      formData.append('transcript', blob, filename)
      await this.$axios.$post(`/api/items/${libraryItemId}/transcript`, formData)

      commit('removeJob', libraryItemId)
      persistJobs(state)
      toast('success', title ? `${getString('ToastTranscriptCreated')}: ${title}` : getString('ToastTranscriptCreated'))
      return true
    } catch (error) {
      console.error('[transcripts] Upload failed', error)
      let message = error.response?.data || error.message
      if (error.response?.status === 413) message = getString('ToastTranscriptUploadTooLarge')
      commit('updateJob', { libraryItemId, status: 'error', errorCode: 'upload_failed', error: message, uploadStarted: false })
      persistJobs(state)
      toast('error', getString('ToastTranscriptUploadFailed', [message]))
      return false
    }
  }
}

export const mutations = {
  setHelper(state, payload) {
    state.helper = { ...state.helper, ...payload }
  },
  setJob(state, job) {
    Vue.set(state.jobs, job.libraryItemId, job)
  },
  updateJob(state, { libraryItemId, ...updates }) {
    if (!state.jobs[libraryItemId]) return
    Vue.set(state.jobs, libraryItemId, { ...state.jobs[libraryItemId], ...updates })
  },
  removeJob(state, libraryItemId) {
    Vue.delete(state.jobs, libraryItemId)
  }
}
