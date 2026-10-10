import { alignEbook } from './ebookAlign'
import { readEpubText } from './ebookText'
import { buildTranscript, partWordsToBook, segmentsFromWords } from './transcriptBuild'

/**
 * Read-along transcripts created in the browser: Whisper runs on the user's GPU (WebGPU) in Web Workers
 * (static/transcriber/worker.js). The server only decodes audio to 16 kHz PCM
 * (GET /api/items/:id/transcript/audio/:fileid) and stores the result.
 *
 * Audio is cut into ~2 minute parts at quiet moments; several workers, each with its own copy of the model,
 * transcribe parts in parallel (a single worker leaves most of a fast GPU idle). Finished parts are kept in
 * IndexedDB, so a job interrupted by closing the page continues where it stopped the next time.
 */

export const TRANSCRIBER_MODEL = 'onnx-community/whisper-large-v3-turbo_timestamped'
const MODEL_URL = `https://huggingface.co/${TRANSCRIBER_MODEL}/resolve/main/`
const MODEL_CACHE = 'transformers-cache' // transformers.js browser cache
export const PRECISIONS = {
  // Needs the shader-f16 WebGPU feature
  fp16: { dtype: { encoder_model: 'fp16', decoder_model_merged: 'fp16' }, files: ['onnx/encoder_model_fp16.onnx', 'onnx/decoder_model_merged_fp16.onnx'], bytes: 1.62e9 },
  q4: { dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' }, files: ['onnx/encoder_model_q4.onnx', 'onnx/decoder_model_merged_q4.onnx'], bytes: 0.77e9 }
}

const SAMPLE_RATE = 16000
const BLOCK_SEC = 600 // audio requested from the server at a time
const PART_SEC = 120 // audio per GPU job
const CUT_WINDOW_SEC = 10 // a part ends at the quietest moment within this distance of PART_SEC
const CUT_FRAME = SAMPLE_RATE / 4
const MAX_WORKERS = 8
const QUEUE_PER_WORKER = 2
const DB_NAME = 'abs-transcriber'
const DB_STORE = 'parts'
const GPU_ERROR = /memory|allocat|device (was )?lost|GPUDevice|out of/i

export class TranscriberError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

// ------------------------------------------------------------------------------------------- requirements
/**
 * What this browser and computer offer for transcription
 *
 * @returns {Promise<{secureContext: boolean, webgpu: boolean, adapter: Object|null, precision: string|null, modelBytes: number, modelCached: boolean, storage: Object|null}>}
 */
export async function checkTranscriberSupport() {
  const result = { secureContext: !!window.isSecureContext, webgpu: false, adapter: null, precision: null, modelBytes: 0, modelCached: false, storage: null }
  if (!result.secureContext || !navigator.gpu) return result
  let adapter = null
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  } catch (error) {
    console.error('[browserTranscriber] requestAdapter failed', error)
  }
  if (!adapter) return result
  result.webgpu = true
  const info = adapter.info || {}
  result.adapter = { vendor: info.vendor || '', architecture: info.architecture || '', description: info.description || '' }
  result.precision = adapter.features.has('shader-f16') ? 'fp16' : 'q4'
  result.modelBytes = PRECISIONS[result.precision].bytes
  result.modelCached = await isModelCached(result.precision)
  if (navigator.storage?.estimate) {
    try {
      const { quota, usage } = await navigator.storage.estimate()
      result.storage = { quota, usage, persisted: (await navigator.storage.persisted?.()) || false }
    } catch (error) {
      result.storage = null
    }
  }
  return result
}

export async function isModelCached(precision) {
  if (typeof caches === 'undefined') return false
  try {
    const cache = await caches.open(MODEL_CACHE)
    for (const file of PRECISIONS[precision].files) {
      if (!(await cache.match(`${MODEL_URL}${file}`))) return false
    }
    return true
  } catch (error) {
    return false
  }
}

/** Load a worker with the model; downloads the model into the browser cache the first time */
function loadWorker(workerUrl, precision, onProgress) {
  const worker = new Worker(workerUrl, { type: 'module' })
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') onProgress?.(data.progress)
      else if (data.type === 'loaded') resolve(worker)
      else if (data.type === 'error') {
        worker.terminate()
        reject(new TranscriberError(data.message, 'gpu_unavailable'))
      }
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new TranscriberError(event.message || 'The transcription worker could not start', 'worker_failed'))
    }
    worker.postMessage({ type: 'load', model: TRANSCRIBER_MODEL, dtype: PRECISIONS[precision].dtype })
  })
}

/**
 * Download the speech model into this browser (and try it on the GPU)
 * @param {{workerUrl: string, precision: string, onProgress?: (fraction: number) => void}} options
 */
