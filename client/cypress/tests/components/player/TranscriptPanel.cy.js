import Vue from 'vue'
import TranscriptPanel from '@/components/player/TranscriptPanel.vue'
import Tooltip from '@/components/ui/Tooltip.vue'
import ToggleBtns from '@/components/ui/ToggleBtns.vue'
import LoadingSpinner from '@/components/widgets/LoadingSpinner.vue'
import ReadAlongPopup from '@/components/player/ReadAlongPopup.vue'
import Strings from '@/strings/en-us.json'
import { allPlaybackRates } from '../../../support/playbackRates'

const WORD_DURATION = 0.36 // ~150k words in 15 hours
const STUBS = { 'ui-tooltip': Tooltip, 'ui-toggle-btns': ToggleBtns, 'widgets-loading-spinner': LoadingSpinner, 'player-read-along-popup': ReadAlongPopup, 'modals-annotations-modal': { render: (h) => h('div') } }

/** $axios.$request of the annotation API: keeps the saved annotations */
function annotationRequest(annotations = []) {
  const saved = [...annotations]
  const request = cy.stub().callsFake(({ method, url, data }) => {
    if (method === 'GET') return Promise.resolve({ annotations: [...saved] })
    if (method === 'PUT') {
      const index = saved.findIndex((a) => a.id === data.id)
      if (index >= 0) saved[index] = data
      else saved.push(data)
      return Promise.resolve({ annotation: data })
    }
    if (method === 'DELETE') {
      const id = url.split('/').pop()
      saved.splice(
        saved.findIndex((a) => a.id === id),
        1
      )
      return Promise.resolve()
    }
    return Promise.reject(new Error(`Unexpected ${method} ${url}`))
  })
  request.saved = saved
  return request
}

function baseMocks(settings) {
  return {
    $store: {
      getters: { 'user/getUserSetting': (key) => settings[key] ?? null, 'user/getUserBookmarksForItem': () => [] },
      dispatch: cy.stub().callsFake((action, payload) => {
        if (action === 'user/updateUserSettings') Object.assign(settings, payload)
      }),
      commit: cy.stub()
    },
    $strings: Strings,
    $getString: (key, subs = []) => Strings[key].replace(/\{(\d+)\}/g, (match, n) => subs[n]),
    $config: { routerBasePath: '/audiobookshelf' },
    $toast: { success: cy.stub(), error: cy.stub(), info: cy.stub() }
  }
}
const WORDS_PER_SEGMENT = 14
const LOOKAHEAD = 0.03

/** A 15 hour book: 150k words, 2 files, a chapter every ~30 minutes, a unique marker word every 1000 words */
function makeBook(libraryItemId, numWords = 150000) {
  const vocabulary = ['the', 'raven', 'once', 'upon', 'a', 'midnight', 'dreary', 'while', 'I', 'pondered,', 'weak', 'and', 'weary.', 'nevermore', 'quoth']
  const segments = []
  for (let i = 0; i < numWords; i += WORDS_PER_SEGMENT) {
    const words = []
    for (let j = i; j < Math.min(numWords, i + WORDS_PER_SEGMENT); j++) {
      const w = j % 1000 === 0 ? `marker${j / 1000}x` : vocabulary[(j * 7) % vocabulary.length]
      words.push({ w, start: wordStart(j), end: Math.round((j * WORD_DURATION + WORD_DURATION * 0.85) * 1000) / 1000 })
    }
    segments.push({ start: words[0].start, end: words[words.length - 1].end, text: words.map((w) => w.w).join(' '), words })
  }
  const duration = Math.ceil(numWords * WORD_DURATION)
  const half = Math.round(duration / 2)
  const tracks = [
    { ino: 'f1', startOffset: 0, duration: half, contentUrl: `/api/items/${libraryItemId}/file/f1`, metadata: { filename: '01.mp3' } },
    { ino: 'f2', startOffset: half, duration: duration - half, contentUrl: `/api/items/${libraryItemId}/file/f2`, metadata: { filename: '02.mp3' } }
  ]
  const chapters = []
  for (let start = 0, id = 0; start < duration; start += 1800, id++) chapters.push({ id, start, end: Math.min(duration, start + 1800), title: `Chapter ${id + 1}` })
  const transcript = {
    version: 1,
    libraryItemId,
    model: 'test',
    language: 'en',
    durationSec: duration,
    source: 'whisper',
    files: tracks.map((t) => ({ ino: t.ino, filename: t.metadata.filename, startOffset: t.startOffset, duration: t.duration })),
    segments
  }
  return { transcript, chapters, libraryItem: { id: libraryItemId, hasTranscript: true, updatedAt: 1, media: { tracks, chapters } } }
}

