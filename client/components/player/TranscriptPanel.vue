<template>
  <!-- Rendered as the first child of the player container without z-index, so the player controls always stay on top -->
  <div id="transcript-panel" class="fixed left-0 right-0 lg:left-auto top-16 bottom-48 lg:bottom-40 w-full lg:w-[30rem] bg-bg border-l border-t border-black-200 shadow-xl flex flex-col text-gray-200">
    <div class="flex items-center pl-3 pr-1 py-1 border-b border-black-200 shrink-0">
      <span class="material-symbols text-xl text-gray-300">subtitles</span>
      <p class="pl-2 font-semibold truncate">{{ $strings.HeaderTranscript }}</p>
      <div class="grow" />
      <ui-tooltip :text="$strings.ButtonSearch" direction="bottom">
        <button class="transcript-icon-btn" :class="showSearch ? 'text-white' : ''" :aria-label="$strings.ButtonSearch" @click="toggleSearch"><span class="material-symbols text-xl">search</span></button>
      </ui-tooltip>
      <ui-tooltip :text="readAlongWordsLabel" direction="bottom">
        <button class="transcript-icon-btn" :aria-label="readAlongWordsLabel" @click="nextReadAlongWords">
          <span class="material-symbols text-xl">ink_highlighter</span><span class="text-xs font-semibold">{{ readAlongWords }}</span>
        </button>
      </ui-tooltip>
      <ui-tooltip :text="$strings.LabelFontScale" direction="bottom">
        <div class="flex items-center">
          <button class="transcript-icon-btn" :disabled="fontScale <= minFontScale" :aria-label="$strings.LabelFontScale + ' -'" @click="changeFontScale(-0.125)"><span class="material-symbols text-xl">text_decrease</span></button>
          <button class="transcript-icon-btn" :disabled="fontScale >= maxFontScale" :aria-label="$strings.LabelFontScale + ' +'" @click="changeFontScale(0.125)"><span class="material-symbols text-xl">text_increase</span></button>
        </div>
      </ui-tooltip>
      <ui-tooltip :text="$strings.ButtonClose" direction="bottom">
        <button class="transcript-icon-btn" :aria-label="$strings.ButtonClose" @click="$emit('close')"><span class="material-symbols text-xl">close</span></button>
      </ui-tooltip>
    </div>

    <div v-if="showSearch" class="flex items-center px-3 py-1.5 border-b border-black-200 shrink-0">
      <input
        ref="searchInput"
        v-model="searchQuery"
        type="search"
        class="grow min-w-0 bg-primary border border-gray-600 rounded-sm px-2 py-1 text-sm text-gray-100 outline-hidden focus:border-gray-400"
        :placeholder="$strings.LabelTranscriptSearch"
        :aria-label="$strings.LabelTranscriptSearch"
        @keydown.enter.prevent="goToSearchResult($event.shiftKey ? -1 : 1)"
        @keydown.esc.stop.prevent="toggleSearch"
      />
      <p class="text-xs text-gray-300 px-2 whitespace-nowrap">{{ searchStatusText }}</p>
      <button class="transcript-icon-btn" :disabled="!searchResults.length" :aria-label="$strings.ButtonPrevious" @click="goToSearchResult(-1)"><span class="material-symbols text-xl">keyboard_arrow_up</span></button>
      <button class="transcript-icon-btn" :disabled="!searchResults.length" :aria-label="$strings.ButtonNext" @click="goToSearchResult(1)"><span class="material-symbols text-xl">keyboard_arrow_down</span></button>
    </div>

    <p v-if="audioMismatch" class="px-3 py-2 text-xs bg-warning/20 text-gray-100 shrink-0">{{ $strings.MessageTranscriptAudioMismatch }}</p>

    <div class="relative grow min-h-0">
      <div v-if="loading" class="absolute inset-0 flex items-center justify-center">
        <widgets-loading-spinner />
      </div>
      <p v-else-if="error" class="p-4 text-sm text-gray-300">{{ error }}</p>

      <div v-show="!loading && !error" ref="scroller" class="transcript-scroller absolute inset-0 overflow-y-auto overflow-x-hidden outline-hidden" tabindex="0" @scroll.passive="onScroll" @wheel.passive="stopAutoScroll" @touchstart.passive="stopAutoScroll" @mousedown="onScrollerMousedown" @keydown="onScrollerKeydown" @click="onClick">
        <div class="relative" :style="{ height: totalHeight + 'px' }">
          <div ref="window" class="absolute left-0 right-0 top-0 px-4" :class="{ 'transcript-highlight-api': highlightApi }" :style="{ transform: `translateY(${windowTop}px)`, fontSize: fontSizePx + 'px' }">
            <div v-for="row in visibleRows" :key="row.key" :data-row="row.index" class="transcript-row" :class="{ 'transcript-row-paragraph': row.paragraph }">
              <h3 v-if="row.type === 'chapter'" class="transcript-chapter" :data-chapter-start="row.start">{{ row.title }}</h3>
              <p v-else class="transcript-segment" :class="{ 'transcript-search-current': row.segment === currentSearchSegment, 'transcript-segment-heading': row.heading }" :data-seg="row.segment">
                <template v-for="word in row.words"
                  ><span :key="word.i" class="transcript-word" :class="{ 'transcript-search-hit': word.hit }" :data-wi="word.i">{{ word.w }}</span
                  >{{ ' ' }}</template
                >
              </p>
            </div>
          </div>
        </div>
      </div>

      <button v-if="!autoScroll && !loading && !error" class="absolute bottom-3 left-1/2 -translate-x-1/2 bg-primary border border-gray-600 hover:border-gray-400 shadow-lg rounded-full px-3 py-1 text-sm flex items-center whitespace-nowrap" @click="returnToCurrentPosition"><span class="material-symbols text-lg pr-1">my_location</span>{{ $strings.ButtonReturnToCurrentPosition }}</button>
    </div>
  </div>
