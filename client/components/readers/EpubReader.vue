<template>
  <div id="epub-reader" class="h-full w-full relative">
    <!-- Read along with the audiobook (ebook transcript): play from this page (also when reading ahead of the audio), or go back to the narrated page.
         Opened where the user stopped listening: offer to go back to where they were reading. -->
    <div v-if="readAlongAvailable && listeningJump" class="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2">
      <p class="readalong-btn pointer-events-none"><span class="material-symbols text-xl pr-1">headphones</span>{{ $strings.MessageOpenedWhereYouStoppedListening }}</p>
      <button type="button" class="readalong-btn" @click="backToReadingPosition"><span class="material-symbols text-xl pr-1">undo</span>{{ $strings.ButtonBackToReadingPosition }}</button>
    </div>
    <div v-else-if="readAlongAvailable && (!isStreamingThisItem || !readAlongFollowing)" class="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2">
      <button type="button" class="readalong-btn" @click="playFromHere()"><span class="material-symbols fill text-xl pr-1">play_arrow</span>{{ $strings.ButtonPlayFromHere }}</button>
      <button v-if="isStreamingThisItem" type="button" class="readalong-btn" @click="returnToNarration"><span class="material-symbols text-xl pr-1">my_location</span>{{ $strings.ButtonReturnToNarration }}</button>
    </div>
    <player-read-along-popup v-if="popup" :library-item-id="libraryItemId" :selection="popup.selection" :annotation="popup.annotation" :anchor="popup.anchor" :play-time="popup.playTime" @play="playFromHere" @close="closePopup" />
    <div class="h-full flex items-center justify-center">
      <button type="button" aria-label="Previous page" class="w-24 max-w-24 h-full hidden sm:flex items-center overflow-x-hidden justify-center opacity-50 hover:opacity-100">
        <span v-if="hasPrev" class="material-symbols text-6xl" @mousedown.prevent @click="prev">chevron_left</span>
      </button>
      <div id="frame" class="w-full" style="height: 80%">
        <div id="viewer"></div>
      </div>
      <button type="button" aria-label="Next page" class="w-24 max-w-24 h-full hidden sm:flex items-center justify-center overflow-x-hidden opacity-50 hover:opacity-100">
        <span v-if="hasNext" class="material-symbols text-6xl" @mousedown.prevent @click="next">chevron_right</span>
      </button>
    </div>
  </div>
</template>

<script>
import ePub from 'epubjs'
import ReadAlong from '@/players/ReadAlong'
import { readAlongWordCount } from '@/players/transcriptUtils'
import { wordsText } from '@/players/annotations'
import { getAnnotationStore } from '@/players/annotationStore'
import { loadTranscript as fetchTranscript } from '@/players/transcriptCache'

const READ_ALONG_PLAYING_POLL_MS = 50
const READ_ALONG_PAUSED_POLL_MS = 250
/** Page turns made by the reader itself (opening at the listening position, going to a highlight) are not the user reading */
const OWN_NAVIGATION_MS = 2000
/** How long "opened where you stopped listening" offers to go back */
const LISTENING_JUMP_NOTICE_MS = 12000

/**
 * @typedef {object} EpubReader
 * @property {ePub.Book} book
 * @property {ePub.Rendition} rendition
 */
