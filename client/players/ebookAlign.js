/**
 * Align an ebook's text with a Whisper transcript of the audiobook (port of the transcribe helper's
 * tools/transcribe-helper/transcribe_helper/align.py; keep both in sync).
 *
 * The result is a v1 transcript (source "ebook") whose words are the book's words, timed by the Whisper
 * words they match. Text that was not narrated (title pages, contents, licenses, captions) is left out;
 * speech that is not in the book (narrator intros, credits) simply has no text.
 *
 * Steps:
 * 1. Normalize both sides into comparable tokens (case, accents, apostrophes and hyphenation removed).
 * 2. Anchor on word trigrams (then single words) that occur exactly once on both sides and keep the
 *    longest chain of anchors in increasing order (patience-diff style).
 * 3. Align the small gaps between anchors with an edit-distance DP.
 * 4. Drop matches in regions where the two texts do not really correspond (low local match density).
 * 5. Time each book word from its matched Whisper words; unmatched stretches between matches are either
 *    misrecognized speech (timed by interpolation) or text that was never read (dropped).
 */

import { enforceMonotonic, roundTime } from './transcriptBuild'

const DP_MAX_CELLS = 250000
const SKIP_AUDIO_AT_BREAK_COST = 0.6
const EXACT = 1
const SIMILAR = 2
const SUBSTITUTION = 3
const DENSITY_WINDOW = 10
const MIN_DENSITY = 0.35
const SUBSTITUTION_CONTEXT = 3
const SHORT_GAP_WORDS = 3
const EDGE_WORDS_KEPT = 8
const MIN_SEC_PER_WORD = 0.12
const MIN_EXACT_MATCHES = 50
const MIN_EXACT_MATCH_RATIO = 0.05

const APOSTROPHES = /['’‘`´]/g
const COMBINING = /\p{Mn}/gu
const PIECES = /[\p{L}\p{N}]+/gu
const CLOSING = '"\'”’)]»›'
const OPENING = '"\'“‘(«‹—–-'
const ABBREVIATIONS = new Set(['mr.', 'mrs.', 'ms.', 'dr.', 'st.', 'mt.', 'jr.', 'sr.', 'vs.', 'etc.', 'e.g.', 'i.e.', 'prof.', 'capt.', 'col.', 'gen.', 'lt.', 'sgt.', 'rev.', 'no.', 'vol.', 'ch.', 'fig.', 'pp.', 'ave.', 'co.', 'inc.', 'ltd.', 'messrs.', 'mme.', 'mlle.', 'hon.', 'esq.'])

export class EbookAlignmentError extends Error {
  constructor(message) {
    super(message)
    this.name = 'EbookAlignmentError'
  }
}

/** "Don’t" -> ["dont"], "to-night" -> ["to", "night"], "Café," -> ["cafe"] */
export function normalizePieces(word) {
  const text = word.toLowerCase().normalize('NFKD').replace(COMBINING, '').replace(APOSTROPHES, '')
  return text.match(PIECES) || []
}

function tokenize(words) {
  const pieces = []
  const pieceWord = []
  words.forEach((word, index) => {
    for (const piece of normalizePieces(word)) {
      pieces.push(piece)
      pieceWord.push(index)
    }
  })
  return { pieces, pieceWord }
}

/** Characters in common (difflib.SequenceMatcher's matching blocks) */
function matchingCharacters(a, b) {
  let total = 0
  const stack = [[0, a.length, 0, b.length]]
  while (stack.length) {
    const [alo, ahi, blo, bhi] = stack.pop()
    let bestI = alo
    let bestJ = blo
    let bestSize = 0
    // Longest common substring, earliest in a, then in b
    let lengths = new Map()
    for (let i = alo; i < ahi; i++) {
      const next = new Map()
      for (let j = blo; j < bhi; j++) {
        if (a[i] !== b[j]) continue
        const k = (lengths.get(j - 1) || 0) + 1
        next.set(j, k)
        if (k > bestSize) {
          bestI = i - k + 1
          bestJ = j - k + 1
          bestSize = k
        }
      }
      lengths = next
    }
    if (!bestSize) continue
    total += bestSize
    if (alo < bestI && blo < bestJ) stack.push([alo, bestI, blo, bestJ])
    if (bestI + bestSize < ahi && bestJ + bestSize < bhi) stack.push([bestI + bestSize, ahi, bestJ + bestSize, bhi])
  }
  return total
}

function similar(x, y) {
  if (x === y) return true
  if (x.length >= 3 && y.length >= 3 && (x.startsWith(y) || y.startsWith(x)) && Math.abs(x.length - y.length) <= 3) return true
  return Math.min(x.length, y.length) >= 4 && (2 * matchingCharacters(x, y)) / (x.length + y.length) >= 0.75
}

function bisectLeft(sorted, value) {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (sorted[mid] < value) low = mid + 1
    else high = mid
  }
  return low
}

