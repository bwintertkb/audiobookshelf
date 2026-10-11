/**
 * Helpers for read-along transcripts (format v1: times are seconds on the book timeline,
 * i.e. the same time PlayerHandler.getCurrentTime() returns).
 */

export const DEFAULT_TRANSCRIPT_HELPER_URL = 'http://127.0.0.1:8765'

/** A word counts as current slightly before its start (seek precision, render latency) */
export const WORD_LOOKAHEAD_SEC = 0.03

/**
 * @param {ArrayLike<number>} sorted ascending
 * @param {number} value
 * @returns {number} index of the last element <= value, or -1
 */
export function findLastLessOrEqual(sorted, value) {
  let low = 0
  let high = sorted.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (sorted[mid] <= value) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return found
}

/**
 * Flat lookup tables for syncing and a list of rows to render (chapter headings + segments).
 * With `paragraphs`, rows are the book's paragraphs and headings instead (ebook transcripts: segments are
 * sentences, `paragraph` marks the first sentence of a paragraph and `heading` a heading): row
 * { type: 'paragraph', segments: [segment indexes], heading, afterHeading }.
 *
 * @param {{segments: {start:number, end:number, text:string, words:{w:string, start:number, end:number}[], paragraph?:boolean, heading?:boolean, spine?:number}[]}} transcript
 * @param {{start:number, title:string}[]} [chapters]
 * @param {{paragraphs?: boolean}} [options]
 */
export function buildTranscriptIndex(transcript, chapters = [], { paragraphs = false } = {}) {
  const segments = transcript.segments || []
  let numWords = 0
  for (const segment of segments) numWords += segment.words.length

  const wordStarts = new Float64Array(numWords)
  const wordSegment = new Int32Array(numWords)
  const segmentFirstWord = new Int32Array(segments.length)
  const segmentStarts = new Float64Array(segments.length)
  const segmentRow = new Int32Array(segments.length)
  const rows = []

  const sortedChapters = [...chapters].filter((c) => typeof c.start === 'number').sort((a, b) => a.start - b.start)
  let chapterIndex = 0
  let wordIndex = 0
  for (let si = 0; si < segments.length; si++) {
    const segment = segments[si]
    // Chapter heading goes before the first segment that starts in that chapter
    while (chapterIndex < sortedChapters.length && sortedChapters[chapterIndex].start <= segment.start + 0.25) {
      rows.push({ type: 'chapter', chapter: sortedChapters[chapterIndex] })
      chapterIndex++
    }
    if (paragraphs) {
      const last = rows[rows.length - 1]
      const previous = segments[si - 1]
      const continues = last?.type === 'paragraph' && !segment.paragraph && !!segment.heading === !!previous.heading && segment.spine === previous.spine
      if (continues) {
        last.segments.push(si)
      } else {
        // Books do not indent the first paragraph after a heading or at the start of a section
        const afterHeading = !last || last.type === 'chapter' || last.heading || segment.spine !== previous?.spine
        rows.push({ type: 'paragraph', segments: [si], heading: !!segment.heading, afterHeading })
      }
      segmentRow[si] = rows.length - 1
    } else {
      segmentRow[si] = rows.length
      rows.push({ type: 'segment', segment: si })
    }

    segmentFirstWord[si] = wordIndex
    segmentStarts[si] = segment.start
    for (const word of segment.words) {
      wordStarts[wordIndex] = word.start
      wordSegment[wordIndex] = si
      wordIndex++
    }
  }
  while (chapterIndex < sortedChapters.length) {
    rows.push({ type: 'chapter', chapter: sortedChapters[chapterIndex++] })
  }

  return { segments, rows, wordStarts, wordSegment, segmentFirstWord, segmentStarts, segmentRow, numWords, searchTexts: null }
}

/**
 * Current word and segment for a time on the book timeline.
 * Before the first word: { word: -1, segment: -1 }. Between words the last started word stays current.
 *
 * @param {ReturnType<typeof buildTranscriptIndex>} index
 * @param {number} time
 */
export function findPosition(index, time) {
  const word = findLastLessOrEqual(index.wordStarts, time + WORD_LOOKAHEAD_SEC)
  if (word >= 0) return { word, segment: index.wordSegment[word] }
  // Segments without words (text only)
  return { word: -1, segment: findLastLessOrEqual(index.segmentStarts, time + WORD_LOOKAHEAD_SEC) }
}

/** Number of words the read-along highlight can cover (user setting readAlongWords) */
export const READ_ALONG_WORD_COUNTS = [1, 3, 5]
export const DEFAULT_READ_ALONG_WORDS = 3

/** @returns {number} a valid number of highlighted words for a stored setting */
export function readAlongWordCount(value) {
  return READ_ALONG_WORD_COUNTS.includes(Number(value)) ? Number(value) : DEFAULT_READ_ALONG_WORDS
}

/**
 * Words highlighted together with the narrated word: `count` words of its segment (sentence), centred on it
 * where the segment allows. The highlight moves on one word at a time and is easier to follow than a single word.
 *
 * @param {ReturnType<typeof buildTranscriptIndex>} index
 * @param {number} word - the narrated word, -1 for none
 * @param {number} count
 * @returns {{first: number, last: number}} first and last word index (inclusive), -1 if there is no narrated word
 */
