# Read-along transcripts

Create a word-level transcript of an audiobook on your own GPU, store it on the Audiobookshelf server, and follow along in the web player: the current word and sentence are highlighted, the text scrolls with the audio, and clicking a word jumps there.

```
 Browser (ABS web client)               Your PC                        ABS server
 [Create transcript] ──── job ───────▶  transcribe helper
                                        (faster-whisper on CUDA)
                                         │ downloads audio ◀───────── /api/items/:id/file/:ino
 progress ◀──────────────────────────────┤
 result ◀────────────────────────────────┘
 upload ─────────────────────────────────────────────────────────────▶ POST /api/items/:id/transcript
 player transcript panel ◀───────────────────────────────────────────── GET /api/items/:id/transcript
```

Transcription never runs on the ABS server. It runs in a small helper service on the computer you browse ABS from (`tools/transcribe-helper`). Once uploaded, a transcript works in any browser.

## Setup

1. Install and start the helper on the PC with the NVIDIA GPU: see [`tools/transcribe-helper/README.md`](../tools/transcribe-helper/README.md) (Windows and Linux). In short: create a venv, `pip install -r requirements.txt`, `python check_gpu.py`, then `python run_helper.py`.
2. Allow your ABS address in the helper: copy `config.example.toml` to `config.toml` and add the address you open ABS at (e.g. `https://abs.example.com`) to `allowed_origins`.
3. In the ABS web player, open **Player settings** (gear icon in the player). The **Transcription helper URL** defaults to `http://127.0.0.1:8765`; the line below it shows whether the helper is connected and which GPU and model it uses.

Chrome and Edge 142+ ask once for permission to access devices on your local network when ABS is served from a public address; allow it. Safari cannot call the helper from an HTTPS page, so use Chrome, Edge or Firefox to create transcripts (viewing works in every browser).

## Use

- **Create**: on a book's page open the **⋮** menu and choose **Create transcript** (shown to users who can edit items, when the helper is reachable). Progress, the current file and the time remaining are shown on the page. The job keeps running if you navigate away or reload; the page reconnects to it. When it finishes the transcript is uploaded and a confirmation appears.
- **Re-create**: **Re-create transcript** in the same menu (asks for confirmation) replaces it.
- **Delete**: **Delete transcript** (users with delete permission).
- **Read along**: while the book plays, press the transcript button (subtitles icon) in the player. The panel opens on the right (full width on narrow screens) and remembers whether it was open.
  - The current sentence and word are highlighted at every playback speed (0.5x to 10x).
  - It scrolls with the audio; scroll yourself to look around and use **Return to current position** to follow the audio again.
  - Click a word to jump to it, or a chapter heading to jump to the chapter.
  - Search (magnifier icon), with Enter / Shift+Enter for the next / previous result.
  - Change the text size with the A- / A+ buttons.
  - If the book's audio files changed after the transcript was made (files added, removed or replaced), the panel warns that the highlighting may be out of sync; re-create the transcript.

On an RTX 5090 with `large-v3-turbo`, transcription runs at roughly 100x real time: a 15 hour book takes about 10 minutes plus the download time.

## Use the book's own text (EPUB)

If the book also has an EPUB in ABS (put the `.epub` in the book's folder; the book page then shows **Read**), choose **Create transcript from ebook** in the **⋮** menu. The helper still times the words with Whisper on your GPU, then lines up the EPUB's text with the narration:

- The transcript shows the book's real text: spelling, punctuation, quotes, paragraphs and chapter headings.
- Text that is not read aloud (title pages, contents, copyright and license pages, captions, footnotes) is left out; speech that is not in the book (narrator intros, "Chapter two of …" announcements) simply has no text.
- If the book already has a normal transcript made from the same audio files, it is reused: no audio is downloaded or transcribed and the alignment takes seconds.
- Only DRM-free EPUB files can be used. If the EPUB is a different edition or the wrong book, the job stops with "The ebook text does not match the audio". An abridged recording only gets the parts that were read.

## Read along in the ebook reader

With a transcript made from the ebook, open the book with **Read** while the audiobook plays:

- The narrated sentence and word are highlighted in the book itself, with the book's formatting (fonts, italics, images, the reader's themes and font settings), at every playback speed. The player stays at the bottom of the screen with its speed control.
- Pages turn by themselves to follow the narration. Turn a page yourself to look around and use **Return to narration** to follow the audio again.
- Tap a word to play from there.
- When the audiobook is not playing, **Play from here** starts it at the first word of the page you are reading.

This uses the [CSS Custom Highlight API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API) (Chrome/Edge 105+, Safari 17.2+, Firefox 140+); older browsers highlight the sentence only.

## Permissions

| Action                      | Requires                                                      |
| --------------------------- | ------------------------------------------------------------- |
| View a transcript           | access to the item (library, tags, explicit content)          |
| Create / re-create (upload) | "Can Update" (same as editing chapters)                       |
| Delete                      | "Can Delete" (same as removing a cover; root only by default) |

## Storage

