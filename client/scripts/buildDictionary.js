/**
 * Offline English dictionary for "tap a word for its definition" in read-along (players/dictionary.js).
 * Built from Princeton WordNet 3.1 (npm package wordnet-db) and the WordNet 3.0 exception lists of irregular
 * forms (npm package wndb-with-exceptions), downloaded from the npm registry at build time and checked against
 * the registry's integrity hashes. Writes small JSON shards (by the first two letters of a word) to
 * static/dictionary/<DICTIONARY_VERSION>/, served by ABS, so a lookup only loads a few kilobytes.
 *
 * Runs before `npm run generate` / `npm run dev`. Does nothing if the dictionary is already there.
 * Keep in sync with scripts/buildDictionary.js in the app repo.
 */
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// Keep in sync with DICTIONARY_VERSION in players/dictionary.js
const DICTIONARY_VERSION = 'wordnet-3.1-v1'
const WORDNET = {
  tarball: 'https://registry.npmjs.org/wordnet-db/-/wordnet-db-3.1.14.tgz',
  integrity: 'sha512-zVyFsvE+mq9MCmwXUWHIcpfbrHHClZWZiVOzKSxNJruIcFn2RbY55zkhiAMMxM8zCVSmtNiViq8FsAZSFpMYag=='
}
const EXCEPTIONS = {
  tarball: 'https://registry.npmjs.org/wndb-with-exceptions/-/wndb-with-exceptions-3.0.2.tgz',
  integrity: 'sha512-EErtrDAl7z1f0eG+XzomB+I6Kj6eYuFukBbmWvdbwcLbUN6qbjFHDEW+/PFWOGKlqxIfOWYBn1ANRm/1Z5OQiA=='
}
const PARTS_OF_SPEECH = [
  { file: 'noun', pos: 'n' },
  { file: 'verb', pos: 'v' },
  { file: 'adj', pos: 'a' },
  { file: 'adv', pos: 'r' }
]
/** Senses kept per part of speech and per word (the most frequent come first in WordNet) */
const SENSES_PER_POS = 3
const SENSES_PER_WORD = 6
const MAX_EXAMPLE_LENGTH = 90
const DEST = path.join(__dirname, '..', 'static', 'dictionary', DICTIONARY_VERSION)

/** Shard of a (lower case) word: its first two letters, other characters as "_". Same as players/dictionary.js */
function shardKey(word) {
  return `${word}__`.slice(0, 2).replace(/[^a-z]/g, '_')
}

/** Files of a (gunzipped) tar archive; names are POSIX paths */
function* tarEntries(buffer) {
  let offset = 0
  let longName = null
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '')
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1)
    const prefix = field(345, 155)
    let name = longName || (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    longName = null
    const data = buffer.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === 'x') {
      const match = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))
      if (match) longName = match[1]
      continue
    }
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/s, '')
      continue
    }
    if (type === '0' || type === '') yield { name, data }
  }
}

/** @returns {Promise<Map<string, Buffer>>} files of a package tarball by path */
async function fetchPackage({ tarball, integrity }) {
  const response = await fetch(tarball)
  if (!response.ok) throw new Error(`Download of ${tarball} failed: HTTP ${response.status}`)
  const archive = Buffer.from(await response.arrayBuffer())
  const [algorithm, expected] = integrity.split(/-(.*)/s)
  const actual = crypto.createHash(algorithm).update(archive).digest('base64')
  if (actual !== expected) throw new Error(`Integrity check failed for ${tarball}`)
  const files = new Map()
  for (const entry of tarEntries(zlib.gunzipSync(archive))) files.set(entry.name, entry.data)
  return files
}

function readFile(files, name) {
  const data = files.get(name)
  if (!data) throw new Error(`Missing ${name}`)
  return data.toString('utf8')
}

/** "definition; more; \"example\"" -> { definition, example } */
function parseGloss(gloss) {
  const quote = gloss.search(/;?\s*"/)
  const definition = (quote >= 0 ? gloss.slice(0, quote) : gloss).trim().replace(/;$/, '')
  const example = quote >= 0 ? /"([^"]+)"/.exec(gloss.slice(quote))?.[1]?.trim() : null
  return { definition, example: example && example.length <= MAX_EXAMPLE_LENGTH ? example : null }
}

