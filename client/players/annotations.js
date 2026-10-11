import { findLastLessOrEqual } from './transcriptUtils'

/**
 * Highlights and notes in a book's read-along transcript, made in the transcript panel or the ebook reader and
 * stored on the server per user (server/managers/AnnotationManager.js, /api/me/item/:id/annotations).
 * An annotation covers the transcript words from the one starting at `start` to the one starting at `end`.
 *
 * Keep in sync with utils/annotations.js in the app repo.
 */

export const ANNOTATION_COLORS = ['yellow', 'blue', 'pink', 'orange']
export const DEFAULT_ANNOTATION_COLOR = 'yellow'
/** Highlight colours (also used by the CSS Custom Highlights in the panel and the reader) */
export const ANNOTATION_COLOR_VALUES = {
  yellow: 'rgb(250 204 21 / 0.38)',
  blue: 'rgb(56 189 248 / 0.38)',
  pink: 'rgb(244 114 182 / 0.4)',
  orange: 'rgb(251 146 60 / 0.42)'
}
/** Swatches in menus */
export const ANNOTATION_SWATCHES = {
  yellow: '#facc15',
  blue: '#38bdf8',
  pink: '#f472b6',
  orange: '#fb923c'
}

/** Word start times are stored rounded by JSON; matching allows for that */
const TIME_TOLERANCE_SEC = 0.005

export function newAnnotationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12)
}

/** Text in quotation marks, unless it already starts with one (a quote of dialogue) */
export function quotedText(text) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  return /^[\u201c\u2018"']/.test(clean) ? clean : `\u201c${clean}\u201d`
}

/** Text of transcript words first..last (inclusive) */
export function wordsText(index, first, last) {
  const words = []
  for (let i = first; i <= last; i++) {
    const segment = index.segments[index.wordSegment[i]]
    words.push(segment.words[i - index.segmentFirstWord[index.wordSegment[i]]].w)
  }
  return words.join(' ')
}

/**
 * @param {ReturnType<import('./transcriptUtils').buildTranscriptIndex>} index
 * @returns {{first: number, last: number}|null} words of the transcript the annotation covers
 */
export function annotationWords(index, annotation) {
  if (!index?.numWords) return null
  const first = Math.max(0, findLastLessOrEqual(index.wordStarts, annotation.start + TIME_TOLERANCE_SEC))
  const last = findLastLessOrEqual(index.wordStarts, annotation.end + TIME_TOLERANCE_SEC)
  if (last < first) return null
  return { first, last }
}

/** A new annotation of transcript words first..last */
export function createAnnotation(index, first, last, { color = DEFAULT_ANNOTATION_COLOR, note = null } = {}) {
  const now = Date.now()
  return { id: newAnnotationId(), start: index.wordStarts[first], end: index.wordStarts[last], text: wordsText(index, first, last), color, note, createdAt: now, updatedAt: now }
}

