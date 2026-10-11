import { DEFAULT_READ_ALONG_WORDS, buildTranscriptIndex, findPosition, highlightedWords } from './transcriptUtils'
import { ANNOTATION_COLORS, ANNOTATION_COLOR_VALUES, annotationWordRanges, annotationsAtWord } from './annotations'

/**
 * Read-along in the EPUB reader: highlights the narrated words and sentence of an ebook transcript
 * (source "ebook", segments carry their EPUB spine position) in the rendered book, follows the
 * narration from page to page and maps clicks on words back to audio times. It also draws the user's
 * highlights (annotations.js) and reports words the user selects or right-clicks.
 *
 * Words are found in a rendered section by tokenizing its document the same way the transcribe helper
 * read the EPUB (tools/transcribe-helper/transcribe_helper/ebook.py) and matching tokens in order.
 * Highlighting uses the CSS Custom Highlight API, which does not touch the book's DOM (so epub.js
 * pagination and CFIs are unaffected); without it, sentences are highlighted with epub.js annotations.
 */

const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'caption', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hgroup', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul'])
const SKIP_TAGS = new Set(['head', 'script', 'style', 'svg', 'math', 'rt', 'rp', 'noscript'])
const SKIP_TYPES = new Set(['footnote', 'footnotes', 'endnote', 'endnotes', 'rearnote', 'rearnotes', 'noteref', 'toc', 'landmarks', 'page-list', 'pagebreak', 'doc-footnote', 'doc-endnotes', 'doc-noteref', 'doc-pagebreak', 'doc-toc'])
const NOTE_MARKER = /^[\s[(]*[\d*†‡§¶]+[\])\s]*$/
const WHITESPACE = /\s/
const EPUB_NS = 'http://www.idpf.org/2007/ops'
const LOOKAHEAD_TOKENS = 4000
const NAVIGATION_TIMEOUT_MS = 3000

/** Range.START_TO_START, START_TO_END and END_TO_START (compareBoundaryPoints) */
const START_TO_START = 0
const START_TO_END = 1
const END_TO_START = 3

/** How long a position before a requested start is ignored (see update) */
const START_SETTLE_MS = 5000
/** How long turning to a chosen position (goToTime) keeps trying */
const GO_TO_TIMEOUT_MS = 8000
/** Time epub.js gets to display the page again after a resize before following continues */
const REDISPLAY_SETTLE_MS = 1000

export const WORD_HIGHLIGHT = 'abs-readalong-word'
export const SENTENCE_HIGHLIGHT = 'abs-readalong-sentence'
/** The user's highlights, one CSS Custom Highlight per colour */
export const ANNOTATION_HIGHLIGHT_PREFIX = 'abs-readalong-annotation-'
const HIGHLIGHT_CSS = `::highlight(${WORD_HIGHLIGHT}) { background-color: rgba(250, 204, 21, 0.55); }
::highlight(${SENTENCE_HIGHLIGHT}) { background-color: rgba(250, 204, 21, 0.16); }
${ANNOTATION_COLORS.map((color) => `::highlight(${ANNOTATION_HIGHLIGHT_PREFIX}${color}) { background-color: ${ANNOTATION_COLOR_VALUES[color]}; }`).join('\n')}`

function isSkipped(element) {
  const tag = element.localName
  if (SKIP_TAGS.has(tag)) return true
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return true
  const types = `${element.getAttribute('epub:type') || element.getAttributeNS(EPUB_NS, 'type') || ''} ${element.getAttribute('role') || ''}`.toLowerCase().split(/\s+/)
  if (types.some((type) => SKIP_TYPES.has(type))) return true
  // Superscript note markers ("1", "*") are not read aloud
  return (tag === 'sup' || tag === 'sub') && NOTE_MARKER.test(element.textContent)
}

/**
 * Words of a content document in reading order: whitespace separated, block elements and <br> also separate words.
 * @param {Document} doc
 * @returns {{text: string, startNode: Text, startOffset: number, endNode: Text, endOffset: number}[]}
 */
