import io
import zipfile

import pytest

from transcribe_helper.ebook import EbookError, extract_html_paragraphs, read_epub

CONTAINER = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"""


def make_epub(chapters, title="A Test Book", nav=True, extra_files=None, spine_extra=""):
    """chapters: list of (filename, xhtml body). Returns EPUB bytes."""
    manifest = "".join(f'<item id="c{i}" href="text/{name}" media-type="application/xhtml+xml"/>' for i, (name, _) in enumerate(chapters))
    spine = "".join(f'<itemref idref="c{i}"/>' for i in range(len(chapters)))
    if nav:
        manifest += '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
        spine = '<itemref idref="nav"/>' + spine
    opf = f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>{title}</dc:title></metadata>
  <manifest>{manifest}</manifest>
  <spine>{spine}{spine_extra}</spine>
</package>"""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr("META-INF/container.xml", CONTAINER)
        z.writestr("OEBPS/content.opf", opf)
        if nav:
            z.writestr("OEBPS/nav.xhtml", '<html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc"><ol><li>Chapter One</li></ol></nav></body></html>')
        for name, body in chapters:
            z.writestr(f"OEBPS/text/{name}", f'<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>x</title><style>p {{ color: red }}</style></head><body>{body}</body></html>')
        for name, data in (extra_files or {}).items():
            z.writestr(name, data)
    return buffer.getvalue()


def test_reads_paragraphs_in_spine_order_with_headings():
    epub = make_epub([
        ("c1.xhtml", "<h1>Chapter One</h1><p>It was a <em>bright</em> cold day in April,</p><p>and the clocks were striking thirteen.</p>"),
        ("c2.xhtml", "<h2>Chapter Two</h2><p>Winston Smith slipped quickly&#160;through.</p>"),
    ])
    book = read_epub(epub)
    assert book["title"] == "A Test Book"
    # "spine" is the OPF spine position (the navigation document is position 0), like epub.js' Section.index
    assert book["paragraphs"] == [
        {"text": "Chapter One", "heading": True, "spine": 1},
        {"text": "It was a bright cold day in April,", "heading": False, "spine": 1},
        {"text": "and the clocks were striking thirteen.", "heading": False, "spine": 1},
        {"text": "Chapter Two", "heading": True, "spine": 2},
        {"text": "Winston Smith slipped quickly through.", "heading": False, "spine": 2},
    ]


def test_skips_navigation_notes_scripts_and_note_markers():
    paragraphs = extract_html_paragraphs(
        "<html><head><title>Ignored</title></head><body>"
        "<script>var x = 1</script>"
        '<p>A sentence with a note<a epub:type="noteref" href="#n1">1</a> and another<sup>2</sup> marker, but E=mc<sup>two</sup>.</p>'
        '<aside epub:type="footnote" id="n1"><p>The footnote text.</p></aside>'
        '<div epub:type="pagebreak" title="12">12</div>'
        '<p hidden="hidden">Hidden text</p>'
        "<p>Last line.</p></body></html>"
    )
    assert [p["text"] for p in paragraphs] == ["A sentence with a note and another marker, but E=mctwo.", "Last line."]


def test_line_breaks_become_separate_lines():
    paragraphs = extract_html_paragraphs("<p>Once upon a midnight dreary,<br/>while I pondered, weak and weary,<br>Over many a quaint</p>")
    assert [p["text"] for p in paragraphs] == ["Once upon a midnight dreary,", "while I pondered, weak and weary,", "Over many a quaint"]


def test_nav_document_and_non_linear_items_are_skipped():
    epub = make_epub([("c1.xhtml", "<p>Body text.</p>")], spine_extra="")
    assert [p["text"] for p in read_epub(epub)["paragraphs"]] == ["Body text."]


def test_declared_non_utf8_encoding():
    buffer = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(make_epub([("c1.xhtml", "<p>x</p>")]))) as source, zipfile.ZipFile(buffer, "w") as target:
        for name in source.namelist():
            data = source.read(name)
            if name.endswith("c1.xhtml"):
                data = '<?xml version="1.0" encoding="iso-8859-1"?><html><body><p>Café crème</p></body></html>'.encode("iso-8859-1")
            target.writestr(name, data)
    assert read_epub(buffer.getvalue())["paragraphs"][0]["text"] == "Café crème"


def test_invalid_and_drm_epubs_are_rejected():
    with pytest.raises(EbookError, match="Not a valid EPUB"):
        read_epub(b"not a zip file")
    def encryption(algorithm, uri):
        return (
            '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">'
            f'<enc:EncryptedData><enc:EncryptionMethod Algorithm="{algorithm}"/><enc:CipherData><enc:CipherReference URI="{uri}"/></enc:CipherData></enc:EncryptedData>'
            "</encryption>"
        )

    drm = make_epub([("c1.xhtml", "<p>x</p>")], extra_files={"META-INF/encryption.xml": encryption("http://www.w3.org/2001/04/xmlenc#aes128-cbc", "OEBPS/text/c1.xhtml")})
    with pytest.raises(EbookError, match="DRM"):
        read_epub(drm)
    # Font obfuscation does not affect the text
    fonts_only = make_epub([("c1.xhtml", "<p>Readable.</p>")], extra_files={"META-INF/encryption.xml": encryption("http://www.idpf.org/2008/embedding", "OEBPS/fonts/serif.otf")})
    assert read_epub(fonts_only)["paragraphs"][0]["text"] == "Readable."
    with pytest.raises(EbookError, match="No text"):
        read_epub(make_epub([("c1.xhtml", "<p>   </p>")]))
