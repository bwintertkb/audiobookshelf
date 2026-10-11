import { ReadingSettingsSync, takeLegacyReadingSettings, validReadingSettings } from '@/players/readingSettings'

export const state = () => ({
  user: null,
  accessToken: null,
  settings: {
    orderBy: 'media.metadata.title',
    orderDesc: false,
    filterBy: 'all',
    playbackRate: 1,
    playbackRateIncrementDecrement: 0.1,
    bookshelfCoverSize: 120,
    collapseSeries: false,
    collapseBookSeries: false,
    showSubtitles: false,
    useChapterTrack: false,
    seriesSortBy: 'name',
    seriesSortDesc: false,
    seriesFilterBy: 'all',
    authorSortBy: 'name',
    authorSortDesc: false,
    jumpForwardAmount: 10,
    jumpBackwardAmount: 10,
    // 'browser': speech recognition on this computer's GPU in the page (WebGPU); 'helper': the local transcribe helper
    transcriptEngine: 'browser',
    transcriptHelperUrl: 'http://127.0.0.1:8765',
    showTranscriptPanel: false,
    // Read-along: words highlighted around the narrated word (transcript panel and ebook reader)
    readAlongWords: 3,
    // Transcript panel: 'book' lays out ebook transcripts like the book (paragraphs), 'lines' shows a sentence per line
    transcriptLayout: 'book',
    // Saved on the account with the other reading settings (players/readingSettings.js): the font of the book and the
    // transcript ('sans', 'serif' or 'lexend'; '': serif, sans in the transcript's lines layout), text size (%), the
    // book's line spacing, boldness and layout, and the app's full page reader
    readingFont: '',
    readingFontScale: 100,
    readingLineSpacing: 115,
    readingTextStroke: 0,
    readingSpread: 'auto',
    readerHidePlayer: false,
    readerShowInfo: true,
    // Reading the ebook while its audio is not playing moves the listening position along; opening the ebook goes to where you stopped listening
    syncReadingListening: true,
    // When a sleep timer ends: 'sentence' or 'paragraph' finishes it first (books with a transcript), 'off' stops right away
    sleepTimerFinish: 'sentence',
    // The browser's media controls show the sentence being read
    readAlongMediaSession: true,
    // Highlighter pen: selected words are highlighted right away (no menu), in the colour last picked
    highlighterMode: false,
    highlighterColor: 'yellow',
    // Colour scheme of the transcript and the ebook reader (players/readingThemes.js; '' until chosen: the reader's old theme)
    readingTheme: ''
  }
})

/** Reading settings kept in step with the account (players/readingSettings.js) */
let readingSync = null
function getReadingSync(store) {
  if (!readingSync) {
    readingSync = new ReadingSettingsSync({
      request: (method, path, body) => (method === 'GET' ? store.$axios.$get(path) : store.$axios.$patch(path, body)),
      current: () => validReadingSettings(store.state.user.settings),
      apply: (settings) => store.dispatch('user/applyReadingSettings', settings)
    })
  }
  return readingSync
}

/**
 * @param {Object} settings
 * @param {Object} payload
 * @returns {Object} the settings in `payload` that change `settings`
 */
function changedSettings(settings, payload) {
  const changed = {}
  for (const key in settings) {
    if (payload[key] !== undefined && settings[key] !== payload[key]) changed[key] = payload[key]
  }
  return changed
}

export const getters = {
  getIsRoot: (state) => state.user && state.user.type === 'root',
  getIsAdminOrUp: (state) => state.user && (state.user.type === 'admin' || state.user.type === 'root'),
  getToken: (state) => {
    return state.accessToken || null
  },
  getUserMediaProgress:
    (state) =>
    (libraryItemId, episodeId = null) => {
      if (!state.user?.mediaProgress) return null
      return state.user.mediaProgress.find((li) => {
        if (episodeId && li.episodeId !== episodeId) return false
        return li.libraryItemId == libraryItemId
      })
    },
  getUserBookmarksForItem: (state) => (libraryItemId) => {
    if (!state.user?.bookmarks) return []
    return state.user.bookmarks.filter((bm) => bm.libraryItemId === libraryItemId)
  },
  getUserSetting: (state) => (key) => {
    return state.settings?.[key] || null
  },
  getUserCanUpdate: (state) => {
    return !!state.user?.permissions?.update
  },
  getUserCanDelete: (state) => {
    return !!state.user?.permissions?.delete
  },
  getUserCanDownload: (state) => {
    return !!state.user?.permissions?.download
  },
  getUserCanUpload: (state) => {
    return !!state.user?.permissions?.upload
  },
  getUserCanAccessAllLibraries: (state) => {
    return !!state.user?.permissions?.accessAllLibraries
  },
  getUserCanAccessExplicitContent: (state) => {
    return !!state.user?.permissions?.accessExplicitContent
  },
  getLibrariesAccessible: (state, getters) => {
    if (!state.user) return []
    if (getters.getUserCanAccessAllLibraries) return []
    return state.user.librariesAccessible || []
  },
  getCanAccessLibrary: (state, getters) => (libraryId) => {
    if (!state.user) return false
    if (getters.getUserCanAccessAllLibraries) return true
    return getters.getLibrariesAccessible.includes(libraryId)
  },
  getIsSeriesRemovedFromContinueListening: (state) => (seriesId) => {
    if (!state.user || !state.user.seriesHideFromContinueListening || !state.user.seriesHideFromContinueListening.length) return false
    return state.user.seriesHideFromContinueListening.includes(seriesId)
  },
  getSizeMultiplier: (state) => {
    return state.settings.bookshelfCoverSize / 120
  }
}