export function tokenizeDocument(doc) {
  const tokens = []
  let current = null
  const boundary = () => {
    if (current) tokens.push(current)
    current = null
  }
  const walk = (node, skipping) => {
    if (node.nodeType === 3) {
      if (skipping) return
      const data = node.data
      for (let i = 0; i < data.length; i++) {
        if (WHITESPACE.test(data[i])) {
          boundary()
          continue
        }
        if (!current) current = { text: '', startNode: node, startOffset: i }
        current.text += data[i]
        current.endNode = node
        current.endOffset = i + 1
      }
      return
    }
    if (node.nodeType !== 1) return
    if (node.localName === 'br') {
      if (!skipping) boundary()
      return
    }
    const skip = skipping || isSkipped(node)
    const block = BLOCK_TAGS.has(node.localName)
    if (block && !skipping) boundary()
    for (let child = node.firstChild; child; child = child.nextSibling) walk(child, skip)
    if (block && !skipping) boundary()
  }
  walk(doc.documentElement, false)
  boundary()
  return tokens
}

export default class ReadAlong {
  /**
   * @param {Object} options
   * @param {import('epubjs').Rendition} options.rendition
   * @param {Object} options.transcript - v1 transcript with source "ebook"
   * @param {number} [options.highlightWords] - words highlighted around the narrated one (1, 3 or 5)
   * @param {(time: number) => void} [options.onSeek] - a word was clicked
   * @param {() => void} [options.onFollowChanged] - following was paused or resumed
   * @param {(selection: {first: number, last: number, rect: Object, annotation: Object|null}) => void} [options.onSelect] - words were
   *   selected, right-clicked or long-pressed (rect: where they are in the reader's window)
   */
  constructor({ rendition, transcript, highlightWords = DEFAULT_READ_ALONG_WORDS, onSeek, onFollowChanged, onSelect }) {
    this.rendition = rendition
    this.transcript = transcript
    this.highlightWords = highlightWords
    this.onSeek = onSeek
    this.onFollowChanged = onFollowChanged
    this.onSelect = onSelect
    this.annotations = []
    this.annotationRanges = []
    this.annotationCfis = [] // epub.js annotations drawn without the Highlight API
    this.index = buildTranscriptIndex(transcript)
    this.following = true
    this.sections = new Map() // spine index -> { doc, window, contents, firstWord, ranges }
    this.activeWord = -1
    this.activeSegment = -1
    this.highlightWindow = null
    this.annotationCfi = null
    this.navigating = null
    this.pendingSpine = null
    this.dirty = false
    this.lastTime = null
    this.followPending = false
    this.listening = new WeakSet() // documents with event listeners
    this.redisplayUntil = 0
    // epub.js displays the page again after a resize (e.g. the player bar opened)
    this.onResized = () => {
      this.redisplayUntil = Date.now() + REDISPLAY_SETTLE_MS
      this.dirty = true
    }
    rendition.on('resized', this.onResized)

    // Words of each spine section are contiguous in the transcript
    this.spineWords = new Map()
    const segments = this.index.segments
    for (let si = 0; si < segments.length; si++) {
      const spine = segments[si].spine
      const first = this.index.segmentFirstWord[si]
      const count = segments[si].words.length
      if (spine === undefined || !count) continue
      const entry = this.spineWords.get(spine)
      if (entry) entry.count = first + count - entry.firstWord
      else this.spineWords.set(spine, { firstWord: first, count })
    }
  }

  /** Ebook transcripts made by the helper carry spine positions; others cannot be shown in the book */
  static isSupported(transcript) {
    return transcript?.source === 'ebook' && transcript.segments?.some((s) => s.spine !== undefined)
  }

