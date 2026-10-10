/**
 * Speech recognition with Whisper on the user's GPU (WebGPU), one model instance per worker.
 * Used by players/browserTranscriber.js. Not bundled: transformers.js and ONNX Runtime Web are served by ABS
 * from vendor/ (downloaded at build time by scripts/fetchTranscriberVendor.js).
 *
 * Messages in:  { type: 'load', model, dtype }  { type: 'transcribe', id, audio: Float32Array (16 kHz mono), language }
 * Messages out: { type: 'progress', progress }  { type: 'loaded' }  { type: 'result', id, words }  { type: 'error', id, message }
 */

// Static import (resolved before messages arrive). Keep the version in sync with scripts/fetchTranscriberVendor.js
import { pipeline, env } from './vendor/transformers-4.3.1/transformers.min.js'

env.allowLocalModels = false
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/transformers-4.3.1/', import.meta.url).href
// WebGPU runs the model; threads would need a cross-origin isolated page
env.backends.onnx.wasm.numThreads = 1

let asr = null

/**
 * transformers.js 4.3.1 reports each word with the timing of the word after it (its token-level DTW timestamps
 * are attributed one word late): give every word the timing of the word before it.
 */
function wordsFromChunks(chunks) {
  const words = []
  chunks.forEach((chunk, i) => {
    const w = chunk.text.trim()
    if (!w) return
    let [start, end] = chunk.timestamp
    if (i > 0) {
      ;[start, end] = chunks[i - 1].timestamp
    } else {
      end = start
      start = Math.max(0, start - 0.4)
    }
    if (typeof start !== 'number' || typeof end !== 'number') return
    words.push({ w, start, end: Math.max(start, end) })
  })
  return words
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      asr = await pipeline('automatic-speech-recognition', data.model, {
        device: 'webgpu',
        dtype: data.dtype,
        progress_callback: (progress) => {
          if (progress.status === 'progress_total' || progress.status === 'ready') self.postMessage({ type: 'progress', progress: { status: progress.status, loaded: progress.loaded, total: progress.total, progress: progress.progress } })
        }
      })
      // A first short run prepares the GPU programs, so the first part runs at full speed (the speed of each
      // worker's parts decides how many workers to use)
      await asr(new Float32Array(16000), { return_timestamps: 'word', chunk_length_s: 29, language: 'en', task: 'transcribe' })
      self.postMessage({ type: 'loaded' })
    } else if (data.type === 'transcribe') {
      const output = await asr(data.audio, {
        return_timestamps: 'word',
        chunk_length_s: 29,
        stride_length_s: 2,
        language: data.language || null,
        task: 'transcribe'
      })
      self.postMessage({ type: 'result', id: data.id, words: wordsFromChunks(output.chunks || []) })
    }
  } catch (error) {
    self.postMessage({ type: 'error', id: data.id, message: error?.message || String(error) })
  }
}
