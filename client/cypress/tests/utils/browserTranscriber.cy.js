import { BrowserTranscription, clearCachedParts } from '@/players/browserTranscriber'

/**
 * How many GPU workers a browser transcription uses. The workers are fakes: their speed follows a curve of the total
 * speed by number of workers (like a real GPU, which gets slower for everybody once its memory is full).
 */
const SAMPLE_RATE = 16000
const MS_PER_AUDIO_SEC = 0.01 // 120 s of audio at 8x real time takes 150 ms

function simulation(totalSpeed) {
  const sim = { totalSpeed, slowdown: 1, active: new Set(), created: 0, maxActive: 0, parts: 0 }
  sim.Worker = class FakeWorker {
    constructor() {
      sim.created++
    }
    postMessage(message) {
      if (message.type === 'load') {
        setTimeout(() => {
          sim.active.add(this)
          sim.maxActive = Math.max(sim.maxActive, sim.active.size)
          this.onmessage?.({ data: { type: 'loaded' } })
        }, 5)
      } else if (message.type === 'transcribe') {
        const workers = sim.active.size
        const speed = (sim.totalSpeed(workers) / workers) * sim.slowdown
        const audioSec = message.audio.length / SAMPLE_RATE
        setTimeout(
          () => {
            sim.parts++
            sim.onPart?.(sim)
            this.onmessage?.({ data: { type: 'result', id: message.id, words: [{ w: 'word', start: 0.5, end: 1 }] } })
          },
          (audioSec / speed) * 1000 * MS_PER_AUDIO_SEC
        )
      }
    }
    terminate() {
      sim.active.delete(this)
    }
  }
  return sim
}

function runJob(sim, durationSec) {
  const libraryItem = { id: `test-${Date.now()}-${Math.random()}`, hasTranscript: false, media: { tracks: [{ ino: '1', metadata: { filename: 'book.mp3' }, startOffset: 0, duration: durationSec }] } }
  // The server's audio: silence, as 16-bit PCM
  const axios = {
    $get: async (url, { params }) => {
      const seconds = Math.max(0, Math.min(params.duration, durationSec - params.start))
      return new ArrayBuffer(Math.round(seconds * SAMPLE_RATE) * 2)
    }
  }
  const updates = []
  const job = new BrowserTranscription({ libraryItem, mode: 'whisper', language: 'en', precision: 'fp16', workerUrl: 'fake-worker.js', axios, onUpdate: (update) => updates.push(update) })
  return job.run().then((transcript) => clearCachedParts(libraryItem.id).then(() => ({ transcript, updates })))
}

const workerCounts = (updates) => updates.filter((u) => u.status === 'transcribing').map((u) => u.workers)

describe('browserTranscriber workers', () => {
  let originalWorker
  beforeEach(() => {
    originalWorker = window.Worker
  })
  afterEach(() => {
    window.Worker = originalWorker
  })

  it('adds workers while each one makes transcription faster', () => {
    const sim = simulation((n) => [8, 15, 21, 26, 30, 34, 38, 42][n - 1])
    window.Worker = sim.Worker
    cy.wrap(runJob(sim, 4 * 3600), { timeout: 60000 }).then(({ transcript, updates }) => {
      expect(sim.created).to.equal(8)
      expect(sim.maxActive).to.equal(8)
      expect(transcript.segments.length).to.be.greaterThan(0)
      const last = updates.filter((u) => u.status === 'transcribing').pop()
      // Fake time runs 1 / MS_PER_AUDIO_SEC times faster
      expect(last.speed * MS_PER_AUDIO_SEC).to.be.closeTo(42, 4)
      expect(last.progress).to.be.closeTo(1, 0.001)
    })
  })

  it('stops adding workers, and removes the newest one, when the GPU memory is full', () => {
    // The 7th worker does not fit: the GPU swaps memory and everything gets slower
    const sim = simulation((n) => [8, 15, 21, 26, 29, 31, 10, 6][n - 1])
    window.Worker = sim.Worker
    cy.wrap(runJob(sim, 4 * 3600), { timeout: 60000 }).then(({ updates }) => {
      expect(sim.created).to.equal(7)
      expect(sim.maxActive).to.equal(7)
      const counts = workerCounts(updates)
      expect(Math.max(...counts)).to.equal(7)
      expect(counts[counts.length - 1]).to.equal(6)
    })
  })

  it('keeps the first workers when another one adds little', () => {
    const sim = simulation((n) => [8, 15, 21, 21.5, 22, 22.5, 23, 23.5][n - 1])
    window.Worker = sim.Worker
    cy.wrap(runJob(sim, 4 * 3600), { timeout: 60000 }).then(({ updates }) => {
      expect(sim.created).to.equal(4)
      const counts = workerCounts(updates)
      expect(counts[counts.length - 1]).to.equal(3)
    })
  })

  it('uses fewer workers when transcription gets much slower', () => {
    const sim = simulation((n) => [8, 15, 21, 26, 30, 34, 38, 42][n - 1])
    // Another program starts using the GPU
    sim.onPart = () => {
      if (sim.parts === 60) sim.slowdown = 0.5
    }
    window.Worker = sim.Worker
    cy.wrap(runJob(sim, 4 * 3600), { timeout: 60000 }).then(({ transcript, updates }) => {
      expect(sim.maxActive).to.equal(8)
      const counts = workerCounts(updates)
      expect(counts[counts.length - 1]).to.be.lessThan(8)
      expect(updates.filter((u) => u.status === 'transcribing').pop().progress).to.be.closeTo(1, 0.001)
      expect(transcript.segments.length).to.be.greaterThan(0)
    })
  })
})