export function highlightedWords(index, word, count) {
  if (word < 0 || word >= index.numWords) return { first: -1, last: -1 }
  const segment = index.wordSegment[word]
  const segmentFirst = index.segmentFirstWord[segment]
  const segmentLast = segmentFirst + index.segments[segment].words.length - 1
  const size = Math.max(1, Math.min(Math.round(count) || 1, segmentLast - segmentFirst + 1))
  const first = Math.max(segmentFirst, Math.min(word - Math.floor((size - 1) / 2), segmentLast - size + 1))
  return { first, last: first + size - 1 }
}

/** @returns {string} the text of a segment (sentence) */
export function segmentText(segment) {
  return (segment.text || segment.words.map((word) => word.w).join(' ')).trim()
}

/**
 * Sentences of a transcript on the book timeline, for the media notification (current sentence) and the sleep
 * timer (stop at the end of a sentence or paragraph). Paragraphs are those of the book for ebook transcripts,
 * every segment otherwise.
 *
 * @returns {{starts: number[], ends: number[], texts: string[], paragraphEnds: number[]}}
 */
export function buildSentenceTimeline(transcript) {
  const starts = []
  const ends = []
  const texts = []
  const paragraphEnds = []
  const segments = (transcript?.segments || []).filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end))
  const hasParagraphs = segments.some((segment) => segment.paragraph)
  for (let si = 0; si < segments.length; si++) {
    const segment = segments[si]
    starts.push(segment.start)
    ends.push(Math.max(segment.start, segment.end))
    texts.push(segmentText(segment))
    const next = segments[si + 1]
    if (!hasParagraphs || !next || next.paragraph || !!next.heading !== !!segment.heading) paragraphEnds.push(ends[ends.length - 1])
  }
  return { starts, ends, texts, paragraphEnds }
}

/** Longest a sleep timer keeps playing to finish a sentence or a paragraph (seconds of book time) */
export const SLEEP_TIMER_FINISH_LIMITS = { sentence: 30, paragraph: 120 }

/**
 * Where playback should stop when a sleep timer ends at `time`: the end of the sentence or paragraph being read.
 *
 * @param {ReturnType<typeof buildSentenceTimeline>} timeline
 * @param {number} time
 * @param {'sentence'|'paragraph'} mode
 * @returns {number|null} book time to stop at, or null to stop right away (between sentences, or too far)
 */
export function sleepTimerStopTime(timeline, time, mode) {
  if (!timeline || !SLEEP_TIMER_FINISH_LIMITS[mode]) return null
  const sentence = findLastLessOrEqual(timeline.starts, time + WORD_LOOKAHEAD_SEC)
  if (sentence < 0 || time >= timeline.ends[sentence]) return null
  let stopAt = timeline.ends[sentence]
  if (mode === 'paragraph') {
    const paragraph = timeline.paragraphEnds.findIndex((end) => end >= stopAt)
    if (paragraph >= 0) stopAt = timeline.paragraphEnds[paragraph]
  }
  return stopAt - time <= SLEEP_TIMER_FINISH_LIMITS[mode] ? stopAt : null
}

function normalizeSearchText(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * @param {ReturnType<typeof buildTranscriptIndex>} index
 * @param {string} query
 * @param {number} [limit]
 * @returns {number[]} matching segment indexes in order
 */
export function searchTranscript(index, query, limit = 2000) {
  const needle = normalizeSearchText(query || '')
  if (!needle) return []
  if (!index.searchTexts) {
    index.searchTexts = index.segments.map((segment) => normalizeSearchText(segmentText(segment)))
  }
  const results = []
  for (let si = 0; si < index.searchTexts.length && results.length < limit; si++) {
    if (index.searchTexts[si].includes(needle)) results.push(si)
  }
  return results
}

/**
 * Detect whether the item's audio changed since the transcript was made.
 *
 * @param {{files?:{ino:string, startOffset:number, duration:number}[], durationSec?:number}} transcript
 * @param {{ino:string, startOffset:number, duration:number}[]} tracks - libraryItem.media.tracks
 * @returns {string|null} reason ('count' | 'files' | 'duration') or null if it matches
 */
export function getTranscriptAudioMismatch(transcript, tracks) {
  if (!transcript || !tracks?.length) return null
  const files = transcript.files
  if (Array.isArray(files) && files.length) {
    if (files.length !== tracks.length) return 'count'
    for (let i = 0; i < files.length; i++) {
      if (files[i].ino && tracks[i].ino && files[i].ino !== tracks[i].ino) return 'files'
      if (Math.abs((files[i].duration || 0) - (tracks[i].duration || 0)) > 0.5) return 'duration'
      if (Math.abs((files[i].startOffset || 0) - (tracks[i].startOffset || 0)) > 0.5) return 'duration'
    }
    return null
  }
  const lastTrack = tracks[tracks.length - 1]
  const tracksDuration = (lastTrack.startOffset || 0) + (lastTrack.duration || 0)
  if (transcript.durationSec && Math.abs(transcript.durationSec - tracksDuration) > 1) return 'duration'
  return null
}

/**
 * Files for a transcribe helper job, with the same book timeline offsets the player uses
 *
 * @param {Object} libraryItem - expanded library item
 * @param {string} absBaseUrl - origin + router base path the helper can reach ABS at
 */
export function buildHelperJobFiles(libraryItem, absBaseUrl) {
  return (libraryItem.media?.tracks || []).map((track) => ({
    url: `${absBaseUrl}${track.contentUrl}`,
    path: track.metadata?.path || null,
    ino: track.ino || null,
    filename: track.metadata?.filename || track.title || null,
    startOffset: track.startOffset,
    duration: track.duration
  }))
}

export function normalizeHelperUrl(url) {
  return (url || DEFAULT_TRANSCRIPT_HELPER_URL).trim().replace(/\/+$/, '')
}