function buildEntries(wordnet, exceptionFiles) {
  /** @type {Map<string, {d?: Array, b?: string[]}>} */
  const entries = new Map()
  const entry = (word) => {
    if (!entries.has(word)) entries.set(word, {})
    return entries.get(word)
  }

  for (const { file, pos } of PARTS_OF_SPEECH) {
    // data.<pos>: "offset lex_filenum ss_type w_cnt word lex_id ... | gloss"
    const glosses = new Map()
    for (const line of readFile(wordnet, `package/dict/data.${file}`).split('\n')) {
      if (!line || line.startsWith('  ')) continue // license header
      const bar = line.indexOf(' | ')
      if (bar < 0) continue
      glosses.set(line.slice(0, 8), parseGloss(line.slice(bar + 3)))
    }
    // index.<pos>: "lemma pos synset_cnt p_cnt [ptr_symbol...] sense_cnt tagsense_cnt synset_offset..."
    for (const line of readFile(wordnet, `package/dict/index.${file}`).split('\n')) {
      if (!line || line.startsWith('  ')) continue
      const parts = line.trim().split(' ')
      const lemma = parts[0]
      if (lemma.includes('_')) continue // multi-word expressions: lookups are for single words
      const pointerCount = Number(parts[3])
      const tagged = Number(parts[5 + pointerCount])
      const offsets = parts.slice(6 + pointerCount)
      const senses = []
      for (const offset of offsets.slice(0, SENSES_PER_POS)) {
        const gloss = glosses.get(offset)
        if (gloss?.definition) senses.push(gloss.example ? [pos, gloss.definition, gloss.example] : [pos, gloss.definition])
      }
      if (!senses.length) continue
      const target = entry(lemma)
      target.groups = target.groups || []
      target.groups.push({ tagged, senses })
    }
  }

  // The part of speech used most often in WordNet's sense-tagged texts comes first ("run": verb before noun)
  for (const target of entries.values()) {
    if (!target.groups) continue
    target.groups.sort((a, b) => b.tagged - a.tagged)
    target.d = target.groups.flatMap((group) => group.senses).slice(0, SENSES_PER_WORD)
    delete target.groups
  }

  // <pos>.exc: "inflected base [base...]" (geese goose, ran run, better good)
  for (const { file } of PARTS_OF_SPEECH) {
    for (const line of readFile(exceptionFiles, `package/data/${file}.exc`).split('\n')) {
      const [inflected, ...bases] = line.trim().split(' ')
      if (!inflected || inflected.includes('_') || !bases.length) continue
      const target = entry(inflected)
      for (const base of bases) {
        if (base === inflected || !entries.get(base)?.d) continue
        target.b = target.b || []
        if (!target.b.includes(base)) target.b.push(base)
      }
      if (!target.d && !target.b) entries.delete(inflected)
    }
  }
  return entries
}

async function main() {
  const manifestPath = path.join(DEST, 'manifest.json')
  if (fs.existsSync(manifestPath)) return
  const [wordnet, exceptionFiles] = await Promise.all([fetchPackage(WORDNET), fetchPackage(EXCEPTIONS)])
  const entries = buildEntries(wordnet, exceptionFiles)

  const shards = new Map()
  for (const word of [...entries.keys()].sort()) {
    const key = shardKey(word)
    if (!shards.has(key)) shards.set(key, {})
    shards.get(key)[word] = entries.get(word)
  }

  fs.mkdirSync(DEST, { recursive: true })
  let bytes = 0
  for (const [key, words] of shards) {
    const json = JSON.stringify(words)
    bytes += json.length
    fs.writeFileSync(path.join(DEST, `${key}.json`), json)
  }
  fs.writeFileSync(path.join(DEST, 'LICENSE.txt'), readFile(wordnet, 'package/LICENSE'))
  // Written last: its presence means the dictionary is complete
  fs.writeFileSync(manifestPath, JSON.stringify({ version: DICTIONARY_VERSION, source: 'Princeton WordNet 3.1', shards: [...shards.keys()].sort() }))
  console.log(`[buildDictionary] Wrote ${entries.size} words in ${shards.size} files (${(bytes / 1048576).toFixed(1)} MB) to ${path.relative(process.cwd(), DEST)}`)
}

main().catch((error) => {
  console.error('[buildDictionary]', error.message)
  process.exit(1)
})