</template>

<script>
import { READ_ALONG_WORD_COUNTS, buildTranscriptIndex, findLastLessOrEqual, findPosition, getTranscriptAudioMismatch, highlightedWords, readAlongWordCount, searchTranscript } from '@/players/transcriptUtils'

const OVERSCAN_PX = 600
const BASE_FONT_SIZE = 16
const LINE_HEIGHT = 1.6
const AVG_CHAR_WIDTH_EM = 0.48
const ROW_PADDING_PX = 10
const PAUSED_POLL_MS = 250
const PLAYING_POLL_MS = 50
/** CSS Custom Highlight of the words highlighted with the narrated one (styled in the unscoped style below) */
const WORDS_HIGHLIGHT = 'abs-transcript-words'

export default {
  props: {
    libraryItem: {
      type: Object,
      required: true
    },
    chapters: {
      type: Array,
      default: () => []
    },
    /** Returns the current time on the book timeline (PlayerHandler.getCurrentTime) */
    getCurrentTime: {
      type: Function,
      required: true
    },
    playing: Boolean
  },
  data() {
    return {
      loading: false,
      error: null,
      audioMismatch: false,
      renderVersion: 0,
      firstRow: 0,
      lastRow: -1,
      windowTop: 0,
      totalHeight: 0,
      autoScroll: true,
      showSearch: false,
      searchQuery: '',
      searchResults: [],
      searchPosition: -1,
      fontScale: 1,
      minFontScale: 0.75,
      maxFontScale: 2,
      // The highlighted words are one highlight, spaces included; without the API each word is highlighted
      highlightApi: !!(window.CSS?.highlights && window.Highlight)
    }
  },
  watch: {
    'libraryItem.id'() {
      this.loadTranscript()
    },
    'libraryItem.updatedAt'() {
      // Transcript may have been re-created while the panel is open
      if (this.libraryItem.hasTranscript) this.loadTranscript(true)
    },
    chapters() {
      if (this.transcript) this.setTranscript(this.transcript)
    },
    playing() {
      this.startSyncLoop()
    },
    searchQuery() {
      clearTimeout(this.searchTimeout)
      this.searchTimeout = setTimeout(this.runSearch, 250)
    },
    readAlongWords() {
      this.applyHighlight()
    }
  },
  computed: {
    fontSizePx() {
      return Math.round(BASE_FONT_SIZE * this.fontScale)
    },
    /** Words highlighted around the narrated word (user setting, shared with the ebook reader) */
    readAlongWords() {
      return readAlongWordCount(this.$store.getters['user/getUserSetting']('readAlongWords'))
    },
    readAlongWordsLabel() {
      const words = this.readAlongWords === 1 ? this.$strings.LabelReadAlongHighlightOneWord : this.$getString('LabelReadAlongHighlightWords', [this.readAlongWords])
      return `${this.$strings.LabelReadAlongHighlight}: ${words}`
    },
    normalizedQuery() {
      return this.searchQuery.trim().toLowerCase()
    },
    searchTokens() {
      return this.normalizedQuery.split(/\s+/).filter((token) => token.length > 1 || this.normalizedQuery.length === 1)
    },
    currentSearchSegment() {
      return this.searchPosition >= 0 ? this.searchResults[this.searchPosition] : -1
    },
    searchStatusText() {
      if (!this.normalizedQuery) return ''
      if (!this.searchResults.length) return this.$strings.MessageNoResults
      return this.$getString('LabelTranscriptSearchResults', [this.searchPosition + 1, this.searchResults.length])
    },
    visibleRows() {
      // eslint-disable-next-line no-unused-expressions
      this.renderVersion // index is not reactive; renderVersion changes when it is replaced
      const index = this.index
      if (!index) return []
      const tokens = this.searchTokens
      const rows = []
      for (let r = this.firstRow; r <= this.lastRow && r < index.rows.length; r++) {
        const row = index.rows[r]
        if (row.type === 'chapter') {
          rows.push({ key: `r${r}`, index: r, type: 'chapter', title: row.chapter.title, start: row.chapter.start })
          continue
        }
        const segment = index.segments[row.segment]
        const firstWord = index.segmentFirstWord[row.segment]
        const words = segment.words.length
          ? segment.words.map((word, j) => ({
              i: firstWord + j,
              w: word.w,
              hit: tokens.length > 0 && tokens.some((token) => word.w.toLowerCase().includes(token))
            }))
          : [{ i: -1, w: segment.text, hit: false }]
        rows.push({ key: `r${r}`, index: r, type: 'segment', segment: row.segment, words, heading: !!segment.heading, paragraph: !!segment.paragraph })
      }
      return rows
    }
  },
  methods: {
    async loadTranscript(background = false) {
      const libraryItemId = this.libraryItem.id
      if (!background) {
        this.loading = true
        this.error = null
        this.clearTranscript()
      }
      try {
        const transcript = await this.$axios.$get(`/api/items/${libraryItemId}/transcript`, { progress: false })
        if (this.libraryItem?.id !== libraryItemId || this._isDestroyed) return
        this.loading = false
        this.error = null
        this.setTranscript(transcript)
      } catch (error) {
        if (this.libraryItem?.id !== libraryItemId || background) return
        console.error('[TranscriptPanel] Failed to load transcript', error)
        this.loading = false
        this.error = error.response?.status === 404 ? this.$strings.MessageTranscriptNotFound : this.$strings.MessageTranscriptLoadFailed
      }
    },
    clearTranscript() {
      this.transcript = null
      this.index = null
      this.heights = null
      this.offsets = null
      this.activeWord = -1
      this.activeSegment = -1
      this.activeWordEl = null
      this.activeSegmentEl = null
      this.groupEls = []
      this.audioMismatch = false
      this.searchResults = []
      this.searchPosition = -1
      this.renderVersion++
    },
    async setTranscript(transcript) {
      this.transcript = transcript
      this.heights = null
      this.offsets = null
      // Ebook transcripts carry the book's own headings, so the item's chapter markers would be duplicates
      this.index = buildTranscriptIndex(transcript, transcript.source === 'ebook' ? [] : this.chapters)
      this.audioMismatch = !!getTranscriptAudioMismatch(transcript, this.libraryItem.media?.tracks)
      this.activeWord = -1
      this.activeSegment = -1
      this.lastTime = null
      this.renderVersion++
      await this.$nextTick() // scroller is visible now
      this.resetLayout()
      if (this.normalizedQuery) this.runSearch()
      this.tick(true)
    },

    // ---------------------------------------------------------------- layout / virtualization
    resetLayout() {
      const index = this.index
      const scroller = this.$refs.scroller
      if (!index || !scroller) return
      const count = index.rows.length
      this.contentWidth = Math.max(100, scroller.clientWidth - 32)
      this.heights = new Float64Array(count)
      this.offsets = new Float64Array(count + 1)
      for (let r = 0; r < count; r++) this.heights[r] = this.estimateRowHeight(r)
      this.recomputeOffsets(0)
      this.updateWindow()
    },
    estimateRowHeight(r) {
      const row = this.index.rows[r]
      const lineHeight = this.fontSizePx * LINE_HEIGHT
      if (row.type === 'chapter') return lineHeight * 1.25 + 28
      const segment = this.index.segments[row.segment]
      const chars = segment.text ? segment.text.length : segment.words.reduce((total, word) => total + word.w.length + 1, 0)
      const lines = Math.max(1, Math.ceil((chars * this.fontSizePx * AVG_CHAR_WIDTH_EM) / this.contentWidth))
      return lines * lineHeight + ROW_PADDING_PX
    },
    recomputeOffsets(fromRow) {
      const count = this.heights.length
      for (let r = fromRow; r < count; r++) this.offsets[r + 1] = this.offsets[r] + this.heights[r]
      this.totalHeight = Math.ceil(this.offsets[count])
    },
    rowAtY(y) {
      if (!this.offsets || this.heights.length === 0) return 0
      return Math.min(this.heights.length - 1, Math.max(0, findLastLessOrEqual(this.offsets, y)))
    },
    updateWindow() {
      const scroller = this.$refs.scroller
      if (!this.index || !scroller || !this.heights) return
      if (!this.heights.length) {
        this.firstRow = 0
        this.lastRow = -1
        return
      }
      const scrollTop = scroller.scrollTop
      const first = this.rowAtY(scrollTop - OVERSCAN_PX)
      const last = this.rowAtY(scrollTop + scroller.clientHeight + OVERSCAN_PX)
      if (first !== this.firstRow || last !== this.lastRow) {
        this.firstRow = first
        this.lastRow = last
      }
      this.windowTop = this.offsets[first]
    },
    /** Replace estimated heights with real ones for rendered rows, keeping the view anchored */
    measureRenderedRows() {
      const container = this.$refs.window
      const scroller = this.$refs.scroller
      if (!container || !scroller || !this.heights) return
      let firstChanged = -1
      for (const el of container.children) {
        const r = Number(el.dataset.row)
        const height = el.offsetHeight
        if (!height || r >= this.heights.length) continue
        if (Math.abs(height - this.heights[r]) > 0.5) {
          this.heights[r] = height
          if (firstChanged < 0 || r < firstChanged) firstChanged = r
        }
      }
      if (firstChanged < 0) return

      const anchorRow = this.rowAtY(scroller.scrollTop)
      const anchorDelta = scroller.scrollTop - this.offsets[anchorRow]
      this.recomputeOffsets(firstChanged)
      if (firstChanged < anchorRow && !this.autoScroll) {
        this.setScrollTop(this.offsets[anchorRow] + anchorDelta)
      }
      this.updateWindow()
    },
    setScrollTop(value) {
      const scroller = this.$refs.scroller
      if (!scroller) return
      const target = Math.max(0, Math.round(value))
      if (Math.abs(scroller.scrollTop - target) < 1) return
      scroller.scrollTop = target
      this.updateWindow()
    },
    onScroll() {
      if (this.scrollFrame) return
      this.scrollFrame = requestAnimationFrame(() => {
        this.scrollFrame = null
        this.updateWindow()
      })
    },
    onResize() {
      const scroller = this.$refs.scroller
      if (!scroller || !this.index || !this.heights) return
      const width = Math.max(100, scroller.clientWidth - 32)
      if (Math.abs(width - this.contentWidth) > 1) {
        this.relayout()
      } else {
        this.updateWindow()
        this.followCurrent()
      }
    },
    relayout() {
      // Font size or width changed: re-estimate everything, then keep the current position in view
      const scroller = this.$refs.scroller
      const anchorRow = scroller ? this.rowAtY(scroller.scrollTop) : 0
      this.resetLayout()
      if (this.autoScroll) {
        this.followCurrent(true)
      } else if (this.offsets) {
        this.setScrollTop(this.offsets[anchorRow])
      }
    },

    // ---------------------------------------------------------------- sync with playback
    startSyncLoop() {
      this.stopSyncLoop()
      if (this.playing) {
        // Every frame while playing: at 10x speed a word lasts only a couple of frames
        const step = () => {
          this.rafId = requestAnimationFrame(step)
          this.tick()
        }
        this.rafId = requestAnimationFrame(step)
        // Browsers may throttle animation frames (power saving, occluded windows), a timer bounds the delay
        this.pollTimer = setInterval(() => this.tick(), PLAYING_POLL_MS)
      } else {
        // Paused: time only changes by seeking
        this.pollTimer = setInterval(() => this.tick(), PAUSED_POLL_MS)
      }
    },
    stopSyncLoop() {
      if (this.rafId) cancelAnimationFrame(this.rafId)
      clearInterval(this.pollTimer)
      this.rafId = null
      this.pollTimer = null
    },
    tick(force = false) {
      if (!this.index) return
      const time = this.getCurrentTime()
      if (!force && time === this.lastTime) return
      this.lastTime = time
      const { word, segment } = findPosition(this.index, time)
      if (force || word !== this.activeWord || segment !== this.activeSegment) {
        this.activeWord = word
        this.activeSegment = segment
        this.applyHighlight()
        this.followCurrent()
      }
    },
    /** Toggle classes directly on the few affected elements instead of re-rendering the list */
    applyHighlight() {
      const container = this.$refs.window
      if (!container) return
      const wordEl = this.activeWord >= 0 ? container.querySelector(`[data-wi="${this.activeWord}"]`) : null
      if (this.activeWordEl && this.activeWordEl !== wordEl) this.activeWordEl.classList.remove('transcript-word-active')
      if (wordEl) wordEl.classList.add('transcript-word-active')
      this.activeWordEl = wordEl
      this.applyWordGroup(container)

      const segmentEl = this.activeSegment >= 0 ? container.querySelector(`[data-seg="${this.activeSegment}"]`) : null
      if (this.activeSegmentEl && this.activeSegmentEl !== segmentEl) this.activeSegmentEl.classList.remove('transcript-segment-active')
      if (segmentEl) segmentEl.classList.add('transcript-segment-active')
      this.activeSegmentEl = segmentEl
    },
    /** Highlight the words around the narrated one too (READ_ALONG_WORD_COUNTS) */
    applyWordGroup(container) {
      const { first, last } = highlightedWords(this.index, this.activeWord, this.readAlongWords)
      const elements = []
      for (let i = first; i >= 0 && i <= last; i++) {
        const el = container.querySelector(`[data-wi="${i}"]`)
        if (el) elements.push(el)
      }
      if (this.highlightApi) {
        if (!elements.length) return CSS.highlights.delete(WORDS_HIGHLIGHT)
        const range = document.createRange()
        range.setStartBefore(elements[0])
        range.setEndAfter(elements[elements.length - 1])
        CSS.highlights.set(WORDS_HIGHLIGHT, new Highlight(range))
        return
      }
      for (const el of this.groupEls) if (!elements.includes(el)) el.classList.remove('transcript-word-group')
      for (const el of elements) el.classList.add('transcript-word-group')
      this.groupEls = elements
    },
    nextReadAlongWords() {
      const next = READ_ALONG_WORD_COUNTS[(READ_ALONG_WORD_COUNTS.indexOf(this.readAlongWords) + 1) % READ_ALONG_WORD_COUNTS.length]
      this.$store.dispatch('user/updateUserSettings', { readAlongWords: next })
    },
    /** Keep the current word (or its segment while not rendered yet) in view */
    followCurrent(force = false) {
      if (!this.autoScroll || !this.index || this.activeSegment < 0 || !this.offsets) return
      const scroller = this.$refs.scroller
      if (!scroller) return
      const viewport = scroller.clientHeight
      const margin = Math.min(80, viewport * 0.15)
      let top
      let bottom
      if (this.activeWordEl && this.activeWordEl.isConnected) {
        // Measured from the live DOM so it is right even while the window is being re-rendered
        const wordRect = this.activeWordEl.getBoundingClientRect()
        top = wordRect.top - scroller.getBoundingClientRect().top + scroller.scrollTop
        bottom = top + wordRect.height
      } else {
        const row = this.index.segmentRow[this.activeSegment]
        top = this.offsets[row]
        bottom = this.offsets[row + 1]
      }
      const scrollTop = scroller.scrollTop
      if (force || top < scrollTop + margin || bottom > scrollTop + viewport - margin) {
        this.setScrollTop(top - viewport * 0.3)
      }
    },
    stopAutoScroll() {
      this.autoScroll = false
    },
    returnToCurrentPosition() {
      this.autoScroll = true
      this.$nextTick(() => {
        this.applyHighlight()
        this.followCurrent(true)
      })
    },
    onScrollerMousedown(event) {
      // Dragging the scrollbar (the scroller itself is the target, not its content)
      if (event.target === this.$refs.scroller) this.stopAutoScroll()
    },
    onScrollerKeydown(event) {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) this.stopAutoScroll()
    },
    onClick(event) {
      const wordEl = event.target.closest('[data-wi]')
      if (wordEl) {
        const wordIndex = Number(wordEl.dataset.wi)
        if (wordIndex >= 0) this.seek(this.index.wordStarts[wordIndex])
        return
      }
      const chapterEl = event.target.closest('[data-chapter-start]')
      if (chapterEl) this.seek(Number(chapterEl.dataset.chapterStart))
    },
    seek(time) {
      this.autoScroll = true
      this.$emit('seek', time)
      this.$nextTick(() => this.tick(true))
    },

    // ---------------------------------------------------------------- search
    toggleSearch() {
      this.showSearch = !this.showSearch
      if (this.showSearch) {
        this.$nextTick(() => this.$refs.searchInput?.focus())
      } else {
        this.searchQuery = ''
        this.searchResults = []
        this.searchPosition = -1
      }
    },
    runSearch() {
      if (!this.index || !this.normalizedQuery) {
        this.searchResults = []
        this.searchPosition = -1
        return
      }
      this.searchResults = Object.freeze(searchTranscript(this.index, this.normalizedQuery))
      // Start at the first result after the current position
      const startIndex = this.searchResults.findIndex((segmentIndex) => segmentIndex >= Math.max(0, this.activeSegment))
      this.searchPosition = -1
      if (this.searchResults.length) this.goToSearchResult(0, startIndex >= 0 ? startIndex : 0)
    },
    goToSearchResult(direction, absolutePosition = null) {
      if (!this.searchResults.length) return
      const count = this.searchResults.length
      this.searchPosition = absolutePosition !== null ? absolutePosition : (this.searchPosition + direction + count) % count
      const row = this.index.segmentRow[this.searchResults[this.searchPosition]]
      this.autoScroll = false
      const scroller = this.$refs.scroller
      if (scroller) this.setScrollTop(this.offsets[row] - scroller.clientHeight * 0.3)
    },

    changeFontScale(delta) {
      const scale = Math.min(this.maxFontScale, Math.max(this.minFontScale, Math.round((this.fontScale + delta) * 1000) / 1000))
      if (scale === this.fontScale) return
      this.fontScale = scale
      this.$store.dispatch('user/updateUserSettings', { transcriptFontScale: scale })
      this.$nextTick(this.relayout)
    }
  },
  created() {
    // Large, non-reactive data
    this.transcript = null
    this.index = null
    this.heights = null
    this.offsets = null
    this.activeWord = -1
    this.activeSegment = -1
    this.activeWordEl = null
    this.activeSegmentEl = null
    this.groupEls = []
    this.lastTime = null
    this.contentWidth = 400
  },
  updated() {
    // Rows were (re-)rendered: measure them and restore the highlight on the new elements
    this.measureRenderedRows()
    this.applyHighlight()
    this.followCurrent()
  },
  mounted() {
    this.fontScale = this.$store.getters['user/getUserSetting']('transcriptFontScale') || 1
    if (window.ResizeObserver && this.$refs.scroller) {
      this.resizeObserver = new ResizeObserver(() => this.onResize())
      this.resizeObserver.observe(this.$refs.scroller)
    }
    this.loadTranscript()
    this.startSyncLoop()
  },
  beforeDestroy() {
    if (this.highlightApi) CSS.highlights.delete(WORDS_HIGHLIGHT)
    this.stopSyncLoop()
    clearTimeout(this.searchTimeout)
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame)
    this.resizeObserver?.disconnect()
  }
}
</script>

