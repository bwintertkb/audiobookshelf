const Path = require('path')
const fs = require('../libs/fsExtra')
const Logger = require('../Logger')

/**
 * Highlights and notes a user makes in a book's read-along transcript (in the transcript panel or the ebook reader).
 * An annotation covers transcript words from the one starting at `start` to the one starting at `end` (seconds on
 * the book timeline), so every client maps it to the same words, and keeps their text in case the transcript is
 * re-created. Stored per user in the item metadata folder: /metadata/items/<libraryItemId>/annotations/<userId>.json
 * (removed with the item, like transcript.json.gz).
 *
 * Clients create annotations with their own ids and send whole annotations (PUT), so a change made offline can be
 * sent again later: the copy with the newest `updatedAt` wins.
 *
 * @typedef Annotation
 * @property {string} id
 * @property {number} start - start time of the first word
 * @property {number} end - start time of the last word
 * @property {string} text
 * @property {string} color
 * @property {string|null} note
 * @property {number} createdAt
 * @property {number} updatedAt
 */
class AnnotationManager {
  constructor() {
    this.Colors = ['yellow', 'blue', 'pink', 'orange']
    this.MaxTextLength = 20000
    this.MaxNoteLength = 20000
    this.MaxAnnotationsPerItem = 5000
    /** @type {Map<string, Promise>} pending writes per file, so concurrent requests do not lose changes */
    this.queues = new Map()
  }

  getAnnotationsPath(libraryItemId, userId) {
    return Path.join(global.MetadataPath, 'items', libraryItemId, 'annotations', `${userId}.json`)
  }

  /**
   * @param {string} libraryItemId
   * @param {string} userId
   * @returns {Promise<Annotation[]>} in book order
   */
  async getAnnotations(libraryItemId, userId) {
    const filePath = this.getAnnotationsPath(libraryItemId, userId)
    if (!(await fs.pathExists(filePath))) return []
    try {
      const data = JSON.parse(await fs.readFile(filePath, 'utf8'))
      return Array.isArray(data.annotations) ? data.annotations : []
    } catch (error) {
      Logger.error(`[AnnotationManager] Failed to read "${filePath}"`, error)
      return []
    }
  }

  /**
   * @param {*} payload - annotation sent by a client
   * @param {string} id
   * @returns {{annotation?: Annotation, error?: string}}
   */
  validate(payload, id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return { error: 'Invalid id' }
    if (!payload || typeof payload !== 'object') return { error: 'Invalid annotation' }
    const { start, end, text, color, note, createdAt, updatedAt } = payload
    if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) return { error: 'Invalid start' }
    if (typeof end !== 'number' || !Number.isFinite(end) || end < start) return { error: 'Invalid end' }
    if (typeof text !== 'string' || !text.trim() || text.length > this.MaxTextLength) return { error: 'Invalid text' }
    if (!this.Colors.includes(color)) return { error: 'Invalid color' }
    if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > this.MaxNoteLength)) return { error: 'Invalid note' }
    const now = Date.now()
    const time = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), now + 60000) : now)
    return {
      annotation: {
        id,
        start,
        end,
        text: text.trim(),
        color,
        note: typeof note === 'string' && note.trim() ? note.trim() : null,
        createdAt: time(createdAt),
        updatedAt: time(updatedAt)
      }
    }
  }

  /**
   * Run changes to one file one after another
   * @template T
   * @param {string} filePath
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  queue(filePath, task) {
    const previous = this.queues.get(filePath) || Promise.resolve()
    const next = previous.catch(() => {}).then(task)
    this.queues.set(filePath, next)
    next
      .catch(() => {})
      .finally(() => {
        if (this.queues.get(filePath) === next) this.queues.delete(filePath)
      })
    return next
  }

  async writeAnnotations(filePath, annotations) {
    await fs.ensureDir(Path.dirname(filePath))
    const tempPath = `${filePath}.tmp`
    await fs.writeFile(tempPath, JSON.stringify({ version: 1, annotations }))
    await fs.rename(tempPath, filePath)
  }

  /**
   * Create or replace an annotation (unless the stored copy was changed later)
   *
   * @param {string} libraryItemId
   * @param {string} userId
   * @param {Annotation} annotation - validated
   * @returns {Promise<{annotation?: Annotation, error?: string}>} the stored annotation
   */
  saveAnnotation(libraryItemId, userId, annotation) {
    const filePath = this.getAnnotationsPath(libraryItemId, userId)
    return this.queue(filePath, async () => {
      const annotations = await this.getAnnotations(libraryItemId, userId)
      const index = annotations.findIndex((a) => a.id === annotation.id)
      if (index >= 0) {
        if (annotations[index].updatedAt > annotation.updatedAt) return { annotation: annotations[index] }
        annotations[index] = { ...annotation, createdAt: annotations[index].createdAt }
      } else {
        if (annotations.length >= this.MaxAnnotationsPerItem) return { error: 'Too many annotations' }
        annotations.push(annotation)
      }
      annotations.sort((a, b) => a.start - b.start || a.end - b.end)
      await this.writeAnnotations(filePath, annotations)
      return { annotation: annotations.find((a) => a.id === annotation.id) }
    })
  }

  /**
   * @param {string} libraryItemId
   * @param {string} userId
   * @param {string} id
   * @returns {Promise<boolean>} true if it was removed
   */
  removeAnnotation(libraryItemId, userId, id) {
    const filePath = this.getAnnotationsPath(libraryItemId, userId)
    return this.queue(filePath, async () => {
      const annotations = await this.getAnnotations(libraryItemId, userId)
      const remaining = annotations.filter((a) => a.id !== id)
      if (remaining.length === annotations.length) return false
      if (remaining.length) await this.writeAnnotations(filePath, remaining)
      else await fs.remove(filePath)
      return true
    })
  }
}
module.exports = new AnnotationManager()
