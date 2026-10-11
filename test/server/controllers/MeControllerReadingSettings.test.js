const { expect } = require('chai')
const sinon = require('sinon')

const MeController = require('../../../server/controllers/MeController')
const SocketAuthority = require('../../../server/SocketAuthority')

function fakeUser(extraData = null) {
  return { id: 'user-1', extraData, changed: sinon.spy(), save: sinon.stub().resolves() }
}

function fakeRes() {
  const res = { json: sinon.spy(), send: sinon.spy() }
  res.status = sinon.stub().returns(res)
  return res
}

describe('MeController - reading settings', () => {
  beforeEach(() => {
    sinon.stub(SocketAuthority, 'clientEmitter')
  })

  afterEach(() => {
    sinon.restore()
  })

  it('returns no settings for a user who never saved any', () => {
    const res = fakeRes()
    MeController.getReadingSettings({ user: fakeUser() }, res)
    expect(res.json.calledOnceWith({ settings: {} })).to.be.true
  })

  it('leaves out saved settings that are no longer valid', () => {
    const res = fakeRes()
    MeController.getReadingSettings({ user: fakeUser({ readingSettings: { readingTheme: 'sepia', readingFontScale: 9000, removed: 1 } }) }, res)
    expect(res.json.firstCall.args[0]).to.deep.equal({ settings: { readingTheme: 'sepia' } })
  })

  it('merges changed settings into the saved ones, keeps the other extra data and tells the other devices', async () => {
    const user = fakeUser({ oldUserId: 'old', readingSettings: { readingTheme: 'night', readingFontScale: 110 } })
    const res = fakeRes()
    await MeController.updateReadingSettings({ user, body: { readingFontScale: 130, readingFont: 'lexend', readerHidePlayer: true } }, res)

    const settings = { readingTheme: 'night', readingFontScale: 130, readingFont: 'lexend', readerHidePlayer: true }
    expect(user.extraData).to.deep.equal({ oldUserId: 'old', readingSettings: settings })
    expect(user.changed.calledWith('extraData', true)).to.be.true
    expect(user.save.calledOnce).to.be.true
    expect(res.json.firstCall.args[0]).to.deep.equal({ settings })
    expect(SocketAuthority.clientEmitter.calledOnceWith('user-1', 'reading_settings_updated', { settings })).to.be.true
  })

  it('rejects unknown settings and invalid values without saving', async () => {
    for (const body of [{ readingTheme: 'neon' }, { readingFontScale: '120' }, { readAlongWords: 2 }, { highlighterMode: 'yes' }, { isRoot: true }, {}, null, []]) {
      const user = fakeUser()
      const res = fakeRes()
      await MeController.updateReadingSettings({ user, body }, res)
      expect(res.status.calledWith(400), JSON.stringify(body)).to.be.true
      expect(user.save.called).to.be.false
    }
    expect(SocketAuthority.clientEmitter.called).to.be.false
  })
})
