<template>
  <!-- Words chosen in the transcript or the book (right-click, long-press or a text selection): definition of a single word,
       highlight in a colour, add a note, play from there, copy. Opened on an existing highlight it changes or deletes it. -->
  <div ref="popup" class="readalong-popup fixed z-[70] flex flex-col bg-primary border border-gray-600 rounded-lg shadow-2xl text-gray-100" :style="style" role="dialog" :aria-label="title" @mousedown.stop @touchstart.stop @click.stop @contextmenu.stop.prevent @keydown.stop>
    <div class="flex items-center pl-3 pr-1 pt-1.5 shrink-0">
      <p class="grow min-w-0 truncate font-semibold text-base" :class="{ 'italic font-normal text-sm text-gray-300': !isSingleWord }">{{ title }}</p>
      <button class="readalong-popup-icon-btn" :aria-label="$strings.ButtonClose" @click="$emit('close')"><span class="material-symbols text-xl">close</span></button>
    </div>

    <div class="readalong-popup-body px-3 pb-2 overflow-y-auto text-sm leading-snug">
      <template v-if="isSingleWord && !editingNote">
        <div v-if="lookingUp" class="py-2 flex justify-center"><widgets-loading-spinner size="la-sm" /></div>
        <p v-else-if="lookupError" class="py-1 text-gray-300">{{ $strings.MessageDictionaryUnavailable }}</p>
        <p v-else-if="!results.length" class="py-1 text-gray-300">{{ $strings.MessageNoDefinitionFound }}</p>
        <div v-for="result in results" v-else :key="result.word" class="pt-1">
          <p v-if="results.length > 1 || result.word !== query" class="font-semibold text-gray-200">{{ result.word }}</p>
          <ol class="list-decimal pl-5 space-y-1">
            <li v-for="(sense, i) in result.senses" :key="i">
              <span class="italic text-gray-400">{{ sense.partOfSpeech }}</span> {{ sense.definition }}<span v-if="sense.example" class="text-gray-400"> &ldquo;{{ sense.example }}&rdquo;</span>
            </li>
          </ol>
        </div>
      </template>

      <div v-if="editingNote" class="pt-1">
        <textarea ref="noteInput" v-model="noteDraft" rows="4" class="w-full bg-bg border border-gray-600 rounded-sm px-2 py-1 text-sm text-gray-100 outline-hidden focus:border-gray-400 resize-y" :placeholder="$strings.LabelNotePlaceholder" @keydown.ctrl.enter.prevent="saveNote" @keydown.meta.enter.prevent="saveNote" @keydown.esc.prevent="editingNote = false" />
        <div class="flex justify-end gap-1 pt-1">
          <button class="readalong-popup-btn" @click="editingNote = false">{{ $strings.ButtonCancel }}</button>
          <button class="readalong-popup-btn readalong-popup-btn-primary" :disabled="busy" @click="saveNote">{{ $strings.ButtonSave }}</button>
        </div>
      </div>
      <button v-else-if="current && current.note" class="block w-full text-left mt-1 px-2 py-1.5 rounded-sm bg-white/5 hover:bg-white/10 whitespace-pre-wrap" @click="startNote"><span class="material-symbols text-base align-text-bottom pr-1 text-gray-400">sticky_note_2</span>{{ current.note }}</button>
    </div>

    <div class="flex items-center gap-1 p-1.5 border-t border-gray-600 shrink-0 flex-wrap">
      <div class="flex items-center gap-1 pr-1" role="group" :aria-label="$strings.LabelHighlightColor">
        <button v-for="color in colors" :key="color" class="readalong-swatch" :class="{ 'readalong-swatch-selected': current && current.color === color }" :style="{ backgroundColor: swatches[color] }" :aria-label="$strings.ButtonHighlight + ': ' + colorName(color)" :aria-pressed="current && current.color === color ? 'true' : 'false'" :disabled="busy" @click="highlight(color)" />
      </div>
      <button class="readalong-popup-btn" :disabled="busy" :aria-label="$strings.ButtonNote" @click="startNote"><span class="material-symbols text-lg">edit_note</span></button>
      <button v-if="playTime !== null" class="readalong-popup-btn" :aria-label="$strings.ButtonPlayFromHere" @click="$emit('play', playTime)"><span class="material-symbols fill text-lg">play_arrow</span></button>
      <button class="readalong-popup-btn" :aria-label="$strings.ButtonCopy" @click="copy"><span class="material-symbols text-lg">content_copy</span></button>
      <div class="grow" />
      <button v-if="current" class="readalong-popup-btn" :disabled="busy" :aria-label="$strings.ButtonDeleteHighlight" @click="remove"><span class="material-symbols text-lg">delete</span></button>
    </div>
  </div>
