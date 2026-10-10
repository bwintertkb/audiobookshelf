import ePub from 'epubjs'

/**
 * The text of an EPUB in reading order, as paragraphs (port of the transcribe helper's
 * tools/transcribe-helper/transcribe_helper/ebook.py; keep both in sync with ReadAlong's tokenizer).
 * Sections are read with epub.js, so their spine positions are the reader's Section.index.
 */

const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'caption', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hgroup', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul'])
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const SKIP_TAGS = new Set(['head', 'script', 'style', 'svg', 'math', 'rt', 'rp', 'noscript'])
// epub:type / role values whose content is not read aloud
const SKIP_TYPES = new Set(['footnote', 'footnotes', 'endnote', 'endnotes', 'rearnote', 'rearnotes', 'noteref', 'toc', 'landmarks', 'page-list', 'pagebreak', 'doc-footnote', 'doc-endnotes', 'doc-noteref', 'doc-pagebreak', 'doc-toc'])
const NOTE_MARKER = /^[\s[(]*[\d*†‡§¶]+[\])\s]*$/
const EPUB_NS = 'http://www.idpf.org/2007/ops'
const TEXT_DOCUMENT = /\.(xhtml|html|htm|xml|opf|ncx)$/i

export class EbookError extends Error {
  constructor(message) {
    super(message)
    this.name = 'EbookError'
  }
}

/**
 * Paragraphs of a content document: block elements and <br> separate paragraphs; headings are flagged;
 * notes, tables of contents and superscript note markers are left out.
 *
 * @param {Document} doc
 * @returns {{text: string, heading: boolean}[]}
 */
export function extractDocumentParagraphs(doc) {
  const paragraphs = []
  let buffer = []
  const stack = [] // { tag, skips, heading, sup }
  const supBuffers = []
  const skipping = () => stack.some((entry) => entry.skips)
  const inHeading = () => stack.some((entry) => entry.heading)
  const flush = () => {
    const text = buffer.join('').split(/\s+/).filter(Boolean).join(' ')
    buffer = []
    if (text) paragraphs.push({ text, heading: inHeading() })
  }
  const append = (data) => {
    if (supBuffers.length) supBuffers[supBuffers.length - 1].push(data)
    else buffer.push(data)
  }
  const close = (entry) => {
    if (!entry.sup) return
    // Superscript/subscript that is only a note marker ("1", "*", "[2]") is not read aloud
    const text = supBuffers.pop().join('')
    if (!NOTE_MARKER.test(text)) append(text)
  }
  const walk = (node) => {
    if (node.nodeType === 3 || node.nodeType === 4) {
      if (!skipping()) append(node.data)
      return
    }
    if (node.nodeType !== 1) return
    const tag = node.localName.toLowerCase()
    if (tag === 'br') {
      if (!skipping()) flush() // line breaks (poetry) become separate lines
      return
    }
    if (VOID_TAGS.has(tag)) return
    const types = `${node.getAttribute('epub:type') || node.getAttributeNS(EPUB_NS, 'type') || ''} ${node.getAttribute('role') || ''}`.toLowerCase().trim().split(/\s+/)
    const skips = SKIP_TAGS.has(tag) || types.some((type) => SKIP_TYPES.has(type)) || node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true'
    const block = BLOCK_TAGS.has(tag)
    if (block && !skipping()) flush()
    const entry = { tag, skips, heading: HEADING_TAGS.has(tag), sup: tag === 'sup' || tag === 'sub' }
    stack.push(entry)
    if (entry.sup) supBuffers.push([])
    for (let child = node.firstChild; child; child = child.nextSibling) walk(child)
    if (block && !skipping()) flush() // while the element is still on the stack, so headings are recognized
    close(stack.pop())
  }
  walk(doc.documentElement)
  while (supBuffers.length) buffer.push(...supBuffers.pop())
  flush()
  return paragraphs
}

/** True if any text document is encrypted (DRM). Obfuscated/encrypted fonts are fine. */
export function hasEncryptedContent(encryptionXml) {
  let doc
  try {
    doc = new DOMParser().parseFromString(encryptionXml, 'application/xml')
  } catch (error) {
    return true
  }
  if (doc.getElementsByTagName('parsererror').length) return true
  for (const element of doc.getElementsByTagName('*')) {
    if (element.localName === 'CipherReference') {
      let uri = element.getAttribute('URI') || ''
      try {
        uri = decodeURIComponent(uri)
      } catch (error) {
        // keep as is
      }
      if (TEXT_DOCUMENT.test(uri)) return true
    }
  }
  return false
}

/**
 * @param {ArrayBuffer} data - the EPUB file
 * @returns {Promise<{title: string|null, paragraphs: {text: string, heading: boolean, spine: number}[]}>} in reading (spine) order
 */
export async function readEpubText(data) {
  const book = ePub(data)
  try {
    try {
      await book.opened
    } catch (error) {
      throw new EbookError(`Not a valid EPUB file (${error.message || error})`)
    }
    const encryption = book.archive?.zip?.file('META-INF/encryption.xml')
    if (encryption && hasEncryptedContent(await encryption.async('string'))) {
      throw new EbookError('This EPUB is DRM protected; its text cannot be read')
    }

    const paragraphs = []
    // section.index counts every itemref (like the reader), so readers can find the text again
    for (const section of book.spine.spineItems) {
      if (!section.linear) continue
      if (section.properties?.includes('nav')) continue // the EPUB 3 navigation document is a table of contents
      const type = book.packaging.manifest[section.idref]?.type
      if (type !== 'application/xhtml+xml' && type !== 'text/html') continue
      try {
        await section.load(book.load.bind(book))
      } catch (error) {
        continue // listed in the spine but missing from the archive
      }
      for (const paragraph of extractDocumentParagraphs(section.document)) {
        paragraphs.push({ ...paragraph, spine: section.index })
      }
      section.unload()
    }
    if (!paragraphs.length) throw new EbookError('No text found in the EPUB')
    const title = book.packaging.metadata?.title
    return { title: title ? String(title).trim() : null, paragraphs }
  } finally {
    book.destroy()
  }
}