Transcripts are stored gzipped at `<metadata>/items/<libraryItemId>/transcript.json.gz`, next to the item's cover and `metadata.json` (also when "store metadata with item" is enabled, so nothing is written to the media folders). They are deleted together with the library item, and included in backups. A 15 hour book is about 8 MB of JSON, 1.5 MB gzipped. The item record keeps a short summary in `extraData.transcript`, which the API exposes as `hasTranscript` on the expanded item.

## API

| Method | Path                        |                                                                                                                                                                                      |
| ------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/items/:id/transcript` | the transcript JSON (served `Content-Encoding: gzip`, with ETag/304); 404 if none                                                                                                    |
| POST   | `/api/items/:id/transcript` | upload or replace: multipart file field `transcript` (gzipped or plain JSON), or a JSON body (JSON bodies are limited to 10 MB by the server, so use the file upload for long books) |
| DELETE | `/api/items/:id/transcript` | remove                                                                                                                                                                               |

`GET /api/items/:id?expanded=1` includes `"hasTranscript": true|false`. Uploads and deletes emit the `item_updated` socket event. Uploads are validated: `version` must be 1, `libraryItemId` must match the URL, every segment/word time must be a number within the item's playable duration (+1 s), and word start times must not decrease. Limits: 64 MB uploaded, 256 MB after decompression.

Examples (`$TOKEN` is an ABS API token or access token):

```bash
# Upload (gzip first; plain JSON files work too)
gzip -k transcript.json
curl -X POST -H "Authorization: Bearer $TOKEN" -F "transcript=@transcript.json.gz" \
  https://abs.example.com/audiobookshelf/api/items/<id>/transcript

# Download
curl --compressed -H "Authorization: Bearer $TOKEN" https://abs.example.com/audiobookshelf/api/items/<id>/transcript

# Delete
curl -X DELETE -H "Authorization: Bearer $TOKEN" https://abs.example.com/audiobookshelf/api/items/<id>/transcript
```

## Transcript format (version 1)

All times are seconds on the **book's timeline** (what the player shows), not per file. For multi-file books the helper adds each file's start offset, taken from the item's `media.tracks[].startOffset`, which is exactly what the player uses.

```json
{
  "version": 1,
  "libraryItemId": "…",
  "model": "large-v3-turbo",
  "language": "en",
  "createdAt": "2026-10-09T12:00:00Z",
  "durationSec": 2122.397,
  "source": "whisper",
  "helperVersion": "0.1.0",
  "files": [
    { "ino": "…", "filename": "01.mp3", "startOffset": 0, "duration": 567.2 },
    { "ino": "…", "filename": "02.mp3", "startOffset": 567.2, "duration": 84.9 }
  ],
  "segments": [
    {
      "start": 0.34,
      "end": 4.1,
      "text": "Once upon a midnight dreary,",
      "words": [
        { "w": "Once", "start": 0.34, "end": 0.6 },
        { "w": "upon", "start": 0.6, "end": 0.9 }
      ]
    }
  ]
}
```

- `durationSec` is the playable duration (sum of the included tracks).
- `files` records the audio files the transcript was made from; clients compare it with `media.tracks` to detect changed audio.
- `source` is `whisper` for speech recognition, or `ebook` for the text of the item's EPUB aligned to the audio.
- Segments and word start times are in ascending order; words never extend past their file's end.

Ebook transcripts (`"source": "ebook"`) use the same structure, with optional extras:

```json
{
  "source": "ebook",
  "ebook": { "title": "The Happy Prince, and Other Tales" },
  "alignment": { "bookWords": 19314, "keptWords": 16162, "matchedWords": 16108, "interpolatedWords": 54, "droppedWords": 3152, "audioWords": 16366, "audioWordsMatched": 16226 },
  "segments": [
    { "start": 24.33, "end": 25.65, "text": "The Happy Prince.", "words": [ … ], "paragraph": true, "heading": true, "spine": 2 },
    { "start": 26.99, "end": 31.9, "text": "High above the city, on a tall column, stood the statue of the Happy Prince.", "words": [ … ], "paragraph": true, "spine": 2 }
  ]
}
```

- Segments are the book's sentences; `paragraph: true` marks the first sentence of a paragraph and `heading: true` a heading.
- `spine` is the position in the EPUB's spine (the OPF `<itemref>` list, as epub.js numbers sections) of the document the sentence comes from. Words are the EPUB's whitespace-separated words, in order, so readers can find them in that document.
- `alignment` reports how much of the book was matched (`keptWords` = words in the transcript, `interpolatedWords` = misheard words timed from their neighbours, `droppedWords` = text not narrated).

## Limitations

- Web client only (the Vue client in `client/`); the mobile apps do not show transcripts yet.
- Books only (no podcast episodes).
- Creating transcripts needs the helper on the same PC as the browser; Safari cannot reach it from an HTTPS page.
- When the browser cannot play the files directly and ABS streams a transcoded HLS version, timing can drift slightly for VBR MP3 files without a duration header (ABS chapter markers have the same drift).
- While casting, the highlight follows the cast device's (less frequent) position updates.
- Ebook mode needs a DRM-free EPUB of the same edition as the recording; read-along in the reader works with the item's primary ebook (not supplementary ebook files).
- Long stretches the narrator reads differently from the printed text (e.g. tables, lists read as sentences) are shown with estimated timing or left out.
