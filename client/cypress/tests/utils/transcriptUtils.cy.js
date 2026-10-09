import { buildHelperJobFiles, buildTranscriptIndex, findLastLessOrEqual, findPosition, getTranscriptAudioMismatch, normalizeHelperUrl, searchTranscript, WORD_LOOKAHEAD_SEC } from '@/players/transcriptUtils'
import { allPlaybackRates } from '../../support/playbackRates'

function makeTranscript({ numWords = 1000, wordDuration = 0.3, wordsPerSegment = 12, gapEvery = 0, gap = 0 } = {}) {
  const segments = []
  let time = 0
  for (let i = 0; i < numWords; i += wordsPerSegment) {
    const words = []
    for (let j = i; j < Math.min(numWords, i + wordsPerSegment); j++) {
      if (gapEvery && j > 0 && j % gapEvery === 0) time += gap
      words.push({ w: `w${j}`, start: Number(time.toFixed(3)), end: Number((time + wordDuration * 0.8).toFixed(3)) })
      time += wordDuration
    }
    segments.push({ start: words[0].start, end: words[words.length - 1].end, text: words.map((w) => w.w).join(' '), words })
  }
  return { version: 1, libraryItemId: 'li', segments }
}

function bruteForceWord(index, time) {
  let found = -1
  for (let i = 0; i < index.wordStarts.length; i++) {
    if (index.wordStarts[i] <= time + WORD_LOOKAHEAD_SEC) found = i
  }
  return found
}

