/**
 * Offline English dictionary (Princeton WordNet 3.1) for definitions of words in read-along.
 * The data is built by scripts/buildDictionary.js into static/dictionary/<DICTIONARY_VERSION>/ as JSON shards
 * by the first two letters of a word: { word: { d?: [[pos, definition, example?]...], b?: [base forms] } }.
 * `b` comes from WordNet's exception lists of irregular forms (geese -> goose, ran -> run).
 *
 * Keep in sync with utils/dictionary.js in the app repo.
 */

// Keep in sync with DICTIONARY_VERSION in scripts/buildDictionary.js
export const DICTIONARY_VERSION = 'wordnet-3.1-v1'

const PART_OF_SPEECH = { n: 'noun', v: 'verb', a: 'adjective', r: 'adverb' }

/** Regular inflections (WordNet's morphy detachment rules): suffix -> replacement */
const DETACHMENTS = [
  ['ses', 's'],
  ['xes', 'x'],
  ['zes', 'z'],
  ['ches', 'ch'],
  ['shes', 'sh'],
  ['men', 'man'],
  ['ies', 'y'],
  ['es', 'e'],
  ['es', ''],
  ['s', ''],
  ['ed', 'e'],
  ['ed', ''],
  ['ing', 'e'],
  ['ing', ''],
  ['er', ''],
  ['er', 'e'],
  ['est', ''],
  ['est', 'e'],
  ['ier', 'y'],
  ['iest', 'y'],
  ['ied', 'y']
]

/** Shard of a (lower case) word: its first two letters, other characters as "_". Same as scripts/buildDictionary.js */
export function shardKey(word) {
  return `${word}__`.slice(0, 2).replace(/[^a-z]/g, '_')
}

/**
 * The word as the dictionary lists it: lower case, without surrounding punctuation, quotes or a possessive 's.
 * @param {string} text - a word of the book ("Prince's", "“Swallow,”")
 */
export function normalizeWord(text) {
  let word = String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // accents (café -> cafe)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[‐-—]/g, '-')
    .toLowerCase()
  word = word.replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, '')
  word = word.replace(/'s$/, '').replace(/s'$/, 's')
  return word
}

/** Base forms a regular inflection could come from ("stopped" -> stop, "cities" -> city), most likely first */
export function regularBaseForms(word) {
  const forms = []
  for (const [suffix, replacement] of DETACHMENTS) {
    if (word.length <= suffix.length + 1 || !word.endsWith(suffix)) continue
    const stem = word.slice(0, -suffix.length)
    forms.push(stem + replacement)
    // Doubled final consonant: stopped -> stop, running -> run, bigger -> big
    if (!replacement && /([b-df-hj-np-tv-z])\1$/.test(stem)) forms.push(stem.slice(0, -1))
  }
  return [...new Set(forms)].filter((form) => form !== word)
}

const dictionaries = new Map()

/** @returns {Dictionary} one shared instance per location, so shards stay loaded */
export function getDictionary(baseUrl) {
  if (!dictionaries.has(baseUrl)) dictionaries.set(baseUrl, new Dictionary({ baseUrl }))
  return dictionaries.get(baseUrl)
}

export default class Dictionary {
  /**
   * @param {Object} options
   * @param {string} options.baseUrl - URL of the dictionary folder (without the version)
   * @param {(url: string) => Promise<Object>} [options.fetchJson]
   */
  constructor({ baseUrl, fetchJson }) {
    this.baseUrl = `${baseUrl.replace(/\/$/, '')}/${DICTIONARY_VERSION}`
    this.fetchJson =
      fetchJson ||
      (async (url) => {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      })
    this.shards = new Map() // key -> Promise<Object>
    this.manifest = null
  }

  async shardKeys() {
    if (!this.manifest) {
      this.manifest = this.fetchJson(`${this.baseUrl}/manifest.json`).then((manifest) => new Set(manifest.shards))
      this.manifest.catch(() => (this.manifest = null))
    }
    return this.manifest
  }

  async entry(word) {
    const key = shardKey(word)
    if (!(await this.shardKeys()).has(key)) return null
    if (!this.shards.has(key)) {
      const shard = this.fetchJson(`${this.baseUrl}/${key}.json`)
      shard.catch(() => this.shards.delete(key))
      this.shards.set(key, shard)
    }
    return (await this.shards.get(key))[word] || null
  }

  /**
   * Definitions of a word of the book. Irregular forms show their base word first ("geese": goose), a regular
   * inflection shows the word itself if listed ("building") and then its base ("build").
   *
   * @param {string} text
   * @param {number} [maxWords] - how many dictionary words to return
   * @returns {Promise<{query: string, results: {word: string, senses: {partOfSpeech: string, definition: string, example: string|null}[]}[]}>}
   */
  async lookup(text, maxWords = 2) {
    const query = normalizeWord(text)
    const results = []
    if (!query) return { query, results }
    const seen = new Set()
    const add = async (word) => {
      if (results.length >= maxWords || seen.has(word)) return
      seen.add(word)
      const entry = await this.entry(word)
      if (entry?.d) results.push({ word, senses: entry.d.map(([pos, definition, example]) => ({ partOfSpeech: PART_OF_SPEECH[pos] || pos, definition, example: example || null })) })
    }

    const exact = await this.entry(query)
    for (const base of exact?.b || []) await add(base)
    await add(query)
    // Irregular forms are listed with their bases; very short stems are chance matches ("was" -> "wa")
    if (!exact?.b) {
      for (const form of regularBaseForms(query)) if (form.length >= 3) await add(form)
    }
    // Hyphenated words: as one word ("sea-shore" -> seashore), then the last part
    if (query.includes('-')) {
      await add(query.replace(/-/g, ''))
      await add(query.split('-').pop())
    }
    return { query, results }
  }
}
