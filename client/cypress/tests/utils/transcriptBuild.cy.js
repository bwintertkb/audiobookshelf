import { bookDuration, buildTranscript, enforceMonotonic, partWordsToBook, segmentsFromWords } from '@/players/transcriptBuild'

describe('transcriptBuild', () => {
  it('maps a part of a file onto the book timeline, clamped to the file', () => {
    const file = { ino: 'f2', filename: '02.mp3', startOffset: 100, duration: 50 }
    const words = partWordsToBook(
      [
        { w: ' Hello', start: 0.5, end: 0.9 },
        { w: '   ', start: 1, end: 1.1 },
        { w: 'end', start: 9.8, end: 12 }
      ],
      40,
      file
    )
    expect(words).to.deep.equal([
      { w: 'Hello', start: 140.5, end: 140.9 },
      { w: 'end', start: 149.8, end: 150 }
    ])
  })

  it('groups words into sentences and splits at long pauses', () => {
    const word = (w, start) => ({ w, start, end: start + 0.3 })
    const segments = segmentsFromWords([word('It', 0), word('was', 0.4), word('late.', 0.8), word('Then', 1.2), word('silence', 1.6), word('and', 4), word('“more.”', 4.4)])
    expect(segments.map((s) => s.text)).to.deep.equal(['It was late.', 'Then silence', 'and “more.”'])
    expect(segments[1].start).to.equal(1.2)
    expect(segments[1].end).to.be.closeTo(1.9, 1e-9)
  })

  it('makes word and segment starts non-decreasing', () => {
    const segments = enforceMonotonic([
      { start: 5, end: 6, words: [{ w: 'a', start: 5, end: 5.5 }] },
      { start: 4, end: 4.5, words: [{ w: 'b', start: 4.2, end: 4.4 }] }
    ])
    expect(segments[1]).to.deep.include({ start: 5, end: 5 })
    expect(segments[1].words[0]).to.deep.equal({ w: 'b', start: 5, end: 5 })
  })

  it('builds a v1 transcript with the audio files it was made from', () => {
    const files = [
      { ino: 'a', filename: '01.mp3', startOffset: 0, duration: 100.1234 },
      { ino: 'b', filename: '02.mp3', startOffset: 100.1234, duration: 50 }
    ]
    const transcript = buildTranscript([], files, { libraryItemId: 'li', model: 'whisper', language: null })
    expect(transcript).to.include({ version: 1, libraryItemId: 'li', source: 'whisper', durationSec: bookDuration(files) })
    expect(transcript.durationSec).to.equal(150.123)
    expect(transcript.files[1]).to.deep.equal({ ino: 'b', filename: '02.mp3', startOffset: 100.123, duration: 50 })
  })
})