export default {
  props: {
    libraryItem: {
      type: Object,
      default: () => {}
    },
    playerOpen: Boolean,
    keepProgress: Boolean,
    fileId: String
  },
  data() {
    return {
      windowWidth: 0,
      windowHeight: 0,
      /** @type {ePub.Book} */
      book: null,
      /** @type {ePub.Rendition} */
      rendition: null,
      chapters: [],
      readAlongAvailable: false,
      readAlongFollowing: true,
      popup: null,
      listeningJump: null,
      ereaderSettings: {
        theme: 'dark',
        font: 'serif',
        fontScale: 100,
        lineSpacing: 115,
        spread: 'auto',
        textStroke: 0
      }
    }
  },
  watch: {
    playerOpen() {
      this.resize()
    },
    isStreamingThisItem() {
      this.startReadAlongLoop()
    },
    isPlaying(playing) {
      this.startReadAlongLoop()
      // Play pressed after reading on with the audio paused: it continues from the page, so follow it again
      if (playing && this.isStreamingThisItem && this.readAlong && !this.readAlong.following) {
        let state = null
        this.$eventBus.$emit('player-get-time', (value) => (state = value))
        const page = this.readAlong.pageTimeRange()
        if (page && state && state.time >= page.start - 1 && state.time <= page.end + 1) this.readAlong.resumeFollowing()
      }
    },
    readAlongWords(count) {
      this.readAlong?.setHighlightWords(count)
    },
    readAlongAvailable(available) {
      this.$emit('read-along', available)
    }
  },
  computed: {
    /** @returns {string} */
    libraryItemId() {
      return this.libraryItem?.id
    },
    isStreamingThisItem() {
      return !!this.libraryItemId && this.$store.state.streamLibraryItem?.id === this.libraryItemId
    },
    isPlaying() {
      return this.$store.state.streamIsPlaying
    },
    /** Words highlighted around the narrated word (user setting, shared with the transcript panel) */
    readAlongWords() {
      const getUserSetting = this.$store.getters['user/getUserSetting']
      return readAlongWordCount(getUserSetting ? getUserSetting('readAlongWords') : null)
    },
    /** Reading (audio not playing) moves the listening position along; opening goes to where the user stopped listening */
    syncReadingListening() {
      const getUserSetting = this.$store.getters['user/getUserSetting']
      return !getUserSetting || getUserSetting('syncReadingListening') !== false
    },
    allowScriptedContent() {
      return this.$store.getters['libraries/getLibraryEpubsAllowScriptedContent']
    },
    hasPrev() {
      return !this.rendition?.location?.atStart
    },
    hasNext() {
      return !this.rendition?.location?.atEnd
    },
    userMediaProgress() {
      if (!this.libraryItemId) return
      return this.$store.getters['user/getUserMediaProgress'](this.libraryItemId)
    },
    savedEbookLocation() {
      if (!this.keepProgress) return null
      if (!this.userMediaProgress?.ebookLocation) return null
      // Validate ebookLocation is an epubcfi
      if (!String(this.userMediaProgress.ebookLocation).startsWith('epubcfi')) return null
      return this.userMediaProgress.ebookLocation
    },
    localStorageLocationsKey() {
      return `ebookLocations-${this.libraryItemId}`
    },
    readerWidth() {
      if (this.windowWidth < 640) return this.windowWidth
      return this.windowWidth - 200
    },
    readerHeight() {
      if (this.windowHeight < 400 || !this.playerOpen) return this.windowHeight
      return this.windowHeight - 164
    },
    ebookUrl() {
      if (this.fileId) {
        return `/api/items/${this.libraryItemId}/ebook/${this.fileId}`
      }
      return `/api/items/${this.libraryItemId}/ebook`
    },
    themeRules() {
      const theme = this.ereaderSettings.theme
      const isDark = theme === 'dark'
      const isSepia = theme === 'sepia'

      const fontColor = isDark
        ? '#fff'
        : isSepia
        ? '#5b4636'
        : '#000'

      const backgroundColor = isDark
        ? 'rgb(35 35 35)'
        : isSepia
        ? 'rgb(244, 236, 216)'
        : 'rgb(255, 255, 255)'

      const lineSpacing = this.ereaderSettings.lineSpacing / 100
      const fontScale   = this.ereaderSettings.fontScale   / 100
      const textStroke  = this.ereaderSettings.textStroke  / 100

      return {
        '*': {
          color: `${fontColor}!important`,
          'background-color': `${backgroundColor}!important`,
          'line-height': `${lineSpacing * fontScale}rem!important`,
          '-webkit-text-stroke': `${textStroke}px ${fontColor}!important`
        },
        a: {
          color: `${fontColor}!important`
        }
      }
    }
  },
  methods: {
    updateSettings(settings) {
      this.ereaderSettings = settings

      if (!this.rendition) return

      this.applyTheme()

      const fontScale = settings.fontScale || 100
      this.rendition.themes.fontSize(`${fontScale}%`)
      this.rendition.themes.font(settings.font)
      this.rendition.spread(settings.spread || 'auto')
    },
    prev() {
      if (!this.rendition?.manager) return
      this.readAlong?.pauseFollowing()
      return this.rendition?.prev()
    },
    next() {
      if (!this.rendition?.manager) return
      this.readAlong?.pauseFollowing()
      return this.rendition?.next()
    },
    goToChapter(href) {
      if (!this.rendition?.manager) return
      this.readAlong?.pauseFollowing()
      return this.rendition?.display(href)
    },
    /** Read along with the audiobook when the item has a transcript made from this ebook */
    async loadReadAlong() {
      if (!this.libraryItem?.hasTranscript || this.fileId) return
      let transcript
      try {
        transcript = await fetchTranscript(this.$axios, this.libraryItem)
      } catch (error) {
        console.error('EpubReader.loadReadAlong failed', error)
        return
      }
      if (!ReadAlong.isSupported(transcript) || !this.rendition || this._isDestroyed) return
      this.readAlong = new ReadAlong({
        rendition: this.rendition,
        transcript,
        highlightWords: this.readAlongWords,
        onSeek: (time) => this.$eventBus.$emit('playback-seek', time),
        onFollowChanged: (following) => {
          this.readAlongFollowing = following
        },
        onSelect: (selection) => this.openPopup(selection)
      })
      const views = this.rendition.views()?.all?.() || []
      views.forEach((view) => this.readAlong.onRendered(view.section, view))
      this.readAlongAvailable = true
      this.subscribeAnnotations()
      this.startReadAlongLoop()
      this.openAtListeningPosition()
    },
    subscribeAnnotations() {
      const store = getAnnotationStore(this.$axios)
      this.releaseAnnotations?.()
      this.readAlong.setAnnotations(store.get(this.libraryItemId))
      this.releaseAnnotations = store.subscribe(this.libraryItemId, (annotations) => this.readAlong?.setAnnotations(annotations))
      store.load(this.libraryItemId)
    },
    /**
     * Opened without the audiobook in the player: if the user listened on since they last read (the listening position is not
     * on the saved page), show where they stopped listening instead, and offer to go back
     */
    async openAtListeningPosition() {
      if (!this.syncReadingListening || !this.keepProgress || this.isStreamingThisItem) return
      const progress = this.userMediaProgress
      const listeningTime = progress?.currentTime
      if (!listeningTime || progress.isFinished) return
      await this.initialDisplay?.catch(() => {})
      if (!this.readAlong || this._isDestroyed || this.isStreamingThisItem) return
      const page = this.readAlong.pageTimeRange()
      if (page && listeningTime >= page.start - 1 && listeningTime <= page.end + 1) return
      let cfi = null
      try {
        cfi = this.rendition.currentLocation()?.start?.cfi || null
      } catch (error) {
        cfi = null
      }
      this.listeningJump = { cfi }
      this.ownNavigationUntil = Date.now() + OWN_NAVIGATION_MS
      this.staticTime = listeningTime
      this.readAlong.showTime(listeningTime)
      this.startReadAlongLoop()
      clearTimeout(this.listeningJumpTimeout)
      this.listeningJumpTimeout = setTimeout(() => (this.listeningJump = null), LISTENING_JUMP_NOTICE_MS)
    },
    backToReadingPosition() {
      const cfi = this.listeningJump?.cfi
      this.listeningJump = null
      this.readAlong?.pauseFollowing()
      this.ownNavigationUntil = Date.now() + OWN_NAVIGATION_MS
      if (cfi) this.rendition?.display(cfi)
    },
    /** A highlight chosen in the list: turn to it (the narration is not changed) */
    goToAnnotation(annotation) {
      if (!this.readAlong) return
      this.ownNavigationUntil = Date.now() + OWN_NAVIGATION_MS
      this.readAlong.goToTime(annotation.start)
      this.startReadAlongLoop()
    },
    openPopup({ first, last, rect, annotation }) {
      const index = this.readAlong.index
      this.popup = {
        selection: { first, last, text: wordsText(index, first, last), start: index.wordStarts[first], end: index.wordStarts[last] },
        annotation,
        anchor: rect,
        playTime: index.wordStarts[first],
        // Closed when the page turns (epub.js also reports the same page again, e.g. after re-displaying it)
        page: this.currentPageCfi()
      }
    },
    currentPageCfi() {
      try {
        return this.rendition?.currentLocation()?.start?.cfi || null
      } catch (error) {
        return null
      }
    },
    closePopup() {
      this.popup = null
      this.readAlong?.clearTextSelection()
    },
    startReadAlongLoop() {
      this.stopReadAlongLoop()
      if (!this.readAlong) return
      if (!this.isStreamingThisItem) {
        // Not in the player: keep turning to a chosen position (where the user stopped listening, a highlight)
        this.readAlongTimer = setInterval(this.readAlongTick, READ_ALONG_PAUSED_POLL_MS)
        this.readAlongTick(true)
        return
      }
      this.staticTime = null
      if (this.isPlaying) {
        // Every frame while playing (a word can last a couple of frames at high speeds), plus a timer in case frames are throttled
        const step = () => {
          this.readAlongFrame = requestAnimationFrame(step)
          this.readAlongTick()
        }
        this.readAlongFrame = requestAnimationFrame(step)
        this.readAlongTimer = setInterval(this.readAlongTick, READ_ALONG_PLAYING_POLL_MS)
      } else {
        this.readAlongTimer = setInterval(this.readAlongTick, READ_ALONG_PAUSED_POLL_MS)
      }
      this.readAlongTick(true)
    },
    stopReadAlongLoop() {
      if (this.readAlongFrame) cancelAnimationFrame(this.readAlongFrame)
      clearInterval(this.readAlongTimer)
      this.readAlongFrame = null
      this.readAlongTimer = null
    },
    readAlongTick(force = false) {
      if (!this.readAlong) return
      let state = null
      if (this.isStreamingThisItem) this.$eventBus.$emit('player-get-time', (value) => (state = value))
      try {
        if (state?.libraryItemId === this.libraryItemId) this.readAlong.update(state.time, force)
        else if (this.staticTime !== null && this.staticTime !== undefined) this.readAlong.update(this.staticTime, force)
        else this.readAlong.pump()
      } catch (error) {
        // Runs every frame: report once instead of flooding the console
        if (!this.readAlongErrorLogged) console.error('EpubReader read along failed', error)
        this.readAlongErrorLogged = true
      }
    },
    /** @param {number} [time] - a chosen word; the first narrated word of the page if not given */
    playFromHere(time) {
      this.closePopup()
      this.listeningJump = null
      const startTime = typeof time === 'number' ? time : this.readAlong?.firstVisibleWordTime() ?? 0
      // Highlight the new start first, so following does not turn back to the old narration page
      this.readAlong?.startAt(startTime)
      if (this.isStreamingThisItem) {
        // Jump the open player to this page (e.g. after reading ahead of the audio) and play
        this.$eventBus.$emit('playback-seek', startTime)
        if (!this.isPlaying) this.$eventBus.$emit('play-item', { libraryItemId: this.libraryItemId })
      } else {
        this.$eventBus.$emit('play-item', { libraryItemId: this.libraryItemId, startTime })
      }
    },
    returnToNarration() {
      this.readAlong?.resumeFollowing()
    },
    /**
     * The user read on with the audio not playing: the listening position follows the page (the first narrated word on it),
     * also in the player if the book is open there, so pressing play continues from the page
     *
     * @returns {Object} progress fields to save with the ebook location
     */
    readingProgress() {
      if (!this.syncReadingListening || !this.readAlong || this.readAlong.following || Date.now() < (this.ownNavigationUntil || 0)) return {}
      if (this.isStreamingThisItem && this.isPlaying) return {} // reading ahead while listening
      const time = this.readAlong.firstVisibleWordTime()
      if (time === null) return {}
      this.listeningJump = null
      if (this.isStreamingThisItem) {
        this.readAlong.startAt(time)
        this.readAlong.pauseFollowing()
        this.$eventBus.$emit('playback-seek', time)
      }
      const duration = this.libraryItem?.media?.duration
      return duration ? { currentTime: time, duration, progress: Math.min(1, time / duration) } : { currentTime: time }
    },
    /** @returns {object} Returns the chapter that the `position` in the book is in */
    findChapterFromPosition(chapters, position) {
      let foundChapter
      for (let i = 0; i < chapters.length; i++) {
        if (position >= chapters[i].start && (!chapters[i + 1] || position < chapters[i + 1].start)) {
          foundChapter = chapters[i]
          if (chapters[i].subitems && chapters[i].subitems.length > 0) {
            return this.findChapterFromPosition(chapters[i].subitems, position, foundChapter)
          }
          break
        }
      }
      return foundChapter
    },
    /** @returns {Array} Returns an array of chapters that only includes chapters with query results */
    async searchBook(query) {
      const chapters = structuredClone(await this.chapters)
      const searchResults = await Promise.all(this.book.spine.spineItems.map((item) => item.load(this.book.load.bind(this.book)).then(item.find.bind(item, query)).finally(item.unload.bind(item))))
      const mergedResults = [].concat(...searchResults)

      mergedResults.forEach((chapter) => {
        chapter.start = this.book.locations.percentageFromCfi(chapter.cfi)
        const foundChapter = this.findChapterFromPosition(chapters, chapter.start)
        if (foundChapter) foundChapter.searchResults.push(chapter)
      })

      let filteredResults = chapters.filter(function f(o) {
        if (o.searchResults.length) return true
        if (o.subitems.length) {
          return (o.subitems = o.subitems.filter(f)).length
        }
      })
      return filteredResults
    },
    keyUp(e) {
      const rtl = this.book.package.metadata.direction === 'rtl'
      if ((e.keyCode || e.which) == 37) {
        return rtl ? this.next() : this.prev()
      } else if ((e.keyCode || e.which) == 39) {
        return rtl ? this.prev() : this.next()
      }
    },
    /**
     * @param {object} payload
     * @param {string} payload.ebookLocation - CFI of the current location
     * @param {string} payload.ebookProgress - eBook Progress Percentage
     */
    updateProgress(payload) {
      if (!this.keepProgress) return
      this.$axios.$patch(`/api/me/progress/${this.libraryItemId}`, payload, { progress: false }).catch((error) => {
        console.error('EpubReader.updateProgress failed:', error)
      })
    },
    getAllEbookLocationData() {
      const locations = []
      let totalSize = 0 // Total in bytes

      for (const key in localStorage) {
        if (!localStorage.hasOwnProperty(key) || !key.startsWith('ebookLocations-')) {
          continue
        }

        try {
          const ebookLocations = JSON.parse(localStorage[key])
          if (!ebookLocations.locations) throw new Error('Invalid locations object')

          ebookLocations.key = key
          ebookLocations.size = (localStorage[key].length + key.length) * 2
          locations.push(ebookLocations)
          totalSize += ebookLocations.size
        } catch (error) {
          console.error('Failed to parse ebook locations', key, error)
          localStorage.removeItem(key)
        }
      }

      // Sort by oldest lastAccessed first
      locations.sort((a, b) => a.lastAccessed - b.lastAccessed)

      return {
        locations,
        totalSize
      }
    },
    /** @param {string} locationString */
    checkSaveLocations(locationString) {
      const maxSizeInBytes = 3000000 // Allow epub locations to take up to 3MB of space
      const newLocationsSize = JSON.stringify({ lastAccessed: Date.now(), locations: locationString }).length * 2

      // Too large overall
      if (newLocationsSize > maxSizeInBytes) {
        console.error('Epub locations are too large to store. Size =', newLocationsSize)
        return
      }

      const ebookLocationsData = this.getAllEbookLocationData()

      let availableSpace = maxSizeInBytes - ebookLocationsData.totalSize

      // Remove epub locations until there is room for locations
      while (availableSpace < newLocationsSize && ebookLocationsData.locations.length) {
        const oldestLocation = ebookLocationsData.locations.shift()
        console.log(`Removing cached locations for epub "${oldestLocation.key}" taking up ${oldestLocation.size} bytes`)
        availableSpace += oldestLocation.size
        localStorage.removeItem(oldestLocation.key)
      }

      console.log(`Cacheing epub locations with key "${this.localStorageLocationsKey}" taking up ${newLocationsSize} bytes`)
      this.saveLocations(locationString)
    },
    /** @param {string} locationString */
    saveLocations(locationString) {
      localStorage.setItem(
        this.localStorageLocationsKey,
        JSON.stringify({
          lastAccessed: Date.now(),
          locations: locationString
        })
      )
    },
    loadLocations() {
      const locationsObjString = localStorage.getItem(this.localStorageLocationsKey)
      if (!locationsObjString) return null

      const locationsObject = JSON.parse(locationsObjString)

      // Remove invalid location objects
      if (!locationsObject.locations) {
        console.error('Invalid epub locations stored', this.localStorageLocationsKey)
        localStorage.removeItem(this.localStorageLocationsKey)
        return null
      }

      // Update lastAccessed
      this.saveLocations(locationsObject.locations)

      return locationsObject.locations
    },
    /** @param {string} location - CFI of the new location */
    relocated(location) {
      if (this.popup && this.popup.page !== location.start.cfi) this.closePopup()
      if (this.savedEbookLocation === location.start.cfi) {
        return
      }

      const reading = this.keepProgress ? this.readingProgress() : {}
      if (location.end.percentage) {
        this.updateProgress({
          ebookLocation: location.start.cfi,
          ebookProgress: location.end.percentage,
          ...reading
        })
      } else {
        this.updateProgress({
          ebookLocation: location.start.cfi,
          ...reading
        })
      }
    },
    initEpub() {
      /** @type {EpubReader} */
      const reader = this

      // Use axios to make request because we have token refresh logic in interceptor
      const customRequest = async (url) => {
        try {
          return this.$axios.$get(url, {
            responseType: 'arraybuffer'
          })
        } catch (error) {
          console.error('EpubReader.initEpub customRequest failed:', error)
          throw error
        }
      }

      /** @type {ePub.Book} */
      reader.book = new ePub(reader.ebookUrl, {
        width: this.readerWidth,
        height: this.readerHeight - 50,
        openAs: 'epub',
        requestMethod: customRequest
      })

      /** @type {ePub.Rendition} */
      reader.rendition = reader.book.renderTo('viewer', {
        width: this.readerWidth,
        height: this.readerHeight * 0.8,
        allowScriptedContent: this.allowScriptedContent,
        spread: 'auto',
        snap: true,
        manager: 'continuous',
        flow: 'paginated'
      })

      // load saved progress
      this.initialDisplay = Promise.resolve(reader.rendition.display(this.savedEbookLocation || reader.book.locations.start))

      reader.rendition.on('rendered', (section, view) => {
        this.applyTheme()
        this.readAlong?.onRendered(section, view)
      })
      reader.rendition.on('removed', (section, view) => {
        this.readAlong?.onRemoved(section, view)
      })

      reader.book.ready
        .then(() => {
          // set up event listeners
          reader.rendition.on('relocated', reader.relocated)
          reader.rendition.on('keydown', reader.keyUp)

          // A click or touch in the book closes the menu of chosen words (the book is in iframes, the menu does not see it)
          reader.rendition.on('mousedown', () => {
            if (this.popup) this.closePopup()
          })
          reader.rendition.on('touchstart', (event) => {
            if (this.popup) this.closePopup()
            this.$emit('touchstart', event)
          })
          reader.rendition.on('touchend', (event) => {
            this.$emit('touchend', event)
          })

          // load ebook cfi locations
          const savedLocations = this.loadLocations()
          if (savedLocations) {
            reader.book.locations.load(savedLocations)
          } else {
            reader.book.locations.generate().then(() => {
              this.checkSaveLocations(reader.book.locations.save())
            })
          }
          this.getChapters()
          this.loadReadAlong()
        })
        .catch((error) => {
          console.error('EpubReader.initEpub failed:', error)
        })
    },
    getChapters() {
      // Load the list of chapters in the book. See https://github.com/futurepress/epub.js/issues/759
      const toc = this.book?.navigation?.toc || []

      const tocTree = []

      const resolveURL = (url, relativeTo) => {
        // see https://github.com/futurepress/epub.js/issues/1084
        // HACK-ish: abuse the URL API a little to resolve the path
        // the base needs to be a valid URL, or it will throw a TypeError,
        // so we just set a random base URI and remove it later
        const base = 'https://example.invalid/'
        return new URL(url, base + relativeTo).href.replace(base, '')
      }

      const basePath = this.book.packaging.navPath || this.book.packaging.ncxPath

      const createTree = async (toc, parent) => {
        const promises = toc.map(async (tocItem, i) => {
          const href = resolveURL(tocItem.href, basePath)
          const id = href.split('#')[1]
          const item = this.book.spine.get(href)
          await item.load(this.book.load.bind(this.book))
          const el = id ? item.document.getElementById(id) : item.document.body

          const cfi = item.cfiFromElement(el)

          parent[i] = {
            title: tocItem.label.trim(),
            subitems: [],
            href,
            cfi,
            start: this.book.locations.percentageFromCfi(cfi),
            end: null, // set by flattenChapters()
            id: null, // set by flattenChapters()
            searchResults: []
          }

          if (tocItem.subitems) {
            await createTree(tocItem.subitems, parent[i].subitems)
          }
        })
        await Promise.all(promises)
      }
      return createTree(toc, tocTree).then(() => {
        this.chapters = tocTree
      })
    },
    flattenChapters(chapters) {
      // Convert the nested epub chapters into something that looks like audiobook chapters for player-ui
      const unwrap = (chapters) => {
        return chapters.reduce((acc, chapter) => {
          return chapter.subitems ? [...acc, chapter, ...unwrap(chapter.subitems)] : [...acc, chapter]
        }, [])
      }
      let flattenedChapters = unwrap(chapters)

      flattenedChapters = flattenedChapters.sort((a, b) => a.start - b.start)
      for (let i = 0; i < flattenedChapters.length; i++) {
        flattenedChapters[i].id = i
        if (i < flattenedChapters.length - 1) {
          flattenedChapters[i].end = flattenedChapters[i + 1].start
        } else {
          flattenedChapters[i].end = 1
        }
      }
      return flattenedChapters
    },
    resize() {
      this.windowWidth = window.innerWidth
      this.windowHeight = window.innerHeight
      // The manager only exists once the first section is displayed
      if (this.rendition?.manager) this.rendition.resize(this.readerWidth, this.readerHeight * 0.8)
    },
    applyTheme() {
      if (!this.rendition) return
      this.rendition.getContents().forEach((c) => {
        c.addStylesheetRules(this.themeRules)
      })
    }
  },
  created() {
    this.staticTime = null
    this.ownNavigationUntil = 0
  },
  mounted() {
    this.windowWidth = window.innerWidth
    this.windowHeight = window.innerHeight
    window.addEventListener('resize', this.resize)
    this.initEpub()
  },
  beforeDestroy() {
    window.removeEventListener('resize', this.resize)
    clearTimeout(this.listeningJumpTimeout)
    this.releaseAnnotations?.()
    this.stopReadAlongLoop()
    this.readAlong?.destroy()
    this.book?.destroy()
  }
}
</script>

<style scoped>
.readalong-btn {
  display: flex;
  align-items: center;
  white-space: nowrap;
  border-radius: 9999px;
  padding: 0.25rem 0.9rem 0.25rem 0.6rem;
  font-size: 0.875rem;
  background-color: rgb(35 35 35 / 0.85);
  color: white;
  border: 1px solid rgb(255 255 255 / 0.25);
  box-shadow: 0 4px 12px rgb(0 0 0 / 0.3);
}
.readalong-btn:hover {
  border-color: rgb(255 255 255 / 0.6);
}
</style>
