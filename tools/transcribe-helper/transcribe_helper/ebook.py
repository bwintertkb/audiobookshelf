"""Read the text of an EPUB in reading order, as paragraphs (standard library only)."""

import io
import posixpath
import re
import zipfile
from html.parser import HTMLParser
from urllib.parse import unquote
from xml.etree import ElementTree

CONTAINER_NS = {"c": "urn:oasis:names:tc:opendocument:xmlns:container"}
OPF_NS = {"opf": "http://www.idpf.org/2007/opf", "dc": "http://purl.org/dc/elements/1.1/"}

BLOCK_TAGS = {
    "address", "article", "aside", "blockquote", "caption", "dd", "div", "dl", "dt", "figcaption", "figure", "footer", "header",
    "h1", "h2", "h3", "h4", "h5", "h6", "hgroup", "li", "main", "nav", "ol", "p", "pre", "section", "table", "td", "th", "tr", "ul",
}
HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
SKIP_TAGS = {"head", "script", "style", "svg", "math", "rt", "rp", "noscript"}
# epub:type / role values whose content is not read aloud
SKIP_TYPES = {"footnote", "footnotes", "endnote", "endnotes", "rearnote", "rearnotes", "noteref", "toc", "landmarks", "page-list", "pagebreak", "doc-footnote", "doc-endnotes", "doc-noteref", "doc-pagebreak", "doc-toc"}
NOTE_MARKER = re.compile(r"^[\s\[\(]*[\d*†‡§¶]+[\]\)\s]*$")


class EbookError(Exception):
    pass


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.paragraphs = []
        self._buffer = []
        self._stack = []  # (tag, skips, is_heading, is_sup)
        self._sup_buffers = []

    def _skipping(self):
        return any(entry[1] for entry in self._stack)

    def _in_heading(self):
        return any(entry[2] for entry in self._stack)

    def _flush(self):
        text = " ".join("".join(self._buffer).split())
        self._buffer = []
        if text:
            self.paragraphs.append({"text": text, "heading": self._in_heading()})

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag == "br":
            if not self._skipping():
                self._flush()  # line breaks (poetry) become separate lines
            return
        if tag in VOID_TAGS:
            return
        attributes = dict(attrs)
        types = set(re.split(r"[\s]+", f"{attributes.get('epub:type') or ''} {attributes.get('role') or ''}".lower().strip()))
        skips = tag in SKIP_TAGS or bool(types & SKIP_TYPES) or "hidden" in attributes or attributes.get("aria-hidden") == "true"
        if tag in BLOCK_TAGS and not self._skipping():
            self._flush()
        is_sup = tag in ("sup", "sub")
        self._stack.append((tag, skips, tag in HEADING_TAGS, is_sup))
        if is_sup:
            self._sup_buffers.append([])

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag.lower() not in VOID_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in VOID_TAGS or not any(entry[0] == tag for entry in self._stack):
            return
        while self._stack[-1][0] != tag:  # elements left open inside this one
            self._close(self._stack.pop())
        if tag in BLOCK_TAGS and not self._skipping():
            self._flush()  # while the element is still on the stack, so headings are recognized
        self._close(self._stack.pop())

    def _close(self, entry):
        if entry[3]:
            # Superscript/subscript that is only a note marker ("1", "*", "[2]") is not read aloud
            text = "".join(self._sup_buffers.pop())
            if not NOTE_MARKER.match(text):
                self._append(text)

    def _append(self, data):
        if self._sup_buffers:
            self._sup_buffers[-1].append(data)
        else:
            self._buffer.append(data)

    def handle_data(self, data):
        if not self._skipping():
            self._append(data)

    def close(self):
        super().close()
        while self._sup_buffers:
            self._buffer.extend(self._sup_buffers.pop())
        self._flush()


def extract_html_paragraphs(html):
    parser = _TextExtractor()
    parser.feed(html)
    parser.close()
    return parser.paragraphs


def read_epub(source):
    """source: path or bytes. Returns {"title", "paragraphs": [{"text", "heading"}]} in reading (spine) order."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(source) if isinstance(source, (bytes, bytearray)) else source)
    except (zipfile.BadZipFile, OSError) as error:
        raise EbookError(f"Not a valid EPUB file ({error})") from None

    with archive:
        names = set(archive.namelist())
        if "META-INF/container.xml" not in names:
            raise EbookError("Not a valid EPUB file (META-INF/container.xml is missing)")
        if "META-INF/encryption.xml" in names and _has_encrypted_content(archive.read("META-INF/encryption.xml")):
            raise EbookError("This EPUB is DRM protected; its text cannot be read")

        try:
            container = ElementTree.fromstring(archive.read("META-INF/container.xml"))
            rootfile = container.find(".//c:rootfile", CONTAINER_NS).get("full-path")
            opf = ElementTree.fromstring(archive.read(rootfile))
        except (ElementTree.ParseError, AttributeError, KeyError) as error:
            raise EbookError(f"Not a valid EPUB file ({error})") from None

        opf_dir = posixpath.dirname(rootfile)
        title_el = opf.find(".//dc:title", OPF_NS)
        manifest = {}
        for item in opf.findall(".//opf:manifest/opf:item", OPF_NS):
            manifest[item.get("id")] = {
                "path": posixpath.normpath(posixpath.join(opf_dir, unquote(item.get("href", "")))),
                "type": item.get("media-type", ""),
                "properties": (item.get("properties") or "").split(),
            }

        paragraphs = []
        for itemref in opf.findall(".//opf:spine/opf:itemref", OPF_NS):
            if itemref.get("linear", "yes") == "no":
                continue
            item = manifest.get(itemref.get("idref"))
            if not item or "nav" in item["properties"]:
                continue  # the EPUB 3 navigation document is a table of contents
            if item["type"] not in ("application/xhtml+xml", "text/html") or item["path"] not in names:
                continue
            paragraphs.extend(extract_html_paragraphs(_decode(archive.read(item["path"]))))

    if not paragraphs:
        raise EbookError("No text found in the EPUB")
    return {"title": title_el.text.strip() if title_el is not None and title_el.text else None, "paragraphs": paragraphs}


def _decode(data):
    """EPUB content documents should be UTF-8, but older files sometimes declare another encoding."""
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16", errors="replace")
    declared = re.match(rb"""^\s*<\?xml[^>]*encoding=["']([A-Za-z0-9._-]+)["']""", data)
    encoding = declared.group(1).decode("ascii") if declared else "utf-8"
    try:
        return data.decode(encoding)
    except (LookupError, UnicodeDecodeError):
        return data.decode("utf-8", errors="replace")


def _has_encrypted_content(encryption_xml):
    """True if any text document is encrypted (DRM). Obfuscated/encrypted fonts are fine."""
    try:
        root = ElementTree.fromstring(encryption_xml)
    except ElementTree.ParseError:
        return True
    for element in root.iter():
        if element.tag.endswith("CipherReference"):
            uri = unquote(element.get("URI", "")).lower()
            if uri.endswith((".xhtml", ".html", ".htm", ".xml", ".opf", ".ncx")):
                return True
    return False