export const actions = {
  // When changing libraries make sure sort and filter is still valid
  checkUpdateLibrarySortFilter({ state, dispatch, commit }, mediaType) {
    const settingsUpdate = {}
    if (mediaType == 'podcast') {
      if (state.settings.orderBy == 'media.metadata.authorName' || state.settings.orderBy == 'media.metadata.authorNameLF') {
        settingsUpdate.orderBy = 'media.metadata.author'
      }
      if (state.settings.orderBy == 'media.duration') {
        settingsUpdate.orderBy = 'media.numTracks'
      }
      if (state.settings.orderBy == 'media.metadata.publishedYear' || state.settings.orderBy == 'progress') {
        settingsUpdate.orderBy = 'media.metadata.title'
      }
      const invalidFilters = ['series', 'authors', 'narrators', 'publishers', 'publishedDecades', 'languages', 'progress', 'issues', 'ebooks', 'abridged']
      const filterByFirstPart = (state.settings.filterBy || '').split('.').shift()
      if (invalidFilters.includes(filterByFirstPart)) {
        settingsUpdate.filterBy = 'all'
      }
    } else {
      if (state.settings.orderBy == 'media.metadata.author') {
        settingsUpdate.orderBy = 'media.metadata.authorName'
      }
      if (state.settings.orderBy == 'media.numTracks') {
        settingsUpdate.orderBy = 'media.duration'
      }
    }
    if (Object.keys(settingsUpdate).length) {
      dispatch('updateUserSettings', settingsUpdate)
    }
  },
  updateUserSettings({ state, commit }, payload) {
    if (!payload) return false

    const changed = changedSettings(state.settings, payload)
    if (Object.keys(changed).length) {
      commit('setSettings', { ...state.settings, ...changed })
      this.$eventBus.$emit('user-settings', state.settings)
      // Reading settings are saved on the account too
      const reading = validReadingSettings(changed)
      if (Object.keys(reading).length) getReadingSync(this).changed(reading)
    }
  },
  /** Reading settings of the account (loaded, or changed on another device): used here, not sent back */
  applyReadingSettings({ state, commit }, settings) {
    const changed = changedSettings(state.settings, settings || {})
    if (!Object.keys(changed).length) return
    commit('setSettings', { ...state.settings, ...changed })
    this.$eventBus.$emit('user-settings', state.settings)
  },
  /** Connected: the reading settings changed here are saved on the account, then the account's are used */
  loadReadingSettings() {
    return getReadingSync(this).load()
  },
  /** socket reading_settings_updated */
  receivedReadingSettings(context, settings) {
    getReadingSync(this).received(settings)
  },
  loadUserSettings({ state, commit }) {
    // Load settings from local storage
    let userSettingsFromLocal = null
    try {
      userSettingsFromLocal = JSON.parse(localStorage.getItem('userSettings') || 'null')
    } catch (error) {
      console.error('Failed to load userSettings from local storage', error)
    }
    const userSettings = { ...state.settings }
    for (const key in userSettings) {
      if (userSettingsFromLocal?.[key] !== undefined) {
        userSettings[key] = userSettingsFromLocal[key]
      }
    }
    // Once: the reading settings kept before they were saved on the account (ebook reader, transcript font and size)
    Object.assign(userSettings, takeLegacyReadingSettings(localStorage, userSettingsFromLocal || {}))
    commit('setSettings', userSettings)
    this.$eventBus.$emit('user-settings', state.settings)
  },
  refreshToken({ state, commit }) {
    return this.$axios
      .$post('/auth/refresh')
      .then(async (response) => {
        const newAccessToken = response.user.accessToken
        commit('setAccessToken', newAccessToken)
        // Emit event used to re-authenticate socket in default.vue since $root is not available here
        if (this.$eventBus) {
          this.$eventBus.$emit('token_refreshed', newAccessToken)
        }
        return newAccessToken
      })
      .catch((error) => {
        console.error('Failed to refresh token', error)
        commit('setUser', null)
        commit('setAccessToken', null)
        // Calling function handles redirect to login
        throw error
      })
  }
}

export const mutations = {
  setUser(state, user) {
    state.user = user
  },
  setAccessToken(state, token) {
    if (!token) {
      localStorage.removeItem('token')
      state.accessToken = null
    } else {
      state.accessToken = token
      localStorage.setItem('token', token)
    }
  },
  updateMediaProgress(state, { id, data }) {
    if (!state.user) return
    if (!data) {
      state.user.mediaProgress = state.user.mediaProgress.filter((lip) => lip.id != id)
    } else {
      var indexOf = state.user.mediaProgress.findIndex((lip) => lip.id == id)
      if (indexOf >= 0) {
        state.user.mediaProgress.splice(indexOf, 1, data)
      } else {
        state.user.mediaProgress.push(data)
      }
    }
  },
  setSettings(state, settings) {
    if (!settings) return
    localStorage.setItem('userSettings', JSON.stringify(settings))
    state.settings = settings
  }
}