/** pairs sorted by book position; longest subsequence with strictly increasing audio positions */
function longestIncreasingChain(pairs) {
  const tails = []
  const tailIndex = []
  const previous = new Array(pairs.length).fill(-1)
  for (let i = 0; i < pairs.length; i++) {
    const a = pairs[i][1]
    const k = bisectLeft(tails, a)
    if (k === tails.length) {
      tails.push(a)
      tailIndex.push(i)
    } else {
      tails[k] = a
      tailIndex[k] = i
    }
    previous[i] = k > 0 ? tailIndex[k - 1] : -1
  }
  const chain = []
  let i = tailIndex.length ? tailIndex[tailIndex.length - 1] : -1
  while (i >= 0) {
    chain.push(pairs[i])
    i = previous[i]
  }
  return chain.reverse()
}

function uniqueNgrams(seq, lo, hi, n) {
  const counts = new Map()
  const first = new Map()
  for (let i = lo; i <= hi - n; i++) {
    const key = n === 1 ? seq[i] : seq.slice(i, i + n).join('\u0001')
    const count = counts.get(key) || 0
    counts.set(key, count + 1)
    if (count === 0) first.set(key, i)
  }
  const unique = new Map()
  for (const [key, count] of counts) if (count === 1) unique.set(key, first.get(key))
  return unique
}

function anchorChain(book, audio, b0, b1, a0, a1, n, breaks) {
  const uniqueBook = uniqueNgrams(book, b0, b1, n)
  if (n > 1) {
    // An anchor must not span a paragraph break: narrators often say extra things between paragraphs
    for (const [key, b] of uniqueBook) {
      for (let k = 1; k < n; k++) {
        if (breaks[b + k]) {
          uniqueBook.delete(key)
          break
        }
      }
    }
  }
  if (!uniqueBook.size) return []
  const uniqueAudio = uniqueNgrams(audio, a0, a1, n)
  const pairs = []
  for (const [key, b] of uniqueBook) {
    if (uniqueAudio.has(key)) pairs.push([b, uniqueAudio.get(key)])
  }
  pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1])
  const chain = []
  let lastB = b0
  let lastA = a0
  for (const [b, a] of longestIncreasingChain(pairs)) {
    if (b >= lastB && a >= lastA) {
      chain.push([b, a])
      lastB = b + n
      lastA = a + n
    }
  }
  return chain
}

/**
 * Edit distance alignment of a small region; diagonal steps become match/substitution pairs.
 * Skipping audio (speech that is not in the book: intros, chapter announcements) is cheaper at a
 * paragraph boundary than inside a paragraph, so such speech is not wedged into a heading or sentence.
 */
function dpAlign(book, audio, b0, b1, a0, a1, match, kind, breaks) {
  const nb = b1 - b0
  const na = a1 - a0
  const width = na + 1
  const trace = new Uint8Array((nb + 1) * width) // 0 diagonal, 1 skip book token, 2 skip audio token
  let previous = new Float64Array(width)
  let skipCost = breaks[b0] ? SKIP_AUDIO_AT_BREAK_COST : 1
  for (let j = 1; j < width; j++) {
    previous[j] = previous[j - 1] + skipCost
    trace[j] = 2
  }
  for (let i = 1; i <= nb; i++) {
    const current = new Float64Array(width)
    current[0] = i
    trace[i * width] = 1
    const token = book[b0 + i - 1]
    const row = i * width
    skipCost = breaks[b0 + i] ? SKIP_AUDIO_AT_BREAK_COST : 1
    for (let j = 1; j < width; j++) {
      const diagonal = previous[j - 1] + (token === audio[a0 + j - 1] ? 0 : 1)
      const up = previous[j] + 1
      const left = current[j - 1] + skipCost
      if (diagonal <= up && diagonal <= left) {
        current[j] = diagonal
      } else if (up <= left) {
        current[j] = up
        trace[row + j] = 1
      } else {
        current[j] = left
        trace[row + j] = 2
      }
    }
    previous = current
  }
  let i = nb
  let j = na
  while (i > 0 && j > 0) {
    const step = trace[i * width + j]
    if (step === 0) {
      const b = b0 + i - 1
      const a = a0 + j - 1
      match[b] = a
      kind[b] = book[b] === audio[a] ? EXACT : similar(book[b], audio[a]) ? SIMILAR : SUBSTITUTION
      i--
      j--
    } else if (step === 1) {
      i--
    } else {
      j--
    }
  }
}

