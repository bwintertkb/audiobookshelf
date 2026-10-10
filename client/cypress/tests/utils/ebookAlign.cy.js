import { alignEbook, alignSequences, normalizePieces } from '@/players/ebookAlign'

// Same cases as the transcribe helper's tests/test_align.py (the alignment is a port of align.py)

const STORY =
  'High above the city, on a tall column, stood the statue of the Happy Prince. He was gilded all over with thin leaves of fine gold, ' +
  'for eyes he had two bright sapphires, and a large red ruby glowed on his sword-hilt. He was very much admired indeed. ' +
  '“He is as beautiful as a weathercock,” remarked one of the Town Councillors who wished to gain a reputation for having artistic tastes; ' +
  '“only not quite so useful,” he added, fearing lest people should think him unpractical, which he really was not. ' +
  '“Why can’t you be like the Happy Prince?” asked a sensible mother of her little boy who was crying for the moon. ' +
  '“The Happy Prince never dreams of crying for anything.”'
const STORY_TWO = '“She said that she would dance with me if I brought her red roses,” cried the young Student; “but in all my garden there is no red rose.” ' + 'From her nest in the holm-oak tree the Nightingale heard him, and she looked out through the leaves, and wondered.'

const round = (t) => Math.round(t * 1000) / 1000
const STRIP = '“”"‘’,.;?!'
function strip(word) {
  let start = 0
  let end = word.length
  while (start < end && STRIP.includes(word[start])) start++
  while (end > start && STRIP.includes(word[end - 1])) end--
  return word.slice(start, end)
}

/** Whisper-like words: punctuation mostly gone, timed sequentially */
function audioFromText(text, start = 0, wordDuration = 0.4, gap = 0.05) {
  const words = []
  let t = start
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    words.push({ w: strip(raw), start: round(t), end: round(t + wordDuration) })
    t += wordDuration + gap
  }
  return [words, t]
}

function whisperTranscript(words, duration) {
  const segments = []
  for (let i = 0; i < words.length; i += 10) segments.push({ start: words[i].start, end: words[Math.min(i + 9, words.length - 1)].end, text: '', words: words.slice(i, i + 10) })
  return { version: 1, libraryItemId: 'li', model: 'test', language: 'en', durationSec: duration, source: 'whisper', files: [{ ino: '1', filename: '01.mp3', startOffset: 0, duration }], segments }
}

const book = (...paragraphs) => ({ title: 'Book', paragraphs: paragraphs.map(([text, heading]) => ({ text, heading })) })
const allWords = (transcript) => transcript.segments.flatMap((s) => s.words)
const split = (text) => text.split(/\s+/).filter(Boolean)