export async function downloadModel({ workerUrl, precision, onProgress }) {
  // Ask the browser not to evict the model when disk space is low
  await navigator.storage?.persist?.().catch(() => false)
  const worker = await loadWorker(workerUrl, precision, (progress) => {
    if (progress.status === 'progress_total' && progress.total) onProgress?.(progress.loaded / progress.total)
  })
  worker.terminate()
}

// ------------------------------------------------------------------------------------------- part cache
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function dbRequest(mode, action) {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, mode)
      const request = action(transaction.objectStore(DB_STORE))
      transaction.oncomplete = () => resolve(request?.result)
      transaction.onerror = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

const partCache = {
  get: (key) => dbRequest('readonly', (store) => store.get(key)).catch(() => undefined),
  set: (key, words) => dbRequest('readwrite', (store) => store.put(words, key)).catch((error) => console.error('[browserTranscriber] Failed to cache part', error)),
  /** Forget the parts of an item (after its transcript was uploaded) */
  clearItem: (libraryItemId) => dbRequest('readwrite', (store) => store.delete(IDBKeyRange.bound(`${libraryItemId}|`, `${libraryItemId}|￿`))).catch((error) => console.error('[browserTranscriber] Failed to clear cached parts', error))
}
export const clearCachedParts = partCache.clearItem

// ------------------------------------------------------------------------------------------- audio
function quietestPoint(audio, from, to) {
  let best = Math.min(to, audio.length)
  let bestEnergy = Infinity
  for (let start = Math.max(0, from); start + CUT_FRAME <= Math.min(to, audio.length); start += CUT_FRAME / 2) {
    let energy = 0
    for (let i = start; i < start + CUT_FRAME; i++) energy += audio[i] * audio[i]
    if (energy < bestEnergy) {
      bestEnergy = energy
      best = start + CUT_FRAME / 2
    }
  }
  return best
}

function concat(a, b) {
  if (!a.length) return b
  const result = new Float32Array(a.length + b.length)
  result.set(a)
  result.set(b, a.length)
  return result
}

/** Async queue of parts with a size limit (the audio feeder waits while the GPU workers are busy) */
class PartQueue {
  constructor(limit) {
    this.limit = limit
    this.items = []
    this.closed = false
    this.takers = []
    this.spaceWaiters = []
  }

  async put(item) {
    while (this.items.length >= this.limit && !this.closed) await new Promise((resolve) => this.spaceWaiters.push(resolve))
    if (this.closed) return
    const taker = this.takers.shift()
    if (taker) taker(item)
    else this.items.push(item)
  }

  /** Put back a part a worker could not finish */
  putFront(item) {
    const taker = this.takers.shift()
    if (taker) taker(item)
    else this.items.unshift(item)
  }

  take() {
    if (this.items.length) {
      const item = this.items.shift()
      this.spaceWaiters.shift()?.()
      return Promise.resolve(item)
    }
    if (this.closed) return Promise.resolve(null)
    return new Promise((resolve) => this.takers.push(resolve))
  }

  close() {
    this.closed = true
    this.takers.splice(0).forEach((resolve) => resolve(null))
    this.spaceWaiters.splice(0).forEach((resolve) => resolve())
  }
}

// ------------------------------------------------------------------------------------------- job
export class BrowserTranscription {
  /**
   * @param {Object} options
   * @param {Object} options.libraryItem - expanded library item
   * @param {'whisper'|'ebook'} options.mode - "ebook": the item's EPUB text, timed by the recognized speech
   * @param {string|null} options.language - Whisper language code, null to detect
   * @param {string} options.precision - key of PRECISIONS
   * @param {string} options.workerUrl
   * @param {Object} options.axios - the client's $axios (ABS API with the user's token)
   * @param {(update: Object) => void} options.onUpdate - progress for the job status
   * @param {number} [options.maxWorkers]
   * @param {string} [options.version] - client version recorded in the transcript
   */
  constructor({ libraryItem, mode, language, precision, workerUrl, axios, onUpdate, maxWorkers = MAX_WORKERS, version }) {
    this.libraryItem = libraryItem
    this.mode = mode
    this.language = language || null
    this.precision = precision
    this.workerUrl = workerUrl
    this.axios = axios
    this.onUpdate = onUpdate
    this.maxWorkers = maxWorkers
    this.version = version
    this.cancelled = false
    this.abort = new AbortController()
    this.workers = new Set()
    this.queue = null
  }

  update(values) {
    if (!this.cancelled) this.onUpdate?.(values)
  }

  checkCancelled() {
    if (this.cancelled) throw new TranscriberError('Cancelled', 'cancelled')
  }

  cancel() {
    this.cancelled = true
    this.abort.abort()
    this.queue?.close()
    this.workers.forEach((worker) => worker.terminate())
    this.workers.clear()
  }