/**
 * @param {string[]} book
 * @param {string[]} audio
 * @param {boolean[]} [breaks] - book.length + 1 entries, true where book token i starts a paragraph
 * @returns {{match: Int32Array, kind: Uint8Array}} match[i] is the audio token aligned to book token i, or -1
 */
export function alignSequences(book, audio, breaks = null) {
  if (!breaks) {
    breaks = new Array(book.length + 1).fill(false)
    breaks[0] = true
    breaks[book.length] = true
  }
  const match = new Int32Array(book.length).fill(-1)
  const kind = new Uint8Array(book.length)
  const work = [[0, book.length, 0, audio.length]]
  while (work.length) {
    const [b0, b1, a0, a1] = work.pop()
    if (b0 >= b1 || a0 >= a1) continue
    if ((b1 - b0) * (a1 - a0) <= DP_MAX_CELLS) {
      dpAlign(book, audio, b0, b1, a0, a1, match, kind, breaks)
      continue
    }
    let chain = []
    let n = 3
    for (n of [3, 1]) {
      chain = anchorChain(book, audio, b0, b1, a0, a1, n, breaks)
      if (chain.length) break
    }
    if (!chain.length) continue // nothing in common: this stretch stays unmatched
    let prevB = b0
    let prevA = a0
    for (const [b, a] of chain) {
      for (let k = 0; k < n; k++) {
        match[b + k] = a + k
        kind[b + k] = EXACT
      }
      work.push([prevB, b, prevA, a])
      prevB = b + n
      prevA = a + n
    }
    work.push([prevB, b1, prevA, a1])
  }
  return { match, kind }
}

function filterMatches(match, kind) {
  const n = match.length
  const exact = new Uint8Array(n)
  for (let i = 0; i < n; i++) exact[i] = match[i] >= 0 && kind[i] === EXACT ? 1 : 0
  // Substitutions only count between exact matches (a misheard word inside correctly aligned text)
  for (let i = 0; i < n; i++) {
    if (match[i] >= 0 && kind[i] === SUBSTITUTION) {
      let before = false
      for (let k = Math.max(0, i - SUBSTITUTION_CONTEXT); k < i; k++) before = before || !!exact[k]
      let after = false
      for (let k = i + 1; k < Math.min(n, i + 1 + SUBSTITUTION_CONTEXT); k++) after = after || !!exact[k]
      if (!(before && after)) match[i] = -1
    }
  }
  // Matches in regions where the texts do not correspond (chance hits on common words) are dropped
  const prefix = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + exact[i]
  for (let i = 0; i < n; i++) {
    if (match[i] < 0) continue
    const lo = Math.max(0, i - DENSITY_WINDOW)
    const hi = Math.min(n, i + DENSITY_WINDOW + 1)
    if ((prefix[hi] - prefix[lo]) / (hi - lo) < MIN_DENSITY) match[i] = -1
  }
  return match
}

function samePargraphWords(bookWords, indexes, paragraph) {
  const words = []
  for (const k of indexes) {
    if (bookWords[k].paragraph !== paragraph) break
    words.push(k)
  }
  return words
}

function trimEnd(text, chars) {
  let end = text.length
  while (end > 0 && chars.includes(text[end - 1])) end--
  return text.slice(0, end)
}

function trimStart(text, chars) {
  let start = 0
  while (start < text.length && chars.includes(text[start])) start++
  return text.slice(start)
}

function endsSentence(word, nextWord) {
  const stripped = trimEnd(word, CLOSING)
  if (!stripped || !'.!?…'.includes(stripped[stripped.length - 1])) return false
  if (ABBREVIATIONS.has(stripped.toLowerCase()) || /^[A-Z]\.$/.test(stripped)) return false
  if (nextWord === null) return true
  const first = trimStart(nextWord, OPENING)
  return !first || /^[\p{Lu}\p{Nd}]/u.test(first) || OPENING.includes(nextWord[0])
}

