/**
 * Reading settings saved on the user's account (GET/PATCH /api/me/reading-settings), so books and transcripts look the
 * same in every book, on the web and in the app: theme, font, text size, layout, highlighter, ...
 * The same rules are in the clients (client/players/readingSettings.js; the app's utils/readingSettings.js)
 */
const READING_SETTINGS = {
  readingTheme: { values: ['paper', 'sepia', 'sage', 'night', 'black'] },
  // '': the default (serif in the book and the transcript's book layout, sans in its lines layout)
  readingFont: { values: ['', 'sans', 'serif', 'lexend'] },
  // Text size in % (the book and the transcript)
  readingFontScale: { min: 25, max: 300 },
  readingLineSpacing: { min: 100, max: 300 },
  readingTextStroke: { min: 0, max: 300 },
  readingSpread: { values: ['auto', 'none'] },
  readAlongWords: { values: [1, 3, 5] },
  transcriptLayout: { values: ['book', 'lines'] },
  highlighterMode: { boolean: true },
  highlighterColor: { values: ['yellow', 'blue', 'pink', 'orange'] },
  syncReadingListening: { boolean: true },
  sleepTimerFinish: { values: ['sentence', 'paragraph', 'off'] },
  // App ebook reader: the player bar and the location bar hidden (full page)
  readerHidePlayer: { boolean: true },
  readerShowInfo: { boolean: true }
}

/**
 * @param {string} key
 * @param {*} value
 * @returns {boolean}
 */
function isValidReadingSetting(key, value) {
  const rule = READING_SETTINGS[key]
  if (!rule) return false
  if (rule.boolean) return typeof value === 'boolean'
  if (rule.values) return rule.values.includes(value)
  return typeof value === 'number' && Number.isFinite(value) && value >= rule.min && value <= rule.max
}

/**
 * The reading settings in a request, checked
 *
 * @param {*} body
 * @returns {{ settings?: Object, error?: string }}
 */
function validateReadingSettings(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Invalid reading settings' }
  const settings = {}
  for (const key in body) {
    if (!isValidReadingSetting(key, body[key])) return { error: `Invalid reading setting "${key}"` }
    settings[key] = body[key]
  }
  if (!Object.keys(settings).length) return { error: 'No reading settings' }
  return { settings }
}

/**
 * The valid reading settings saved for a user (settings that are no longer valid are left out)
 *
 * @param {*} saved
 * @returns {Object}
 */
function savedReadingSettings(saved) {
  const settings = {}
  if (!saved || typeof saved !== 'object') return settings
  for (const key in saved) {
    if (isValidReadingSetting(key, saved[key])) settings[key] = saved[key]
  }
  return settings
}

module.exports = { READING_SETTINGS, validateReadingSettings, savedReadingSettings }
