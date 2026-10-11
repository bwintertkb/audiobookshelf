/**
 * The read-along transcripts last loaded, shared by the transcript panel, the ebook reader and the player
 * (sleep timer, media controls), so a book's transcript (several MB for a long book) is downloaded once.
 */

const CACHE_SIZE = 2
const cache = new Map() // `${libraryItemId}:${updatedAt}` -> Promise<transcript>

/**
 * @param {Object} axios - $axios
 * @param {{id: string, updatedAt?: number}} libraryItem - a new updatedAt (transcript re-created) loads it again
 * @returns {Promise<Object>} rejects like the request (404: no transcript)
 */
export function loadTranscript(axios, libraryItem) {
  const key = `${libraryItem.id}:${libraryItem.updatedAt || ''}`
  if (cache.has(key)) return cache.get(key)
  const promise = axios.$get(`/api/items/${libraryItem.id}/transcript`, { progress: false })
  promise.catch(() => cache.delete(key))
  cache.set(key, promise)
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value)
  return promise
}
