import { ReadingSettingsSync, readerFontFamily, readingFontOf, takeLegacyReadingSettings, transcriptFontScale, validReadingSettings } from '@/players/readingSettings'

class MemoryStorage {
  constructor(data = {}) {
    this.data = { ...data }
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

/** A server keeping the account's settings, and a device using them */
function setup({ account = {}, device = {}, storage = new MemoryStorage(), offline = false } = {}) {
  const server = { settings: { ...account }, offline, requests: [] }
  const deviceSettings = { ...device }
  const request = cy.spy(async (method, path, body) => {
    server.requests.push({ method, path, body })
    if (server.offline) throw new Error('Network Error')
    if (method === 'PATCH') Object.assign(server.settings, body)
    return { settings: { ...server.settings } }
  })
  const apply = cy.spy((settings) => Object.assign(deviceSettings, settings))
  const sync = new ReadingSettingsSync({ request, current: () => deviceSettings, apply, storage, sendDelayMs: 20 })
  return { server, deviceSettings, request, apply, sync, storage }
}

describe('readingSettings', () => {
  it('keeps only known settings with valid values', () => {
    expect(validReadingSettings({ readingTheme: 'sepia', readingFont: 'lexend', readingFontScale: 130, readAlongWords: 5, highlighterMode: true, readerHidePlayer: true })).to.deep.equal({
      readingTheme: 'sepia',
      readingFont: 'lexend',
      readingFontScale: 130,
      readAlongWords: 5,
      highlighterMode: true,
      readerHidePlayer: true
    })
    expect(validReadingSettings({ readingTheme: '', readingFontScale: 1000, readAlongWords: 2, highlighterMode: 'yes', orderBy: 'title', readingSpread: 'none' })).to.deep.equal({ readingSpread: 'none' })
    expect(validReadingSettings(null)).to.deep.equal({})
  })

  it('maps the reading font to the ebook reader font and back, and the text size to the transcript', () => {
    expect(['sans', 'serif', 'lexend', ''].map(readerFontFamily)).to.deep.equal(['sans-serif', 'serif', 'Lexend, sans-serif', 'serif'])
    expect(['sans-serif', 'serif', 'Lexend, sans-serif', 'Lexend', undefined].map(readingFontOf)).to.deep.equal(['sans', 'serif', 'lexend', 'lexend', 'serif'])
    expect([100, 130, 50, 300, null].map(transcriptFontScale)).to.deep.equal([1, 1.3, 0.75, 2, 1])
  })

  it('takes the settings kept on the device before, once', () => {
    const storage = new MemoryStorage({
      ereaderSettings: JSON.stringify({ theme: 'dark', font: 'Lexend, sans-serif', fontScale: 120, lineSpacing: 150, textStroke: 10, spread: 'none', navigateWithVolume: 'enabled' }),
      transcriptLayout: 'lines',
      readerHidePlayer: '1',
      readerShowInfo: '0'
    })
    expect(takeLegacyReadingSettings(storage, { transcriptFont: 'sans', transcriptFontScale: 1.5 })).to.deep.equal({
      readingFont: 'lexend',
      readingFontScale: 120,
      readingLineSpacing: 150,
      readingTextStroke: 10,
      readingSpread: 'none',
      transcriptLayout: 'lines',
      readerHidePlayer: true,
      readerShowInfo: false
    })
    expect(takeLegacyReadingSettings(storage)).to.equal(null)
    // Only the transcript's settings (web user settings)
    expect(takeLegacyReadingSettings(new MemoryStorage(), { transcriptFont: 'serif', transcriptFontScale: 1.25 })).to.deep.equal({ readingFont: 'serif', readingFontScale: 125 })
    expect(takeLegacyReadingSettings(new MemoryStorage())).to.deep.equal({})
  })

  it('sends changes to the account a moment later, together', () => {
    const { server, request, sync } = setup()
    sync.changed({ readingFontScale: 110 })
    sync.changed({ readingFontScale: 120, readingFont: 'serif', orderBy: 'title' })
    cy.wrap(null).should(() => expect(request).to.have.been.calledOnce)
    cy.then(() => {
      expect(server.requests[0]).to.deep.equal({ method: 'PATCH', path: '/api/me/reading-settings', body: { readingFontScale: 120, readingFont: 'serif' } })
      expect(sync.pending).to.deep.equal({})
    })
  })

  it('keeps changes made offline (also when the app restarts) and sends them first when connecting', () => {
    const storage = new MemoryStorage()
    const first = setup({ storage, offline: true, account: { readingTheme: 'night', readingFontScale: 100 } })
    first.sync.changed({ readingFontScale: 140 })
    cy.wrap(null).should(() => expect(first.request).to.have.been.calledOnce)
    cy.then(() => {
      expect(first.server.settings.readingFontScale).to.equal(100)
      expect(JSON.parse(storage.getItem('readingSettingsPending'))).to.deep.equal({ readingFontScale: 140 })
      // Restarted and back online: the change is sent before loading, and the account's other settings are taken
      const second = setup({ storage, account: { readingTheme: 'sepia', readingFontScale: 100 }, device: { readingTheme: 'night', readingFontScale: 140 } })
      return second.sync.load().then(() => second)
    }).then(({ server, deviceSettings, request }) => {
      expect(request.firstCall.args).to.deep.equal(['PATCH', '/api/me/reading-settings', { readingFontScale: 140 }])
      expect(server.settings).to.deep.equal({ readingTheme: 'sepia', readingFontScale: 140 })
      expect(deviceSettings).to.deep.equal({ readingTheme: 'sepia', readingFontScale: 140 })
      expect(storage.getItem('readingSettingsPending')).to.equal(null)
    })
  })

  it("takes the account's settings when connecting and gives the account the ones chosen here that it does not have", () => {
    const { server, deviceSettings, apply, sync } = setup({ account: { readingTheme: 'sage', readingFont: 'lexend' }, device: { readingTheme: 'night', readingFont: '', readingFontScale: 100, readingLineSpacing: 140, readerHidePlayer: true } })
    cy.then(() => sync.load()).then(() => {
      expect(apply).to.have.been.calledOnceWith({ readingTheme: 'sage', readingFont: 'lexend' })
      expect(deviceSettings).to.deep.equal({ readingTheme: 'sage', readingFont: 'lexend', readingFontScale: 100, readingLineSpacing: 140, readerHidePlayer: true })
      // Defaults (text size 100%) are not sent
      expect(server.settings).to.deep.equal({ readingTheme: 'sage', readingFont: 'lexend', readingLineSpacing: 140, readerHidePlayer: true })
    })
  })

  it('an account without settings starts with the choices of this device', () => {
    const { server, apply, sync } = setup({ device: { readingTheme: 'paper', readingFontScale: 115, readerShowInfo: false, readerHidePlayer: false } })
    cy.then(() => sync.load()).then(() => {
      expect(apply).not.to.have.been.called
      expect(server.settings).to.deep.equal({ readingTheme: 'paper', readingFontScale: 115, readerShowInfo: false })
    })
  })

  it('a device that was never set up does not undo the choices of another', () => {
    const device = { readingFont: '', readingFontScale: 100, readingLineSpacing: 115, readerHidePlayer: false, readerShowInfo: true, highlighterColor: 'yellow' }
    const web = setup({ device })
    cy.then(() => web.sync.load())
      .then(() => {
        expect(web.request).to.have.been.calledOnceWith('GET')
        expect(web.server.settings).to.deep.equal({})
        // The phone, set up for reading full page in Lexend, connects next and keeps its settings
        const phone = setup({ account: web.server.settings, device: { ...device, readingFont: 'lexend', readerHidePlayer: true, readerShowInfo: false } })
        return phone.sync.load().then(() => phone)
      })
      .then(({ server, deviceSettings }) => {
        expect(deviceSettings).to.include({ readingFont: 'lexend', readerHidePlayer: true, readerShowInfo: false })
        expect(server.settings).to.deep.equal({ readingFont: 'lexend', readerHidePlayer: true, readerShowInfo: false })
      })
  })

  it('takes changes from another device, except settings changed here and not sent yet', () => {
    const { deviceSettings, sync } = setup({ device: { readingTheme: 'night', readingFontScale: 100 } })
    sync.pending = { readingFontScale: 150 }
    sync.received({ readingTheme: 'black', readingFontScale: 90, bogus: 1 })
    expect(deviceSettings).to.deep.equal({ readingTheme: 'black', readingFontScale: 100 })
  })
})