function wordStart(j) {
  return Math.round(j * WORD_DURATION * 1000) / 1000
}

/** Independent of the code under test: closed form, corrected with exact comparisons at word boundaries */
function expectedWord(time, numWords) {
  const target = time + LOOKAHEAD
  if (target < 0) return -1
  let j = Math.min(numWords - 1, Math.floor(target / WORD_DURATION))
  while (j + 1 < numWords && wordStart(j + 1) <= target) j++
  while (j >= 0 && wordStart(j) > target) j--
  return j
}

function isInside(el, container) {
  const r = el.getBoundingClientRect()
  const c = container.getBoundingClientRect()
  return r.top >= c.top - 1 && r.bottom <= c.bottom + 1
}

const books = {}
function getBook(id) {
  if (!books[id]) books[id] = makeBook(id)
  return books[id]
}

function mountPanel({ libraryItemId = 'book-1', time = 0, playing = true, libraryItem = null, readAlongWords = null } = {}) {
  const book = getBook(libraryItemId)
  const clock = { time, getCurrentTime: null }
  clock.getCurrentTime = () => (typeof clock.time === 'function' ? clock.time() : clock.time)
  const axiosGet = cy.stub().callsFake((url) => {
    const id = url.split('/')[3]
    return Promise.resolve(getBook(id).transcript)
  })
  const settings = Vue.observable({ transcriptFontScale: 1, readAlongWords })
  const mocks = { ...baseMocks(settings), $axios: { $get: axiosGet, $request: annotationRequest() } }
  const stubs = STUBS
  const propsData = { libraryItem: libraryItem || book.libraryItem, chapters: book.chapters, getCurrentTime: () => clock.getCurrentTime(), playing }
  return cy.mount(TranscriptPanel, { propsData, mocks, stubs }).then(({ wrapper }) => {
    return cy
      .get('#transcript-panel [data-wi]', { timeout: 20000 })
      .should('exist')
      .then(() => ({ wrapper, vm: wrapper.vm, clock, book, axiosGet }))
  })
}