describe('ebookAlign', () => {
  it('normalizes words into comparable pieces', () => {
    expect(normalizePieces('Don’t')).to.deep.equal(['dont'])
    expect(normalizePieces('“Café,”')).to.deep.equal(['cafe'])
    expect(normalizePieces('sword-hilt.')).to.deep.equal(['sword', 'hilt'])
    expect(normalizePieces('—')).to.deep.equal([])
    expect(normalizePieces('1910')).to.deep.equal(['1910'])
  })

  it('aligns sequences with insertions and deletions', () => {
    const bookTokens = split('front matter page the quick brown fox jumps over the lazy dog end')
    const audioTokens = split('intro words here the quick brown fox jumps over the lazy dog')
    const { match } = alignSequences(bookTokens, audioTokens)
    const aligned = {}
    match.forEach((a, i) => a >= 0 && (aligned[bookTokens[i]] = audioTokens[a]))
    for (const word of ['quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog']) expect(aligned[word]).to.equal(word)
  })

  it('uses the Whisper times and the book text on a perfect match', () => {
    const [words, end] = audioFromText(STORY, 10)
    const result = alignEbook(whisperTranscript(words, end + 5), book([STORY, false]))
    const out = allWords(result)
    expect(out.map((w) => w.w)).to.deep.equal(split(STORY))
    expect(out.map((w) => w.start)).to.deep.equal(words.map((w) => w.start))
    expect(result.source).to.equal('ebook')
    expect(result.alignment.droppedWords).to.equal(0)
  })

  it('leaves out front matter and narrator intros', () => {
    const [intro, t] = audioFromText('This is a LibriVox recording all LibriVox recordings are in the public domain read by Jane')
    const [story, end] = audioFromText(STORY, t + 2)
    const front = 'Title: The Happy Prince Author: Oscar Wilde Release date: May 1, 1997 Language: English CONTENTS The Happy Prince The Nightingale and the Rose'
    const result = alignEbook(whisperTranscript([...intro, ...story], end), book([front, false], ['The Happy Prince', true], [STORY, false]))
    const texts = allWords(result).map((w) => w.w)
    expect(texts).not.to.include('Title:')
    expect(texts).not.to.include('CONTENTS')
    expect(allWords(result).find((w) => w.w === 'High').start).to.equal(story[0].start)
  })

  it('keeps misheard words with their timing', () => {
    const audioText = STORY.replace('weathercock', 'whether cock').replace('sapphires', 'safires').replace('Councillors', 'counselors')
    const [words, end] = audioFromText(audioText)
    const result = alignEbook(whisperTranscript(words, end), book([STORY, false]))
    const out = Object.fromEntries(allWords(result).map((w) => [w.w, w]))
    expect(out).to.include.keys(['weathercock,”', 'sapphires,', 'Councillors'])
    expect(out['sapphires,'].start).to.equal(words.find((w) => w.w === 'safires').start)
    expect(result.alignment.droppedWords).to.equal(0)
  })

  it('interpolates a garbled stretch inside its audio window', () => {
    const [words, end] = audioFromText(STORY.replace('asked a sensible mother of her little boy', 'ask the sense of muddle love her lid all'))
    const result = alignEbook(whisperTranscript(words, end), book([STORY, false]))
    const out = allWords(result)
    expect(out.map((w) => w.w)).to.deep.equal(split(STORY))
    const starts = out.map((w) => w.start)
    expect(starts).to.deep.equal([...starts].sort((a, b) => a - b))
    const mother = out.find((w) => w.w === 'mother')
    const window = words.filter((w) => ['ask', 'the', 'sense', 'of', 'muddle', 'love', 'her', 'lid', 'all'].includes(w.w))
    expect(mother.start).to.be.within(window[0].start - 1, window[window.length - 1].end)
  })

  it('drops an unnarrated caption between paragraphs', () => {
    const [first, t] = audioFromText(STORY)
    const [second, end] = audioFromText(STORY_TWO, t)
    const caption = 'Illustration: The Swallow and the Reed, drawn by Walter Crane for this edition of the book'
    const result = alignEbook(whisperTranscript([...first, ...second], end), book([STORY, false], [caption, false], [STORY_TWO, false]))
    expect(allWords(result).map((w) => w.w)).to.deep.equal([...split(STORY), ...split(STORY_TWO)])
  })

  it('does not wedge a chapter announcement into the heading', () => {
    const [first, t1] = audioFromText(STORY)
    const [outro, t2] = audioFromText('End of the happy prince', t1 + 1)
    const [announcement, t3] = audioFromText('Chapter two of the happy prince and other tales the nightingale and the rose', t2 + 2)
    const [second, end] = audioFromText(STORY_TWO, t3 + 1)
    const result = alignEbook(whisperTranscript([...first, ...outro, ...announcement, ...second], end), book(['The Happy Prince', true], [STORY, false], ['The Nightingale and the Rose', true], [STORY_TWO, false]))
    const heading = result.segments.find((s) => s.heading && s.text.startsWith('The Nightingale'))
    expect(heading.words.map((w) => w.start)).to.deep.equal(announcement.slice(-5).map((w) => w.start))
    expect(heading.paragraph).to.equal(true)
  })

  it('keeps a misheard heading after unnarrated contents', () => {
    const contents = Array.from({ length: 14 }, (_, i) => `Chapter ${i + 1}: A Title Of Some Length And More Words Here, page ${(i + 1) * 7}`).join(' ')
    const [intro, t1] = audioFromText('Chapter three of the happy prince and other tales by Oscar Wilde')
    const [heading, t2] = audioFromText('duh sell fish giant', t1 + 1)
    const [story, end] = audioFromText(STORY, t2 + 1)
    const result = alignEbook(whisperTranscript([...intro, ...heading, ...story], end), book([contents, false], ['The Selfish Giant.', true], [STORY, false]))
    const first = result.segments[0]
    expect(first.text).to.equal('The Selfish Giant.')
    expect(first.heading).to.equal(true)
    expect(first.words[0].start).to.be.at.least(heading[0].start)
    expect(first.words[first.words.length - 1].start).to.equal(heading[heading.length - 1].start)
    expect(allWords(result).map((w) => w.w)).not.to.include('Chapter')
  })

  it('matches apostrophe and hyphenation variants', () => {
    const text = 'Why can’t you dance to-night, said the Student; it is the Rose’s fault.'
    const [audio, end] = audioFromText("why can't you dance tonight said the student it is the roses fault")
    const repeated = Array(10).fill(audio).flat()
    const result = alignEbook(whisperTranscript(repeated, end * 10), book([Array(10).fill(text).join(' '), false]))
    const out = allWords(result)
    expect(out).to.have.length(split(text).length * 10)
    expect(out.find((w) => w.w === 'to-night,').start).to.equal(audio.find((w) => w.w === 'tonight').start)
  })

  it('rejects the wrong ebook', () => {
    const [words, end] = audioFromText([STORY, STORY, STORY].join(' '))
    const other = 'Call me Ishmael. Some years ago never mind how long precisely having little or no money in my purse '.repeat(20)
    let error = null
    try {
      alignEbook(whisperTranscript(words, end), book([other, false]))
    } catch (e) {
      error = e
    }
    expect(error?.name).to.equal('EbookAlignmentError')
    expect(error?.message).to.contain('does not match')
  })

  it('turns sentences, paragraphs and headings into segments', () => {
    const text = Array(3).fill('Mr. Smith arrived at 5 p.m. on Tuesday. “Hello!” he said. She paused… then smiled. The end.').join(' ')
    const [words, end] = audioFromText('Chapter One ' + text)
    const segments = alignEbook(whisperTranscript(words, end), book(['Chapter One', true], [text, false])).segments
    expect(segments[0]).to.include({ text: 'Chapter One', heading: true, paragraph: true })
    expect(segments.slice(1, 5).map((s) => s.text)).to.deep.equal(['Mr. Smith arrived at 5 p.m. on Tuesday.', '“Hello!” he said.', 'She paused… then smiled.', 'The end.'])
    expect(segments[1].paragraph).to.equal(true)
    expect(segments[2]).not.to.have.property('paragraph')
    expect(segments.slice(1).every((s) => !('heading' in s))).to.equal(true)
  })
})