<style scoped>
.transcript-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.25rem;
  color: rgb(209 213 219);
}
.transcript-icon-btn:hover:not(:disabled) {
  color: white;
}
.transcript-icon-btn:disabled {
  opacity: 0.4;
}
.transcript-scroller {
  overflow-anchor: none;
}
.transcript-row {
  padding: 5px 0;
}
/* Ebook transcripts: segments are sentences; extra space where a new paragraph of the book starts */
.transcript-row-paragraph {
  padding-top: 0.9em;
}
.transcript-chapter {
  font-size: 1.15em;
  font-weight: 600;
  color: white;
  padding-top: 14px;
  line-height: 1.6;
  cursor: pointer;
}
.transcript-chapter:hover {
  text-decoration: underline;
}
.transcript-segment {
  line-height: 1.6;
  color: rgb(156 163 175);
  border-left: 3px solid transparent;
  padding-left: 8px;
  margin-left: -11px;
  overflow-wrap: anywhere;
}
.transcript-segment-active {
  color: rgb(243 244 246);
  border-left-color: var(--color-accent);
}
.transcript-segment-heading {
  font-size: 1.15em;
  font-weight: 600;
  color: rgb(229 231 235);
}
.transcript-word {
  cursor: pointer;
  border-radius: 3px;
}
.transcript-word:hover {
  text-decoration: underline;
}
.transcript-word-active,
.transcript-word-group {
  background-color: rgb(250 204 21 / 0.3);
  color: white;
  box-shadow: 0 0 0 2px rgb(250 204 21 / 0.3);
}
/* The narrated word is part of the highlighted words (::highlight below) */
.transcript-highlight-api .transcript-word-active {
  background-color: transparent;
  box-shadow: none;
}
.transcript-search-hit {
  background-color: rgb(33 150 243 / 0.35);
}
.transcript-search-current {
  background-color: rgb(255 255 255 / 0.05);
}
</style>

<style>
::highlight(abs-transcript-words) {
  background-color: rgb(250 204 21 / 0.3);
  color: white;
}
</style>