describe('<TranscriptPanel />', () => {
  beforeEach(() => {
    cy.viewport(1280, 900)
  })

  it('renders a virtualized window of a 150k word transcript', () => {
    mountPanel({ time: 0 }).then(({ vm }) => {
      expect(vm.index.numWords).to.equal(150000)
      cy.get('#transcript-panel [data-wi]').its('length').should('be.lessThan', 1500)
      cy.get('#transcript-panel h3').first().should('have.text', 'Chapter 1')
      cy.get('[data-wi="0"]').should('have.class', 'transcript-word-active')
      cy.get('[data-seg="0"]').should('have.class', 'transcript-segment-active')
    })
  })

  it('highlights the narrated word with the words around it in its sentence (1, 3 or 5 words)', () => {
    // Word 20 is the 7th of the second segment (words 14 to 27)
    mountPanel({ time: wordStart(20) + 0.05, playing: false }).then(({ vm, clock, book }) => {
      const allWords = book.transcript.segments.flatMap((s) => s.words.map((w) => w.w))
      const text = (first, last) => allWords.slice(first, last + 1).join(' ')
      const highlightedText = () => {
        if (!vm.highlightApi) return [...vm.$refs.window.querySelectorAll('.transcript-word-group')].map((el) => el.textContent).join(' ')
        const highlight = CSS.highlights.get('abs-transcript-words')
        return highlight && highlight.size ? [...highlight][0].toString() : ''
      }
      // The number of words is set in the display menu
      const count = (n) => cy.get('.transcript-display-menu').contains('p', Strings.LabelReadAlongHighlight).parent().contains('button', String(n))
      expect(vm.highlightApi, 'CSS Custom Highlight API').to.be.true
      cy.get('.transcript-word-active').should('have.attr', 'data-wi', '20')
      cy.wrap(null).should(() => expect(highlightedText()).to.equal(text(19, 21)))
      cy.get(`button[aria-label="${Strings.LabelTranscriptDisplay}"]`).click()
      count(3).should('have.class', 'selected')
      count(5).click()
      cy.wrap(null).should(() => expect(highlightedText()).to.equal(text(18, 22)))
      count(1).click()
      cy.wrap(null).should(() => expect(highlightedText()).to.equal(text(20, 20)))
      count(3).click()
      cy.wrap(null).should(() => expect(highlightedText()).to.equal(text(19, 21)))
      cy.get('.transcript-word-active').should('have.length', 1)

      // At the start and end of a sentence the highlight stays in the sentence
      cy.then(() => (clock.time = wordStart(14) + 0.05))
      cy.wrap(null).should(() => expect(highlightedText()).to.equal(text(14, 16)))
      cy.then(() => (clock.time = wordStart(27) + 0.05))
      cy.wrap(null).should(() => expect(highlightedText()).to.equal(text(25, 27)))

      // Browsers without the highlight API: the words are highlighted one by one
      cy.then(() => {
        CSS.highlights.delete('abs-transcript-words')
        vm.highlightApi = false
        vm.applyHighlight()
      })
      cy.get('.transcript-word-group').should('have.length', 3)
      cy.wrap(null).should(() => expect(highlightedText()).to.equal(text(25, 27)))
    })
  })

  it('stays in sync at every playback speed the player offers (0.5x to 10x)', () => {
    mountPanel().then(({ vm, clock }) => {
      const numWords = vm.index.numWords
      const scroller = vm.$refs.scroller
      const rates = allPlaybackRates()
      const failures = []
      let ticks = 0
      let maxRendered = 0
      let maxTickMs = 0

      // Check the highlight after every tick of the panel's own requestAnimationFrame loop
      const originalTick = vm.tick.bind(vm)
      vm.tick = (force) => {
        const t0 = performance.now()
        originalTick(force)
        maxTickMs = Math.max(maxTickMs, performance.now() - t0)
        ticks++
        const expected = expectedWord(vm.lastTime, numWords)
        if (vm.activeWord !== expected && failures.length < 20) failures.push(`t=${vm.lastTime.toFixed(3)} word ${vm.activeWord} expected ${expected}`)
      }

      const run = async () => {
        for (let r = 0; r < rates.length; r++) {
          const rate = rates[r]
          // Each speed starts somewhere else in the book (a far seek), then plays for a moment
          const startTime = (r * 2797) % 50000
          const startedAt = performance.now()
          clock.time = () => startTime + (rate * (performance.now() - startedAt)) / 1000
          await new Promise((resolve) => setTimeout(resolve, 300))

          maxRendered = Math.max(maxRendered, vm.$refs.window.querySelectorAll('[data-wi]').length)
          const activeEl = vm.$refs.window.querySelector('.transcript-word-active')
          if (!activeEl) failures.push(`rate ${rate}: no highlighted word`)
          else if (Number(activeEl.dataset.wi) !== vm.activeWord) failures.push(`rate ${rate}: highlighted element ${activeEl.dataset.wi} != active word ${vm.activeWord}`)
          else if (!isInside(activeEl, scroller)) failures.push(`rate ${rate}: highlighted word is not visible`)
          if (vm.$refs.window.querySelectorAll('.transcript-word-active').length > 1) failures.push(`rate ${rate}: more than one word highlighted`)
        }
      }
      cy.wrap(null, { timeout: 180000 })
        .then({ timeout: 180000 }, () => run())
        .then(() => {
          cy.log(`ticks: ${ticks}, max rendered words: ${maxRendered}, slowest tick: ${maxTickMs.toFixed(2)} ms`)
          expect(failures, failures.join('\n')).to.be.empty
          expect(ticks).to.be.greaterThan(rates.length * 5)
          expect(maxRendered).to.be.lessThan(1500)
        })
    })
  })

  it('follows seeks to far positions and chapter jumps', () => {
    mountPanel({ time: 10 }).then(({ vm, clock, book }) => {
      const scroller = vm.$refs.scroller
      const targets = [53000, 120, book.chapters[12].start, 27000.5, 0, book.chapters[29].start]
      cy.wrap(targets).each((target) => {
        cy.then(() => {
          clock.time = target
        })
        cy.get('.transcript-word-active').should(($el) => {
          expect(Number($el[0].dataset.wi)).to.equal(expectedWord(target, vm.index.numWords))
          expect(isInside($el[0], scroller), 'visible').to.be.true
        })
      })
    })
  })

  it('works while paused (seeking without playback)', () => {
    mountPanel({ time: 500, playing: false }).then(({ vm, clock }) => {
      cy.get('.transcript-word-active').should('have.attr', 'data-wi', String(expectedWord(500, vm.index.numWords)))
      cy.then(() => {
        clock.time = 9000
      })
      cy.get('.transcript-word-active').should('have.attr', 'data-wi', String(expectedWord(9000, vm.index.numWords)))
    })
  })

  it('seeks to a word when it is clicked', () => {
    mountPanel({ time: 100, playing: false }).then(({ wrapper, vm }) => {
      cy.get('[data-wi="290"]').click()
      cy.then(() => {
        const emitted = wrapper.emitted('seek')
        expect(emitted).to.have.length(1)
        expect(emitted[0][0]).to.equal(vm.index.wordStarts[290])
      })
    })
  })

  it('pauses auto-scroll on manual scroll and returns to the current position', () => {
    mountPanel({ time: 3000 }).then(({ vm, clock }) => {
      const scroller = vm.$refs.scroller
      cy.get('.transcript-word-active').should('exist')
      cy.get('.transcript-scroller').trigger('wheel', { deltaY: 2000 })
      cy.then(() => {
        scroller.scrollTop = 0
      })
      cy.contains('button', Strings.ButtonReturnToCurrentPosition).should('be.visible')
      // Playback continues but the view stays where the user scrolled
      cy.then(() => {
        clock.time = 3100
      })
      cy.wait(300)
      cy.then(() => expect(scroller.scrollTop).to.be.lessThan(50))
      cy.contains('button', Strings.ButtonReturnToCurrentPosition).click()
      cy.get('.transcript-word-active').should(($el) => {
        expect(Number($el[0].dataset.wi)).to.equal(expectedWord(3100, vm.index.numWords))
        expect(isInside($el[0], scroller)).to.be.true
      })
      cy.contains('button', Strings.ButtonReturnToCurrentPosition).should('not.exist')
    })
  })

  it('searches the transcript and jumps to results', () => {
    mountPanel({ time: 0, playing: false }).then(({ vm }) => {
      cy.get('button[aria-label="Search"]').click()
      cy.get('input[type="search"]').type('marker123x')
      cy.contains('1 of 1').should('exist')
      cy.get('.transcript-search-hit')
        .should('contain.text', 'marker123x')
        .and(($el) => {
          expect(isInside($el[0], vm.$refs.scroller)).to.be.true
        })
      cy.contains('button', Strings.ButtonReturnToCurrentPosition).should('be.visible')
      cy.get('input[type="search"]').clear().type('nonexistentword')
      cy.contains(Strings.MessageNoResults).should('exist')
    })
  })

  it('changes the font size and keeps the current word in view', () => {
    mountPanel({ time: 20000, playing: false }).then(({ vm }) => {
      cy.get(`button[aria-label="${Strings.LabelTranscriptDisplay}"]`).click()
      cy.get('button[aria-label="Font scale +"]').click().click().click()
      cy.get('.transcript-word-active').should(($el) => {
        expect(isInside($el[0], vm.$refs.scroller)).to.be.true
        expect(parseFloat(getComputedStyle($el[0]).fontSize)).to.be.greaterThan(20)
      })
    })
  })

  it('warns when the audio files changed since the transcript was made', () => {
    const book = getBook('book-1')
    const changed = { ...book.libraryItem, media: { ...book.libraryItem.media, tracks: [{ ...book.libraryItem.media.tracks[0], duration: 1234 }, book.libraryItem.media.tracks[1]] } }
    mountPanel({ libraryItem: changed }).then(() => {
      cy.contains(Strings.MessageTranscriptAudioMismatch).should('be.visible')
    })
  })

  it('loads the new transcript when switching to another book', () => {
    mountPanel({ time: 100 }).then(({ wrapper, axiosGet, clock }) => {
      cy.then(() => {
        clock.time = 5
        return wrapper.setProps({ libraryItem: getBook('book-2').libraryItem, chapters: getBook('book-2').chapters })
      })
      cy.then(() => expect(axiosGet).to.have.been.calledWith('/api/items/book-2/transcript'))
      cy.get('.transcript-word-active').should('have.attr', 'data-wi', String(expectedWord(5, 150000)))
    })
  })

  describe('ebook transcripts', () => {
    const words = (text, start) => text.split(' ').map((w, i) => ({ w, start: Math.round((start + i * 0.4) * 1000) / 1000, end: Math.round((start + i * 0.4 + 0.3) * 1000) / 1000 }))
    const segment = (text, start, flags = {}) => {
      const ws = words(text, start)
      return { start, end: ws[ws.length - 1].end, text, words: ws, ...flags }
    }
    const transcript = {
      version: 1,
      libraryItemId: 'ebook-book',
      source: 'ebook',
      files: [{ ino: 'f1', startOffset: 0, duration: 100 }],
      segments: [
        segment('The Selfish Giant.', 10, { heading: true, paragraph: true, spine: 2 }),
        segment('Every afternoon, as they were coming from school, the children used to go and play in the Giant’s garden.', 12, { paragraph: true, spine: 2 }),
        segment('It was a large lovely garden, with soft green grass.', 20, { spine: 2 }),
        segment('“How happy we are here!” they cried to each other.', 30, { paragraph: true, spine: 2 })
      ]
    }
    // Word indexes: heading 0-2, first paragraph 3-21 and 22-31 ("It was a large lovely garden, ..."), last paragraph 32-41
    const libraryItem = { id: 'ebook-book', hasTranscript: true, updatedAt: 1, media: { ebookFormat: 'epub', metadata: { title: 'The Happy Prince', authorName: 'Oscar Wilde' }, tracks: [{ ino: 'f1', startOffset: 0, duration: 100 }] } }
    const chapters = [{ id: 0, start: 0, end: 100, title: 'Chapter 1' }]

    function mountEbookPanel({ settings = {}, request = annotationRequest(), time = 21 } = {}) {
      const observableSettings = Vue.observable({ transcriptLayout: 'book', transcriptFont: '', readAlongWords: 3, ...settings })
      const axios = { $get: cy.stub().callsFake((url) => (url.includes('expanded') ? Promise.resolve({ ...libraryItem, expanded: true }) : Promise.resolve(transcript))), $request: request }
      const mocks = { ...baseMocks(observableSettings), $axios: axios }
      return cy.mount(TranscriptPanel, { propsData: { libraryItem, chapters, getCurrentTime: () => time, playing: false }, mocks, stubs: STUBS }).then(({ wrapper }) => {
        return cy
          .get('#transcript-panel [data-wi]')
          .should('exist')
          .then(() => ({ wrapper, vm: wrapper.vm, mocks, settings: observableSettings, request }))
      })
    }
    const highlightText = (name) => {
      const highlight = CSS.highlights.get(name)
      return highlight ? [...highlight].map((range) => range.toString().trim()) : []
    }

    beforeEach(() => {
      cy.intercept('GET', '**/dictionary/wordnet-3.1-v1/manifest.json', { version: 'wordnet-3.1-v1', shards: ['ga'] })
      cy.intercept('GET', '**/dictionary/wordnet-3.1-v1/ga.json', { garden: { d: [['n', 'a plot of ground where plants are cultivated', 'the garden was full of flowers']] } })
    })

    it('lays them out like the book: headings and paragraphs, no chapter markers', () => {
      mountEbookPanel().then(({ vm }) => {
        cy.get('#transcript-panel .transcript-book-heading').should('have.text', 'The Selfish Giant. ')
        cy.get('#transcript-panel h3').should('not.exist') // no duplicate "Chapter 1" marker
        cy.get('#transcript-panel .transcript-paragraph').should('have.length', 3)
        // The sentences of a paragraph flow together; the first paragraph after the heading is not indented
        cy.get('#transcript-panel .transcript-paragraph').eq(1).should('have.class', 'transcript-no-indent').find('.transcript-sentence').should('have.length', 2)
        cy.get('#transcript-panel .transcript-paragraph').eq(2).should('not.have.class', 'transcript-no-indent').and('have.css', 'text-indent').and('not.equal', '0px')
        cy.get('#transcript-panel .transcript-word-active').should('have.text', 'a') // "a" starts at 20.8 s, "large" at 21.2 s
        cy.get('#transcript-panel .transcript-sentence.transcript-segment-active').should('contain.text', 'It was a large lovely garden')
        // Serif unless another font is chosen
        cy.get('.transcript-book').should(($el) => expect($el[0].style.fontFamily).to.equal('serif'))
        cy.then(() => expect(vm.index.rows.map((row) => row.segments)).to.deep.equal([[0], [1, 2], [3]]))
      })
    })

    it('switches between the book layout and a sentence per line, and changes the font', () => {
      mountEbookPanel().then(({ settings }) => {
        cy.get(`button[aria-label="${Strings.LabelTranscriptDisplay}"]`).click()
        cy.get('.transcript-display-menu').contains('button', Strings.LabelTranscriptLayoutLines).click()
        cy.then(() => expect(settings.transcriptLayout).to.equal('lines'))
        cy.get('#transcript-panel .transcript-segment-heading').should('have.text', 'The Selfish Giant. ')
        cy.get('#transcript-panel .transcript-row-paragraph').should('have.length', 3)
        cy.get('#transcript-panel .transcript-paragraph').should('not.exist')
        cy.get('#transcript-panel .transcript-word-active').should('have.text', 'a')
        cy.get('[data-wi="0"]')
          .closest('[style*="translateY"]')
          .should(($el) => expect($el[0].style.fontFamily).to.equal(''))

        cy.get('.transcript-display-menu').contains('button', 'Lexend').click()
        cy.then(() => expect(settings.transcriptFont).to.equal('lexend'))
        cy.get('[data-wi="0"]')
          .closest('[style*="translateY"]')
          .should(($el) => expect($el[0].style.fontFamily).to.contain('Lexend'))
        cy.get('.transcript-display-menu').contains('button', Strings.LabelTranscriptLayoutBook).click()
        cy.get('#transcript-panel .transcript-paragraph').should('have.length', 3)
      })
    })

    it('shows the definition of a right-clicked word, highlights it and adds a note', () => {
      mountEbookPanel().then(({ vm, request }) => {
        // "garden." ends the first sentence of the paragraph (word 21)
        cy.get('[data-wi="21"]').should('have.text', 'garden.').rightclick()
        cy.get('.readalong-popup').should('contain.text', 'a plot of ground where plants are cultivated').and('contain.text', 'garden')
        cy.get(`.readalong-popup button[aria-label="${Strings.ButtonHighlight}: ${Strings.LabelColorYellow}"]`).click()
        cy.then(() => {
          const put = request.getCalls().find((call) => call.args[0].method === 'PUT')
          expect(put.args[0].url).to.match(/^\/api\/me\/item\/ebook-book\/annotations\//)
          expect(put.args[0].data).to.include({ start: vm.index.wordStarts[21], end: vm.index.wordStarts[21], text: 'garden.', color: 'yellow', note: null })
        })
        cy.wrap(null).should(() => expect(highlightText('abs-transcript-annotation-yellow')).to.deep.equal(['garden.']))

        // A note: marked after the highlight
        cy.get(`.readalong-popup button[aria-label="${Strings.ButtonNote}"]`).click()
        cy.get('.readalong-popup textarea').type('Where the children play')
        cy.get('.readalong-popup').contains('button', Strings.ButtonSave).click()
        cy.get('.transcript-note-marker').should('have.length', 1)
        cy.then(() => expect(request.saved[0]).to.include({ note: 'Where the children play', color: 'yellow' }))
        cy.get('.readalong-popup button[aria-label="Close"]').click()
        cy.get('.readalong-popup').should('not.exist')

        // The note marker opens the highlight again: change its colour, then delete it
        cy.get('.transcript-note-marker').click()
        cy.get('.readalong-popup').should('contain.text', 'Where the children play')
        cy.get(`.readalong-popup button[aria-label="${Strings.ButtonHighlight}: ${Strings.LabelColorPink}"]`).click()
        cy.wrap(null).should(() => {
          expect(highlightText('abs-transcript-annotation-pink')).to.deep.equal(['garden.'])
          expect(highlightText('abs-transcript-annotation-yellow')).to.deep.equal([])
        })
        cy.get(`.readalong-popup button[aria-label="${Strings.ButtonDeleteHighlight}"]`).click()
        cy.get('.readalong-popup').should('not.exist')
        cy.get('.transcript-note-marker').should('not.exist')
        cy.wrap(null).should(() => expect(highlightText('abs-transcript-annotation-pink')).to.deep.equal([]))
        cy.then(() => expect(request.saved).to.have.length(0))
      })
    })

    it('highlights selected text and plays from it', () => {
      mountEbookPanel().then(({ wrapper, vm, request }) => {
        // Select "a large lovely garden," with the mouse
        cy.then(() => {
          const from = vm.$refs.window.querySelector('[data-wi="24"]').firstChild
          const to = vm.$refs.window.querySelector('[data-wi="27"]').firstChild
          window.getSelection().setBaseAndExtent(from, 0, to, to.length)
        })
        cy.get('[data-wi="27"]').trigger('mouseup', { button: 0 })
        cy.get('.readalong-popup').should('contain.text', '“a large lovely garden,”')
        cy.get(`.readalong-popup button[aria-label="${Strings.ButtonHighlight}: ${Strings.LabelColorBlue}"]`).click()
        cy.then(() => expect(request.saved[0]).to.include({ text: 'a large lovely garden,', color: 'blue', start: vm.index.wordStarts[24], end: vm.index.wordStarts[27] }))
        cy.wrap(null).should(() => expect(highlightText('abs-transcript-annotation-blue')).to.deep.equal(['a large lovely garden,']))
        cy.get(`.readalong-popup button[aria-label="${Strings.ButtonPlayFromHere}"]`).click()
        cy.then(() => {
          expect(wrapper.emitted('seek')[0][0]).to.equal(vm.index.wordStarts[24])
          expect(wrapper.emitted('play')).to.have.length(1)
        })
        cy.get('.readalong-popup').should('not.exist')
      })
    })

    it('shows highlights saved before, from the server', () => {
      const saved = [{ id: 'annotation-1', start: 30, end: 31.2, text: '“How happy we are', color: 'orange', note: 'Joy', createdAt: 1, updatedAt: 1 }]
      mountEbookPanel({ request: annotationRequest(saved) }).then(() => {
        cy.wrap(null).should(() => expect(highlightText('abs-transcript-annotation-orange')).to.deep.equal(['“How happy we are']))
        cy.get('.transcript-note-marker').should('have.length', 1)
        // Right-clicking a highlighted word opens the highlight
        cy.get('[data-wi="33"]').should('have.text', 'happy').rightclick()
        cy.get('.readalong-popup').should('contain.text', 'Joy').find(`button[aria-label="${Strings.ButtonDeleteHighlight}"]`).should('exist')
      })
    })

    it('opens the book in the reader', () => {
      mountEbookPanel().then(({ mocks }) => {
        cy.get(`button[aria-label="${Strings.ButtonOpenInBook}"]`).click()
        cy.then(() => {
          expect(mocks.$axios.$get).to.have.been.calledWith('/api/items/ebook-book?expanded=1')
          expect(mocks.$store.commit).to.have.been.calledWith('showEReader', { libraryItem: { ...libraryItem, expanded: true }, keepProgress: true })
        })
      })
    })
  })

  it('shows a message when the transcript is missing', () => {
    const mocks = { ...baseMocks({}), $axios: { $get: cy.stub().rejects({ response: { status: 404 } }), $request: annotationRequest() } }
    cy.mount(TranscriptPanel, { propsData: { libraryItem: { id: 'x', media: { tracks: [] } }, getCurrentTime: () => 0 }, mocks, stubs: STUBS })
    cy.contains(Strings.MessageTranscriptNotFound).should('be.visible')
  })
})
