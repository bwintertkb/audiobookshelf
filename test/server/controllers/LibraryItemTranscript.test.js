const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')
const os = require('os')
const Path = require('path')
const zlib = require('zlib')
const { PassThrough } = require('stream')
const fs = require('../../../server/libs/fsExtra')

const Database = require('../../../server/Database')
const ApiRouter = require('../../../server/routers/ApiRouter')
const LibraryItemController = require('../../../server/controllers/LibraryItemController')
const ApiCacheManager = require('../../../server/managers/ApiCacheManager')
const SocketAuthority = require('../../../server/SocketAuthority')
const Auth = require('../../../server/Auth')
const Logger = require('../../../server/Logger')

function audioFile(ino, duration, index) {
  return { ino, index, duration, metadata: { filename: `${ino}.mp3`, path: `/test/book/${ino}.mp3`, relPath: `${ino}.mp3` } }
}

function makeTranscript(libraryItemId, overrides = {}) {
  return {
    version: 1,
    libraryItemId,
    model: 'large-v3-turbo',
    language: 'en',
    createdAt: '2026-10-09T12:00:00Z',
    durationSec: 150,
    source: 'whisper',
    files: [
      { ino: 'ino1', filename: 'ino1.mp3', startOffset: 0, duration: 100 },
      { ino: 'ino2', filename: 'ino2.mp3', startOffset: 100, duration: 50 }
    ],
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
        start: 101,
        end: 102,
        text: 'Second file',
        words: [
          { w: 'Second', start: 101, end: 101.5 },
          { w: 'file', start: 101.6, end: 102 }
        ]
      }
    ],
    ...overrides
  }
}

function fakeRes() {
  const res = {
    headers: {},
    headersSent: false,
    statusCode: 200,
    body: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    status(code) {
      this.statusCode = code
      return this
    },
    send(body) {
      this.body = body
      return this
    },
    json(body) {
      this.body = body
      return this
    },
    sendStatus(code) {
      this.statusCode = code
      return this
    },
    sendFile: sinon.spy()
  }
  sinon.spy(res, 'status')
  sinon.spy(res, 'sendStatus')
  return res
}