/** Annotations that cover a word, the most recent first */
export function annotationsAtWord(index, annotations, word) {
  return annotations
    .filter((annotation) => {
      const words = annotationWords(index, annotation)
      return words && word >= words.first && word <= words.last
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Highlighted word ranges by colour, for drawing
 * @returns {{color: string, first: number, last: number, annotation: Object}[]}
 */
export function annotationWordRanges(index, annotations) {
  const ranges = []
  for (const annotation of annotations) {
    const words = annotationWords(index, annotation)
    if (words) ranges.push({ color: ANNOTATION_COLORS.includes(annotation.color) ? annotation.color : DEFAULT_ANNOTATION_COLOR, ...words, annotation })
  }
  return ranges
}

/**
 * The highlights and notes of a book as Markdown, in book order
 *
 * @param {Object} options
 * @param {string} options.title
 * @param {string} [options.author]
 * @param {Object[]} options.annotations
 * @param {{start: number, title: string}[]} [options.chapters]
 * @param {(seconds: number) => string} options.formatTime
 */
export function annotationsMarkdown({ title, author, annotations, chapters = [], formatTime }) {
  const lines = [`# ${title}`]
  if (author) lines.push('', `*${author}*`)
  for (const annotation of [...annotations].sort((a, b) => a.start - b.start)) {
    const chapter = [...chapters].reverse().find((c) => c.start <= annotation.start + 0.5)
    const where = [chapter?.title, formatTime(annotation.start)].filter(Boolean).join(' · ')
    lines.push('', `> ${annotation.text.replace(/\s+/g, ' ')}`)
    if (annotation.note) lines.push('', ...annotation.note.split('\n').map((line) => line.trimEnd()))
    lines.push('', `— ${where}`)
  }
  return lines.join('\n') + '\n'
}

/** A file name for the exported highlights and notes of a book */
export function annotationsFilename(title) {
  const name = String(title || 'Book')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
  return `${name || 'Book'} - highlights and notes.md`
}

const CACHE_PREFIX = 'readAlongAnnotations-'
const QUEUE_KEY = 'readAlongAnnotationQueue'

/**
 * The annotations of the books open in this client, shared by the transcript panel and the reader.
 * With `storage` (the app), annotations are kept for offline reading and changes made offline are sent later.
 */
export class AnnotationStore {
  /**
   * @param {Object} options
   * @param {(method: string, url: string, body?: Object) => Promise<any>} options.request
   * @param {(error: any) => boolean} [options.isPermanentError] - the server refused the change (it is dropped, not retried)
   * @param {Storage} [options.storage]
   */
  constructor({ request, isPermanentError = () => false, storage = null }) {
    this.request = request
    this.isPermanentError = isPermanentError
    this.storage = storage
    this.items = new Map() // libraryItemId -> annotations
    this.loading = new Map() // libraryItemId -> Promise
    this.listeners = new Map() // libraryItemId -> Set<listener>
    this.flushing = null
  }

  /** @returns {Object[]} the annotations known for an item (empty until loaded) */
  get(libraryItemId) {
    if (!this.items.has(libraryItemId)) {
      const cached = this.readCache(libraryItemId)
      if (cached) this.items.set(libraryItemId, cached)
    }
    return this.items.get(libraryItemId) || []
  }

  subscribe(libraryItemId, listener) {
    if (!this.listeners.has(libraryItemId)) this.listeners.set(libraryItemId, new Set())
    this.listeners.get(libraryItemId).add(listener)
    return () => this.listeners.get(libraryItemId)?.delete(listener)
  }

  notify(libraryItemId) {
    for (const listener of this.listeners.get(libraryItemId) || []) listener(this.get(libraryItemId))
  }

  /** Load from the server (changes made offline are sent first). Keeps the known annotations if that fails. */
  load(libraryItemId) {
    if (!libraryItemId) return Promise.resolve([])
    if (this.loading.has(libraryItemId)) return this.loading.get(libraryItemId)
    const promise = (async () => {
      await this.flush()
      try {
        const { annotations } = await this.request('GET', `/api/me/item/${libraryItemId}/annotations`)
        this.setItem(libraryItemId, this.withPending(libraryItemId, annotations || []))
      } catch (error) {
        console.warn('[AnnotationStore] Failed to load annotations', error)
      }
      return this.get(libraryItemId)
    })().finally(() => this.loading.delete(libraryItemId))
    this.loading.set(libraryItemId, promise)
    return promise
  }

  /** Create or change an annotation (shown right away, sent to the server) */
  async save(libraryItemId, annotation) {
    const saved = { ...annotation, updatedAt: Math.max(Date.now(), (annotation.updatedAt || 0) + 1) }
    this.setItem(libraryItemId, [...this.get(libraryItemId).filter((a) => a.id !== saved.id), saved])
    await this.send({ libraryItemId, op: 'put', annotation: saved })
    return saved
  }

  async remove(libraryItemId, annotationId) {
    this.setItem(
      libraryItemId,
      this.get(libraryItemId).filter((a) => a.id !== annotationId)
    )
    await this.send({ libraryItemId, op: 'delete', id: annotationId })
  }

  async send(change) {
    try {
      await this.sendChange(change)
    } catch (error) {
      if (this.isPermanentError(error)) throw error
      if (!this.storage) throw error
      // Offline: keep the change and send it later (load, flush)
      this.writeQueue([...this.readQueue().filter((c) => !(c.libraryItemId === change.libraryItemId && this.changeId(c) === this.changeId(change))), change])
    }
  }

  sendChange({ libraryItemId, op, annotation, id }) {
    if (op === 'put') return this.request('PUT', `/api/me/item/${libraryItemId}/annotations/${annotation.id}`, annotation)
    return this.request('DELETE', `/api/me/item/${libraryItemId}/annotations/${id}`).catch((error) => {
      if (/404|not found/i.test(error?.message || '') || error?.response?.status === 404) return // already gone
      throw error
    })
  }

  changeId(change) {
    return change.op === 'put' ? change.annotation.id : change.id
  }

  /** Send changes made offline, in order */
  flush() {
    if (!this.storage) return Promise.resolve()
    if (this.flushing) return this.flushing
    this.flushing = (async () => {
      for (const change of this.readQueue()) {
        try {
          await this.sendChange(change)
        } catch (error) {
          if (!this.isPermanentError(error)) break // still offline
        }
        this.writeQueue(this.readQueue().filter((c) => c !== change && !(c.libraryItemId === change.libraryItemId && this.changeId(c) === this.changeId(change) && c.op === change.op)))
      }
    })().finally(() => (this.flushing = null))
    return this.flushing
  }

  /** Server annotations with the changes still waiting to be sent */
  withPending(libraryItemId, annotations) {
    let result = annotations
    for (const change of this.readQueue()) {
      if (change.libraryItemId !== libraryItemId) continue
      result = result.filter((a) => a.id !== this.changeId(change))
      if (change.op === 'put') result.push(change.annotation)
    }
    return result
  }

  setItem(libraryItemId, annotations) {
    const sorted = [...annotations].sort((a, b) => a.start - b.start || a.end - b.end)
    this.items.set(libraryItemId, sorted)
    this.writeCache(libraryItemId, sorted)
    this.notify(libraryItemId)
  }

  readCache(libraryItemId) {
    if (!this.storage) return null
    try {
      const value = JSON.parse(this.storage.getItem(CACHE_PREFIX + libraryItemId) || 'null')
      return Array.isArray(value) ? value : null
    } catch (error) {
      return null
    }
  }

  writeCache(libraryItemId, annotations) {
    if (!this.storage) return
    try {
      if (annotations.length) this.storage.setItem(CACHE_PREFIX + libraryItemId, JSON.stringify(annotations))
      else this.storage.removeItem(CACHE_PREFIX + libraryItemId)
    } catch (error) {
      console.warn('[AnnotationStore] Failed to cache annotations', error)
    }
  }

  readQueue() {
    if (!this.storage) return []
    try {
      const value = JSON.parse(this.storage.getItem(QUEUE_KEY) || '[]')
      return Array.isArray(value) ? value : []
    } catch (error) {
      return []
    }
  }

  writeQueue(queue) {
    if (!this.storage) return
    if (queue.length) this.storage.setItem(QUEUE_KEY, JSON.stringify(queue))
    else this.storage.removeItem(QUEUE_KEY)
  }
}