  // ------------------------------------------------------------------ sections
  onRendered(section, view) {
    const contents = view?.contents
    if (!contents?.document || !this.spineWords.has(section.index)) return
    contents.addStylesheetCss(HIGHLIGHT_CSS, 'abs-readalong')
    const entry = this.mapSection(section.index, contents.document)
    entry.view = view
    entry.contents = contents
    entry.window = contents.window
    if (!this.listening.has(contents.document)) {
      this.listening.add(contents.document)
      contents.document.addEventListener('click', (event) => this.onDocumentClick(section.index, event))
      contents.document.addEventListener('mouseup', (event) => this.onDocumentMouseUp(section.index, event))
      contents.document.addEventListener('contextmenu', (event) => this.onDocumentContextMenu(section.index, event))
    }
    if (this.pendingSpine === section.index) this.pendingSpine = null
    this.drawAnnotations(entry)
    // A (re-)rendered section has new nodes: highlight again on the next update, even if the time did not change
    this.dirty = true
  }

  onRemoved(section, view) {
    const entry = this.sections.get(section.index)
    // epub.js can render a section's new view before removing its old one: only forget the removed view
    if (!entry || (view && entry.view !== view)) return
    if (this.highlightWindow === entry.window) this.highlightWindow = null
    this.sections.delete(section.index)
    this.dirty = true
  }

  /** Map the transcript words of a spine section to text ranges in its document */
  mapSection(spine, doc) {
    const { firstWord, count } = this.spineWords.get(spine)
    const words = this.wordTexts(firstWord, count)
    const tokens = tokenizeDocument(doc)
    const ranges = new Array(count)
    let p = 0
    let mapped = 0
    for (let k = 0; k < count; k++) {
      const limit = Math.min(tokens.length, p + LOOKAHEAD_TOKENS)
      for (let q = p; q < limit; q++) {
        if (tokens[q].text !== words[k]) continue
        // After skipping text that was not narrated, make sure this is not a chance match of a common word
        if (q > p && !(tokens[q + 1]?.text === words[k + 1] || k + 1 >= count)) continue
        const range = doc.createRange()
        range.setStart(tokens[q].startNode, tokens[q].startOffset)
        range.setEnd(tokens[q].endNode, tokens[q].endOffset)
        ranges[k] = range
        mapped++
        p = q + 1
        break
      }
    }
    const entry = { doc, firstWord, ranges, mapped }
    this.sections.set(spine, entry)
    return entry
  }

  wordTexts(firstWord, count) {
    const texts = new Array(count)
    let wi = 0
    for (const segment of this.index.segments) {
      for (const word of segment.words) {
        if (wi >= firstWord && wi < firstWord + count) texts[wi - firstWord] = word.w
        wi++
      }
      if (wi >= firstWord + count) break
    }
    return texts
  }

  wordRange(wordIndex) {
    if (wordIndex < 0) return null
    const spine = this.index.segments[this.index.wordSegment[wordIndex]].spine
    const entry = this.sectionEntry(spine)
    return entry ? { entry, spine, range: entry.ranges[wordIndex - entry.firstWord] || null } : { entry: null, spine, range: null }
  }

  /** Words of a rendered section, or null if the section is not rendered */
  sectionEntry(spine) {
    let entry = this.sections.get(spine)
    if (entry && !this.isAttached(entry)) {
      // epub.js tore down this section's iframe (paged away from it): it has to be rendered again
      this.sections.delete(spine)
      entry = null
    }
    if (!entry && this.spineWords.has(spine)) {
      // Rendered again without a "rendered" event (e.g. while resizing): map its new document
      const view = (this.rendition.views()?.all?.() || []).find((v) => v.section?.index === spine && v.contents?.document?.defaultView)
      if (view) {
        this.onRendered(view.section, view)
        entry = this.sections.get(spine) || null
      }
    }
    return entry
  }

  isAttached(entry) {
    return !!entry.window?.frameElement?.isConnected && !!entry.doc.defaultView
  }

