import JSZip from 'jszip'
import { EbookError, extractDocumentParagraphs, readEpubText } from '@/players/ebookText'

// Same cases as the transcribe helper's tests/test_ebook.py (ebookText.js is a port of ebook.py)

const XHTML = (body) => `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>t</title></head><body>${body}</body></html>`

/** @param {[string, string][]} chapters - [filename, body html] */
async function makeEpub(chapters, { encryption = null, extraSpine = '<itemref idref="notes" linear="no"/>' } = {}) {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  if (encryption) zip.file('META-INF/encryption.xml', encryption)
  const manifest = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>', '<item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/>', ...chapters.map(([name], i) => `<item id="c${i}" href="${name}" media-type="application/xhtml+xml"/>`)].join('')
  const spine = ['<itemref idref="nav"/>', ...chapters.map((_, i) => `<itemref idref="c${i}"/>`), extraSpine].join('')
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>A Test Book</dc:title><dc:identifier id="id">test</dc:identifier></metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`)
  zip.file('OEBPS/nav.xhtml', XHTML('<nav epub:type="toc"><ol><li><a href="c1.xhtml">Chapter One</a></li></ol></nav>'))
  zip.file('OEBPS/notes.xhtml', XHTML('<p>Notes that are not part of the reading order.</p>'))
  chapters.forEach(([name, body]) => zip.file(`OEBPS/${name}`, XHTML(body)))
  return zip.generateAsync({ type: 'arraybuffer' })
}

const paragraphsOf = (html) => extractDocumentParagraphs(new DOMParser().parseFromString(html, 'text/html')).map((p) => p.text)

describe('ebookText', () => {
  it('reads paragraphs in spine order with headings', () => {
    cy.wrap(
      makeEpub([
        ['c1.xhtml', '<h1>Chapter One</h1><p>It was a <em>bright</em> cold day in April,</p><p>and the clocks were striking thirteen.</p>'],
        ['c2.xhtml', '<h2>Chapter Two</h2><p>Winston Smith slipped quickly&#160;through.</p>']
      ]).then(readEpubText)
    ).then((book) => {
      expect(book.title).to.equal('A Test Book')
      // "spine" is the OPF spine position (the navigation document is position 0), like epub.js' Section.index
      expect(book.paragraphs).to.deep.equal([
        { text: 'Chapter One', heading: true, spine: 1 },
        { text: 'It was a bright cold day in April,', heading: false, spine: 1 },
        { text: 'and the clocks were striking thirteen.', heading: false, spine: 1 },
        { text: 'Chapter Two', heading: true, spine: 2 },
        { text: 'Winston Smith slipped quickly through.', heading: false, spine: 2 }
      ])
    })
  })

  it('skips navigation, notes, scripts and note markers', () => {
    const html =
      '<html><head><title>Ignored</title></head><body><script>var x = 1</script>' + '<p>A sentence with a note<a epub:type="noteref" href="#n1">1</a> and another<sup>2</sup> marker, but E=mc<sup>two</sup>.</p>' + '<aside epub:type="footnote" id="n1"><p>The footnote text.</p></aside><div epub:type="pagebreak" title="12">12</div>' + '<p hidden="hidden">Hidden text</p><p>Last line.</p></body></html>'
    expect(paragraphsOf(html)).to.deep.equal(['A sentence with a note and another marker, but E=mctwo.', 'Last line.'])
  })

  it('turns line breaks into separate lines', () => {
    expect(paragraphsOf('<p>Once upon a midnight dreary,<br/>while I pondered, weak and weary,<br>Over many a quaint</p>')).to.deep.equal(['Once upon a midnight dreary,', 'while I pondered, weak and weary,', 'Over many a quaint'])
  })

  it('skips the navigation document and non-linear items', () => {
    cy.wrap(makeEpub([['c1.xhtml', '<p>Body text.</p>']]).then(readEpubText)).then((book) => {
      expect(book.paragraphs.map((p) => p.text)).to.deep.equal(['Body text.'])
    })
  })

  it('rejects DRM protected EPUBs but accepts obfuscated fonts', () => {
    const encryption = (algorithm, uri) => `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="${algorithm}"/><enc:CipherData><enc:CipherReference URI="${uri}"/></enc:CipherData></enc:EncryptedData></encryption>`
    const chapters = [['c1.xhtml', '<p>Body text.</p>']]
    cy.wrap(
      makeEpub(chapters, { encryption: encryption('http://www.w3.org/2001/04/xmlenc#aes128-cbc', 'OEBPS/c1.xhtml') })
        .then(readEpubText)
        .then(
          () => null,
          (error) => error
        )
    ).then((error) => {
      expect(error).to.be.instanceOf(EbookError)
      expect(error.message).to.contain('DRM')
    })
    cy.wrap(makeEpub(chapters, { encryption: encryption('http://www.idpf.org/2008/embedding', 'OEBPS/fonts/font.otf') }).then(readEpubText)).then((book) => {
      expect(book.paragraphs.map((p) => p.text)).to.deep.equal(['Body text.'])
    })
  })
})