</template>

<script>
import { getDictionary, normalizeWord } from '@/players/dictionary'
import { ANNOTATION_COLORS, ANNOTATION_SWATCHES, DEFAULT_ANNOTATION_COLOR, newAnnotationId, quotedText } from '@/players/annotations'
import { getAnnotationStore } from '@/players/annotationStore'

const MARGIN_PX = 8
const MAX_WIDTH_PX = 360

export default {
  props: {
    libraryItemId: {
      type: String,
      required: true
    },
    /**
     * The chosen transcript words: { first, last, text, start, end } (word indexes, their text, start times of the first
     * and last word). A single word also gets its definition.
     */
    selection: {
      type: Object,
      required: true
    },
    /** An existing highlight it was opened on */
    annotation: {
      type: Object,
      default: null
    },
    /** Where the words are on screen (viewport coordinates) */
    anchor: {
      type: Object,
      required: true
    },
    /** Book time to play from (null: no play button) */
    playTime: {
      type: Number,
      default: null
    }
  },
  data() {
    return {
      colors: ANNOTATION_COLORS,
      swatches: ANNOTATION_SWATCHES,
      lookingUp: false,
      lookupError: false,
      query: '',
      results: [],
      current: this.annotation,
      editingNote: false,
      noteDraft: '',
      busy: false,
      style: {}
    }
  },
  computed: {
    isSingleWord() {
      return !this.current && this.selection.first === this.selection.last
    },
    title() {
      if (this.isSingleWord) return this.query || this.selection.text
      return quotedText(this.current?.text || this.selection.text)
    }
  },
  watch: {
    annotation(value) {
      this.current = value
    },
    selection() {
      this.editingNote = false
      if (this.isSingleWord) this.lookup()
      this.$nextTick(this.position)
    },
    anchor() {
      this.$nextTick(this.position)
    },
    editingNote() {
      this.$nextTick(this.position)
    }
  },
  methods: {
    colorName(color) {
      return this.$strings[`LabelColor${color[0].toUpperCase()}${color.slice(1)}`] || color
    },
    async lookup() {
      const word = this.selection.text
      this.query = normalizeWord(word)
      this.lookingUp = true
      this.lookupError = false
      this.results = []
      try {
        const { results } = await getDictionary(`${this.$config.routerBasePath}/dictionary`).lookup(word)
        if (word !== this.selection.text) return
        this.results = results
      } catch (error) {
        console.error('[ReadAlongPopup] Dictionary lookup failed', error)
        if (word === this.selection.text) this.lookupError = true
      } finally {
        if (word === this.selection.text) {
          this.lookingUp = false
          this.$nextTick(this.position)
        }
      }
    },
    /** The highlight with changes (a new one for the selection if there is none yet) */
    async saveAnnotation(changes) {
      const base = this.current || { id: newAnnotationId(), start: this.selection.start, end: this.selection.end, text: this.selection.text, color: DEFAULT_ANNOTATION_COLOR, note: null, createdAt: Date.now() }
      this.busy = true
      try {
        this.current = await getAnnotationStore(this.$axios).save(this.libraryItemId, { ...base, ...changes })
        this.$emit('saved', this.current)
      } catch (error) {
        console.error('[ReadAlongPopup] Failed to save highlight', error)
        this.$toast.error(this.$strings.ToastHighlightSaveFailed)
      } finally {
        this.busy = false
      }
    },
    highlight(color) {
      // The highlighter pen uses the colour picked last
      this.$store.dispatch('user/updateUserSettings', { highlighterColor: color })
      if (this.current?.color === color) return
      this.saveAnnotation({ color })
    },
    startNote() {
      this.noteDraft = this.current?.note || ''
      this.editingNote = true
      this.$nextTick(() => this.$refs.noteInput?.focus())
    },
    async saveNote() {
      await this.saveAnnotation({ note: this.noteDraft.trim() || null })
      this.editingNote = false
    },
    async remove() {
      if (!this.current) return
      this.busy = true
      try {
        await getAnnotationStore(this.$axios).remove(this.libraryItemId, this.current.id)
        this.$emit('close')
      } catch (error) {
        console.error('[ReadAlongPopup] Failed to delete highlight', error)
        this.$toast.error(this.$strings.ToastHighlightSaveFailed)
      } finally {
        this.busy = false
      }
    },
    async copy() {
      try {
        await navigator.clipboard.writeText(this.current?.text || this.selection.text)
        this.$toast.success(this.$strings.ToastCopiedToClipboard)
      } catch (error) {
        console.error('[ReadAlongPopup] Copy failed', error)
      }
    },
    /** Below the words if there is room, otherwise above them; always inside the window */
    position() {
      const popup = this.$refs.popup
      if (!popup) return
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const width = Math.min(MAX_WIDTH_PX, viewportWidth - MARGIN_PX * 2)
      const { left, top, width: anchorWidth = 0, height: anchorHeight = 0 } = this.anchor
      const x = Math.min(Math.max(MARGIN_PX, left + anchorWidth / 2 - width / 2), viewportWidth - width - MARGIN_PX)
      const below = viewportHeight - (top + anchorHeight) - MARGIN_PX * 2
      const above = top - MARGIN_PX * 2
      const height = popup.offsetHeight
      const style = { left: `${x}px`, width: `${width}px` }
      if (height <= below || below >= above) {
        style.top = `${Math.max(MARGIN_PX, top + anchorHeight + MARGIN_PX)}px`
        style.maxHeight = `${Math.max(160, below)}px`
      } else {
        style.bottom = `${viewportHeight - top + MARGIN_PX}px`
        style.maxHeight = `${Math.max(160, above)}px`
      }
      this.style = style
    },
    onDocumentPointer(event) {
      if (!this.$refs.popup?.contains(event.target)) this.$emit('close')
    },
    onKeydown(event) {
      if (event.key !== 'Escape' || this.editingNote) return
      // Only the popup closes (not the reader or a modal behind it)
      event.stopPropagation()
      event.preventDefault()
      this.$emit('close')
    }
  },
  mounted() {
    this.position()
    if (this.isSingleWord) this.lookup()
    // Capture: the panel and the reader stop some events from bubbling
    document.addEventListener('mousedown', this.onDocumentPointer, true)
    document.addEventListener('touchstart', this.onDocumentPointer, true)
    document.addEventListener('keydown', this.onKeydown, true)
    window.addEventListener('resize', this.position)
  },
  beforeDestroy() {
    document.removeEventListener('mousedown', this.onDocumentPointer, true)
    document.removeEventListener('touchstart', this.onDocumentPointer, true)
    document.removeEventListener('keydown', this.onKeydown, true)
    window.removeEventListener('resize', this.position)
  }
}
</script>

<style scoped>
.readalong-popup {
  max-height: 60vh;
}
.readalong-popup-body {
  min-height: 0.5rem;
}
.readalong-popup-icon-btn {
  display: inline-flex;
  padding: 0.25rem;
  color: rgb(209 213 219);
}
.readalong-popup-icon-btn:hover {
  color: white;
}
.readalong-popup-btn {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
  border-radius: 0.375rem;
  padding: 0.3rem 0.5rem;
  font-size: 0.875rem;
  color: rgb(229 231 235);
  background-color: rgb(255 255 255 / 0.06);
}
.readalong-popup-btn:hover:not(:disabled) {
  background-color: rgb(255 255 255 / 0.14);
}
.readalong-popup-btn:disabled {
  opacity: 0.6;
}
.readalong-popup-btn-primary {
  background-color: rgb(255 255 255 / 0.16);
}
.readalong-swatch {
  width: 1.5rem;
  height: 1.5rem;
  border-radius: 9999px;
  border: 2px solid transparent;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.25);
}
.readalong-swatch-selected {
  border-color: white;
}
</style>
