import Vue from 'vue'
import JSZip from 'jszip'
import EpubReader from '@/components/readers/EpubReader.vue'
import ReadAlongPopup from '@/components/player/ReadAlongPopup.vue'
import LoadingSpinner from '@/components/widgets/LoadingSpinner.vue'
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
    if (highlight && highlight.size) return [...highlight][0].toString().replace(/\s+/g, ' ')
  }
  return null
}

/** Text of the words highlighted with narrated word i: `count` words of its sentence, centred on it where the sentence allows */
function wordGroup(words, i, count = 3) {
  const sentence = words.filter((w) => w.segment === words[i].segment)
  const first = words.indexOf(sentence[0])
  const size = Math.min(count, sentence.length)
  const start = Math.min(Math.max(i - Math.floor((size - 1) / 2), first), first + sentence.length - size)
  return words
    .slice(start, start + size)
    .map((w) => w.w)
    .join(' ')
}

describe('<EpubReader /> read along', () => {
  const allChapters = chapters()
  const transcript = buildTranscript(allChapters)
  const words = transcript.segments.flatMap((s, segment) => s.words.map((w) => ({ ...w, spine: s.spine, segment })))
  const group = (i, count) => wordGroup(words, i, count)
  const wordsText = (first, last) =>
    words
      .slice(first, last + 1)
      .map((w) => w.w)
      .join(' ')
  let epub

  before(() => {
    cy.wrap(null).then(() => buildEpub(allChapters).then((buffer) => (epub = buffer)))
  })

  function mount({ streaming = true, playing = streaming, keepProgress = false, progress = null, annotations = [], settings = Vue.observable({ readAlongWords: null }) } = {}) {
    const clock = { time: words[0].start + 0.05 } // narration has started: first word
    const eventBus = new Vue()
    const events = { seeks: [], plays: [] }
    eventBus.$on('player-get-time', (callback) => callback({ libraryItemId: 'book', time: clock.time, playing: true }))
    eventBus.$on('playback-seek', (time) => {
      events.seeks.push(time)
      clock.time = time
    })
    eventBus.$on('play-item', (payload) => events.plays.push(payload))
    const state = Vue.observable({ streamLibraryItem: streaming ? { id: 'book' } : null, streamIsPlaying: playing })
    const saved = [...annotations]
    const patches = []
    const mocks = {
      $axios: {
        $get: (url) => Promise.resolve(url.endsWith('/transcript') ? transcript : epub.slice(0)),
        $patch: (url, payload) => {
          patches.push(payload)
          return Promise.resolve()
        },
        $request: ({ method, data }) => {
          if (method === 'GET') return Promise.resolve({ annotations: [...saved] })
          if (method === 'PUT') saved.push(data)
          return Promise.resolve({ annotation: data })
        }
      },
      $store: { state, getters: { 'libraries/getLibraryEpubsAllowScriptedContent': false, 'user/getUserMediaProgress': () => progress, 'user/getUserSetting': (key) => settings[key] ?? null, 'user/getUserBookmarksForItem': () => [] } },
      $eventBus: eventBus,
      $strings: Strings,
      $getString: (key) => Strings[key],
      $config: { routerBasePath: '/audiobookshelf' },
      $toast: { success: () => {}, error: () => {}, info: () => {} }
    }
    const stubs = { 'player-read-along-popup': ReadAlongPopup, 'widgets-loading-spinner': LoadingSpinner }
    cy.viewport(1100, 750)
    const libraryItem = { id: 'book', hasTranscript: true, updatedAt: 1, media: { duration: words[words.length - 1].end + 5 } }
    return cy.mount(EpubReader, { propsData: { libraryItem, keepProgress }, mocks, stubs }).then(({ wrapper }) => {
      cy.wrap(wrapper.vm, { timeout: 20000 }).its('readAlongAvailable').should('be.true')
      // The first page is displayed (page turns and locations need epub.js' view manager)
      cy.wrap(wrapper.vm, { timeout: 20000 }).should((vm) => expect(vm.rendition.manager && vm.rendition.currentLocation()?.start).to.exist)
      return cy.wrap({ vm: wrapper.vm, clock, events, state, patches, saved })
    })
  }

  /** Dispatch a mouse event at the middle of a word in its section's document */
  function mouseAtWord(vm, wordIndex, type, init = {}) {
    const { entry, range } = vm.readAlong.wordRange(wordIndex)
    const rect = range.getBoundingClientRect()
    const element = range.startContainer.parentElement
    element.dispatchEvent(new entry.doc.defaultView.MouseEvent(type, { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, ...init }))
  }

  function highlightedRanges(name) {
    const texts = []
    for (const iframe of document.querySelectorAll('#viewer iframe')) {
      const highlight = iframe.contentWindow.CSS?.highlights?.get(name)
      if (highlight) for (const range of highlight) texts.push(range.toString().replace(/\s+/g, ' '))
    }
    return texts
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

  it('highlights the narrated words and sentence in the book', () => {
    mount().then(({ vm, clock }) => {
      const target = words.findIndex((w, i) => i > 0 && w.segment === words[i - 1].segment && (w.w.startsWith('children') || w.w.startsWith('garden')))
      cy.then(() => {
        clock.time = words[target].start + 0.05
      })
      cy.wrap(null, { timeout: 10000 }).should(() => {
        // The narrated word with the words before and after it
        expect(highlighted(WORD_HIGHLIGHT)).to.equal(`${words[target - 1].w} ${words[target].w} ${words[target + 1].w}`)
        expect(highlighted(SENTENCE_HIGHLIGHT)).to.contain(words[target].w)
        expect(isVisible(vm, target)).to.be.true
      })
    })
  })

  it('highlights 1, 3 or 5 words as set, within the sentence', () => {
    const settings = Vue.observable({ readAlongWords: 1 })
    mount({ settings }).then(({ clock }) => {
      const sentenceStart = words.findIndex((w, i) => i > 0 && w.segment !== words[i - 1].segment && w.spine === 0)
      const middle = sentenceStart + 4
      cy.then(() => {
        clock.time = words[middle].start + 0.05
      })
      cy.wrap(null, { timeout: 10000 }).should(() => expect(highlighted(WORD_HIGHLIGHT)).to.equal(words[middle].w))
      cy.then(() => (settings.readAlongWords = 5))
      cy.wrap(null, { timeout: 10000 }).should(() => expect(highlighted(WORD_HIGHLIGHT)).to.equal(wordsText(middle - 2, middle + 2)))
      cy.then(() => (settings.readAlongWords = 3))
      cy.wrap(null, { timeout: 10000 }).should(() => expect(highlighted(WORD_HIGHLIGHT)).to.equal(group(middle)))
      // The first word of a sentence: it and the next two
      cy.then(() => {
        clock.time = words[sentenceStart].start + 0.05
      })
      cy.wrap(null, { timeout: 10000 }).should(() => expect(highlighted(WORD_HIGHLIGHT)).to.equal(wordsText(sentenceStart, sentenceStart + 2)))
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
        expect(highlighted(WORD_HIGHLIGHT)).to.equal(group(lateInChapterOne))
        expect(isVisible(vm, lateInChapterOne), 'late word visible').to.be.true
      })
      cy.then(() => {
        clock.time = words[inChapterTwo].start + 0.05
      })
      cy.wrap(null, { timeout: 15000 }).should(() => {
        expect(highlighted(WORD_HIGHLIGHT)).to.equal(group(inChapterTwo))
        expect(isVisible(vm, inChapterTwo), 'chapter two word visible').to.be.true
      })
    })
  })

  it('seeks the audio when a word is tapped', () => {
    mount().then(({ vm, clock, events }) => {
      cy.wrap(null, { timeout: 10000 }).should(() => expect(highlighted(WORD_HIGHLIGHT)).to.equal(group(0)))
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
      cy.wrap(null, { timeout: 10000 }).should(() => expect(highlighted(WORD_HIGHLIGHT)).to.equal(group(0)))
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
          if (highlighted(WORD_HIGHLIGHT) !== group(active)) failures.push(`rate ${rate}: highlighted "${highlighted(WORD_HIGHLIGHT)}" but narrating "${words[active]?.w}" (expected "${group(active)}")`)
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
      cy.wrap(null, { timeout: 10000 }).should(() => expect(highlighted(WORD_HIGHLIGHT)).to.equal(group(0)))
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
  it('draws highlights saved before and opens one when a highlighted word is right-clicked', () => {
    const annotation = { id: 'annotation-1', start: words[10].start, end: words[12].start, text: wordsText(10, 12), color: 'blue', note: 'Spring', createdAt: 1, updatedAt: 1 }
    mount({ annotations: [annotation] }).then(({ vm }) => {
      cy.wrap(null, { timeout: 10000 }).should(() => expect(highlightedRanges('abs-readalong-annotation-blue')).to.deep.equal([wordsText(10, 12)]))
      cy.then(() => mouseAtWord(vm, 11, 'contextmenu'))
      cy.get('.readalong-popup').should('contain.text', 'Spring').find(`button[aria-label="${Strings.ButtonDeleteHighlight}"]`).should('exist')
    })
  })

  it('highlights words selected in the book', () => {
    mount().then(({ vm, saved }) => {
      cy.wrap(null, { timeout: 10000 }).should(() => expect(highlighted(WORD_HIGHLIGHT)).to.equal(group(0)))
      cy.then(() => {
        const first = vm.readAlong.wordRange(20)
        const last = vm.readAlong.wordRange(23)
        first.entry.doc.getSelection().setBaseAndExtent(first.range.startContainer, first.range.startOffset, last.range.endContainer, last.range.endOffset)
        mouseAtWord(vm, 23, 'mouseup', { button: 0 })
      })
      cy.get('.readalong-popup').should('contain.text', wordsText(20, 23))
      cy.get(`.readalong-popup button[aria-label="${Strings.ButtonHighlight}: ${Strings.LabelColorYellow}"]`).click()
      cy.then(() => expect(saved[0]).to.include({ start: words[20].start, end: words[23].start, text: wordsText(20, 23), color: 'yellow' }))
      cy.wrap(null).should(() => expect(highlightedRanges('abs-readalong-annotation-yellow')).to.deep.equal([wordsText(20, 23)]))
    })
  })

  it('moves the listening position along when reading on with the audio paused', () => {
    mount({ playing: false, keepProgress: true }).then(({ vm, events, patches }) => {
      cy.wrap(null, { timeout: 10000 }).should(() => expect(highlighted(WORD_HIGHLIGHT)).to.equal(group(0)))
      cy.then(() => vm.next())
      cy.wrap(null, { timeout: 10000 }).should(() => expect(patches.filter((p) => p.currentTime !== undefined)).to.have.length(1))
      cy.then(() => {
        const { currentTime, ebookLocation, duration } = patches.find((p) => p.currentTime !== undefined)
        const index = words.findIndex((w) => w.start === currentTime)
        expect(index, 'the first word of the page').to.be.greaterThan(0)
        expect(isVisible(vm, index)).to.be.true
        expect(isVisible(vm, index - 1)).to.be.false
        expect(ebookLocation).to.match(/^epubcfi/)
        expect(duration).to.be.greaterThan(currentTime)
        // The paused player continues from the page
        expect(events.seeks).to.deep.equal([currentTime])
      })
    })
  })

  it('does not move the listening position while the audio plays', () => {
    mount({ playing: true, keepProgress: true }).then(({ vm, patches }) => {
      cy.wrap(null, { timeout: 10000 }).should(() => expect(highlighted(WORD_HIGHLIGHT)).to.equal(group(0)))
      cy.then(() => vm.next())
      cy.wait(800)
      cy.then(() => expect(patches.length, 'the page is saved').to.be.greaterThan(0))
      cy.then(() => expect(patches.filter((p) => p.currentTime !== undefined)).to.have.length(0))
    })
  })

  it('opens where the user stopped listening and can go back to where they were reading', () => {
    const listened = 400
    mount({ streaming: false, keepProgress: true, progress: { currentTime: words[listened].start + 0.1, ebookLocation: null } }).then(({ vm, patches }) => {
      cy.contains(Strings.MessageOpenedWhereYouStoppedListening, { timeout: 10000 }).should('be.visible')
      cy.wrap(null, { timeout: 10000 }).should(() => expect(isVisible(vm, listened)).to.be.true)
      cy.wrap(null).should(() => expect(highlighted(WORD_HIGHLIGHT)).to.contain(words[listened].w))
      // Turning to that position is not reading on: the listening position stays exactly where it was
      cy.wait(500)
      cy.then(() => expect(patches.filter((p) => p.currentTime !== undefined)).to.have.length(0))
      cy.contains('button', Strings.ButtonBackToReadingPosition).click()
      cy.wrap(null, { timeout: 10000 }).should(() => expect(isVisible(vm, 0)).to.be.true)
      cy.contains(Strings.MessageOpenedWhereYouStoppedListening).should('not.exist')
    })
  })

  it('stays on the saved page when the listening position is on it', () => {
    mount({ streaming: false, keepProgress: true, progress: { currentTime: words[2].start, ebookLocation: null } }).then(({ vm }) => {
      cy.wait(1000)
      cy.contains(Strings.MessageOpenedWhereYouStoppedListening).should('not.exist')
      cy.then(() => expect(isVisible(vm, 0)).to.be.true)
    })
  })

  it('turns to a highlight chosen in the list without changing the narration', () => {
    mount({ playing: true }).then(({ vm, clock, events }) => {
      cy.wrap(null, { timeout: 10000 }).should(() => expect(highlighted(WORD_HIGHLIGHT)).to.equal(group(0)))
      cy.then(() => vm.goToAnnotation({ start: words[900].start, end: words[902].start }))
      cy.wrap(null, { timeout: 10000 }).should(() => expect(isVisible(vm, 900)).to.be.true)
      cy.then(() => {
        expect(events.seeks).to.have.length(0)
        expect(clock.time).to.be.lessThan(words[1].start)
      })
      cy.contains('button', Strings.ButtonReturnToNarration).should('be.visible')
    })
  })
})