function splitSentences(words) {
  const sentences = []
  let current = []
  words.forEach((word, i) => {
    current.push(word)
    if (endsSentence(word.w, i + 1 < words.length ? words[i + 1].w : null)) {
      sentences.push(current)
      current = []
    }
  })
  if (current.length) sentences.push(current)
  return sentences
}

function range(from, to, step = 1) {
  const values = []
  if (step > 0) for (let i = from; i < to; i += step) values.push(i)
  else for (let i = from; i > to; i += step) values.push(i)
  return values
}

/**
 * @param {Object} whisperTranscript - v1 transcript (source "whisper", book timeline)
 * @param {{title: string|null, paragraphs: {text: string, heading: boolean, spine: number}[]}} ebook - readEpubText() result
 * @param {Object} [info] - { version } of the creating client
 */
export function alignEbook(whisperTranscript, ebook, info = {}) {
  const paragraphs = ebook.paragraphs
  const bookWords = []
  paragraphs.forEach((paragraph, paragraphIndex) => {
    for (const word of paragraph.text.split(/\s+/)) {
      if (word) bookWords.push({ w: word, paragraph: paragraphIndex })
    }
  })
  const audioWords = whisperTranscript.segments.flatMap((segment) => segment.words)

  const { pieces: bookPieces, pieceWord: bookPieceWord } = tokenize(bookWords.map((w) => w.w))
  const { pieces: audioPieces, pieceWord: audioPieceWord } = tokenize(audioWords.map((w) => w.w))
  if (!bookPieces.length || !audioPieces.length) throw new EbookAlignmentError('Nothing to align (empty ebook text or transcript)')

  const breaks = new Array(bookPieces.length + 1).fill(false)
  breaks[bookPieces.length] = true
  for (let p = 0; p < bookPieceWord.length; p++) {
    const w = bookPieceWord[p]
    const firstPieceOfWord = p === 0 || bookPieceWord[p - 1] !== w
    const firstWordOfParagraph = w === 0 || bookWords[w - 1].paragraph !== bookWords[w].paragraph
    breaks[p] = firstPieceOfWord && firstWordOfParagraph
  }

  let { match, kind } = alignSequences(bookPieces, audioPieces, breaks)
  let exactMatches = 0
  for (let i = 0; i < match.length; i++) if (match[i] >= 0 && kind[i] === EXACT) exactMatches++
  const required = Math.max(MIN_EXACT_MATCHES, Math.floor(MIN_EXACT_MATCH_RATIO * Math.min(bookPieces.length, audioPieces.length)))
  if (exactMatches < required) throw new EbookAlignmentError(`The ebook text does not match the audio (only ${exactMatches} words matched). Is it the right ebook?`)
  match = filterMatches(match, kind)

  // Time book words from their matched audio words
  const count = bookWords.length
  const starts = new Array(count).fill(null)
  const ends = new Array(count).fill(null)
  const firstAudio = new Array(count).fill(null)
  const lastAudio = new Array(count).fill(null)
  for (let piece = 0; piece < match.length; piece++) {
    const audioPiece = match[piece]
    if (audioPiece < 0) continue
    const w = bookPieceWord[piece]
    const aw = audioPieceWord[audioPiece]
    const audioWord = audioWords[aw]
    starts[w] = starts[w] === null ? audioWord.start : Math.min(starts[w], audioWord.start)
    ends[w] = ends[w] === null ? audioWord.end : Math.max(ends[w], audioWord.end)
    firstAudio[w] = firstAudio[w] === null ? aw : Math.min(firstAudio[w], aw)
    lastAudio[w] = lastAudio[w] === null ? aw : Math.max(lastAudio[w], aw)
  }
  const matchedWords = starts.filter((s) => s !== null).length

  const keep = starts.map((s) => s !== null)
  let interpolated = 0
  let i = 0
  while (i < count) {
    if (starts[i] !== null) {
      i++
      continue
    }
    let j = i
    while (j < count && starts[j] === null) j++
    const hasPrevious = i > 0
    const hasNext = j < count
    let narrated = false
    if (hasPrevious && hasNext) {
      const run = j - i
      const audioGap = firstAudio[j] - lastAudio[i - 1] - 1
      let windowStart
      let windowEnd
      if (audioGap > 0) {
        windowStart = audioWords[lastAudio[i - 1] + 1].start
        windowEnd = audioWords[firstAudio[j] - 1].end
      } else {
        windowStart = ends[i - 1]
        windowEnd = starts[j]
      }
      const duration = Math.max(0, windowEnd - windowStart)
      narrated = run <= SHORT_GAP_WORDS || (audioGap > 0 && audioGap / run >= 0.5 && audioGap / run <= 2 && duration >= MIN_SEC_PER_WORD * run)
      if (narrated) {
        // Misrecognized speech: spread the words over the time it took, by length
        const lengths = range(i, j).map((k) => bookWords[k].w.length + 1)
        const total = lengths.reduce((sum, length) => sum + length, 0)
        let t = windowStart
        range(i, j).forEach((k, n) => {
          const step = (duration * lengths[n]) / total
          starts[k] = t
          ends[k] = t + step
          keep[k] = true
          t += step
        })
        interpolated += run
      }
    }
    if (!narrated) {
      // Mostly not narrated (contents, captions, front matter...), but words in the same paragraph as the
      // neighbouring matched words were read, e.g. "The Selfish" of a heading whose "Giant" matched, or
      // the misheard last words of the book: they take the times of the adjacent unmatched speech
      let gapAudio = range(hasPrevious ? lastAudio[i - 1] + 1 : 0, hasNext ? firstAudio[j] : audioWords.length)
      const leading = hasPrevious ? samePargraphWords(bookWords, range(i, j), bookWords[i - 1].paragraph) : []
      const trailing = hasNext ? samePargraphWords(bookWords, range(j - 1, i - 1, -1), bookWords[j].paragraph).reverse() : []
      if (leading.length && leading.length <= EDGE_WORDS_KEPT && leading.length <= gapAudio.length) {
        leading.forEach((k, n) => {
          starts[k] = audioWords[gapAudio[n]].start
          ends[k] = audioWords[gapAudio[n]].end
          keep[k] = true
        })
        gapAudio = gapAudio.slice(leading.length)
        interpolated += leading.length
      }
      if (trailing.length && trailing.length <= EDGE_WORDS_KEPT && trailing.length <= gapAudio.length) {
        const tail = gapAudio.slice(gapAudio.length - trailing.length)
        trailing.forEach((k, n) => {
          starts[k] = audioWords[tail[n]].start
          ends[k] = audioWords[tail[n]].end
          keep[k] = true
        })
        interpolated += trailing.length
      }
    }
    i = j
  }

  const segments = buildSegments(paragraphs, bookWords, starts, ends, keep)
  enforceMonotonic(segments)

  const kept = keep.filter(Boolean).length
  const audioWordsMatched = new Set()
  for (const a of match) if (a >= 0) audioWordsMatched.add(audioPieceWord[a])
  return {
    version: 1,
    libraryItemId: whisperTranscript.libraryItemId,
    model: whisperTranscript.model,
    language: whisperTranscript.language,
    createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    durationSec: whisperTranscript.durationSec,
    source: 'ebook',
    ...(info.version ? { helperVersion: info.version } : {}),
    files: whisperTranscript.files || [],
    ebook: { title: ebook.title || null },
    alignment: {
      bookWords: count,
      keptWords: kept,
      matchedWords,
      interpolatedWords: interpolated,
      droppedWords: count - kept,
      audioWords: audioWords.length,
      audioWordsMatched: audioWordsMatched.size
    },
    segments
  }
}

function buildSegments(paragraphs, bookWords, starts, ends, keep) {
  const byParagraph = new Map()
  bookWords.forEach((word, k) => {
    if (!keep[k]) return
    if (!byParagraph.has(word.paragraph)) byParagraph.set(word.paragraph, [])
    byParagraph.get(word.paragraph).push({ w: word.w, start: roundTime(starts[k]), end: roundTime(Math.max(ends[k], starts[k])) })
  })
  const segments = []
  for (const paragraphIndex of [...byParagraph.keys()].sort((a, b) => a - b)) {
    const heading = !!paragraphs[paragraphIndex].heading
    splitSentences(byParagraph.get(paragraphIndex)).forEach((words, sentenceIndex) => {
      const segment = { start: words[0].start, end: Math.max(...words.map((w) => w.end)), text: words.map((w) => w.w).join(' '), words }
      if (sentenceIndex === 0) segment.paragraph = true
      if (heading) segment.heading = true
      // EPUB spine position of the sentence, so ebook readers can highlight it in the book itself
      if (paragraphs[paragraphIndex].spine !== undefined && paragraphs[paragraphIndex].spine !== null) segment.spine = paragraphs[paragraphIndex].spine
      segments.push(segment)
    })
  }
  return segments
}