  // ------------------------------------------------------------------ playback sync
  /** Called every frame / timer tick with the current time on the book timeline */
  update(time, force = false) {
    const target = this.startTarget
    if (target) {
      // Until playback gets there: seeks can land a little before the requested word (e.g. MP3 seeking) and a
      // starting player reports 0 or the start of the file for a moment
      if (Date.now() > target.until || time >= target.time) this.startTarget = null
      else time = target.time
    }
    if (force || this.dirty || time !== this.lastTime) {
      this.lastTime = time
      const { word, segment } = findPosition(this.index, time)
      if (force || this.dirty || word !== this.activeWord || segment !== this.activeSegment) {
        this.dirty = false
        this.activeWord = word
        this.activeSegment = segment
        this.highlight()
        this.followPending = true
      }
    }
    // Retried on every tick until the word is on screen (a navigation may still be running)
    if (this.following && this.followPending) this.follow()
    this.pump()
  }

  /** Number of words highlighted around the narrated word */
  setHighlightWords(count) {
    if (count === this.highlightWords) return
    this.highlightWords = count
    this.dirty = true
  }

  highlight() {
    const located = this.wordRange(this.activeWord)
    if (this.highlightWindow && this.highlightWindow !== located?.entry?.window) this.clearHighlights(this.highlightWindow)
    if (!located?.range) return
    const { entry, range } = located
    const win = entry.window
    const segment = this.index.segments[this.activeSegment]
    const firstOfSegment = this.index.segmentFirstWord[this.activeSegment] - entry.firstWord
    const sentence = entry.doc.createRange()
    const first = entry.ranges[firstOfSegment] || range
    const last = entry.ranges[firstOfSegment + segment.words.length - 1] || range
    sentence.setStart(first.startContainer, first.startOffset)
    sentence.setEnd(last.endContainer, last.endOffset)

    if (win?.CSS?.highlights && win.Highlight) {
      // Over the user's highlights
      const words = new win.Highlight(this.wordGroupRange(entry, range))
      words.priority = 2
      const sentenceHighlight = new win.Highlight(sentence)
      sentenceHighlight.priority = 1
      win.CSS.highlights.set(WORD_HIGHLIGHT, words)
      win.CSS.highlights.set(SENTENCE_HIGHLIGHT, sentenceHighlight)
      this.highlightWindow = win
    } else {
      // No Highlight API: highlight the sentence with an epub.js annotation (only when it changes)
      const cfi = entry.contents.cfiFromRange(sentence)
      if (cfi !== this.annotationCfi) {
        if (this.annotationCfi) this.rendition.annotations.remove(this.annotationCfi, 'highlight')
        this.rendition.annotations.highlight(cfi, {}, null, 'abs-readalong-annotation', { fill: 'rgb(250, 204, 21)', 'fill-opacity': '0.3', 'mix-blend-mode': 'multiply' })
        this.annotationCfi = cfi
      }
    }
  }

  /** The narrated word with the words highlighted around it (one range, so the spaces between them are highlighted too) */
  wordGroupRange(entry, range) {
    const { first, last } = highlightedWords(this.index, this.activeWord, this.highlightWords)
    if (first === last) return range
    const start = entry.ranges[first - entry.firstWord] || range
    const end = entry.ranges[last - entry.firstWord] || range
    const group = entry.doc.createRange()
    group.setStart(start.startContainer, start.startOffset)
    group.setEnd(end.endContainer, end.endOffset)
    return group
  }

  clearHighlights(win) {
    try {
      win.CSS?.highlights?.delete(WORD_HIGHLIGHT)
      win.CSS?.highlights?.delete(SENTENCE_HIGHLIGHT)
    } catch (error) {
      // window of a removed section
    }
    if (this.highlightWindow === win) this.highlightWindow = null
  }

