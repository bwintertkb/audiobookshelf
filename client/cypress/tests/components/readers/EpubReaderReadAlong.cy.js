import Vue from 'vue'
import JSZip from 'jszip'
import EpubReader from '@/components/readers/EpubReader.vue'
import Strings from '@/strings/en-us.json'
import { SENTENCE_HIGHLIGHT, WORD_HIGHLIGHT, tokenizeDocument } from '@/players/ReadAlong'
import { allPlaybackRates } from '../../../support/playbackRates'

const WORD_SEC = 0.3
const VOCABULARY = ['the', 'garden', 'giant', 'children', 'played', 'among', 'flowers', 'beneath', 'peach', 'trees', 'and', 'birds', 'sang', 'sweetly', 'every', 'afternoon', 'snow', 'frost', 'came', 'north', 'wind']

/** Paragraph HTML (with inline formatting) and its narrated text */
function paragraph(seed, sentences) {
  const parts = []
  for (let s = 0; s < sentences; s++) {
    const words = []
    for (let w = 0; w < 9; w++) words.push(VOCABULARY[(seed * 7 + s * 5 + w * 3) % VOCABULARY.length] + (seed + s + w === 0 ? '' : ''))
    words[0] = words[0][0].toUpperCase() + words[0].slice(1)
    words[2] = `${words[2]}${seed}x${s}` // unique tokens so tests can find words
    parts.push(words.join(' ') + '.')
  }
  const text = parts.join(' ')
  // Formatting inside words and around them must not change the words
  const html = text.replace(/^(\S+)/, '<em>$1</em>').replace(/ (\S+)\./, ' <strong>$1</strong>.')
  return { html, text }
}

function chapters() {
  const one = [{ html: 'Chapter One', text: 'Chapter One', heading: true }]
  for (let p = 0; p < 40; p++) one.push(paragraph(p, 4))
  const two = [{ html: 'Chapter Two', text: 'Chapter Two', heading: true }]
  for (let p = 40; p < 48; p++) two.push(paragraph(p, 3))
  return [one, two]
}

