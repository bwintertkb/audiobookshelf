/**
 * Colour schemes for reading: the transcript panel and the ebook reader use the same one (user setting readingTheme).
 * Each has the page colours and the read-along colours that suit it (stronger highlights on light pages).
 *
 * Keep in sync with utils/readingThemes.js in the app repo.
 */

export const READING_THEMES = {
  paper: { bg: '#ffffff', surface: '#f1f1f1', text: '#1b1b1b', muted: '#6b6b6b', heading: '#000000', border: 'rgba(0, 0, 0, 0.12)', accent: '#0f8a5f', note: '#b45309', dark: false },
  sepia: { bg: '#f4ecd8', surface: '#e9dfc6', text: '#5b4636', muted: '#8c7660', heading: '#43311f', border: 'rgba(91, 70, 54, 0.2)', accent: '#9a6b2f', note: '#9a3412', dark: false },
  sage: { bg: '#d8e8d4', surface: '#c9dcc4', text: '#22362a', muted: '#56705c', heading: '#14271b', border: 'rgba(34, 54, 42, 0.18)', accent: '#2f7a4a', note: '#9a3412', dark: false },
  night: { bg: '#232323', surface: '#2e2e2e', text: '#e3e3e3', muted: '#9ca3af', heading: '#ffffff', border: 'rgba(255, 255, 255, 0.12)', accent: '#1ad691', note: '#facc15', dark: true },
  black: { bg: '#000000', surface: '#161616', text: '#d6d6d6', muted: '#8a8a8a', heading: '#f2f2f2', border: 'rgba(255, 255, 255, 0.14)', accent: '#1ad691', note: '#facc15', dark: true }
}
export const READING_THEME_NAMES = ['paper', 'sepia', 'sage', 'night', 'black']
export const DEFAULT_READING_THEME = 'night'

/** Read-along colours on light and dark pages: the narrated words and the sentence being read */
export const NARRATION_COLORS = {
  light: { words: 'rgba(255, 193, 7, 0.5)', sentence: 'rgba(255, 193, 7, 0.16)' },
  dark: { words: 'rgba(250, 204, 21, 0.45)', sentence: 'rgba(250, 204, 21, 0.15)' }
}

/** Reader theme names before the reading themes */
const OLD_NAMES = { dark: 'night', light: 'paper' }

/** @returns {string} a reading theme name for a stored setting (also the reader's old dark / light / sepia / black) */
export function readingThemeName(value) {
  const name = OLD_NAMES[value] || value
  return READING_THEMES[name] ? name : DEFAULT_READING_THEME
}

export function readingTheme(value) {
  return READING_THEMES[readingThemeName(value)]
}

export function narrationColors(value) {
  return readingTheme(value).dark ? NARRATION_COLORS.dark : NARRATION_COLORS.light
}

/** CSS custom properties of a theme, for an element's style (--rt-bg, --rt-text, ...) */
export function readingThemeStyle(value) {
  const theme = readingTheme(value)
  const narration = narrationColors(value)
  return {
    '--rt-bg': theme.bg,
    '--rt-surface': theme.surface,
    '--rt-text': theme.text,
    '--rt-muted': theme.muted,
    '--rt-heading': theme.heading,
    '--rt-border': theme.border,
    '--rt-accent': theme.accent,
    '--rt-note': theme.note,
    '--rt-words': narration.words,
    '--rt-hover': theme.dark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.05)'
  }
}
