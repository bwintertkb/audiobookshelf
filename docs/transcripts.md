# Read-along transcripts

Create a word-level transcript of an audiobook on your own GPU, store it on the Audiobookshelf server, and follow along in the web player: the current words and sentence are highlighted, the text scrolls with the audio, and clicking a word jumps there.

```
 Browser (ABS web client on your PC)                                    ABS server
 [Create transcript] -> checks the GPU, downloads the speech model once
 Whisper on your GPU (WebGPU workers) ◀── 16 kHz audio ──────────────── GET /api/items/:id/transcript/audio/:fileid (ffmpeg)
 EPUB text lined up with the speech (ebook mode) ◀── EPUB ───────────── GET /api/items/:id/ebook
 upload ────────────────────────────────────────────────────────────────▶ POST /api/items/:id/transcript
 player transcript panel, ebook reader ◀─────────────────────────────── GET /api/items/:id/transcript
```

Everything happens in the Audiobookshelf web page: speech recognition runs on the GPU of the computer you browse from, with the open-weights Whisper model (`whisper-large-v3-turbo`, via [transformers.js](https://huggingface.co/docs/transformers.js) and WebGPU). The ABS server only converts the audio for it with ffmpeg and stores the result; no audio or text is sent anywhere else. Once uploaded, a transcript works in any browser and in the Android app.

## Requirements

- A browser with WebGPU: Chrome or Edge 113+, Firefox 141+ (Windows). Hardware acceleration must be on.
- ABS opened over HTTPS (or on the same computer as `localhost`): browsers only allow the GPU on secure pages. `http://<LAN address>` does not work.
- A GPU with enough memory: each worker holds its own copy of the model (about 4.5 GB with fp16). Workers are added one at a time while each one makes transcription at least 5% faster, up to 8. A worker that makes it slower (the GPU memory is full and has to be swapped) is removed again, as is one when the speed later falls a lot (e.g. a game starts).
- About 1.6 GB of browser storage for the speech model (0.8 GB on GPUs without 16-bit float support, which use a smaller model).

Nothing has to be installed: the first time, the setup dialog downloads the model from Hugging Face into the browser.

## Use

- **Create**: on a book's page open the **⋮** menu and choose **Create transcript** (shown to users who can edit items). A dialog checks this computer: secure page, GPU (with its name), speech model (with a **Download** button the first time, about a minute on a fast connection) and storage space, and says what is missing. Pick the language (preselected from the book's metadata, or detected automatically) and press **Start**. Progress, the number of GPU workers, the speed ("24x real time") and the time remaining are shown on the page. The browser console logs the speed measured for each number of workers (`[browserTranscriber] 4 workers: 23.3x real time`).
  - Keep the page open while it transcribes (you can use Audiobookshelf in it meanwhile; the browser asks before you close it). Finished parts are kept in the browser: if the page is closed, **Create transcript** continues where it stopped.
  - When it finishes the transcript is uploaded and a confirmation appears.
- **Re-create**: **Re-create transcript** in the same menu (asks for confirmation) replaces it.
- **Delete**: **Delete transcript** (users with delete permission).
- **Read along**: while the book plays, press the transcript button (subtitles icon) in the player. The panel opens on the right (full width on narrow screens) and remembers whether it was open.
  - The current sentence and words are highlighted at every playback speed (0.5x to 10x): the narrated word with the word before and after it, which is easier to follow than a single word.
  - A transcript made from the book's EPUB is laid out like the book: its paragraphs (justified, indented) and headings, in a serif font. **Aa** (text and layout) changes the text size, the font (Sans, Serif or Lexend), the layout (**Book**, or **Sentences**: one sentence per line) and the number of highlighted words (1, 3 or 5, shared with the ebook reader).
  - It scrolls with the audio; scroll yourself to look around and use **Return to current position** to follow the audio again.
  - Click a word to jump to it, or a chapter heading to jump to the chapter.
  - Right-click a word (long-press on a touch screen) for its definition, or select words with the mouse: a menu offers four highlight colours, a note, **Play from here** and copy. See [Highlights and notes](#highlights-and-notes).
  - **Open in book** (book icon; transcripts made from the EPUB) opens the ebook reader at the narrated sentence while the audio keeps playing.
  - Search (magnifier icon), with Enter / Shift+Enter for the next / previous result.
  - If the book's audio files changed after the transcript was made (files added, removed or replaced), the panel warns that the highlighting may be out of sync; re-create the transcript.
- **Sleep timer**: for books with a transcript, a timer that runs out mid-sentence plays on to the end of the sentence (or paragraph) and stops there. Choose **Stop**, **Finish sentence** (default) or **Finish paragraph** in the sleep timer menu; it never plays on for more than 30 s (sentence) or 2 minutes (paragraph).
- **Media controls**: the browser's media controls (and a phone's lock screen) show the sentence being read in place of the author. **Player settings → Show the sentence being read in the media controls** turns it off.

On an RTX 5090, transcription in the browser runs at about 25–30x real time with 4–8 workers: a 15 hour book takes 30–40 minutes. It is slower when other programs or browser tabs use much of the GPU memory; keep the page visible (browsers slow down hidden tabs). Its words match the transcribe helper's (faster-whisper) for about 97% of the text, with word times within 0.1 s for three quarters of the words.

### Transcribe helper (optional)

The Python helper in [`tools/transcribe-helper`](../tools/transcribe-helper/README.md) (faster-whisper on CUDA) is about 3x faster but has to be installed and running on the PC. To use it, choose **Player settings → Create transcripts with → Transcribe helper (advanced)** and set its address; see its README for setup (`allowed_origins`, browser permissions). Helper jobs continue in the helper when the page is closed.

## Use the book's own text (EPUB)

If the book also has an EPUB in ABS, choose **Create transcript from ebook** in the **⋮** menu. To add one, choose **Upload ebook** in the same menu and pick the `.epub` on your computer (users who can upload and edit; it is saved in the book's folder and the book page then shows **Read**), or put the file in the book's folder yourself. The [transcriber app](../tools/transcribe-helper/README.md#transcriber-app-windows) does both in one step: **Add EPUB…** uploads the EPUB to the book and queues its transcript from the ebook. The words are still timed with Whisper on your GPU, then the EPUB's text is lined up with the narration:

- The transcript shows the book's real text: spelling, punctuation, quotes, paragraphs and chapter headings.
- Text that is not read aloud (title pages, contents, copyright and license pages, captions, footnotes) is left out; speech that is not in the book (narrator intros, "Chapter two of …" announcements) simply has no text.
- If the book already has a normal transcript made from the same audio files, it is reused: no audio is downloaded or transcribed and the alignment takes seconds.
- Only DRM-free EPUB files can be used. If the EPUB is a different edition or the wrong book, the job stops with "The ebook text does not match the audio". An abridged recording only gets the parts that were read.

## Read along in the ebook reader

With a transcript made from the ebook, open the book with **Read** while the audiobook plays:

- The narrated sentence and words are highlighted in the book itself (3 words by default, the narrated one in the middle and within its sentence; 1, 3 or 5 in the reader's settings under **Read-along highlight**), with the book's formatting (fonts, italics, images, the reader's themes and font settings), at every playback speed. The player stays at the bottom of the screen with its speed control.
- Pages turn by themselves to follow the narration. Turn a page yourself to look around and use **Return to narration** to follow the audio again.
- Click a word to move the audio there.
- **Play from here** starts the audiobook at the first narrated word of the page you are reading. It shows when the audiobook is not playing, and while it plays when you are on another page than the narration (for example after reading ahead): then it moves the narration to your page.
- Select words or right-click a word for the definition and highlight menu; highlights and notes show in the book, and the notes button in the reader's top bar lists them (choosing one turns to it without moving the audio).
- **Reading and listening stay in the same place** (reader settings, on by default): turning pages while the audiobook is not playing moves the listening position to the page, so pressing play continues where you stopped reading (also on another device). Opening the book when you have listened on since you last read it turns to where you stopped listening, with **Back to where you were reading**. Reading ahead while the audiobook plays does not move it.

This uses the [CSS Custom Highlight API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API) (Chrome/Edge 105+, Safari 17.2+, Firefox 140+); older browsers highlight the sentence only.

## Highlights and notes

Highlight the transcript or the book like on a Kindle:

- **Choose words**: in the web client select words with the mouse, or right-click a word; in the app long-press a word, and keep the finger down and drag to choose more. A single word shows its definition.
- **Highlighter** (pen button in the transcript panel and the reader's top bar, shared): while it is on, words you select are highlighted right away in the colour you picked last, without the menu. Right-click (or long-press, in the app) a highlight to change it, add a note or delete it.
- **Highlight** in yellow, blue, pink or orange; **Note** adds a note (marked with a note icon after the highlight in the transcript). Choosing a highlighted word again opens the highlight to change its colour or note, or delete it.
- **Notes & highlights** (note icon in the transcript panel and the reader) lists them in book order with their chapter and time: go to one, edit its note, delete it, or **Export** them all as a Markdown file (the app shares the file).
- Highlights are stored on the server per user, so the web client and the app show the same ones (changes made on another device appear when the book is reopened, or right away while it is open). The app keeps them for reading offline and sends highlights made offline when it is connected again.
- Definitions come from an offline English dictionary (Princeton WordNet 3.1, about 87,000 words, built into the web client and the app at build time by `client/scripts/buildDictionary.js`; nothing is sent to an online service). Plurals, verb forms and irregular forms (geese, ran, better) find their base word.

## Android app

The `feature/transcripts` branch of the Audiobookshelf app (`audiobookshelf-app`) shows transcripts too; see `docs/read-along.md` there for building and installing it. It needs a server running this version.

- **Player**: in the full-screen player, the transcript button (next to the chapters button) shows the transcript instead of the cover, with the same highlighting, scrolling, search, text size and tap-to-jump as the web player.
- **Ebook reader**: with a transcript made from the ebook, **Read** the book while it plays (or **Open in book** in the transcript) to see the narrated sentence and words highlighted in the book, with the reader's own formatting and settings (**Read-along highlight** in the reader settings, or **Aa** in the transcript, chooses 1, 3 or 5 words). Pages turn with the narration; swiping turns pages yourself and **Return to narration** follows the audio again. **Long-press** a word (and drag for more words) for its definition, highlights, notes and **Play from here** (a tap still shows the reader toolbar). **Play from here** at the bottom starts the audiobook at the page you are reading, also while it plays after you read ahead of the narration. The speed button in the reader's bottom bar changes the playback speed without leaving the book. Reading and listening stay in the same place as in the web client, also for downloaded books.
- **Lock screen and sleep timer**: the lock screen and media notification show the sentence being read (**Settings → Show the sentence being read on the lock screen**), and the sleep timer can finish the sentence or paragraph (tap the option at the bottom of the sleep timer menu). Both work with the screen off.
- **Offline**: downloading a book also downloads its transcript (and the ebook, as before). For a book downloaded before it had an ebook or transcript, or to update the transcript after re-creating it, choose **Download ebook and transcript** in the book's **⋮** menu: only those files are added to the downloaded book. A downloaded transcript is used even when the server cannot be reached.
- Creating transcripts is done in the web client (the GPU helper runs on your PC).

## Permissions

| Action                      | Requires                                                      |
| --------------------------- | ------------------------------------------------------------- |
| View a transcript           | access to the item (library, tags, explicit content)          |
| Create / re-create (upload) | "Can Update" (same as editing chapters)                       |
| Delete                      | "Can Delete" (same as removing a cover; root only by default) |

## Storage

Highlights and notes are stored per user at `<metadata>/items/<libraryItemId>/annotations/<userId>.json` (removed with the item, included in backups).

Transcripts are stored gzipped at `<metadata>/items/<libraryItemId>/transcript.json.gz`, next to the item's cover and `metadata.json` (also when "store metadata with item" is enabled, so nothing is written to the media folders). They are deleted together with the library item, and included in backups. A 15 hour book is about 8 MB of JSON, 1.5 MB gzipped. The item record keeps a short summary in `extraData.transcript`, which the API exposes as `hasTranscript` on the expanded item.

## API

| Method | Path                        |                                                                                                                                                                                      |
| ------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/items/:id/transcript` | the transcript JSON (served `Content-Encoding: gzip`, with ETag/304); 404 if none                                                                                                    |
| POST   | `/api/items/:id/transcript` | upload or replace: multipart file field `transcript` (gzipped or plain JSON), or a JSON body (JSON bodies are limited to 10 MB by the server, so use the file upload for long books) |
| DELETE | `/api/items/:id/transcript` | remove                                                                                                                                                                               |
| POST   | `/api/items/:id/ebook` | add an ebook file (multipart field `ebook`: epub, pdf, mobi, azw3, cbr, cbz) to the book's folder and scan the book; the first ebook becomes the main one; requires "Can Upload" and "Can Update"; 409 if a file with that name is already there |
| GET    | `/api/me/item/:id/annotations` | the user's highlights and notes in the book: `{ annotations: [{ id, start, end, text, color, note, createdAt, updatedAt }] }` in book order (`start` / `end`: start times of the first and last transcript word) |
| PUT    | `/api/me/item/:id/annotations/:annotationId` | create or replace a highlight (the client chooses the id, 8–64 letters, digits, `-` or `_`; `color`: yellow, blue, pink or orange). The copy with the newer `updatedAt` is kept, so changes made offline can be sent later. Emits `annotations_updated` `{ libraryItemId }` to the user's other clients |
| DELETE | `/api/me/item/:id/annotations/:annotationId` | delete a highlight (404 if it is not there) |
| GET    | `/api/items/:id/transcript/audio/:fileid?start=<sec>&duration=<sec>` | part of an audio file (by inode) decoded with ffmpeg to raw 16 kHz mono 16-bit PCM (`s16le`), for speech recognition in the browser; at most 900 s per request; requires "Can Update" |

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

- Web client and the Android app built from the `feature/transcripts` branch of `audiobookshelf-app`; the official app builds and iOS do not show transcripts.
- Books only (no podcast episodes).
- Creating transcripts needs a browser with WebGPU on a page served over HTTPS (or localhost), and the page has to stay open meanwhile (the optional helper keeps working without it).
- When the browser cannot play the files directly and ABS streams a transcoded HLS version, timing can drift slightly for VBR MP3 files without a duration header (ABS chapter markers have the same drift).
- While casting, the highlight follows the cast device's (less frequent) position updates.
- Ebook mode needs a DRM-free EPUB of the same edition as the recording; read-along in the reader works with the item's primary ebook (not supplementary ebook files).
- Long stretches the narrator reads differently from the printed text (e.g. tables, lists read as sentences) are shown with estimated timing or left out.