function chapterHtml(paragraphs) {
  const body = paragraphs
    .map((p, i) => {
      if (p.heading) return `<h1>${p.html}</h1>`
      // A footnote marker and an illustration caption are not narrated
      const marker = i === 2 ? '<sup>1</sup>' : ''
      const caption = i === 3 ? '<p class="caption" aria-hidden="true">Illustration of the walled garden in winter</p>' : ''
      return `<p>${p.html}${marker}</p>${caption}`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>${body}</body></html>`
}

async function buildEpub(allChapters) {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  const manifest = allChapters.map((_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')
  const spine = allChapters.map((_, i) => `<itemref idref="c${i}"/>`).join('')
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Read along test</dc:title><dc:identifier id="id">readalong</dc:identifier></metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`)
  allChapters.forEach((paragraphs, i) => zip.file(`OEBPS/c${i}.xhtml`, chapterHtml(paragraphs)))
  return zip.generateAsync({ type: 'arraybuffer' })
}

/** What the helper would produce: the narrated words of each chapter, one segment per sentence, with spine positions */
function buildTranscript(allChapters) {
  const segments = []
  let t = 1
  allChapters.forEach((paragraphs, spine) => {
    paragraphs.forEach((p) => {
      const sentences = p.heading ? [p.text] : p.text.match(/[^.]+\./g).map((s) => s.trim())
      sentences.forEach((sentence, si) => {
        const words = sentence.split(' ').map((w) => {
          const word = { w, start: Number(t.toFixed(3)), end: Number((t + WORD_SEC * 0.8).toFixed(3)) }
          t += WORD_SEC
          return word
        })
        segments.push({ start: words[0].start, end: words[words.length - 1].end, text: sentence, words, spine, ...(si === 0 ? { paragraph: true } : {}), ...(p.heading ? { heading: true } : {}) })
      })
      t += 0.5
    })
    t += 3 // narrator pause between chapters
  })
  return { version: 1, libraryItemId: 'book', source: 'ebook', files: [{ ino: 'f', startOffset: 0, duration: t + 5 }], segments }
}

function highlighted(name) {
  for (const iframe of document.querySelectorAll('#viewer iframe')) {
    const highlight = iframe.contentWindow.CSS?.highlights?.get(name)
    if (highlight && highlight.size) return [...highlight][0].toString()
  }
  return null
}

describe('<EpubReader /> read along', () => {
  const allChapters = chapters()
  const transcript = buildTranscript(allChapters)
  const words = transcript.segments.flatMap((s) => s.words.map((w) => ({ ...w, spine: s.spine })))
  let epub

  before(() => {
    cy.wrap(null).then(() => buildEpub(allChapters).then((buffer) => (epub = buffer)))
  })

  function mount({ streaming = true } = {}) {
    const clock = { time: words[0].start + 0.05 } // narration has started: first word
    const eventBus = new Vue()
    const events = { seeks: [], plays: [] }
    eventBus.$on('player-get-time', (callback) => callback({ libraryItemId: 'book', time: clock.time, playing: true }))
    eventBus.$on('playback-seek', (time) => {
      events.seeks.push(time)
      clock.time = time
    })
    eventBus.$on('play-item', (payload) => events.plays.push(payload))
    const state = Vue.observable({ streamLibraryItem: streaming ? { id: 'book' } : null, streamIsPlaying: streaming })
    const mocks = {
      $axios: {
        $get: (url) => Promise.resolve(url.endsWith('/transcript') ? transcript : epub.slice(0)),
        $patch: () => Promise.resolve()
      },
      $store: { state, getters: { 'libraries/getLibraryEpubsAllowScriptedContent': false, 'user/getUserMediaProgress': () => null } },
      $eventBus: eventBus,
      $strings: Strings
    }
    cy.viewport(1100, 750)
    return cy.mount(EpubReader, { propsData: { libraryItem: { id: 'book', hasTranscript: true, media: {} }, keepProgress: false }, mocks }).then(({ wrapper }) => {
      cy.wrap(wrapper.vm, { timeout: 20000 }).its('readAlongAvailable').should('be.true')
      // The first page is displayed (page turns and locations need epub.js' view manager)
      cy.wrap(wrapper.vm, { timeout: 20000 }).should((vm) => expect(vm.rendition.manager && vm.rendition.currentLocation()?.start).to.exist)
      return cy.wrap({ vm: wrapper.vm, clock, events, state })
    })
  }

  function isVisible(vm, wordIndex) {
    const located = vm.readAlong.wordRange(wordIndex)
    return !!located?.range && vm.readAlong.isVisible(located.entry, located.range)
  }

  it('tokenizes documents like the transcribe helper reads EPUB text', () => {
    const doc = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>T</title><style>p{}</style></head><body><h1>Chapter One</h1><p>It was a <em>bright</em>, cold day<sup>1</sup> in April,<br/>and the clocks<a epub:type="noteref">2</a> were striking.</p><aside epub:type="footnote">Note text</aside></body></html>',
      'application/xhtml+xml'
    )
    expect(tokenizeDocument(doc).map((t) => t.text)).to.deep.equal(['Chapter', 'One', 'It', 'was', 'a', 'bright,', 'cold', 'day', 'in', 'April,', 'and', 'the', 'clocks', 'were', 'striking.'])
  })

  it('highlights the narrated word and sentence in the book', () => {
    mount().then(({ vm, clock }) => {
      const target = words.findIndex((w) => w.w.startsWith('children') || w.w.startsWith('garden'))
      cy.then(() => {
        clock.time = words[target].start + 0.05
      })
      cy.wrap(null, { timeout: 10000 }).should(() => {
        expect(highlighted(WORD_HIGHLIGHT)).to.equal(words[target].w)
        expect(highlighted(SENTENCE_HIGHLIGHT)).to.contain(words[target].w)
        expect(isVisible(vm, target)).to.be.true
      })
    })
  })

  it('skips formatting, note markers and unnarrated captions when matching words', () => {
    mount().then(({ vm }) => {
      cy.wrap(null, { timeout: 10000 }).should(() => {
        const entry = vm.readAlong.sections.get(0)
        expect(entry, 'chapter one mapped').to.exist
        expect(entry.mapped).to.equal(entry.ranges.length) // every narrated word of the chapter was found
        entry.ranges.forEach((range, k) => expect(range.toString()).to.equal(words[entry.firstWord + k].w))
      })
    })
  })

  it('turns pages and chapters to follow the narration', () => {
    mount().then(({ vm, clock }) => {
      const lateInChapterOne = words.filter((w) => w.spine === 0).length - 20
      const inChapterTwo = words.findIndex((w) => w.spine === 1) + 30
      cy.then(() => {
        clock.time = words[lateInChapterOne].start + 0.05
      })
      cy.wrap(null, { timeout: 15000 }).should(() => {
        expect(highlighted(WORD_HIGHLIGHT)).to.equal(words[lateInChapterOne].w)
        expect(isVisible(vm, lateInChapterOne), 'late word visible').to.be.true
      })
      cy.then(() => {
        clock.time = words[inChapterTwo].start + 0.05
      })
      cy.wrap(null, { timeout: 15000 }).should(() => {
        expect(highlighted(WORD_HIGHLIGHT)).to.equal(words[inChapterTwo].w)
        expect(isVisible(vm, inChapterTwo), 'chapter two word visible').to.be.true
      })
    })
  })

  it('seeks the audio when a word is tapped', () => {
    mount().then(({ vm, clock, events }) => {
      cy.wrap(null, { timeout: 10000 }).should(() => expect(highlighted(WORD_HIGHLIGHT)).to.equal(words[0].w))
      cy.then(() => {
        const target = 25
        const { entry, range } = vm.readAlong.wordRange(target)
        const rect = range.getBoundingClientRect()
        const doc = entry.doc
        const element = range.startContainer.parentElement
        element.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }))
        expect(events.seeks).to.deep.equal([words[target].start])
      })
    })
  })

  it('stops following on manual page turns until asked to return', () => {
    mount().then(({ vm, clock }) => {
      cy.wrap(null, { timeout: 10000 }).should(() => expect(highlighted(WORD_HIGHLIGHT)).to.equal(words[0].w))
      cy.then(() => vm.next())
      cy.contains('button', Strings.ButtonReturnToNarration).should('be.visible')
      cy.then(() => {
        clock.time = words[3].start + 0.05 // narration continues on the first page
      })
      cy.wait(600)
      cy.then(() => expect(isVisible(vm, 3), 'reader stays where the user went').to.be.false)
      cy.contains('button', Strings.ButtonReturnToNarration).click()
      cy.wrap(null, { timeout: 10000 }).should(() => expect(isVisible(vm, 3)).to.be.true)
      cy.contains('button', Strings.ButtonReturnToNarration).should('not.exist')
    })
  })

  it('stays in sync at every playback speed the player offers (0.5x to 10x)', () => {
    mount().then(({ vm, clock }) => {
      const starts = words.map((w) => w.start)
      const expectedWord = (time) => {
        let found = -1
        for (let i = 0; i < starts.length && starts[i] <= time + 0.03; i++) found = i
        return found
      }
      const failures = []
      let updates = 0
      const readAlong = vm.readAlong
      const originalUpdate = readAlong.update.bind(readAlong)
      readAlong.update = (time, force) => {
        originalUpdate(time, force)
        updates++
        if (readAlong.activeWord !== expectedWord(time) && failures.length < 20) failures.push(`t=${time.toFixed(3)}: word ${readAlong.activeWord}, expected ${expectedWord(time)}`)
      }
      const rates = allPlaybackRates()
      const lastStart = starts[starts.length - 1]
      const run = async () => {
        for (let r = 0; r < rates.length; r++) {
          const rate = rates[r]
          // Every speed starts somewhere else in the book (a far seek: other page or chapter)
          const startTime = 1 + ((r * 37.3) % (lastStart - 25))
          const startedAt = performance.now()
          clock.time = startTime
          const tick = () => {
            clock.time = startTime + (rate * (performance.now() - startedAt)) / 1000
          }
          const timer = setInterval(tick, 5)
          await new Promise((resolve) => setTimeout(resolve, 400))
          clearInterval(timer)
          await new Promise((resolve) => setTimeout(resolve, 150)) // let the last page turn finish
          const active = readAlong.activeWord
          if (highlighted(WORD_HIGHLIGHT) !== words[active]?.w) failures.push(`rate ${rate}: highlighted "${highlighted(WORD_HIGHLIGHT)}" but narrating "${words[active]?.w}"`)
          else if (!isVisible(vm, active)) failures.push(`rate ${rate}: narrated word ${active} is not on the page`)
        }
      }
      cy.wrap(null, { timeout: 240000 })
        .then({ timeout: 240000 }, () => run())
        .then(() => {
          expect(failures, failures.join('\n')).to.be.empty
          expect(updates).to.be.greaterThan(rates.length * 3)
        })
    })
  })

  it('offers to play the audiobook from the current page', () => {
    mount({ streaming: false }).then(({ vm, events }) => {
      cy.contains('button', Strings.ButtonPlayFromHere).should('be.visible')
      cy.then(() => vm.next())
      cy.wait(500)
      cy.contains('button', Strings.ButtonPlayFromHere).click()
      cy.then(() => {
        expect(events.plays).to.have.length(1)
        const { startTime } = events.plays[0]
        const index = words.findIndex((w) => w.start === startTime)
        expect(index, 'starts at a word').to.be.greaterThan(0) // not the first page any more
        expect(isVisible(vm, index), 'that word is on the page').to.be.true
        expect(isVisible(vm, index - 1), 'and is the first one on it').to.be.false
      })
    })
  })

  it('moves the narration to the page being read when reading ahead of the audio', () => {
    mount().then(({ vm, events }) => {
      cy.wrap(null, { timeout: 10000 }).should(() => expect(highlighted(WORD_HIGHLIGHT)).to.equal(words[0].w))
      cy.then(() => vm.next())
      cy.wait(400)
      cy.then(() => vm.next())
      cy.contains('button', Strings.ButtonReturnToNarration).should('be.visible')
      cy.contains('button', Strings.ButtonPlayFromHere).should('be.visible').click()
      cy.then(() => {
        expect(events.plays, 'the open player is not restarted').to.have.length(0)
        expect(events.seeks).to.have.length(1)
        const index = words.findIndex((w) => w.start === events.seeks[0])
        expect(index, 'seeks to a word').to.be.greaterThan(0)
        expect(isVisible(vm, index), 'that word is on the page').to.be.true
        expect(isVisible(vm, index - 1), 'and is the first one on it').to.be.false
      })
      // Following the narration again
      cy.contains('button', Strings.ButtonReturnToNarration).should('not.exist')
    })
  })
})
