const { expect } = require('chai')
const sinon = require('sinon')
const os = require('os')
const Path = require('path')
const zlib = require('zlib')
const fs = require('../../../server/libs/fsExtra')

const TranscriptManager = require('../../../server/managers/TranscriptManager')
const Logger = require('../../../server/Logger')

function makeLibraryItem(durations = [100, 50]) {
  return {
    id: 'li-1',
    media: {
      includedAudioFiles: durations.map((duration) => ({ duration }))
    }
  }
}

function makeTranscript(overrides = {}) {
  return {
    version: 1,
    libraryItemId: 'li-1',
    model: 'large-v3-turbo',
    language: 'en',
    createdAt: '2026-10-09T12:00:00Z',
    durationSec: 150,
    source: 'whisper',
    segments: [
      {
        start: 1,
        end: 2,
        text: 'Hello world',
        words: [
          { w: 'Hello', start: 1, end: 1.4 },
          { w: 'world', start: 1.5, end: 2 }
        ]
      },
      {
        start: 120,
        end: 150.5,
        text: 'The end',
        words: [
          { w: 'The', start: 120, end: 121 },
          { w: 'end', start: 149, end: 150.5 }
        ]
      }
    ],
    ...overrides
  }
}

describe('TranscriptManager', () => {
  let tempDir

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(Path.join(os.tmpdir(), 'abs-transcript-'))
    global.MetadataPath = tempDir
    sinon.stub(Logger, 'info')
  })

  afterEach(async () => {
    sinon.restore()
    await fs.remove(tempDir)
  })

  describe('validateTranscript', () => {
    it('accepts a valid transcript', () => {
      expect(TranscriptManager.validateTranscript(makeTranscript(), makeLibraryItem())).to.be.null
    })

    it('accepts a transcript with no segments', () => {
      expect(TranscriptManager.validateTranscript(makeTranscript({ segments: [] }), makeLibraryItem())).to.be.null
    })

    it('rejects a wrong version', () => {
      expect(TranscriptManager.validateTranscript(makeTranscript({ version: 2 }), makeLibraryItem())).to.include('Unsupported transcript version')
    })

    it('rejects a libraryItemId that does not match', () => {
      expect(TranscriptManager.validateTranscript(makeTranscript({ libraryItemId: 'other' }), makeLibraryItem())).to.include('does not match')
    })

    it('rejects non-object payloads', () => {
      expect(TranscriptManager.validateTranscript([], makeLibraryItem())).to.include('JSON object')
      expect(TranscriptManager.validateTranscript(null, makeLibraryItem())).to.include('JSON object')
    })

    it('rejects non-numeric and out of range times', () => {
      const transcript = makeTranscript()
      transcript.segments[0].words[0].start = '1'
      expect(TranscriptManager.validateTranscript(transcript, makeLibraryItem())).to.include('must be numbers')

      const beyondEnd = makeTranscript()
      beyondEnd.segments[1].end = 152 // tracks total 150 + 1 s tolerance
      expect(TranscriptManager.validateTranscript(beyondEnd, makeLibraryItem())).to.include('out of range')

      const negative = makeTranscript()
      negative.segments[0].words[0].start = -1
      expect(TranscriptManager.validateTranscript(negative, makeLibraryItem())).to.include('out of range')

      const nan = makeTranscript()
      nan.segments[0].start = NaN
      expect(TranscriptManager.validateTranscript(nan, makeLibraryItem())).to.include('must be numbers')
    })

    it('uses only included audio files for the duration', () => {
      // 100 + 50 is the playable timeline; 150.5 is within the 1 s tolerance
      expect(TranscriptManager.validateTranscript(makeTranscript(), makeLibraryItem([100, 50]))).to.be.null
      expect(TranscriptManager.validateTranscript(makeTranscript(), makeLibraryItem([100]))).to.include('out of range')
    })

    it('rejects words that are out of order', () => {
      const transcript = makeTranscript()
      transcript.segments[1].words[0].start = 0.5
      transcript.segments[1].start = 0.5
      const error = TranscriptManager.validateTranscript(transcript, makeLibraryItem())
      expect(error).to.match(/starts before the previous/)
    })

    it('rejects malformed segments and words', () => {
      const noWords = makeTranscript()
      delete noWords.segments[0].words
      expect(TranscriptManager.validateTranscript(noWords, makeLibraryItem())).to.include('words must be an array')

      const badWord = makeTranscript()
      badWord.segments[0].words[1] = { text: 'x', start: 1, end: 2 }
      expect(TranscriptManager.validateTranscript(badWord, makeLibraryItem())).to.include('is invalid')

      const badText = makeTranscript()
      badText.segments[0].text = 5
      expect(TranscriptManager.validateTranscript(badText, makeLibraryItem())).to.include('text must be a string')

      expect(TranscriptManager.validateTranscript(makeTranscript({ segments: {} }), makeLibraryItem())).to.include('segments must be an array')
      expect(TranscriptManager.validateTranscript(makeTranscript({ model: 5 }), makeLibraryItem())).to.include('model must be a string')
    })
  })

  describe('parseUploadedFile', () => {
    it('parses gzipped and plain JSON files', async () => {
      const json = JSON.stringify(makeTranscript())
      const gzPath = Path.join(tempDir, 'upload.gz')
      await fs.writeFile(gzPath, zlib.gzipSync(json))
      const fromGzip = await TranscriptManager.parseUploadedFile({ tempFilePath: gzPath, size: 100 })
      expect(fromGzip.transcript).to.deep.equal(makeTranscript())

      const fromPlain = await TranscriptManager.parseUploadedFile({ data: Buffer.from(json), size: json.length })
      expect(fromPlain.transcript).to.deep.equal(makeTranscript())
    })

    it('rejects invalid JSON, invalid gzip, empty and oversized files', async () => {
      expect((await TranscriptManager.parseUploadedFile({ data: Buffer.from('{nope'), size: 5 })).error).to.include('not valid JSON')
      expect((await TranscriptManager.parseUploadedFile({ data: Buffer.from([0x1f, 0x8b, 0, 1, 2]), size: 5 })).error).to.include('not valid gzip')
      expect((await TranscriptManager.parseUploadedFile({ data: Buffer.alloc(0), size: 0 })).error).to.include('empty')
      const tooLarge = await TranscriptManager.parseUploadedFile({ data: Buffer.from('{}'), size: TranscriptManager.MaxUploadBytes + 1 })
      expect(tooLarge.status).to.equal(413)
    })

    it('limits the decompressed size', async () => {
      const original = TranscriptManager.MaxJsonBytes
      TranscriptManager.MaxJsonBytes = 1000
      try {
        const bomb = zlib.gzipSync(Buffer.alloc(100000, 0x20))
        const result = await TranscriptManager.parseUploadedFile({ data: bomb, size: bomb.length })
        expect(result.status).to.equal(413)
      } finally {
        TranscriptManager.MaxJsonBytes = original
      }
    })
  })

  describe('storage', () => {
    it('saves gzipped into the item metadata folder and removes it', async () => {
      await TranscriptManager.saveTranscript('li-1', makeTranscript())
      const transcriptPath = Path.join(tempDir, 'items', 'li-1', 'transcript.json.gz')
      expect(TranscriptManager.getTranscriptPath('li-1')).to.equal(transcriptPath)
      const stored = JSON.parse(zlib.gunzipSync(await fs.readFile(transcriptPath)).toString())
      expect(stored).to.deep.equal(makeTranscript())

      // Replace
      await TranscriptManager.saveTranscript('li-1', makeTranscript({ model: 'tiny' }))
      expect(JSON.parse(zlib.gunzipSync(await fs.readFile(transcriptPath)).toString()).model).to.equal('tiny')
      expect(await fs.pathExists(`${transcriptPath}.tmp`)).to.be.false

      expect(await TranscriptManager.removeTranscript('li-1')).to.be.true
      expect(await fs.pathExists(transcriptPath)).to.be.false
      expect(await TranscriptManager.removeTranscript('li-1')).to.be.false
    })

    it('summarizes a transcript', () => {
      const summary = TranscriptManager.getSummary(makeTranscript())
      expect(summary).to.include({ model: 'large-v3-turbo', language: 'en', source: 'whisper', numSegments: 2, numWords: 4, createdAt: '2026-10-09T12:00:00Z' })
      expect(summary.uploadedAt).to.be.a('number')
    })
  })
})
