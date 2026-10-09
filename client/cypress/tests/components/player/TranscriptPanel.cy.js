import TranscriptPanel from '@/components/player/TranscriptPanel.vue'
import Tooltip from '@/components/ui/Tooltip.vue'
import LoadingSpinner from '@/components/widgets/LoadingSpinner.vue'
import Strings from '@/strings/en-us.json'
import { allPlaybackRates } from '../../../support/playbackRates'

const WORD_DURATION = 0.36 // ~150k words in 15 hours
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

function mountPanel({ libraryItemId = 'book-1', time = 0, playing = true, libraryItem = null } = {}) {
  const book = getBook(libraryItemId)
  const clock = { time, getCurrentTime: null }
  clock.getCurrentTime = () => (typeof clock.time === 'function' ? clock.time() : clock.time)
  const axiosGet = cy.stub().callsFake((url) => {
    const id = url.split('/')[3]
    return Promise.resolve(getBook(id).transcript)
  })
  const mocks = {
    $axios: { $get: axiosGet },
    $store: {
      getters: { 'user/getUserSetting': (key) => (key === 'transcriptFontScale' ? 1 : null) },
      dispatch: cy.stub()
    },
    $strings: Strings,
    $getString: (key, subs = []) => Strings[key].replace(/\{(\d+)\}/g, (match, n) => subs[n])
  }
  const stubs = { 'ui-tooltip': Tooltip, 'widgets-loading-spinner': LoadingSpinner }
  const propsData = { libraryItem: libraryItem || book.libraryItem, chapters: book.chapters, getCurrentTime: () => clock.getCurrentTime(), playing }
  return cy.mount(TranscriptPanel, { propsData, mocks, stubs }).then(({ wrapper }) => {
    return cy.get('#transcript-panel [data-wi]', { timeout: 20000 }).should('exist').then(() => ({ wrapper, vm: wrapper.vm, clock, book, axiosGet }))
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
      cy.get('.transcript-search-hit').should('contain.text', 'marker123x').and(($el) => {
        expect(isInside($el[0], vm.$refs.scroller)).to.be.true
      })
      cy.contains('button', Strings.ButtonReturnToCurrentPosition).should('be.visible')
      cy.get('input[type="search"]').clear().type('nonexistentword')
      cy.contains(Strings.MessageNoResults).should('exist')
    })
  })

  it('changes the font size and keeps the current word in view', () => {
    mountPanel({ time: 20000, playing: false }).then(({ vm }) => {
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

  it('shows a message when the transcript is missing', () => {
    const mocks = {
      $axios: { $get: cy.stub().rejects({ response: { status: 404 } }) },
      $store: { getters: { 'user/getUserSetting': () => null }, dispatch: cy.stub() },
      $strings: Strings,
      $getString: (key) => Strings[key]
    }
    cy.mount(TranscriptPanel, { propsData: { libraryItem: { id: 'x', media: { tracks: [] } }, getCurrentTime: () => 0 }, mocks, stubs: { 'ui-tooltip': Tooltip, 'widgets-loading-spinner': LoadingSpinner } })
    cy.contains(Strings.MessageTranscriptNotFound).should('be.visible')
  })
})
