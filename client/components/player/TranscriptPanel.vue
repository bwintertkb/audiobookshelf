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
      <ui-tooltip :text="highlighterMode ? $strings.LabelHighlighterOn : $strings.LabelHighlighterOff" direction="bottom">
        <button class="transcript-icon-btn" :aria-label="$strings.ButtonHighlighter" :aria-pressed="highlighterMode ? 'true' : 'false'" @click="toggleHighlighter">
          <span class="material-symbols text-xl" :class="{ fill: highlighterMode }" :style="highlighterMode ? { color: swatches[highlighterColor] } : null">ink_highlighter</span>
        </button>
      </ui-tooltip>
      <ui-tooltip :text="$strings.LabelTranscriptDisplay" direction="bottom">
        <button class="transcript-icon-btn" :class="showDisplayMenu ? 'text-white' : ''" :aria-label="$strings.LabelTranscriptDisplay" :aria-expanded="showDisplayMenu ? 'true' : 'false'" @click="showDisplayMenu = !showDisplayMenu"><span class="material-symbols text-xl">match_case</span></button>
      </ui-tooltip>
      <ui-tooltip :text="$strings.HeaderNotesAndHighlights" direction="bottom">
        <button class="transcript-icon-btn" :aria-label="$strings.HeaderNotesAndHighlights" @click="showAnnotations = true"><span class="material-symbols text-xl">sticky_note_2</span></button>
      </ui-tooltip>
      <ui-tooltip v-if="canOpenBook" :text="$strings.ButtonOpenInBook" direction="bottom">
        <button class="transcript-icon-btn" :aria-label="$strings.ButtonOpenInBook" @click="openBook"><span class="material-symbols text-xl">menu_book</span></button>
      </ui-tooltip>
      <ui-tooltip :text="$strings.ButtonClose" direction="bottom">
        <button class="transcript-icon-btn" :aria-label="$strings.ButtonClose" @click="$emit('close')"><span class="material-symbols text-xl">close</span></button>
      </ui-tooltip>
    </div>

    <!-- Display: text size, font, layout (ebook transcripts), highlighted words -->
    <div v-if="showDisplayMenu" class="transcript-display-menu px-3 py-2 border-b border-black-200 shrink-0 text-sm space-y-2">
      <div class="flex items-center">
        <p class="w-28 shrink-0 text-gray-300">{{ $strings.LabelFontScale }}</p>
        <button class="transcript-icon-btn" :disabled="fontScale <= minFontScale" :aria-label="$strings.LabelFontScale + ' -'" @click="changeFontScale(-0.125)"><span class="material-symbols text-xl">text_decrease</span></button>
        <p class="w-12 text-center">{{ Math.round(fontScale * 100) }}%</p>
        <button class="transcript-icon-btn" :disabled="fontScale >= maxFontScale" :aria-label="$strings.LabelFontScale + ' +'" @click="changeFontScale(0.125)"><span class="material-symbols text-xl">text_increase</span></button>
      </div>
      <div class="flex items-center">
        <p class="w-28 shrink-0 text-gray-300">{{ $strings.LabelFontFamily }}</p>
        <ui-toggle-btns v-model="fontValue" :items="fontItems" class="transcript-toggle" />
      </div>
      <div v-if="transcriptSource === 'ebook'" class="flex items-center">
        <p class="w-28 shrink-0 text-gray-300">{{ $strings.LabelTranscriptLayout }}</p>
        <ui-toggle-btns v-model="layoutValue" :items="layoutItems" class="transcript-toggle" />
      </div>
      <div class="flex items-center">
        <p class="w-28 shrink-0 text-gray-300">{{ $strings.LabelReadAlongHighlight }}</p>
        <ui-toggle-btns v-model="readAlongWordsValue" :items="readAlongWordsItems" class="transcript-toggle" />
      </div>
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

      <div v-show="!loading && !error" ref="scroller" class="transcript-scroller absolute inset-0 overflow-y-auto overflow-x-hidden outline-hidden" tabindex="0" @scroll.passive="onScroll" @wheel.passive="stopAutoScroll" @touchstart.passive="stopAutoScroll" @mousedown="onScrollerMousedown" @mouseup="onMouseUp" @keydown="onScrollerKeydown" @click="onClick" @contextmenu="onContextMenu">
        <div class="relative" :style="{ height: totalHeight + 'px' }">
          <div ref="window" class="absolute left-0 right-0 top-0" :class="{ 'transcript-highlight-api': highlightApi, 'transcript-book': bookLayout }" :style="{ transform: `translateY(${windowTop}px)`, fontSize: fontSizePx + 'px', fontFamily: currentFont.family, paddingLeft: sidePaddingPx + 'px', paddingRight: sidePaddingPx + 'px' }">
            <div v-for="row in visibleRows" :key="row.key" :data-row="row.index" class="transcript-row" :class="{ 'transcript-row-paragraph': row.paragraph }">
              <h3 v-if="row.type === 'chapter'" class="transcript-chapter" :data-chapter-start="row.start">{{ row.title }}</h3>
              <p v-else-if="row.type === 'paragraph'" class="transcript-paragraph" :class="{ 'transcript-book-heading': row.heading, 'transcript-no-indent': row.afterHeading }">
                <span v-for="part in row.segments" :key="part.segment" class="transcript-sentence" :class="{ 'transcript-search-current': part.segment === currentSearchSegment }" :data-seg="part.segment"
                  ><template v-for="word in part.words"
                    ><span :key="word.i" class="transcript-word" :class="{ 'transcript-search-hit': word.hit }" :data-wi="word.i">{{ word.w }}</span
                    ><span v-if="word.note" :key="'n' + word.i" class="transcript-note-marker material-symbols" :data-annotation="word.note" :title="$strings.ButtonNote">sticky_note_2</span>{{ ' ' }}</template
                  ></span
                >
              </p>
              <p v-else class="transcript-segment" :class="{ 'transcript-search-current': row.segment === currentSearchSegment, 'transcript-segment-heading': row.heading }" :data-seg="row.segment">
                <template v-for="word in row.words"
                  ><span :key="word.i" class="transcript-word" :class="{ 'transcript-search-hit': word.hit }" :data-wi="word.i">{{ word.w }}</span
                  ><span v-if="word.note" :key="'n' + word.i" class="transcript-note-marker material-symbols" :data-annotation="word.note" :title="$strings.ButtonNote">sticky_note_2</span>{{ ' ' }}</template
                >
              </p>
            </div>
          </div>
        </div>
      </div>

      <button v-if="!autoScroll && !loading && !error" class="absolute bottom-3 left-1/2 -translate-x-1/2 bg-primary border border-gray-600 hover:border-gray-400 shadow-lg rounded-full px-3 py-1 text-sm flex items-center whitespace-nowrap" @click="returnToCurrentPosition"><span class="material-symbols text-lg pr-1">my_location</span>{{ $strings.ButtonReturnToCurrentPosition }}</button>
    </div>

    <player-read-along-popup v-if="popup" :library-item-id="libraryItem.id" :selection="popup.selection" :annotation="popup.annotation" :anchor="popup.anchor" :play-time="popup.playTime" @play="playFrom" @close="closePopup" />
    <modals-annotations-modal v-model="showAnnotations" :library-item-id="libraryItem.id" :title="bookTitle" :author="bookAuthor" :chapters="chapters" @select="selectAnnotation" />
  </div>
