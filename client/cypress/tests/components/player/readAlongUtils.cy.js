import { buildSentenceTimeline, buildTranscriptIndex, sleepTimerStopTime } from '@/players/transcriptUtils'
import { AnnotationStore, annotationWords, annotationsAtWord, annotationsFilename, annotationsMarkdown, createAnnotation } from '@/players/annotations'
import Dictionary, { normalizeWord, regularBaseForms, shardKey } from '@/players/dictionary'

function segment(text, start, flags = {}) {
  const words = text.split(' ').map((w, i) => ({ w, start: start + i * 0.5, end: start + i * 0.5 + 0.4 }))
  return { start, end: words[words.length - 1].end, text, words, ...flags }
}

// Heading (0-1), a paragraph of two sentences (2-5, 6-8), a paragraph of one sentence (9-11)
const transcript = {
  version: 1,
  source: 'ebook',
  segments: [segment('Chapter One', 1, { heading: true, paragraph: true, spine: 1 }), segment('The giant came home.', 3, { paragraph: true, spine: 1 }), segment('He was angry.', 6, { spine: 1 }), segment('Snow fell everywhere.', 10, { paragraph: true, spine: 1 })]
}

class MemoryStorage {
  constructor() {
    this.data = {}
  }
  getItem(key) {
    return key in this.data ? this.data[key] : null
  }
  setItem(key, value) {
    this.data[key] = String(value)
  }
  removeItem(key) {
    delete this.data[key]
  }
}

