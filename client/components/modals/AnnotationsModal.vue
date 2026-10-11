<template>
  <!-- Highlights and notes of a book (read-along): go to one, change its note, delete it, export them all as Markdown -->
  <modals-modal v-model="show" name="annotations" :width="560" :height="'unset'">
    <template #outer>
      <div class="absolute top-0 left-0 p-5 w-2/3 overflow-hidden">
        <p class="text-3xl text-white truncate">{{ $strings.HeaderNotesAndHighlights }}</p>
      </div>
    </template>
    <div v-if="show" class="w-full rounded-lg bg-bg box-shadow-md relative flex flex-col" style="max-height: 80vh">
      <div class="flex items-center px-4 py-2 border-b border-white/10 shrink-0">
        <p class="text-sm text-gray-300 grow">{{ countText }}</p>
        <ui-btn small :disabled="!annotations.length" @click="exportAnnotations"><span class="material-symbols text-base align-text-bottom pr-1">download</span>{{ $strings.ButtonExport }}</ui-btn>
      </div>
      <div v-if="annotations.length" class="grow min-h-0 overflow-y-auto overflow-x-hidden">
        <div v-for="annotation in annotations" :key="annotation.id" class="annotation-item flex border-b border-white/10" :data-annotation="annotation.id">
          <div class="w-1.5 shrink-0" :style="{ backgroundColor: swatches[annotation.color] || swatches.yellow }" />
          <div class="grow min-w-0 px-3 py-2">
            <button class="block w-full text-left text-gray-100 hover:text-white annotation-text" @click="$emit('select', annotation)">{{ quoted(annotation.text) }}</button>
            <div v-if="editingId === annotation.id" class="pt-2">
              <textarea ref="noteInput" v-model="noteDraft" rows="3" class="w-full bg-primary border border-gray-600 rounded-sm px-2 py-1 text-sm text-gray-100 outline-hidden focus:border-gray-400 resize-y" :placeholder="$strings.LabelNotePlaceholder" @keydown.ctrl.enter.prevent="saveNote(annotation)" @keydown.esc.stop.prevent="editingId = null" />
              <div class="flex justify-end gap-2 pt-1">
                <ui-btn small @click="editingId = null">{{ $strings.ButtonCancel }}</ui-btn>
                <ui-btn small color="bg-success" @click="saveNote(annotation)">{{ $strings.ButtonSave }}</ui-btn>
              </div>
            </div>
            <p v-else-if="annotation.note" class="mt-1 text-sm text-gray-300 whitespace-pre-wrap"><span class="material-symbols text-base align-text-bottom pr-1 text-gray-400">sticky_note_2</span>{{ annotation.note }}</p>
            <div class="flex items-center pt-1 text-xs text-gray-400">
              <p class="grow truncate">{{ whereText(annotation) }}</p>
              <button class="annotation-icon-btn" :aria-label="$strings.ButtonNote" @click="startNote(annotation)"><span class="material-symbols text-lg">edit_note</span></button>
              <button class="annotation-icon-btn" :aria-label="$strings.ButtonDeleteHighlight" @click="remove(annotation)"><span class="material-symbols text-lg">delete</span></button>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="flex h-32 items-center justify-center px-6 text-center">
        <p class="text-gray-300">{{ $strings.MessageNoHighlights }}</p>
      </div>
    </div>
  </modals-modal>
</template>

<script>
import { ANNOTATION_SWATCHES, annotationsFilename, annotationsMarkdown, quotedText } from '@/players/annotations'
import { getAnnotationStore } from '@/players/annotationStore'

export default {
  props: {
    value: Boolean,
    libraryItemId: String,
    title: String,
    author: String,
    /** Chapters of the audiobook, to say where each highlight is */
    chapters: {
      type: Array,
      default: () => []
    }
  },
  data() {
    return {
      swatches: ANNOTATION_SWATCHES,
      annotations: [],
      editingId: null,
      noteDraft: ''
    }
  },
  computed: {
    show: {
      get() {
        return this.value
      },
      set(val) {
        this.$emit('input', val)
      }
    },
    store() {
      return getAnnotationStore(this.$axios)
    },
    countText() {
      const notes = this.annotations.filter((a) => a.note).length
      return this.$getString('LabelHighlightsAndNotesCount', [this.annotations.length, notes])
    }
  },
  watch: {
    value(open) {
      if (open) this.subscribe()
      else this.unsubscribe()
    },
    libraryItemId() {
      if (this.value) this.subscribe()
    }
  },
  methods: {
    quoted: quotedText,
    subscribe() {
      this.unsubscribe()
      this.editingId = null
      const libraryItemId = this.libraryItemId
      if (!libraryItemId) return
      this.annotations = this.store.get(libraryItemId)
      this.release = this.store.subscribe(libraryItemId, (annotations) => (this.annotations = annotations))
      this.store.load(libraryItemId)
    },
    unsubscribe() {
      this.release?.()
      this.release = null
    },
    chapterOf(annotation) {
      return [...this.chapters].reverse().find((chapter) => chapter.start <= annotation.start + 0.5)
    },
    whereText(annotation) {
      return [this.chapterOf(annotation)?.title, this.$secondsToTimestamp(annotation.start)].filter(Boolean).join(' · ')
    },
    startNote(annotation) {
      this.editingId = annotation.id
      this.noteDraft = annotation.note || ''
      this.$nextTick(() => this.$refs.noteInput?.[0]?.focus())
    },
    async saveNote(annotation) {
      try {
        await this.store.save(this.libraryItemId, { ...annotation, note: this.noteDraft.trim() || null })
        this.editingId = null
      } catch (error) {
        console.error('[AnnotationsModal] Failed to save note', error)
        this.$toast.error(this.$strings.ToastHighlightSaveFailed)
      }
    },
    async remove(annotation) {
      try {
        await this.store.remove(this.libraryItemId, annotation.id)
      } catch (error) {
        console.error('[AnnotationsModal] Failed to delete highlight', error)
        this.$toast.error(this.$strings.ToastHighlightSaveFailed)
      }
    },
    exportAnnotations() {
      const markdown = annotationsMarkdown({ title: this.title, author: this.author, annotations: this.annotations, chapters: this.chapters, formatTime: (seconds) => this.$secondsToTimestamp(seconds) })
      const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = annotationsFilename(this.title)
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
  },
  mounted() {
    if (this.value) this.subscribe()
  },
  beforeDestroy() {
    this.unsubscribe()
  }
}
</script>

<style scoped>
.annotation-text {
  display: -webkit-box;
  -webkit-line-clamp: 5;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.45;
}
.annotation-icon-btn {
  display: inline-flex;
  padding: 0.2rem;
  color: rgb(156 163 175);
}
.annotation-icon-btn:hover {
  color: white;
}
</style>