  /** @returns {Promise<Object>} v1 transcript */
  async run() {
    try {
      this.update({ status: 'preparing' })
      let ebook = null
      let whisper = null
      if (this.mode === 'ebook') {
        ebook = await this.readEbook()
        whisper = await this.reusableWhisperTranscript()
      }
      if (!whisper) whisper = await this.transcribe()
      this.checkCancelled()
      if (this.mode !== 'ebook') return whisper
      this.update({ status: 'aligning' })
      await new Promise((resolve) => setTimeout(resolve, 50))
      try {
        return alignEbook(whisper, ebook, { version: this.version })
      } catch (error) {
        throw new TranscriberError(error.message, 'ebook_mismatch')
      }
    } finally {
      this.cancel()
    }
  }

  async readEbook() {
    let data
    try {
      data = await this.axios.$get(`/api/items/${this.libraryItem.id}/ebook`, { responseType: 'arraybuffer', signal: this.abort.signal })
    } catch (error) {
      this.checkCancelled()
      throw new TranscriberError(`Failed to download the ebook (${error.message})`, 'download_failed')
    }
    try {
      return await readEpubText(data)
    } catch (error) {
      throw new TranscriberError(error.message, 'ebook_unsupported')
    }
  }

  get files() {
    return (this.libraryItem.media?.tracks || []).map((track) => ({
      ino: track.ino,
      filename: track.metadata?.filename || track.title || null,
      startOffset: track.startOffset,
      duration: track.duration
    }))
  }

  /** The item's existing speech transcript, if it was made from the same audio files (no need to transcribe again) */
  async reusableWhisperTranscript() {
    if (!this.libraryItem.hasTranscript) return null
    let existing
    try {
      existing = await this.axios.$get(`/api/items/${this.libraryItem.id}/transcript`, { signal: this.abort.signal })
    } catch (error) {
      return null
    }
    if (existing?.source && existing.source !== 'whisper') return null
    const files = this.files
    const same = existing?.files?.length === files.length && existing.files.every((f, i) => f.ino === files[i].ino && Math.abs((f.duration || 0) - (files[i].duration || 0)) <= 0.05)
    return same ? existing : null
  }

  partKey(file, start, duration) {
    return [this.libraryItem.id, file.ino, start.toFixed(3), duration.toFixed(3), TRANSCRIBER_MODEL, this.precision, this.language || 'auto'].join('|')
  }

  async transcribe() {
    const files = this.files
    if (!files.length) throw new TranscriberError('This book has no audio files', 'invalid_request')
    const totalSec = files.reduce((sum, file) => sum + (file.duration || 0), 0)
    const results = files.map(() => []) // per file: [{ start, words }]
    let doneSec = 0
    let startedAt = performance.now()
    let gpuSec = 0 // audio transcribed on the GPU in this session (for the time estimate)
    const report = (fileIndex) => {
      const elapsed = (performance.now() - startedAt) / 1000
      const rate = gpuSec > 0 && elapsed > 5 ? gpuSec / elapsed : 0
      this.update({ status: 'transcribing', progress: totalSec ? doneSec / totalSec : 0, currentFileIndex: fileIndex, numFiles: files.length, etaSec: rate ? Math.round((totalSec - doneSec) / rate) : null, workers: this.workers.size })
    }

    this.update({ status: 'loading', numFiles: files.length, modelProgress: 0 })
    const first = await loadWorker(this.workerUrl, this.precision, (progress) => {
      if (progress.status === 'progress_total' && progress.total) this.update({ status: 'loading', modelProgress: progress.loaded / progress.total })
    })
    this.checkCancelled()
    this.workers.add(first)
    this.queue = new PartQueue(this.maxWorkers * QUEUE_PER_WORKER)
    startedAt = performance.now()
    report(0)

    let fatal = null
    const runners = []
    const runWorker = async (worker) => {
      let failures = 0
      while (!this.cancelled) {
        const part = await this.queue.take()
        if (!part) return
        try {
          const words = await this.transcribePart(worker, part)
          await partCache.set(part.key, words)
          results[part.fileIndex].push({ start: part.start, words })
          doneSec += part.duration
          gpuSec += part.duration
          report(part.fileIndex)
        } catch (error) {
          if (this.cancelled) return
          this.queue.putFront(part)
          failures++
          if (GPU_ERROR.test(error.message) || failures > 1) {
            // Out of GPU memory or a broken device: this worker stops, the others continue
            console.warn('[browserTranscriber] Worker stopped:', error.message)
            this.maxWorkers = Math.max(1, this.workers.size - 1)
            worker.terminate()
            this.workers.delete(worker)
            if (!this.workers.size) {
              fatal = new TranscriberError(error.message, 'transcription_failed')
              this.queue.close()
            }
            return
          }
        }
      }
    }
    runners.push(runWorker(first))

    // More workers while the first one is busy, until the GPU memory runs out or MAX_WORKERS
    const addWorkers = async () => {
      while (!this.cancelled && !this.queue.closed && this.workers.size < this.maxWorkers) {
        let worker
        try {
          worker = await loadWorker(this.workerUrl, this.precision)
        } catch (error) {
          console.warn('[browserTranscriber] No more workers:', error.message)
          return
        }
        if (this.cancelled || this.queue.closed) {
          worker.terminate()
          return
        }
        this.workers.add(worker)
        runners.push(runWorker(worker))
      }
    }
    const adding = addWorkers()

    try {
      await this.feed(files, results, (seconds, fileIndex) => {
        doneSec += seconds
        report(fileIndex)
      })
    } finally {
      this.queue.close()
    }
    await adding
    // Runners added while waiting are in the array too
    for (let i = 0; i < runners.length; i++) await runners[i]
    this.checkCancelled()
    if (fatal) throw fatal
    if (this.queue.items.length) throw new TranscriberError('Parts of the audio could not be transcribed', 'transcription_failed')

    const words = []
    files.forEach((file, fileIndex) => {
      for (const part of results[fileIndex].sort((a, b) => a.start - b.start)) words.push(...partWordsToBook(part.words, part.start, file))
    })
    if (!words.length) throw new TranscriberError('No speech was recognized', 'transcription_failed')
    return buildTranscript(segmentsFromWords(words), files, { libraryItemId: this.libraryItem.id, model: TRANSCRIBER_MODEL, language: this.language, source: 'whisper', version: this.version })
  }