describe('read-along helpers', () => {
  it('groups the sentences of ebook transcripts into the book paragraphs', () => {
    const index = buildTranscriptIndex(transcript, [], { paragraphs: true })
    expect(index.rows).to.deep.equal([
      { type: 'paragraph', segments: [0], heading: true, afterHeading: true },
      { type: 'paragraph', segments: [1, 2], heading: false, afterHeading: true },
      { type: 'paragraph', segments: [3], heading: false, afterHeading: false }
    ])
    expect([...index.segmentRow]).to.deep.equal([0, 1, 1, 2])
    expect(buildTranscriptIndex(transcript).rows.map((row) => row.type)).to.deep.equal(['segment', 'segment', 'segment', 'segment'])
  })

  it('finds where a sleep timer stops: the end of the sentence or the paragraph', () => {
    const timeline = buildSentenceTimeline(transcript)
    expect(timeline.texts).to.deep.equal(['Chapter One', 'The giant came home.', 'He was angry.', 'Snow fell everywhere.'])
    expect(timeline.paragraphEnds).to.deep.equal([1.9, 7.4, 11.4])
    expect(sleepTimerStopTime(timeline, 3.6, 'sentence')).to.equal(4.9)
    expect(sleepTimerStopTime(timeline, 3.6, 'paragraph')).to.equal(7.4)
    expect(sleepTimerStopTime(timeline, 6.1, 'paragraph')).to.equal(7.4)
    // Between sentences, before the first one, or with finishing off: stop right away
    expect(sleepTimerStopTime(timeline, 5.5, 'sentence')).to.equal(null)
    expect(sleepTimerStopTime(timeline, 0.2, 'sentence')).to.equal(null)
    expect(sleepTimerStopTime(timeline, 3.6, 'off')).to.equal(null)
    // A sentence that would take too long to finish
    const long = buildSentenceTimeline({ segments: [{ start: 0, end: 200, text: 'Long', words: [] }] })
    expect(sleepTimerStopTime(long, 10, 'sentence')).to.equal(null)
    expect(sleepTimerStopTime(long, 175, 'sentence')).to.equal(200)
    // Transcripts without paragraphs: every segment is one
    const plain = buildSentenceTimeline({ segments: transcript.segments.map(({ paragraph, heading, ...rest }) => rest) })
    expect(plain.paragraphEnds).to.deep.equal(plain.ends)
  })

  it('maps highlights to transcript words and exports them as Markdown', () => {
    const index = buildTranscriptIndex(transcript)
    const annotation = createAnnotation(index, 3, 5, { color: 'pink' })
    expect(annotation).to.include({ start: 3.5, end: 4.5, text: 'giant came home.', color: 'pink', note: null })
    expect(annotation.id).to.be.a('string').and.have.length.of.at.least(8)
    expect(annotationWords(index, annotation)).to.deep.equal({ first: 3, last: 5 })
    // Times stored with less precision still map to the same words
    expect(annotationWords(index, { start: 3.501, end: 4.002 })).to.deep.equal({ first: 3, last: 4 })
    const second = { ...createAnnotation(index, 9, 11, { note: 'Winter\ncomes' }), updatedAt: annotation.updatedAt + 5 }
    expect(annotationsAtWord(index, [annotation, second], 10)).to.deep.equal([second])
    expect(annotationsAtWord(index, [annotation, second], 7)).to.deep.equal([])

    const markdown = annotationsMarkdown({ title: 'The Selfish Giant', author: 'Oscar Wilde', annotations: [second, annotation], chapters: [{ start: 0, title: 'Chapter One' }], formatTime: (s) => `${s}s` })
    expect(markdown).to.equal('# The Selfish Giant\n\n*Oscar Wilde*\n\n> giant came home.\n\n— Chapter One · 3.5s\n\n> Snow fell everywhere.\n\nWinter\ncomes\n\n— Chapter One · 10s\n')
    expect(annotationsFilename('Who: "Me"/You?')).to.equal('Who Me You - highlights and notes.md')
  })

  it('keeps highlights made offline and sends them when the server can be reached', () => {
    const storage = new MemoryStorage()
    const server = []
    let online = false
    const request = (method, url, body) => {
      if (!online) return Promise.reject(new Error('Network error'))
      if (method === 'GET') return Promise.resolve({ annotations: [...server] })
      if (method === 'PUT') {
        const index = server.findIndex((a) => a.id === body.id)
        if (index >= 0) server[index] = body
        else server.push(body)
        return Promise.resolve({ annotation: body })
      }
      const id = url.split('/').pop()
      const index = server.findIndex((a) => a.id === id)
      if (index < 0) return Promise.reject(new Error('404 Not Found'))
      server.splice(index, 1)
      return Promise.resolve()
    }
    const store = new AnnotationStore({ request, storage, isPermanentError: (error) => /\b4\d\d\b/.test(error.message) })
    const notified = []
    store.subscribe('book', (annotations) => notified.push(annotations.length))
    const first = { id: 'annotation-1', start: 5, end: 6, text: 'a', color: 'yellow', note: null, createdAt: 1, updatedAt: 1 }
    const second = { id: 'annotation-2', start: 1, end: 2, text: 'b', color: 'blue', note: null, createdAt: 1, updatedAt: 1 }

    cy.then(async () => {
      await store.save('book', first)
      await store.save('book', second)
      await store.remove('book', 'annotation-1')
      expect(store.get('book').map((a) => a.id)).to.deep.equal(['annotation-2'])
      expect(JSON.parse(storage.getItem('readAlongAnnotationQueue')).map((c) => c.op)).to.deep.equal(['put', 'delete'])
      expect(notified).to.deep.equal([1, 2, 1])

      // A new store (the app restarted) still has them, and loading while offline keeps them
      const restarted = new AnnotationStore({ request, storage })
      expect(restarted.get('book').map((a) => a.id)).to.deep.equal(['annotation-2'])
      await restarted.load('book')
      expect(restarted.get('book').map((a) => a.id)).to.deep.equal(['annotation-2'])

      online = true
      await store.load('book')
      expect(server.map((a) => a.id)).to.deep.equal(['annotation-2'])
      expect(storage.getItem('readAlongAnnotationQueue')).to.equal(null)
      expect(store.get('book').map((a) => a.id)).to.deep.equal(['annotation-2'])
    })
  })

  it('reports changes the server refuses instead of queueing them', () => {
    const store = new AnnotationStore({ request: () => Promise.reject(new Error('HTTP 400 Invalid color')), storage: new MemoryStorage(), isPermanentError: (error) => /\b4\d\d\b/.test(error.message) })
    cy.then(() =>
      store.save('book', { id: 'annotation-1', start: 1, end: 1, text: 'a', color: 'red' }).then(
        () => expect.fail('should be refused'),
        (error) => expect(error.message).to.contain('400')
      )
    )
  })

  it('looks words up in the dictionary', () => {
    const shards = {
      ge: { geese: { b: ['goose'] } },
      go: { goose: { d: [['n', 'web-footed bird']] }, good: { d: [['a', 'having desirable qualities']] } },
      ru: { run: { d: [['v', 'move fast']] }, running: { d: [['n', 'the act of running']], b: ['run'] } },
      st: { stop: { d: [['v', 'come to a halt']] } },
      ci: { city: { d: [['n', 'a large town']] } },
      pr: { prince: { d: [['n', 'a son of a king']] } },
      se: { seashore: { d: [['n', 'the shore of a sea']] } },
      be: { better: { b: ['good'] } }
    }
    const fetchJson = (url) => {
      const name = url.split('/').pop().replace('.json', '')
      if (name === 'manifest') return Promise.resolve({ shards: Object.keys(shards) })
      return Promise.resolve(shards[name])
    }
    const dictionary = new Dictionary({ baseUrl: '/dictionary/', fetchJson })
    const words = async (text) => (await dictionary.lookup(text)).results.map((result) => result.word)

    expect(normalizeWord('“Prince’s,”')).to.equal('prince')
    expect(normalizeWord('Café!')).to.equal('cafe')
    expect(shardKey("o'clock")).to.equal('o_')
    expect(regularBaseForms('stopped')).to.include('stop')
    cy.then(async () => {
      expect(await words('Geese')).to.deep.equal(['goose'])
      expect(await words('running')).to.deep.equal(['run', 'running'])
      expect(await words('stopped,')).to.deep.equal(['stop'])
      expect(await words('cities.')).to.deep.equal(['city'])
      expect(await words('“Prince’s')).to.deep.equal(['prince'])
      expect(await words('sea-shore')).to.deep.equal(['seashore'])
      expect(await words('better')).to.deep.equal(['good'])
      expect(await words('xyzzy')).to.deep.equal([])
      const { results } = await dictionary.lookup('goose')
      expect(results[0].senses).to.deep.equal([{ partOfSpeech: 'noun', definition: 'web-footed bird', example: null }])
    })
  })
})