  /** Turn to the page with the narrated word (or load its section) */
  follow() {
    if (this.navigating) return
    // Do not race epub.js re-displaying the page after a resize with another display
    if (Date.now() < this.redisplayUntil || !this.rendition.views()?.length) return
    const located = this.activeWord >= 0 ? this.wordRange(this.activeWord) : null
    if (!located) {
      this.followPending = false
      return
    }
    if (!located.entry) {
      // Waiting for the section to render (retry if epub.js did not render it, e.g. it was already displayed)
      if (this.pendingSpine === located.spine && Date.now() - this.pendingSince < 2000) return
      const section = this.rendition.book.spine.get(located.spine)
      if (!section) {
        this.followPending = false
        return
      }
      this.pendingSpine = located.spine
      this.pendingSince = Date.now()
      this.navigate(section.href)
      return
    }
    if (!located.range || this.isVisible(located.entry, located.range)) {
      this.followPending = false
      return
    }
    // Navigate to the word's start point: a range CFI can scroll to the middle of a two-page spread
    const start = located.range.cloneRange()
    start.collapse(true)
    this.navigate(located.entry.contents.cfiFromRange(start))
  }

  navigate(target) {
    // epub.js can leave a display() pending (e.g. started while the page was still snapping): retry after a while
    let timeout
    const settled = new Promise((resolve) => (timeout = setTimeout(resolve, NAVIGATION_TIMEOUT_MS)))
    const navigation = Promise.race([Promise.resolve(this.rendition.display(target)), settled])
      .catch((error) => console.error('[ReadAlong] Failed to display', target, error))
      .finally(() => {
        clearTimeout(timeout)
        if (this.navigating === navigation) this.navigating = null
      })
    this.navigating = navigation
  }

  isVisible(entry, range) {
    const container = this.rendition.manager?.container
    const iframe = entry.window?.frameElement
    if (!container || !iframe?.isConnected) return false
    const rect = range.getBoundingClientRect()
    if (!rect.width && !rect.height) return true
    const frame = iframe.getBoundingClientRect()
    const area = container.getBoundingClientRect()
    const left = frame.left + rect.left
    const top = frame.top + rect.top
    return left >= area.left - 1 && left + rect.width <= area.right + 1 && top >= area.top - 1 && top + rect.height <= area.bottom + 1
  }

  /** Playback was asked to start at a time (play from here, a chosen word): show it and follow from there */
  startAt(time) {
    this.startTarget = null
    this.update(time, true)
    this.startTarget = { time, until: Date.now() + START_SETTLE_MS }
    this.resumeFollowing()
  }

  /** The user turned pages: stop following until they ask to return */
  pauseFollowing() {
    if (!this.following) return
    this.following = false
    this.onFollowChanged?.(false)
  }

  resumeFollowing() {
    this.goToWord = null
    this.following = true
    this.followPending = true
    this.onFollowChanged?.(true)
    this.follow()
  }

  // ------------------------------------------------------------------ clicks and "play from here"
  onDocumentClick(spine, event) {
    if (event.target?.closest?.('a')) return
    const doc = event.target?.ownerDocument
    // Selecting text: the selection gets the highlight menu instead (onDocumentMouseUp)
    if (doc?.getSelection && !doc.getSelection().isCollapsed) return
    const point = this.caretFromPoint(doc, event.clientX, event.clientY)
    if (!point) return
    const wordIndex = this.wordAtPoint(spine, point.node, point.offset)
    if (wordIndex < 0) return
    const time = this.index.wordStarts[wordIndex]
    this.startAt(time)
    this.onSeek?.(time)
  }

  caretFromPoint(doc, x, y) {
    if (!doc) return null
    if (doc.caretPositionFromPoint) {
      const position = doc.caretPositionFromPoint(x, y)
      return position ? { node: position.offsetNode, offset: position.offset } : null
    }
    if (doc.caretRangeFromPoint) {
      const range = doc.caretRangeFromPoint(x, y)
      return range ? { node: range.startContainer, offset: range.startOffset } : null
    }
    return null
  }