  /** Stream each file's audio from the server and cut it into parts for the workers (cached parts are skipped) */
  async feed(files, results, onCached) {
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex]
      let carry = new Float32Array(0)
      let carryStart = 0
      for (let blockStart = 0; !this.cancelled; blockStart += BLOCK_SEC) {
        const pcm = await this.fetchAudio(file, blockStart, BLOCK_SEC)
        const isLast = pcm.length < BLOCK_SEC * SAMPLE_RATE - SAMPLE_RATE || blockStart + BLOCK_SEC >= file.duration
        const buffer = concat(carry, pcm)
        let offset = 0
        while (buffer.length - offset > (PART_SEC + CUT_WINDOW_SEC) * SAMPLE_RATE) {
          const cut = quietestPoint(buffer, offset + (PART_SEC - CUT_WINDOW_SEC) * SAMPLE_RATE, offset + (PART_SEC + CUT_WINDOW_SEC) * SAMPLE_RATE)
          await this.enqueuePart(file, fileIndex, carryStart + offset / SAMPLE_RATE, buffer.subarray(offset, cut), results, onCached)
          offset = cut
        }
        if (isLast) {
          if (buffer.length - offset > SAMPLE_RATE / 10) await this.enqueuePart(file, fileIndex, carryStart + offset / SAMPLE_RATE, buffer.subarray(offset), results, onCached)
          break
        }
        carry = buffer.slice(offset)
        carryStart += offset / SAMPLE_RATE
      }
    }
  }

  async enqueuePart(file, fileIndex, start, audio, results, onCached) {
    const duration = audio.length / SAMPLE_RATE
    const key = this.partKey(file, start, duration)
    const cached = await partCache.get(key)
    if (cached) {
      results[fileIndex].push({ start, words: cached })
      onCached(duration, fileIndex)
      return
    }
    // A copy: the worker takes ownership of its buffer
    await this.queue.put({ key, fileIndex, start, duration, audio: audio.slice() })
  }

  async fetchAudio(file, start, duration) {
    this.checkCancelled()
    let data
    try {
      data = await this.axios.$get(`/api/items/${this.libraryItem.id}/transcript/audio/${file.ino}`, { params: { start, duration }, responseType: 'arraybuffer', signal: this.abort.signal })
    } catch (error) {
      this.checkCancelled()
      if (error.response?.status === 401) throw new TranscriberError('Your session expired, sign in again and restart the transcript', 'auth_expired')
      throw new TranscriberError(`Failed to get the audio from the server (${error.message})`, 'download_failed')
    }
    const samples = new Int16Array(data, 0, Math.floor(data.byteLength / 2))
    const audio = new Float32Array(samples.length)
    for (let i = 0; i < samples.length; i++) audio[i] = samples[i] / 32768
    return audio
  }

  transcribePart(worker, part) {
    return new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (data.type === 'result' && data.id === part.key) resolve(data.words)
        else if (data.type === 'error') reject(new TranscriberError(data.message, 'transcription_failed'))
      }
      worker.onerror = (event) => reject(new TranscriberError(event.message || 'Worker failed', 'transcription_failed'))
      const audio = part.audio.slice()
      worker.postMessage({ type: 'transcribe', id: part.key, audio, language: this.language }, [audio.buffer])
    })
  }
}
