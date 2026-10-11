const { expect } = require('chai')
const sinon = require('sinon')
const os = require('os')
const Path = require('path')
const fs = require('../../../server/libs/fsExtra')

const AnnotationManager = require('../../../server/managers/AnnotationManager')
const Logger = require('../../../server/Logger')

function makeAnnotation(overrides = {}) {
  return {
    start: 24.33,
    end: 25.1,
    text: 'The Happy Prince.',
    color: 'yellow',
    note: null,
    createdAt: 1760000000000,
    updatedAt: 1760000000000,
    ...overrides
  }
}

describe('AnnotationManager', () => {
  let metadataPath
  let originalMetadataPath

  beforeEach(async () => {
    originalMetadataPath = global.MetadataPath
    metadataPath = await fs.mkdtemp(Path.join(os.tmpdir(), 'abs-annotations-'))
    global.MetadataPath = metadataPath
    sinon.stub(Logger, 'error')
  })

  afterEach(async () => {
    sinon.restore()
    global.MetadataPath = originalMetadataPath
    await fs.remove(metadataPath)
  })

  describe('validate', () => {
    it('accepts an annotation and trims its text and note', () => {
      const { annotation, error } = AnnotationManager.validate(makeAnnotation({ text: '  The Happy Prince.  ', note: ' Lovely ' }), 'annotation-1')
      expect(error).to.be.undefined
      expect(annotation).to.deep.equal({ id: 'annotation-1', start: 24.33, end: 25.1, text: 'The Happy Prince.', color: 'yellow', note: 'Lovely', createdAt: 1760000000000, updatedAt: 1760000000000 })
    })

    it('stores an empty note as null and fills in missing times', () => {
      const before = Date.now()
      const { annotation } = AnnotationManager.validate(makeAnnotation({ note: '   ', createdAt: undefined, updatedAt: 'x' }), 'annotation-1')
      expect(annotation.note).to.be.null
      expect(annotation.createdAt).to.be.at.least(before)
      expect(annotation.updatedAt).to.be.at.least(before)
    })

    it('rejects invalid ids, times, text, colors and notes', () => {
      expect(AnnotationManager.validate(makeAnnotation(), 'bad id!').error).to.equal('Invalid id')
      expect(AnnotationManager.validate(makeAnnotation(), 'short').error).to.equal('Invalid id')
      expect(AnnotationManager.validate(null, 'annotation-1').error).to.equal('Invalid annotation')
      expect(AnnotationManager.validate(makeAnnotation({ start: -1 }), 'annotation-1').error).to.equal('Invalid start')
      expect(AnnotationManager.validate(makeAnnotation({ start: '1' }), 'annotation-1').error).to.equal('Invalid start')
      expect(AnnotationManager.validate(makeAnnotation({ end: 20 }), 'annotation-1').error).to.equal('Invalid end')
      expect(AnnotationManager.validate(makeAnnotation({ text: '  ' }), 'annotation-1').error).to.equal('Invalid text')
      expect(AnnotationManager.validate(makeAnnotation({ color: 'red' }), 'annotation-1').error).to.equal('Invalid color')
      expect(AnnotationManager.validate(makeAnnotation({ note: 5 }), 'annotation-1').error).to.equal('Invalid note')
    })
  })

  describe('save, get and remove', () => {
    it('stores annotations per user and item in book order', async () => {
      const later = AnnotationManager.validate(makeAnnotation({ start: 100, end: 101 }), 'annotation-2').annotation
      const earlier = AnnotationManager.validate(makeAnnotation(), 'annotation-1').annotation
      await AnnotationManager.saveAnnotation('li-1', 'user-1', later)
      await AnnotationManager.saveAnnotation('li-1', 'user-1', earlier)

      const annotations = await AnnotationManager.getAnnotations('li-1', 'user-1')
      expect(annotations.map((a) => a.id)).to.deep.equal(['annotation-1', 'annotation-2'])
      expect(await AnnotationManager.getAnnotations('li-1', 'user-2')).to.deep.equal([])
      expect(await fs.pathExists(Path.join(metadataPath, 'items', 'li-1', 'annotations', 'user-1.json'))).to.be.true
    })

    it('replaces an annotation with a newer copy and keeps a newer stored copy', async () => {
      const original = AnnotationManager.validate(makeAnnotation({ createdAt: 1000, updatedAt: 1000 }), 'annotation-1').annotation
      await AnnotationManager.saveAnnotation('li-1', 'user-1', original)

      const newer = AnnotationManager.validate(makeAnnotation({ color: 'blue', note: 'A note', createdAt: 5000, updatedAt: 2000 }), 'annotation-1').annotation
      const saved = await AnnotationManager.saveAnnotation('li-1', 'user-1', newer)
      expect(saved.annotation).to.include({ color: 'blue', note: 'A note', createdAt: 1000, updatedAt: 2000 })

      // A change made earlier offline arrives late: the stored copy stays
      const stale = AnnotationManager.validate(makeAnnotation({ color: 'pink', updatedAt: 1500 }), 'annotation-1').annotation
      const result = await AnnotationManager.saveAnnotation('li-1', 'user-1', stale)
      expect(result.annotation.color).to.equal('blue')
      const annotations = await AnnotationManager.getAnnotations('li-1', 'user-1')
      expect(annotations).to.have.length(1)
      expect(annotations[0].color).to.equal('blue')
    })

    it('does not lose annotations saved at the same time', async () => {
      const saves = []
      for (let i = 0; i < 20; i++) {
        saves.push(AnnotationManager.saveAnnotation('li-1', 'user-1', AnnotationManager.validate(makeAnnotation({ start: i, end: i }), `annotation-${String(i).padStart(2, '0')}`).annotation))
      }
      await Promise.all(saves)
      expect(await AnnotationManager.getAnnotations('li-1', 'user-1')).to.have.length(20)
    })

    it('refuses more annotations than the limit', async () => {
      sinon.stub(AnnotationManager, 'MaxAnnotationsPerItem').value(1)
      await AnnotationManager.saveAnnotation('li-1', 'user-1', AnnotationManager.validate(makeAnnotation(), 'annotation-1').annotation)
      const result = await AnnotationManager.saveAnnotation('li-1', 'user-1', AnnotationManager.validate(makeAnnotation(), 'annotation-2').annotation)
      expect(result.error).to.equal('Too many annotations')
    })

    it('removes annotations and the file with the last one', async () => {
      await AnnotationManager.saveAnnotation('li-1', 'user-1', AnnotationManager.validate(makeAnnotation(), 'annotation-1').annotation)
      await AnnotationManager.saveAnnotation('li-1', 'user-1', AnnotationManager.validate(makeAnnotation({ start: 30, end: 31 }), 'annotation-2').annotation)

      expect(await AnnotationManager.removeAnnotation('li-1', 'user-1', 'annotation-1')).to.be.true
      expect(await AnnotationManager.removeAnnotation('li-1', 'user-1', 'annotation-1')).to.be.false
      expect((await AnnotationManager.getAnnotations('li-1', 'user-1')).map((a) => a.id)).to.deep.equal(['annotation-2'])

      expect(await AnnotationManager.removeAnnotation('li-1', 'user-1', 'annotation-2')).to.be.true
      expect(await fs.pathExists(AnnotationManager.getAnnotationsPath('li-1', 'user-1'))).to.be.false
    })

    it('reads a damaged file as no annotations', async () => {
      const filePath = AnnotationManager.getAnnotationsPath('li-1', 'user-1')
      await fs.ensureDir(Path.dirname(filePath))
      await fs.writeFile(filePath, '{not json')
      expect(await AnnotationManager.getAnnotations('li-1', 'user-1')).to.deep.equal([])
    })
  })
})
