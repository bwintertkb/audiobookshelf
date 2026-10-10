/**
 * Building v1 transcripts in the browser (port of the transcribe helper's transcript.py helpers).
 * All times are seconds on the book timeline.
 */

const TIME_DECIMALS = 3
const SEGMENT_MAX_WORDS = 50
const SEGMENT_PAUSE_SEC = 1.5
const CLOSING = '"\'”’)]»›'

export function roundTime(t) {
  const factor = 10 ** TIME_DECIMALS
  return Math.round(Number(t) * factor) / factor
}

/**
 * Make segment starts and word starts non-decreasing across the whole transcript.
 * Clients binary-search word start times, so ordering must be guaranteed.
 */
export function enforceMonotonic(segments) {
  let lastSegStart = 0
  let lastWordStart = 0
  for (const seg of segments) {
    if (seg.start < lastSegStart) seg.start = lastSegStart
    seg.end = Math.max(seg.end, seg.start)
    lastSegStart = seg.start
    for (const word of seg.words) {
      if (word.start < lastWordStart) word.start = lastWordStart
      word.end = Math.max(word.end, word.start)
      lastWordStart = word.start
    }
    if (seg.words.length) {
      seg.start = Math.min(seg.start, seg.words[0].start)
      seg.end = Math.max(seg.end, seg.words[seg.words.length - 1].end)
    }
  }
  return segments
}

function endsSentence(word) {
  let end = word.length
  while (end > 0 && CLOSING.includes(word[end - 1])) end--
  return end > 0 && '.!?…'.includes(word[end - 1])
}

/**
 * Group recognized words (book timeline, in order) into segments: sentences, split at long pauses
 *
 * @param {{w: string, start: number, end: number}[]} words
 */
export function segmentsFromWords(words) {
  const segments = []
  let current = []
  const close = () => {
    if (!current.length) return
    segments.push({ start: current[0].start, end: Math.max(...current.map((w) => w.end)), text: current.map((w) => w.w).join(' '), words: current })
    current = []
  }
  words.forEach((word, i) => {
    const next = words[i + 1]
    current.push(word)
    if (!next || endsSentence(word.w) || next.start - word.end >= SEGMENT_PAUSE_SEC || current.length >= SEGMENT_MAX_WORDS) close()
  })
  close()
  return enforceMonotonic(segments)
}

/**
 * Words recognized in a part of an audio file, mapped onto the book timeline and clamped to the file
 *
 * @param {{w: string, start: number, end: number}[]} words - times relative to the part
 * @param {number} partStart - seconds into the file
 * @param {{startOffset: number, duration: number}} file
 */
export function partWordsToBook(words, partStart, file) {
  const toBook = (t) => roundTime(file.startOffset + Math.min(Math.max(0, partStart + Number(t)), file.duration))
  const result = []
  for (const word of words) {
    const w = String(word.w || '').trim()
    if (!w) continue
    const start = toBook(word.start)
    result.push({ w, start, end: Math.max(start, toBook(word.end)) })
  }
  return result
}

export function bookDuration(files) {
  if (!files.length) return 0
  const last = files.reduce((a, b) => (b.startOffset > a.startOffset ? b : a))
  return roundTime(last.startOffset + (last.duration || 0))
}

/**
 * @param {Object[]} segments
 * @param {{ino: string, filename: string, startOffset: number, duration: number}[]} files - audio files on the book timeline
 * @param {Object} info - { libraryItemId, model, language, source, version }
 */
export function buildTranscript(segments, files, { libraryItemId, model, language, source = 'whisper', version }) {
  return {
    version: 1,
    libraryItemId,
    model,
    language,
    createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    durationSec: bookDuration(files),
    source,
    ...(version ? { helperVersion: version } : {}),
    // Snapshot of the audio files this transcript was made from; lets clients detect when the item's audio changed
    files: files.map((f) => ({ ino: f.ino, filename: f.filename, startOffset: roundTime(f.startOffset), duration: roundTime(f.duration || 0) })),
    segments
  }
}