</template>

<script>
import { READ_ALONG_WORD_COUNTS, buildTranscriptIndex, findLastLessOrEqual, findPosition, getTranscriptAudioMismatch, highlightedWords, readAlongWordCount, searchTranscript } from '@/players/transcriptUtils'
import { ANNOTATION_COLORS, ANNOTATION_SWATCHES, annotationWordRanges, annotationsAtWord, createAnnotation, highlighterColor, wordsText } from '@/players/annotations'
import { getAnnotationStore } from '@/players/annotationStore'
import { loadTranscript as fetchTranscript } from '@/players/transcriptCache'

const OVERSCAN_PX = 600
const BASE_FONT_SIZE = 16
const LINE_HEIGHT = 1.6
const ROW_PADDING_PX = 10
const PAUSED_POLL_MS = 250
const PLAYING_POLL_MS = 50
/** CSS Custom Highlight of the words highlighted with the narrated one (styled in the unscoped style below) */
const WORDS_HIGHLIGHT = 'abs-transcript-words'
/** CSS Custom Highlights of the user's highlights, one per colour */
const ANNOTATION_HIGHLIGHT_PREFIX = 'abs-transcript-annotation-'
/** Fonts of the text; avgCharWidth (em) estimates the height of rows that are not rendered yet */
const FONTS = [
  { value: 'sans', family: null, avgCharWidth: 0.48 },
  { value: 'serif', family: 'serif', avgCharWidth: 0.5 },
  { value: 'lexend', family: "'Lexend', sans-serif", avgCharWidth: 0.56 }
]

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
      transcriptSource: null,
      renderVersion: 0,
      annotationsVersion: 0,
      firstRow: 0,
      lastRow: -1,
      windowTop: 0,
      totalHeight: 0,
      autoScroll: true,
      showSearch: false,
      showDisplayMenu: false,
      showAnnotations: false,
      searchQuery: '',
      searchResults: [],
      searchPosition: -1,
      fontScale: 1,
      minFontScale: 0.75,
      maxFontScale: 2,
      popup: null,
      swatches: ANNOTATION_SWATCHES,
      // The highlighted words are one highlight, spaces included; without the API each word is highlighted
      highlightApi: !!(window.CSS?.highlights && window.Highlight)
    }
  },
  watch: {
    'libraryItem.id'() {
      this.loadTranscript()
      this.subscribeAnnotations()
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
    },
    bookLayout() {
      if (this.transcript) this.setTranscript(this.transcript)
    },
    currentFont(font) {
      this.$nextTick(this.relayout)
      // Row heights change again once the font file has loaded
      if (font.family && document.fonts) {
        document.fonts.load(`${this.fontSizePx}px ${font.family}`).then(() => {
          if (this.currentFont === font && !this._isDestroyed) this.relayout()
        })
      }
    }
  },
  computed: {
    fontSizePx() {
      return Math.round(BASE_FONT_SIZE * this.fontScale)
    },
    userSetting() {
      return this.$store.getters['user/getUserSetting'] || (() => null)
    },
    /** Ebook transcripts are laid out like the book (paragraphs, headings) unless set to a sentence per line */
    bookLayout() {
      return this.transcriptSource === 'ebook' && this.userSetting('transcriptLayout') !== 'lines'
    },
    currentFont() {
      const value = this.userSetting('transcriptFont') || (this.bookLayout ? 'serif' : 'sans')
      return FONTS.find((font) => font.value === value) || FONTS[0]
    },
    sidePaddingPx() {
      return this.bookLayout ? 24 : 16
    },
    fontValue: {
      get() {
        return this.currentFont.value
      },
      set(value) {
        this.$store.dispatch('user/updateUserSettings', { transcriptFont: value })
      }
    },
    fontItems() {
      return [
        { text: this.$strings.LabelFontSans, value: 'sans' },
        { text: this.$strings.LabelFontSerif, value: 'serif' },
        { text: 'Lexend', value: 'lexend' }
      ]
    },
    layoutValue: {
      get() {
        return this.bookLayout ? 'book' : 'lines'
      },
      set(value) {
        this.$store.dispatch('user/updateUserSettings', { transcriptLayout: value })
      }
    },
    layoutItems() {
      return [
        { text: this.$strings.LabelTranscriptLayoutBook, value: 'book' },
        { text: this.$strings.LabelTranscriptLayoutLines, value: 'lines' }
      ]
    },
    /** Words highlighted around the narrated word (user setting, shared with the ebook reader) */
    readAlongWords() {
      return readAlongWordCount(this.userSetting('readAlongWords'))
    },
    readAlongWordsValue: {
      get() {
        return this.readAlongWords
      },
      set(count) {
        this.$store.dispatch('user/updateUserSettings', { readAlongWords: count })
      }
    },
    /** Highlighter pen: selected words are highlighted right away, without the menu (user setting, shared with the reader) */
    highlighterMode() {
      return !!this.userSetting('highlighterMode')
    },
    highlighterColor() {
      return highlighterColor(this.userSetting('highlighterColor'))
    },
    readAlongWordsItems() {
      return READ_ALONG_WORD_COUNTS.map((count) => ({ text: String(count), value: count }))
    },
    /** The book's EPUB can be opened in the reader with the highlight (the transcript was made from it) */
    canOpenBook() {
      const media = this.libraryItem.media || {}
      const format = media.ebookFormat || media.ebookFile?.ebookFormat
      return this.transcriptSource === 'ebook' && String(format).toLowerCase() === 'epub'
    },
    bookTitle() {
      return this.libraryItem.media?.metadata?.title || ''
    },
    bookAuthor() {
      const metadata = this.libraryItem.media?.metadata || {}
      return metadata.authorName || (metadata.authors || []).map((author) => author.name).join(', ')
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
      // eslint-disable-next-line no-unused-expressions
      this.annotationsVersion // notes are marked after the last word of their highlight
      const index = this.index
      if (!index) return []
      const tokens = this.searchTokens
      const noteEnds = this.noteEnds
      const segmentWords = (si) => {
        const segment = index.segments[si]
        const firstWord = index.segmentFirstWord[si]
        return segment.words.length
          ? segment.words.map((word, j) => ({
              i: firstWord + j,
              w: word.w,
              hit: tokens.length > 0 && tokens.some((token) => word.w.toLowerCase().includes(token)),
              note: noteEnds.get(firstWord + j) || null
            }))
          : [{ i: -1, w: segment.text, hit: false, note: null }]
      }
      const rows = []
      for (let r = this.firstRow; r <= this.lastRow && r < index.rows.length; r++) {
        const row = index.rows[r]
        if (row.type === 'chapter') {
          rows.push({ key: `r${r}`, index: r, type: 'chapter', title: row.chapter.title, start: row.chapter.start })
        } else if (row.type === 'paragraph') {
          rows.push({ key: `r${r}`, index: r, type: 'paragraph', heading: row.heading, afterHeading: row.afterHeading, segments: row.segments.map((si) => ({ segment: si, words: segmentWords(si) })) })
        } else {
          const segment = index.segments[row.segment]
          rows.push({ key: `r${r}`, index: r, type: 'segment', segment: row.segment, words: segmentWords(row.segment), heading: !!segment.heading, paragraph: !!segment.paragraph })
        }
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
        const transcript = await fetchTranscript(this.$axios, this.libraryItem)
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
      this.transcriptSource = null
      this.index = null
      this.heights = null
      this.offsets = null
      this.activeWord = -1
      this.activeSegment = -1
      this.activeWordEl = null
      this.activeSegmentEl = null
      this.groupEls = []
      this.annotationEls = []
      this.audioMismatch = false
      this.searchResults = []
      this.searchPosition = -1
      this.popup = null
      this.updateAnnotationRanges()
      this.renderVersion++
    },
    async setTranscript(transcript) {
      this.transcript = transcript
      this.transcriptSource = transcript.source || null
      this.heights = null
      this.offsets = null
      // Ebook transcripts carry the book's own headings, so the item's chapter markers would be duplicates
      this.index = buildTranscriptIndex(transcript, transcript.source === 'ebook' ? [] : this.chapters, { paragraphs: this.bookLayout })
      this.audioMismatch = !!getTranscriptAudioMismatch(transcript, this.libraryItem.media?.tracks)
      this.activeWord = -1
      this.activeSegment = -1
      this.lastTime = null
      this.popup = null
      this.updateAnnotationRanges()
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
      this.contentWidth = Math.max(100, scroller.clientWidth - this.sidePaddingPx * 2)
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
      const segments = row.type === 'paragraph' ? row.segments : [row.segment]
      let chars = 0
      for (const si of segments) {
        const segment = this.index.segments[si]
        chars += (segment.text ? segment.text.length : segment.words.reduce((total, word) => total + word.w.length + 1, 0)) + 1
      }
      const scale = row.heading ? 1.2 : 1
      const lines = Math.max(1, Math.ceil((chars * this.fontSizePx * scale * this.currentFont.avgCharWidth) / this.contentWidth))
      if (row.type === 'paragraph') return lines * lineHeight * scale + (row.heading ? this.fontSizePx * 2.1 : 2)
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
      const width = Math.max(100, scroller.clientWidth - this.sidePaddingPx * 2)
      if (Math.abs(width - this.contentWidth) > 1) {
        this.relayout()
      } else {
        this.updateWindow()
        this.followCurrent()
      }
    },
    relayout() {
      // Font, size or width changed: re-estimate everything, then keep the current position in view
      const scroller = this.$refs.scroller
      const anchorRow = scroller ? this.rowAtY(scroller.scrollTop) : 0
      this.resetLayout()
      if (this.autoScroll) {
        this.followCurrent(true)
      } else if (this.offsets) {
        this.setScrollTop(this.offsets[anchorRow])
      }
    },
    /** Scroll a segment into view: to its row first, then to the segment itself once rendered (a paragraph can be long) */
    scrollToSegment(segmentIndex) {
      const scroller = this.$refs.scroller
      if (!scroller || !this.offsets || segmentIndex < 0) return
      const row = this.index.segmentRow[segmentIndex]
      this.setScrollTop(this.offsets[row] - scroller.clientHeight * 0.3)
      this.$nextTick(() => {
        const el = this.$refs.window?.querySelector(`[data-seg="${segmentIndex}"]`)
        if (!el) return
        const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
        this.setScrollTop(top - scroller.clientHeight * 0.3)
      })
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
        const highlight = new Highlight(range)
        highlight.priority = 1 // over the user's highlights
        CSS.highlights.set(WORDS_HIGHLIGHT, highlight)
        return
      }
      for (const el of this.groupEls) if (!elements.includes(el)) el.classList.remove('transcript-word-group')
      for (const el of elements) el.classList.add('transcript-word-group')
      this.groupEls = elements
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
      // Selecting text: the selection gets the highlight menu instead (onMouseUp)
      if (this.hasTextSelection()) return
      const noteEl = event.target.closest('[data-annotation]')
      if (noteEl) {
        this.openAnnotation(noteEl.dataset.annotation, noteEl)
        return
      }
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
    playFrom(time) {
      this.closePopup()
      this.seek(time)
      if (!this.playing) this.$emit('play')
    },

    // ---------------------------------------------------------------- highlights and notes
    subscribeAnnotations() {
      this.releaseAnnotations?.()
      const libraryItemId = this.libraryItem.id
      const store = getAnnotationStore(this.$axios)
      this.annotations = store.get(libraryItemId)
      this.updateAnnotationRanges()
      this.releaseAnnotations = store.subscribe(libraryItemId, (annotations) => {
        this.annotations = annotations
        this.updateAnnotationRanges()
      })
      store.load(libraryItemId)
    },
    updateAnnotationRanges() {
      this.annotationRanges = this.index ? annotationWordRanges(this.index, this.annotations || []) : []
      this.noteEnds = new Map(this.annotationRanges.filter((range) => range.annotation.note).map((range) => [range.last, range.annotation.id]))
      this.annotationsVersion++
      this.$nextTick(this.applyAnnotations)
    },
    /** Draw the user's highlights on the rendered words */
    applyAnnotations() {
      const container = this.$refs.window
      if (!container) return
      const wordEls = container.querySelectorAll('[data-wi]')
      let renderedFirst = Infinity
      let renderedLast = -1
      for (const el of [wordEls[0], wordEls[wordEls.length - 1]]) {
        const i = el ? Number(el.dataset.wi) : -1
        if (i >= 0) {
          renderedFirst = Math.min(renderedFirst, i)
          renderedLast = Math.max(renderedLast, i)
        }
      }
      const byColor = new Map(ANNOTATION_COLORS.map((color) => [color, []]))
      const elements = []
      for (const { color, first, last } of this.annotationRanges || []) {
        const from = Math.max(first, renderedFirst)
        const to = Math.min(last, renderedLast)
        if (from > to) continue
        const startEl = container.querySelector(`[data-wi="${from}"]`)
        const endEl = container.querySelector(`[data-wi="${to}"]`)
        if (!startEl || !endEl) continue
        if (this.highlightApi) {
          const range = document.createRange()
          range.setStartBefore(startEl)
          range.setEndAfter(endEl)
          byColor.get(color).push(range)
        } else {
          for (let i = from; i <= to; i++) {
            const el = container.querySelector(`[data-wi="${i}"]`)
            if (el) elements.push([el, color])
          }
        }
      }
      if (this.highlightApi) {
        for (const [color, ranges] of byColor) {
          if (ranges.length) CSS.highlights.set(ANNOTATION_HIGHLIGHT_PREFIX + color, new Highlight(...ranges))
          else CSS.highlights.delete(ANNOTATION_HIGHLIGHT_PREFIX + color)
        }
        return
      }
      for (const el of this.annotationEls) ANNOTATION_COLORS.forEach((color) => el.classList.remove(`transcript-annotation-${color}`))
      for (const [el, color] of elements) el.classList.add(`transcript-annotation-${color}`)
      this.annotationEls = elements.map(([el]) => el)
    },
    hasTextSelection() {
      const selection = window.getSelection()
      return !!selection && !selection.isCollapsed && !!this.$refs.scroller?.contains(selection.anchorNode)
    },
    /** Transcript words in the text selection: { first, last } or null */
    selectedWords() {
      if (!this.hasTextSelection()) return null
      const selection = window.getSelection()
      let first = -1
      let last = -1
      for (const el of this.$refs.window.querySelectorAll('[data-wi]')) {
        if (!selection.containsNode(el, true)) continue
        const i = Number(el.dataset.wi)
        if (i < 0) continue
        if (first < 0) first = i
        last = i
      }
      return first >= 0 ? { first, last } : null
    },
    onMouseUp(event) {
      if (event.button !== 0) return
      // After the browser updated the selection
      setTimeout(() => {
        const words = this.selectedWords()
        if (!words) return
        if (this.highlighterMode) {
          window.getSelection().removeAllRanges()
          this.quickHighlight(words.first, words.last)
          return
        }
        const rect = window.getSelection().getRangeAt(0).getBoundingClientRect()
        this.openPopup(words.first, words.last, rect)
      })
    },
    toggleHighlighter() {
      const on = !this.highlighterMode
      this.$store.dispatch('user/updateUserSettings', { highlighterMode: on })
      this.$toast.info(on ? this.$strings.ToastHighlighterOn : this.$strings.ToastHighlighterOff)
    },
    /** The highlighter pen: highlight the words in its colour, without the menu */
    async quickHighlight(first, last) {
      try {
        await getAnnotationStore(this.$axios).save(this.libraryItem.id, createAnnotation(this.index, first, last, { color: this.highlighterColor }))
      } catch (error) {
        console.error('[TranscriptPanel] Failed to save highlight', error)
        this.$toast.error(this.$strings.ToastHighlightSaveFailed)
      }
    },
    /** Right-click (or long-press on touch screens) a word: its definition and the highlight menu */
    onContextMenu(event) {
      const wordEl = event.target.closest('[data-wi]')
      const wordIndex = wordEl ? Number(wordEl.dataset.wi) : -1
      if (!this.index || wordIndex < 0) return
      event.preventDefault()
      const words = this.selectedWords()
      if (words && wordIndex >= words.first && wordIndex <= words.last) {
        this.openPopup(words.first, words.last, window.getSelection().getRangeAt(0).getBoundingClientRect())
        return
      }
      const existing = annotationsAtWord(this.index, this.annotations || [], wordIndex)[0]
      if (existing) {
        const range = this.annotationRanges.find((r) => r.annotation.id === existing.id)
        this.openPopup(range.first, range.last, wordEl.getBoundingClientRect(), existing)
        return
      }
      this.openPopup(wordIndex, wordIndex, wordEl.getBoundingClientRect())
    },
    openAnnotation(annotationId, el) {
      const range = (this.annotationRanges || []).find((r) => r.annotation.id === annotationId)
      if (range) this.openPopup(range.first, range.last, el.getBoundingClientRect(), range.annotation)
    },
    openPopup(first, last, rect, annotation = null) {
      const index = this.index
      this.popup = {
        selection: { first, last, text: wordsText(index, first, last), start: index.wordStarts[first], end: index.wordStarts[last] },
        annotation,
        anchor: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        playTime: index.wordStarts[first]
      }
    },
    closePopup() {
      this.popup = null
      if (this.hasTextSelection()) window.getSelection().removeAllRanges()
    },
    selectAnnotation(annotation) {
      this.showAnnotations = false
      this.seek(annotation.start)
    },
    async openBook() {
      try {
        const libraryItem = await this.$axios.$get(`/api/items/${this.libraryItem.id}?expanded=1`)
        this.$store.commit('showEReader', { libraryItem, keepProgress: true })
      } catch (error) {
        console.error('[TranscriptPanel] Failed to open the book', error)
        this.$toast.error(this.$strings.ToastFailedToLoadData)
      }
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
      this.autoScroll = false
      this.scrollToSegment(this.searchResults[this.searchPosition])
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
    this.annotations = []
    this.annotationRanges = []
    this.annotationEls = []
    this.noteEnds = new Map()
    this.lastTime = null
    this.contentWidth = 400
  },
  updated() {
    // Rows were (re-)rendered: measure them and restore the highlights on the new elements
    this.measureRenderedRows()
    this.applyHighlight()
    this.applyAnnotations()
    this.followCurrent()
  },
  mounted() {
    this.fontScale = this.$store.getters['user/getUserSetting']('transcriptFontScale') || 1
    if (window.ResizeObserver && this.$refs.scroller) {
      this.resizeObserver = new ResizeObserver(() => this.onResize())
      this.resizeObserver.observe(this.$refs.scroller)
    }
    this.subscribeAnnotations()
    this.loadTranscript()
    this.startSyncLoop()
  },
  beforeDestroy() {
    if (this.highlightApi) {
      CSS.highlights.delete(WORDS_HIGHLIGHT)
      ANNOTATION_COLORS.forEach((color) => CSS.highlights.delete(ANNOTATION_HIGHLIGHT_PREFIX + color))
    }
    this.releaseAnnotations?.()
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
.transcript-toggle ::v-deep .toggle-btn {
  padding: 0.15rem 0.7rem;
  font-size: 0.8rem;
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
/* Book layout: the book's paragraphs, indented and justified like a printed page */
.transcript-book .transcript-row {
  padding: 0;
}
.transcript-paragraph {
  line-height: 1.6;
  margin: 0;
  padding-bottom: 2px;
  text-indent: 1.5em;
  text-align: justify;
  hyphens: auto;
  overflow-wrap: anywhere;
  color: rgb(209 213 219);
}
.transcript-paragraph.transcript-no-indent {
  text-indent: 0;
}
.transcript-paragraph.transcript-book-heading {
  font-size: 1.2em;
  font-weight: 600;
  line-height: 1.4;
  text-indent: 0;
  text-align: center;
  color: white;
  padding: 1.2em 0 0.55em;
}
.transcript-sentence.transcript-segment-active {
  color: white;
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
.transcript-annotation-yellow {
  background-color: rgb(250 204 21 / 0.38);
}
.transcript-annotation-blue {
  background-color: rgb(56 189 248 / 0.38);
}
.transcript-annotation-pink {
  background-color: rgb(244 114 182 / 0.4);
}
.transcript-annotation-orange {
  background-color: rgb(251 146 60 / 0.42);
}
.transcript-note-marker {
  font-size: 0.85em;
  vertical-align: super;
  color: rgb(250 204 21);
  cursor: pointer;
  text-indent: 0;
  padding-left: 1px;
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
::highlight(abs-transcript-annotation-yellow) {
  background-color: rgb(250 204 21 / 0.38);
}
::highlight(abs-transcript-annotation-blue) {
  background-color: rgb(56 189 248 / 0.38);
}
::highlight(abs-transcript-annotation-pink) {
  background-color: rgb(244 114 182 / 0.4);
}
::highlight(abs-transcript-annotation-orange) {
  background-color: rgb(251 146 60 / 0.42);
}
</style>
