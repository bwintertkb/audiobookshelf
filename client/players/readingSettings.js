import { READING_THEME_NAMES } from './readingThemes'
import { ANNOTATION_COLORS } from './annotations'

/**
 * Reading settings saved on the user's account (GET/PATCH /api/me/reading-settings), so books and transcripts look the
 * same in every book, on the web and in the app. In the store they are user settings (user/getUserSetting); the server
 * checks the same rules (server/utils/readingSettings.js). Kept the same in the web client (players/readingSettings.js)
 * and the app (utils/readingSettings.js)
 */
export const READING_SETTINGS = {
  // No default: '' until chosen (the reader's old theme)
  readingTheme: { values: READING_THEME_NAMES },
  // '': serif in the book and the transcript's book layout, sans in its lines layout
  readingFont: { values: ['', 'sans', 'serif', 'lexend'], default: '' },
  // Text size in % (the book and the transcript)
  readingFontScale: { min: 25, max: 300, default: 100 },
  readingLineSpacing: { min: 100, max: 300, default: 115 },
  readingTextStroke: { min: 0, max: 300, default: 0 },
  readingSpread: { values: ['auto', 'none'], default: 'auto' },
  readAlongWords: { values: [1, 3, 5], default: 3 },
  transcriptLayout: { values: ['book', 'lines'], default: 'book' },
  highlighterMode: { boolean: true, default: false },
  highlighterColor: { values: ANNOTATION_COLORS, default: 'yellow' },
  syncReadingListening: { boolean: true, default: true },
  sleepTimerFinish: { values: ['sentence', 'paragraph', 'off'], default: 'sentence' },
  // App ebook reader: the player bar and the location bar hidden (full page)
  readerHidePlayer: { boolean: true, default: false },
  readerShowInfo: { boolean: true, default: true }
}
export const READING_SETTING_KEYS = Object.keys(READING_SETTINGS)

/** Font of the ebook reader (epub.js) for each reading font */
const READER_FONTS = { sans: 'sans-serif', serif: 'serif', lexend: 'Lexend, sans-serif' }
/** Text size of the transcript (a scale of its base size) */
export const TRANSCRIPT_FONT_SCALE = { min: 0.75, max: 2 }

const PENDING_STORAGE_KEY = 'readingSettingsPending'
const MIGRATED_STORAGE_KEY = 'readingSettingsMigrated'
const SEND_DELAY_MS = 800

/**
 * @param {string} key
 * @param {*} value
 * @returns {boolean}
 */
export function isValidReadingSetting(key, value) {
  const rule = READING_SETTINGS[key]
  if (!rule) return false
  if (rule.boolean) return typeof value === 'boolean'
  if (rule.values) return rule.values.includes(value)
  return typeof value === 'number' && Number.isFinite(value) && value >= rule.min && value <= rule.max
}

/**
 * The valid reading settings in `settings` (other settings and invalid values are left out)
 *
 * @param {Object} settings
 * @returns {Object}
 */
export function validReadingSettings(settings) {
  const valid = {}
  for (const key of READING_SETTING_KEYS) {
    if (settings && isValidReadingSetting(key, settings[key])) valid[key] = settings[key]
  }
  return valid
}

/**
 * @param {string} readingFont
 * @returns {string} font family of the ebook reader
 */
export function readerFontFamily(readingFont) {
  return READER_FONTS[readingFont] || READER_FONTS.serif
}

/**
 * @param {string} readerFont - font family of the ebook reader
 * @returns {string} reading font
 */
export function readingFontOf(readerFont) {
  const family = String(readerFont || '').toLowerCase()
  if (family.includes('lexend')) return 'lexend'
  if (family.startsWith('sans')) return 'sans'
  return 'serif'
}

/**
 * Text size of the transcript for the reading text size (%)
 *
 * @param {number} readingFontScale
 * @returns {number}
 */
export function transcriptFontScale(readingFontScale) {
  const scale = (Number(readingFontScale) || 100) / 100
  return Math.min(TRANSCRIPT_FONT_SCALE.max, Math.max(TRANSCRIPT_FONT_SCALE.min, scale))
}