describe('transcriptUtils', () => {
  it('lists every playback speed the player offers', () => {
    const rates = allPlaybackRates()
    expect(rates.length).to.equal(191)
    expect(rates[0]).to.equal(0.5)
    expect(rates[rates.length - 1]).to.equal(10)
    for (const preset of [0.5, 1, 1.2, 1.5, 2, 3, 3.5, 10]) expect(rates).to.include(preset)
  })

  describe('findLastLessOrEqual', () => {
    it('matches a linear scan, including duplicates and out of range values', () => {
      const values = Float64Array.from([0, 0.5, 0.5, 1, 2.25, 2.25, 2.25, 7, 100])
      for (const probe of [-1, 0, 0.1, 0.5, 0.75, 1, 2, 2.25, 6.99, 7, 50, 100, 1000]) {
        let expected = -1
        values.forEach((v, i) => {
          if (v <= probe) expected = i
        })
        expect(findLastLessOrEqual(values, probe), `probe ${probe}`).to.equal(expected)
      }
      expect(findLastLessOrEqual(new Float64Array(0), 5)).to.equal(-1)
    })
  })

  describe('findPosition', () => {
    const index = buildTranscriptIndex(makeTranscript({ numWords: 100, gapEvery: 25, gap: 5 }))

    it('returns no word before the first word', () => {
      const position = findPosition(index, -10)
      expect(position.word).to.equal(-1)
    })

    it('matches a brute force search at many times, including gaps', () => {
      for (let t = -1; t < 60; t += 0.0137) {
        const expected = bruteForceWord(index, t)
        const position = findPosition(index, t)
        expect(position.word, `t=${t}`).to.equal(expected)
        if (expected >= 0) expect(position.segment).to.equal(index.wordSegment[expected])
      }
    })

    it('treats a word as current slightly before it starts (seek precision)', () => {
      const start = index.wordStarts[10]
      expect(findPosition(index, start - 0.01).word).to.equal(10)
      expect(findPosition(index, start - 0.1).word).to.equal(9)
    })

    it('handles segments without word timestamps', () => {
      const textOnly = buildTranscriptIndex({ segments: [{ start: 1, end: 2, text: 'intro', words: [] }, { start: 5, end: 6, text: 'more', words: [] }] })
      expect(findPosition(textOnly, 0.5)).to.deep.equal({ word: -1, segment: -1 })
      expect(findPosition(textOnly, 5.5)).to.deep.equal({ word: -1, segment: 1 })
    })
  })

  describe('at every playback speed', () => {
    it('finds the expected word on every frame (60 fps) for 0.5x to 10x', () => {
      const wordDuration = 0.3
      const index = buildTranscriptIndex(makeTranscript({ numWords: 20000, wordDuration }))
      const frame = 1 / 60
      let checks = 0
      allPlaybackRates().forEach((rate, r) => {
        let time = 37 + r * 13.37 // a different stretch of the book for each speed
        let previous = -1
        for (let f = 0; f < 600; f++) {
          time += rate * frame
          const { word } = findPosition(index, time)
          // Closed form, then corrected with exact comparisons (floating point at word boundaries)
          const target = time + WORD_LOOKAHEAD_SEC
          let expected = Math.min(19999, Math.floor(target / wordDuration))
          while (expected + 1 < 20000 && index.wordStarts[expected + 1] <= target) expected++
          while (expected >= 0 && index.wordStarts[expected] > target) expected--
          if (word !== expected) throw new Error(`rate ${rate}: t=${time} got word ${word}, expected ${expected}`)
          if (word < previous) throw new Error(`rate ${rate}: highlight moved backwards`)
          previous = word
          checks++
        }
      })
      expect(checks).to.equal(191 * 600)
    })
  })

  describe('buildTranscriptIndex', () => {
    it('places chapter headings before the first segment of each chapter', () => {
      const transcript = makeTranscript({ numWords: 48, wordsPerSegment: 12, wordDuration: 1 }) // segments start at 0, 12, 24, 36
      const chapters = [
        { id: 1, start: 12, end: 24, title: 'Two' },
        { id: 0, start: 0, end: 12, title: 'One' },
        { id: 2, start: 30, end: 100, title: 'Three' },
        { id: 3, start: 100, end: 120, title: 'After the end' }
      ]
      const index = buildTranscriptIndex(transcript, chapters)
      const layout = index.rows.map((row) => (row.type === 'chapter' ? row.chapter.title : `s${row.segment}`))
      expect(layout).to.deep.equal(['One', 's0', 'Two', 's1', 's2', 'Three', 's3', 'After the end'])
      expect(Array.from(index.segmentRow)).to.deep.equal([1, 3, 4, 6])
      expect(index.numWords).to.equal(48)
      expect(index.segmentFirstWord[2]).to.equal(24)
    })
  })

  describe('searchTranscript', () => {
    it('finds segments case-insensitively in order', () => {
      const index = buildTranscriptIndex({
        segments: [
          { start: 0, end: 1, text: 'Once upon a midnight dreary', words: [] },
          { start: 1, end: 2, text: 'while I pondered, weak and weary', words: [] },
          { start: 2, end: 3, text: 'Over many a quaint and curious volume', words: [] }
        ]
      })
      expect(searchTranscript(index, 'AND')).to.deep.equal([1, 2])
      expect(searchTranscript(index, '  midnight   dreary ')).to.deep.equal([0])
      expect(searchTranscript(index, 'raven')).to.deep.equal([])
      expect(searchTranscript(index, '')).to.deep.equal([])
      expect(searchTranscript(index, 'a', 2)).to.have.length(2)
    })
  })

  describe('getTranscriptAudioMismatch', () => {
    const tracks = [
      { ino: 'a', startOffset: 0, duration: 100 },
      { ino: 'b', startOffset: 100, duration: 50 }
    ]
    const files = tracks.map((t) => ({ ...t, filename: `${t.ino}.mp3` }))

    it('detects changed audio files', () => {
      expect(getTranscriptAudioMismatch({ files }, tracks)).to.be.null
      expect(getTranscriptAudioMismatch({ files: files.slice(0, 1) }, tracks)).to.equal('count')
      expect(getTranscriptAudioMismatch({ files: [files[0], { ...files[1], ino: 'c' }] }, tracks)).to.equal('files')
      expect(getTranscriptAudioMismatch({ files: [files[0], { ...files[1], duration: 52 }] }, tracks)).to.equal('duration')
      expect(getTranscriptAudioMismatch({ durationSec: 150 }, tracks)).to.be.null
      expect(getTranscriptAudioMismatch({ durationSec: 160 }, tracks)).to.equal('duration')
    })
  })

  describe('buildHelperJobFiles', () => {
    it('uses the player track offsets and authenticated file urls', () => {
      const libraryItem = {
        media: {
          tracks: [
            { ino: '11', startOffset: 0, duration: 10.5, contentUrl: '/api/items/li/file/11', metadata: { filename: '01.mp3', path: '/books/x/01.mp3' } },
            { ino: '12', startOffset: 10.5, duration: 20, contentUrl: '/api/items/li/file/12', metadata: { filename: '02.mp3', path: '/books/x/02.mp3' } }
          ]
        }
      }
      expect(buildHelperJobFiles(libraryItem, 'https://abs.example.com/audiobookshelf')).to.deep.equal([
        { url: 'https://abs.example.com/audiobookshelf/api/items/li/file/11', path: '/books/x/01.mp3', ino: '11', filename: '01.mp3', startOffset: 0, duration: 10.5 },
        { url: 'https://abs.example.com/audiobookshelf/api/items/li/file/12', path: '/books/x/02.mp3', ino: '12', filename: '02.mp3', startOffset: 10.5, duration: 20 }
      ])
    })

    it('normalizes the helper url', () => {
      expect(normalizeHelperUrl(' http://127.0.0.1:8765/ ')).to.equal('http://127.0.0.1:8765')
      expect(normalizeHelperUrl('')).to.equal('http://127.0.0.1:8765')
      expect(normalizeHelperUrl(null)).to.equal('http://127.0.0.1:8765')
    })
  })
})