describe('LibraryItemController transcripts', () => {
  /** @type {ApiRouter} */
  let apiRouter
  let tempDir
  let libraryItemId
  const user = { username: 'admin', canUpdate: true, canDelete: true }

  beforeEach(async () => {
    global.ServerSettings = {}
    tempDir = await fs.mkdtemp(Path.join(os.tmpdir(), 'abs-transcript-ctrl-'))
    global.MetadataPath = tempDir
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    apiRouter = new ApiRouter({
      auth: new Auth(),
      apiCacheManager: new ApiCacheManager()
    })

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'error')
    sinon.stub(Logger, 'warn')
    sinon.stub(SocketAuthority, 'libraryItemEmitter')

    const library = await Database.libraryModel.create({ name: 'Test Library', mediaType: 'book' })
    const folder = await Database.libraryFolderModel.create({ path: '/test', libraryId: library.id })
    // ino3 is excluded from playback, so the playable timeline is 150 s
    const audioFiles = [audioFile('ino1', 100, 1), audioFile('ino2', 50, 2), { ...audioFile('ino3', 500, -1), exclude: true }]
    const book = await Database.bookModel.create({ title: 'Test Book', audioFiles, tags: [], narrators: [], genres: [], chapters: [], duration: 650 })
    const libraryItem = await Database.libraryItemModel.create({ libraryFiles: [], mediaId: book.id, mediaType: 'book', libraryId: library.id, libraryFolderId: folder.id, path: '/test/book', relPath: 'book' })
    libraryItemId = libraryItem.id
  })

  afterEach(async () => {
    sinon.restore()
    await Database.sequelize.sync({ force: true })
    await fs.remove(tempDir)
  })

  async function getItem() {
    return Database.libraryItemModel.getExpandedById(libraryItemId)
  }

  async function writeUpload(name, buffer) {
    const tempFilePath = Path.join(tempDir, name)
    await fs.writeFile(tempFilePath, buffer)
    return { name, tempFilePath, size: buffer.length, data: Buffer.alloc(0) }
  }

  async function upload(transcript, { gzipped = true, reqUser = user } = {}) {
    const json = Buffer.from(JSON.stringify(transcript))
    const file = await writeUpload('upload.tmp', gzipped ? zlib.gzipSync(json) : json)
    const req = { params: { id: libraryItemId }, user: reqUser, libraryItem: await getItem(), files: { transcript: file }, body: {} }
    const res = fakeRes()
    await LibraryItemController.uploadTranscript.bind(apiRouter)(req, res)
    return { req, res, file }
  }

  it('uploads a gzipped transcript, stores it and flags the item', async () => {
    const { res, file } = await upload(makeTranscript(libraryItemId))
    expect(res.body.success).to.be.true
    expect(res.body.transcript).to.include({ numSegments: 2, numWords: 4, model: 'large-v3-turbo' })

    const transcriptPath = Path.join(tempDir, 'items', libraryItemId, 'transcript.json.gz')
    const stored = JSON.parse(zlib.gunzipSync(await fs.readFile(transcriptPath)).toString())
    expect(stored).to.deep.equal(makeTranscript(libraryItemId))
    // Upload temp file is cleaned up
    expect(await fs.pathExists(file.tempFilePath)).to.be.false

    const libraryItem = await getItem()
    expect(libraryItem.extraData.transcript.numWords).to.equal(4)
    expect(libraryItem.toOldJSONExpanded().hasTranscript).to.be.true
    expect(libraryItem.toOldJSONMinified()).to.not.have.property('hasTranscript')
    expect(SocketAuthority.libraryItemEmitter.calledWith('item_updated')).to.be.true
  })

  it('accepts a plain JSON file and a JSON body', async () => {
    const { res } = await upload(makeTranscript(libraryItemId), { gzipped: false })
    expect(res.body.success).to.be.true

    const req = { params: { id: libraryItemId }, user, libraryItem: await getItem(), body: makeTranscript(libraryItemId, { model: 'tiny' }) }
    const res2 = fakeRes()
    await LibraryItemController.uploadTranscript.bind(apiRouter)(req, res2)
    expect(res2.body.transcript.model).to.equal('tiny')
  })

  it('replaces an existing transcript', async () => {
    await upload(makeTranscript(libraryItemId))
    await upload(makeTranscript(libraryItemId, { model: 'large-v3' }))
    const transcriptPath = Path.join(tempDir, 'items', libraryItemId, 'transcript.json.gz')
    const stored = JSON.parse(zlib.gunzipSync(await fs.readFile(transcriptPath)).toString())
    expect(stored.model).to.equal('large-v3')
    expect((await getItem()).extraData.transcript.model).to.equal('large-v3')
  })

  it('rejects invalid transcripts', async () => {
    const { res } = await upload(makeTranscript('another-item'))
    expect(res.statusCode).to.equal(400)
    expect(res.body).to.include('does not match')

    const beyondEnd = makeTranscript(libraryItemId)
    beyondEnd.segments[1].end = 200 // excluded file must not extend the timeline
    beyondEnd.segments[1].words[1].end = 200
    const { res: res2 } = await upload(beyondEnd)
    expect(res2.statusCode).to.equal(400)
    expect(res2.body).to.include('out of range')

    expect(await fs.pathExists(Path.join(tempDir, 'items', libraryItemId, 'transcript.json.gz'))).to.be.false
    expect((await getItem()).toOldJSONExpanded().hasTranscript).to.be.false
  })

  it('rejects requests without a transcript', async () => {
    const req = { params: { id: libraryItemId }, user, libraryItem: await getItem(), body: {} }
    const res = fakeRes()
    await LibraryItemController.uploadTranscript.bind(apiRouter)(req, res)
    expect(res.statusCode).to.equal(400)
  })

  it('requires update permission to upload', async () => {
    const { res } = await upload(makeTranscript(libraryItemId), { reqUser: { username: 'user', canUpdate: false } })
    expect(res.sendStatus.calledWith(403)).to.be.true
  })

  it('serves the transcript gzip encoded, or decompressed if gzip is not accepted', async () => {
    const req = { params: { id: libraryItemId }, user, libraryItem: await getItem(), acceptsEncodings: () => 'gzip' }
    const res = fakeRes()
    await LibraryItemController.getTranscript.bind(apiRouter)(req, res)
    expect(res.sendStatus.calledWith(404)).to.be.true

    await upload(makeTranscript(libraryItemId))
    const req2 = { ...req, libraryItem: await getItem() }
    const res2 = fakeRes()
    await LibraryItemController.getTranscript.bind(apiRouter)(req2, res2)
    expect(res2.sendFile.calledOnce).to.be.true
    expect(res2.sendFile.firstCall.args[0]).to.equal(Path.join(tempDir, 'items', libraryItemId, 'transcript.json.gz'))
    expect(res2.headers['content-encoding']).to.equal('gzip')
    expect(res2.headers['content-type']).to.include('application/json')

    // Client without gzip support gets plain JSON
    const stream = new PassThrough()
    stream.setHeader = sinon.spy()
    const chunks = []
    stream.on('data', (chunk) => chunks.push(chunk))
    const finished = new Promise((resolve) => stream.on('end', resolve))
    await LibraryItemController.getTranscript.bind(apiRouter)({ ...req2, acceptsEncodings: () => false }, stream)
    await finished
    expect(JSON.parse(Buffer.concat(chunks).toString())).to.deep.equal(makeTranscript(libraryItemId))
    expect(stream.setHeader.calledWith('Content-Encoding')).to.be.false
  })

  it('deletes the transcript and clears the flag', async () => {
    await upload(makeTranscript(libraryItemId))
    const req = { params: { id: libraryItemId }, user, libraryItem: await getItem() }
    const res = fakeRes()
    await LibraryItemController.deleteTranscript.bind(apiRouter)(req, res)
    expect(res.sendStatus.calledWith(200)).to.be.true
    expect(await fs.pathExists(Path.join(tempDir, 'items', libraryItemId, 'transcript.json.gz'))).to.be.false
    expect((await getItem()).toOldJSONExpanded().hasTranscript).to.be.false

    const res2 = fakeRes()
    await LibraryItemController.deleteTranscript.bind(apiRouter)({ ...req, libraryItem: await getItem() }, res2)
    expect(res2.sendStatus.calledWith(404)).to.be.true
  })

  it('removes the transcript when the library item is deleted', async () => {
    await upload(makeTranscript(libraryItemId))
    const transcriptPath = Path.join(tempDir, 'items', libraryItemId, 'transcript.json.gz')
    expect(await fs.pathExists(transcriptPath)).to.be.true

    const req = { query: {}, user, libraryItem: await getItem() }
    const res = fakeRes()
    await LibraryItemController.delete.bind(apiRouter)(req, res)
    expect(res.sendStatus.calledWith(200)).to.be.true
    expect(await fs.pathExists(transcriptPath)).to.be.false
  })

  describe('audio for speech recognition in the browser', () => {
    const TranscriptManager = require('../../../server/managers/TranscriptManager')
    const { EventEmitter } = require('events')

    function fakeDecoder() {
      const decoder = new EventEmitter()
      decoder.pipe = sinon.spy((destination) => {
        decoder.destination = destination
        return destination
      })
      decoder.kill = sinon.spy()
      return decoder
    }

    function streamRes() {
      const res = new PassThrough()
      res.headers = {}
      res.setHeader = (name, value) => (res.headers[name.toLowerCase()] = value)
      res.status = sinon.spy((code) => {
        res.statusCode = code
        return res
      })
      res.send = sinon.spy(() => res)
      res.sendStatus = sinon.spy((code) => {
        res.statusCode = code
        return res
      })
      return res
    }

    async function getAudio(query, { fileid = 'ino2', reqUser = user } = {}) {
      const req = { params: { id: libraryItemId, fileid }, query, user: reqUser, libraryItem: await getItem() }
      const res = streamRes()
      await LibraryItemController.getTranscriptAudio.bind(apiRouter)(req, res)
      return res
    }

    it('streams the requested part of an audio file decoded to 16 kHz mono PCM', async () => {
      const decoder = fakeDecoder()
      const decode = sinon.stub(TranscriptManager, 'decodeAudioPart').returns(decoder)
      const res = await getAudio({ start: '12.5', duration: '120' })
      expect(decode.calledOnceWith('/test/book/ino2.mp3', 12.5, 120)).to.be.true
      expect(decoder.pipe.calledOnce).to.be.true
      expect(decoder.destination).to.equal(res)
      expect(res.headers['content-type']).to.equal('application/octet-stream')
      expect(res.sendStatus.called).to.be.false
    })

    it('stops decoding when the browser cancels the request', async () => {
      const decoder = fakeDecoder()
      sinon.stub(TranscriptManager, 'decodeAudioPart').returns(decoder)
      const res = await getAudio({ start: '0', duration: '60' })
      res.destroy()
      await new Promise((resolve) => setImmediate(resolve))
      expect(decoder.kill.calledOnceWith('SIGKILL')).to.be.true
    })

    it('rejects invalid ranges, unknown files and users who cannot create transcripts', async () => {
      const decode = sinon.stub(TranscriptManager, 'decodeAudioPart').returns(fakeDecoder())
      for (const query of [{ start: '-1', duration: '10' }, { start: '0', duration: '0' }, { start: 'abc', duration: '10' }, { start: '0', duration: String(TranscriptManager.MaxAudioPartSec + 1) }, {}]) {
        expect((await getAudio(query)).status.calledWith(400), JSON.stringify(query)).to.be.true
      }
      expect((await getAudio({ start: '0', duration: '10' }, { fileid: 'nope' })).sendStatus.calledWith(404)).to.be.true
      expect((await getAudio({ start: '0', duration: '10' }, { reqUser: { username: 'guest', canUpdate: false } })).sendStatus.calledWith(403)).to.be.true
      expect(decode.called).to.be.false
    })
  })

  describe('uploading an ebook to a book', () => {
    const LibraryItemScanner = require('../../../server/scanner/LibraryItemScanner')
    const Watcher = require('../../../server/Watcher')
    let bookDir

    beforeEach(async () => {
      bookDir = Path.join(tempDir, 'library', 'Author', 'Book')
      await fs.ensureDir(bookDir)
      await Database.libraryItemModel.update({ path: bookDir }, { where: { id: libraryItemId } })
      sinon.stub(LibraryItemScanner, 'scanLibraryItem').resolves(1)
      sinon.stub(Watcher, 'addIgnoreDir')
      sinon.stub(Watcher, 'removeIgnoreDir')
    })

    async function uploadEbook(name, { reqUser = { ...user, canUpload: true }, content = 'epub data' } = {}) {
      const tempFilePath = Path.join(tempDir, `upload-${name}`)
      await fs.writeFile(tempFilePath, content)
      const file = { name, tempFilePath, mv: (destination) => fs.move(tempFilePath, destination) }
      const req = { params: { id: libraryItemId }, user: reqUser, libraryItem: await getItem(), files: name ? { ebook: file } : {} }
      const res = fakeRes()
      await LibraryItemController.uploadEbook.bind(apiRouter)(req, res)
      return { res, tempFilePath }
    }

    it('puts the ebook in the book folder and scans the book', async () => {
      const { res } = await uploadEbook('The Book.epub')
      expect(await fs.readFile(Path.join(bookDir, 'The Book.epub'), 'utf8')).to.equal('epub data')
      expect(LibraryItemScanner.scanLibraryItem.calledOnceWith(libraryItemId)).to.be.true
      expect(Watcher.addIgnoreDir.calledWith(bookDir)).to.be.true
      expect(Watcher.removeIgnoreDir.calledWith(bookDir)).to.be.true
      expect(res.body.id).to.equal(libraryItemId)
    })

    it('rejects missing and unsupported files, files already in the folder and users who cannot upload', async () => {
      expect((await uploadEbook(null)).res.statusCode).to.equal(400)
      const unsupported = await uploadEbook('notes.txt')
      expect(unsupported.res.statusCode).to.equal(400)
      expect(await fs.pathExists(unsupported.tempFilePath)).to.be.false
      await fs.writeFile(Path.join(bookDir, 'Existing.epub'), 'old')
      expect((await uploadEbook('Existing.epub')).res.statusCode).to.equal(409)
      expect(await fs.readFile(Path.join(bookDir, 'Existing.epub'), 'utf8')).to.equal('old')
      expect((await uploadEbook('New.epub', { reqUser: { ...user, canUpload: false } })).res.statusCode).to.equal(403)
      expect(LibraryItemScanner.scanLibraryItem.called).to.be.false
    })
  })

  describe('middleware permissions', () => {
    async function runMiddleware(method, reqUser) {
      const req = { params: { id: libraryItemId }, method, path: `/items/${libraryItemId}/transcript`, user: { checkCanAccessLibraryItem: () => true, ...reqUser } }
      const res = fakeRes()
      const next = sinon.spy()
      await LibraryItemController.middleware.bind(apiRouter)(req, res, next)
      return { res, next }
    }

    it('lets users with item access read transcripts', async () => {
      const { next } = await runMiddleware('GET', { username: 'reader', canUpdate: false, canDelete: false })
      expect(next.calledOnce).to.be.true
    })

    it('requires update permission to upload and delete permission to remove', async () => {
      const upload = await runMiddleware('POST', { username: 'reader', canUpdate: false, canDelete: false })
      expect(upload.res.sendStatus.calledWith(403)).to.be.true
      const remove = await runMiddleware('DELETE', { username: 'editor', canUpdate: true, canDelete: false })
      expect(remove.res.sendStatus.calledWith(403)).to.be.true
      const allowed = await runMiddleware('DELETE', { username: 'root', canUpdate: true, canDelete: true })
      expect(allowed.next.calledOnce).to.be.true
    })

    it('blocks users without access to the item', async () => {
      const { res } = await runMiddleware('GET', { username: 'other', checkCanAccessLibraryItem: () => false })
      expect(res.sendStatus.calledWith(403)).to.be.true
    })
  })
})