function readStorage(storage, key) {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function writeStorage(storage, key, value) {
  try {
    if (value === null) storage?.removeItem(key)
    else storage?.setItem(key, value)
  } catch {
    // Private windows can refuse storage
  }
}

/**
 * The reading settings this device used before they were saved on the account, once: the ebook reader's settings, the
 * transcript's font, size and layout (user settings on the web, local storage in the app) and the app reader's full page
 *
 * @param {Storage} storage
 * @param {Object} [userSettings]
 * @returns {Object|null} null when done before
 */
export function takeLegacyReadingSettings(storage, userSettings = {}) {
  if (readStorage(storage, MIGRATED_STORAGE_KEY)) return null
  writeStorage(storage, MIGRATED_STORAGE_KEY, '1')
  const settings = {}
  let ereader = null
  try {
    ereader = JSON.parse(readStorage(storage, 'ereaderSettings') || 'null')
  } catch {
    ereader = null
  }
  const transcriptFont = userSettings.transcriptFont || readStorage(storage, 'transcriptFont')
  if (ereader?.font) settings.readingFont = readingFontOf(ereader.font)
  else if (transcriptFont) settings.readingFont = transcriptFont
  const transcriptScale = Number(userSettings.transcriptFontScale || readStorage(storage, 'transcriptFontScale'))
  if (ereader?.fontScale) settings.readingFontScale = Number(ereader.fontScale)
  else if (transcriptScale && transcriptScale !== 1) settings.readingFontScale = Math.round(transcriptScale * 100)
  if (ereader?.lineSpacing) settings.readingLineSpacing = Number(ereader.lineSpacing)
  if (ereader?.textStroke !== undefined) settings.readingTextStroke = Number(ereader.textStroke)
  if (ereader?.spread) settings.readingSpread = ereader.spread
  const layout = readStorage(storage, 'transcriptLayout')
  if (layout) settings.transcriptLayout = layout
  const hidePlayer = readStorage(storage, 'readerHidePlayer')
  if (hidePlayer !== null) settings.readerHidePlayer = hidePlayer === '1'
  const showInfo = readStorage(storage, 'readerShowInfo')
  if (showInfo !== null) settings.readerShowInfo = showInfo !== '0'
  return validReadingSettings(settings)
}

/**
 * Keeps the reading settings in step with the account. Changes made on this device are sent a moment later (and kept
 * until sent, e.g. offline); when connecting, this device takes the account's settings, and the account gets the
 * settings chosen on this device that it does not have yet (e.g. the first time; defaults are not sent, so a device
 * that was never set up does not undo the choices of another)
 */
export class ReadingSettingsSync {
  /**
   * @param {Object} options
   * @param {(method: 'GET'|'PATCH', path: string, body?: Object) => Promise<Object>} options.request
   * @param {() => Object} options.current - the settings on this device
   * @param {(settings: Object) => void} options.apply - this device takes settings of the account
   * @param {Storage} [options.storage] - keeps the changes not sent yet
   * @param {number} [options.sendDelayMs]
   */
  constructor({ request, current, apply, storage = globalThis.localStorage, sendDelayMs = SEND_DELAY_MS }) {
    this.request = request
    this.current = current
    this.apply = apply
    this.storage = storage
    this.sendDelayMs = sendDelayMs
    this.sendTimer = null
    this.loading = null
    let pending = null
    try {
      pending = JSON.parse(readStorage(storage, PENDING_STORAGE_KEY) || 'null')
    } catch {
      pending = null
    }
    this.pending = validReadingSettings(pending || {})
  }

  savePending() {
    writeStorage(this.storage, PENDING_STORAGE_KEY, Object.keys(this.pending).length ? JSON.stringify(this.pending) : null)
  }

  /**
   * Settings changed on this device: send them to the account
   *
   * @param {Object} settings
   */
  changed(settings) {
    const valid = validReadingSettings(settings)
    if (!Object.keys(valid).length) return
    Object.assign(this.pending, valid)
    this.savePending()
    clearTimeout(this.sendTimer)
    this.sendTimer = setTimeout(() => this.send(), this.sendDelayMs)
  }

  /**
   * @returns {Promise<boolean>} false when the changes could not be sent (they are sent later)
   */
  async send() {
    clearTimeout(this.sendTimer)
    this.sendTimer = null
    const sending = { ...this.pending }
    if (!Object.keys(sending).length) return true
    try {
      await this.request('PATCH', '/api/me/reading-settings', sending)
    } catch (error) {
      console.warn('[ReadingSettings] Not saved on the account yet:', error?.message || error)
      return false
    }
    // Settings changed again while sending stay to send
    for (const key in sending) {
      if (this.pending[key] === sending[key]) delete this.pending[key]
    }
    this.savePending()
    return true
  }

  /**
   * Connected: send the changes made here first, then take the account's settings
   *
   * @returns {Promise<void>}
   */
  load() {
    if (!this.loading) {
      this.loading = this.loadSettings().finally(() => {
        this.loading = null
      })
    }
    return this.loading
  }

  async loadSettings() {
    if (!(await this.send())) return
    let settings
    try {
      settings = (await this.request('GET', '/api/me/reading-settings'))?.settings
    } catch (error) {
      console.warn('[ReadingSettings] Could not load the account settings:', error?.message || error)
      return
    }
    const account = validReadingSettings(settings || {})
    this.received(account)
    const missing = {}
    const current = validReadingSettings(this.current() || {})
    for (const key in current) {
      if (!(key in account) && current[key] !== READING_SETTINGS[key].default) missing[key] = current[key]
    }
    if (Object.keys(missing).length) {
      this.changed(missing)
      await this.send()
    }
  }

  /**
   * Settings of the account (loaded, or changed on another device): changes made here and not sent yet are kept
   *
   * @param {Object} settings
   */
  received(settings) {
    const valid = validReadingSettings(settings || {})
    for (const key in this.pending) delete valid[key]
    if (Object.keys(valid).length) this.apply(valid)
  }
}