  /** Global word index whose range contains the point (binary search, ranges are in document order) */
  wordAtPoint(spine, node, offset) {
    const entry = this.sections.get(spine)
    if (!entry) return -1
    const mapped = []
    entry.ranges.forEach((range, k) => range && mapped.push(k))
    let low = 0
    let high = mapped.length - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      const comparison = entry.ranges[mapped[mid]].comparePoint(node, offset)
      if (comparison === 0) return entry.firstWord + mapped[mid]
      if (comparison < 0) high = mid - 1
      else low = mid + 1
    }
    return -1
  }

  /** Book time of the first narrated word on the current page (or after it), to start playback from there */
  firstVisibleWordTime() {
    // The page epub.js shows: its first position as a CFI in a section (no page before the first display)
    let start = null
    try {
      start = this.rendition.manager ? this.rendition.currentLocation()?.start : null
    } catch (error) {
      start = null
    }
    if (start && Number.isInteger(start.index)) {
      const time = this.firstWordTimeFrom(start.index, start.cfi)
      if (time !== null) return time
    }
    const spines = [...this.sections.keys()].sort((a, b) => a - b)
    for (const spine of spines) {
      const entry = this.sections.get(spine)
      for (let k = 0; k < entry.ranges.length; k++) {
        const range = entry.ranges[k]
        if (range && this.isVisible(entry, range)) return this.index.wordStarts[entry.firstWord + k]
      }
    }
    // Nothing narrated on this page (e.g. a title page): start at the next rendered section with words
    for (const spine of spines) {
      const entry = this.sections.get(spine)
      if (entry.mapped) return this.index.wordStarts[entry.firstWord]
    }
    return null
  }

  /** First narrated word at or after a position of a section, or the first narrated word of a later section */
  firstWordTimeFrom(spine, cfi) {
    const entry = this.sectionEntry(spine)
    if (entry && cfi) {
      let start = null
      try {
        start = entry.contents.range(cfi)
      } catch (error) {
        start = null
      }
      if (start) {
        // Word ranges are in document order: binary search the first one starting at or after the page start
        const mapped = []
        entry.ranges.forEach((range, k) => range && mapped.push(k))
        let low = 0
        let high = mapped.length - 1
        let found = -1
        while (low <= high) {
          const mid = (low + high) >> 1
          if (entry.ranges[mapped[mid]].compareBoundaryPoints(START_TO_START, start) >= 0) {
            found = mid
            high = mid - 1
          } else {
            low = mid + 1
          }
        }
        if (found >= 0) return this.index.wordStarts[entry.firstWord + mapped[found]]
      }
    } else if (this.spineWords.has(spine)) {
      return this.index.wordStarts[this.spineWords.get(spine).firstWord]
    }
    // Nothing narrated from here in this section (e.g. a title page): the next section with narrated words
    const next = [...this.spineWords.keys()].filter((s) => s > spine).sort((a, b) => a - b)[0]
    return next === undefined ? null : this.index.wordStarts[this.spineWords.get(next).firstWord]
  }

  // ------------------------------------------------------------------ highlights and selections
  /** The user's highlights in this book (annotations.js) */
  setAnnotations(annotations) {
    this.annotations = annotations || []
    this.annotationRanges = annotationWordRanges(this.index, this.annotations)
    for (const spine of [...this.sections.keys()]) {
      const entry = this.sectionEntry(spine)
      if (entry) this.drawAnnotations(entry)
    }
  }

  /** A document range from word first to word last of a rendered section (null if none of them is mapped) */
  wordsRange(entry, first, last) {
    let from = Math.max(first, entry.firstWord) - entry.firstWord
    let to = Math.min(last, entry.firstWord + entry.ranges.length - 1) - entry.firstWord
    while (from <= to && !entry.ranges[from]) from++
    while (to >= from && !entry.ranges[to]) to--
    if (from > to) return null
    const range = entry.doc.createRange()
    range.setStart(entry.ranges[from].startContainer, entry.ranges[from].startOffset)
    range.setEnd(entry.ranges[to].endContainer, entry.ranges[to].endOffset)
    return range
  }

  drawAnnotations(entry) {
    const win = entry.window
    const sectionLast = entry.firstWord + entry.ranges.length - 1
    const byColor = new Map(ANNOTATION_COLORS.map((color) => [color, []]))
    for (const { color, first, last } of this.annotationRanges) {
      if (last < entry.firstWord || first > sectionLast) continue
      const range = this.wordsRange(entry, first, last)
      if (range) byColor.get(color).push(range)
    }
    if (win?.CSS?.highlights && win.Highlight) {
      for (const [color, ranges] of byColor) {
        if (ranges.length) win.CSS.highlights.set(ANNOTATION_HIGHLIGHT_PREFIX + color, new win.Highlight(...ranges))
        else win.CSS.highlights.delete(ANNOTATION_HIGHLIGHT_PREFIX + color)
      }
      return
    }
    // No Highlight API: epub.js annotations
    entry.annotationCfis = entry.annotationCfis || []
    for (const cfi of entry.annotationCfis) this.rendition.annotations.remove(cfi, 'highlight')
    entry.annotationCfis = []
    for (const [color, ranges] of byColor) {
      for (const range of ranges) {
        const cfi = entry.contents.cfiFromRange(range)
        this.rendition.annotations.highlight(cfi, {}, null, `abs-readalong-annotation-${color}`, { fill: ANNOTATION_COLOR_VALUES[color], 'fill-opacity': '1', 'mix-blend-mode': 'multiply' })
        entry.annotationCfis.push(cfi)
        this.annotationCfis.push(cfi)
      }
    }
  }

  /** Transcript words in a range of a section's document: { first, last } (global word indexes) or null */
  wordsInRange(spine, range) {
    const entry = this.sections.get(spine)
    if (!entry) return null
    let first = -1
    let last = -1
    for (let k = 0; k < entry.ranges.length; k++) {
      const wordRange = entry.ranges[k]
      if (!wordRange) continue
      // Overlaps: the word ends after the range starts (START_TO_END: this end vs the range's start) and starts before the range ends
      if (wordRange.compareBoundaryPoints(START_TO_END, range) <= 0) continue
      if (wordRange.compareBoundaryPoints(END_TO_START, range) >= 0) break
      if (first < 0) first = k
      last = k
    }
    return first >= 0 ? { first: entry.firstWord + first, last: entry.firstWord + last } : null
  }

  /** Where a range of a section's document is in the reader's window */
  rectInReader(entry, range) {
    const rect = range.getBoundingClientRect()
    const frame = entry.window?.frameElement?.getBoundingClientRect() || { left: 0, top: 0 }
    return { left: frame.left + rect.left, top: frame.top + rect.top, width: rect.width, height: rect.height }
  }

  /** Words first..last chosen on screen (at a word of them): report them, or the highlight they are in */
  selectWords(spine, first, last, range) {
    const entry = this.sections.get(spine)
    if (!entry || !this.onSelect) return
    const rect = this.rectInReader(entry, range)
    if (first === last) {
      const annotation = annotationsAtWord(this.index, this.annotations, first)[0]
      if (annotation) {
        const words = this.annotationRanges.find((r) => r.annotation.id === annotation.id)
        this.onSelect({ first: words.first, last: words.last, rect, annotation })
        return
      }
    }
    this.onSelect({ first, last, rect, annotation: null })
  }

  onDocumentMouseUp(spine, event) {
    if (event.button !== 0 || !this.onSelect) return
    const doc = event.target?.ownerDocument
    // After the browser updated the selection
    setTimeout(() => {
      const selection = doc?.getSelection?.()
      if (!selection || selection.isCollapsed || !selection.rangeCount) return
      const range = selection.getRangeAt(0)
      const words = this.wordsInRange(spine, range)
      if (words) this.onSelect({ ...words, rect: this.rectInReader(this.sections.get(spine), range), annotation: null })
    })
  }

  /** Right-click (or long-press on touch screens) a word: its definition and the highlight menu */
  onDocumentContextMenu(spine, event) {
    if (!this.onSelect) return
    const doc = event.target?.ownerDocument
    const entry = this.sections.get(spine)
    const point = this.caretFromPoint(doc, event.clientX, event.clientY)
    const wordIndex = point && entry ? this.wordAtPoint(spine, point.node, point.offset) : -1
    if (wordIndex < 0) return
    event.preventDefault()
    const selection = doc.getSelection()
    if (selection && !selection.isCollapsed && selection.rangeCount) {
      const words = this.wordsInRange(spine, selection.getRangeAt(0))
      if (words && wordIndex >= words.first && wordIndex <= words.last) {
        this.onSelect({ ...words, rect: this.rectInReader(entry, selection.getRangeAt(0)), annotation: null })
        return
      }
    }
    this.selectWords(spine, wordIndex, wordIndex, entry.ranges[wordIndex - entry.firstWord])
  }

  /** Remove the user's text selection from the book (e.g. after it was highlighted) */
  clearTextSelection() {
    for (const entry of this.sections.values()) {
      try {
        entry.doc.getSelection()?.removeAllRanges()
      } catch (error) {
        // document of a removed section
      }
    }
  }

  // ------------------------------------------------------------------ the page and the audio
  /** Turn to the page with the word at a time without following the narration (e.g. a highlight chosen in a list) */
  goToTime(time) {
    const { word } = findPosition(this.index, time)
    if (word < 0) return
    this.pauseFollowing()
    this.goToWord = { word, since: Date.now() }
    this.pump()
  }

  /** Keep turning to the page asked for with goToTime (called on every tick: a section may have to be rendered first) */
  pump() {
    const target = this.goToWord
    if (!target || this.navigating) return
    if (Date.now() - target.since > GO_TO_TIMEOUT_MS) {
      this.goToWord = null
      return
    }
    if (Date.now() < this.redisplayUntil || !this.rendition.views()?.length) return
    const located = this.wordRange(target.word)
    if (!located.entry) {
      if (this.pendingSpine === located.spine && Date.now() - this.pendingSince < 2000) return
      const section = this.rendition.book.spine.get(located.spine)
      if (!section) {
        this.goToWord = null
        return
      }
      this.pendingSpine = located.spine
      this.pendingSince = Date.now()
      this.navigate(section.href)
      return
    }
    if (!located.range || this.isVisible(located.entry, located.range)) {
      this.goToWord = null
      return
    }
    const start = located.range.cloneRange()
    start.collapse(true)
    this.navigate(located.entry.contents.cfiFromRange(start))
  }

  /** Show the narrated position at a time (e.g. where the user stopped listening) and keep it highlighted */
  showTime(time) {
    this.startAt(time)
  }

  /**
   * Book times the current page covers: from its first narrated word to the first narrated word after it
   * @returns {{start: number, end: number}|null}
   */
  pageTimeRange() {
    const start = this.firstVisibleWordTime()
    if (start === null) return null
    let end = null
    try {
      const location = this.rendition.manager ? this.rendition.currentLocation()?.end : null
      if (location && Number.isInteger(location.index)) end = this.firstWordTimeFrom(location.index, location.cfi)
    } catch (error) {
      end = null
    }
    return { start, end: end !== null && end >= start ? end : start }
  }

  destroy() {
    this.rendition.off('resized', this.onResized)
    if (this.highlightWindow) this.clearHighlights(this.highlightWindow)
    if (this.annotationCfi) this.rendition.annotations.remove(this.annotationCfi, 'highlight')
    for (const cfi of this.annotationCfis) this.rendition.annotations.remove(cfi, 'highlight')
    for (const entry of this.sections.values()) {
      try {
        ANNOTATION_COLORS.forEach((color) => entry.window?.CSS?.highlights?.delete(ANNOTATION_HIGHLIGHT_PREFIX + color))
      } catch (error) {
        // window of a removed section
      }
    }
    this.sections.clear()
  }
}
