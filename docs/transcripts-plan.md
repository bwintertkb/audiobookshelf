# Read-Along Transcripts for Audiobookshelf: Implementation Plan

You are working in my fork of Audiobookshelf (ABS): a Node.js server with a Nuxt/Vue web client in `client/`. Follow this plan phase by phase. **At every "STOP" checkpoint, report what you did and wait for my approval before continuing.** Re-read this file at the start of each session.

---

## 1. Goal

- A **"Create transcript"** button on a book's page in the ABS web client.
- Transcription runs **on my local machine** (the machine running the browser, which has an **NVIDIA RTX 5090**), never on the ABS server.
- The finished transcript is uploaded to and stored on the ABS server, so any device can use it later.
- While a book plays in the web player, a **transcript panel** highlights the current word and sentence, auto-scrolls, and lets me click a word to seek there.

### Non-goals (for now)
- Mobile app support (separate repo, later phase).
- Server-side transcription.
- Editing transcripts in the UI.
- Aligning against an ebook's text (possible future feature; keep the format compatible).

---

## 2. Ground rules

- **Explore before coding.** Never assume how ABS works; read the code and cite file paths in your reports.
- **Match existing patterns:** routing, controllers, permissions, Vuex/store usage, component structure, i18n strings, styling. If ABS does something a certain way, do it that way.
- **Minimal footprint:** don't refactor or reformat unrelated code. Keep changes easy to review and rebase onto upstream.
- **Git:** work on a branch named `feature/transcripts`. Make a small, descriptive commit after each completed step. Do not push.
- **Security:** never log or persist auth tokens. The helper listens on `127.0.0.1` only.
- **Ask, don't guess:** if something in this plan conflicts with how the codebase actually works, stop and tell me rather than forcing it.
- After each step, tell me **exactly** what commands to run and what to check to verify it.

---

## 3. Architecture overview

```
 Browser (ABS web client)                My PC                       ABS server
 ─────────────────────────              ───────────────────          ──────────────
 [Create transcript] ──POST job──────▶  Transcribe helper
                                        (Python, faster-whisper,
                                         CUDA on RTX 5090)
                                         │  downloads audio ◀──────── audio endpoints
                                         │  transcribes per file
 progress polling ◀──────────────────────┤
 result ◀────────────────────────────────┘
 upload transcript ─────────────────────────────────────────────────▶ new transcript API
                                                                      (stored with item metadata)
 Player transcript panel ◀── fetch transcript ◀─────────────────────
```

---

## 4. Transcript format (v1)

Stored as JSON. All times are in **seconds on the book's overall timeline** (not per-file).

```json
{
  "version": 1,
  "libraryItemId": "...",
  "model": "large-v3-turbo",
  "language": "en",
  "createdAt": "2026-10-09T12:00:00Z",
  "durationSec": 54321.5,
  "source": "whisper",
  "segments": [
    {
      "start": 12.34,
      "end": 17.80,
      "text": "It was a bright cold day in April.",
      "words": [
        { "w": "It", "start": 12.34, "end": 12.50 },
        { "w": "was", "start": 12.50, "end": 12.71 }
      ]
    }
  ]
}
```

Notes:
- **Multi-file books are the main source of bugs.** Convert each file's local timestamps to the book timeline using the same per-track start offsets ABS uses for playback. Find where ABS computes these and reuse that logic or data; don't reinvent it.
- Keep `source` so a future ebook-alignment mode can produce the same format.
- Expect ~150k words for a 15-hour book. Consider gzip on storage/transfer if size is a problem; measure first.

---

## Phase 0: Reconnaissance (no code changes)

Explore the repo and write a short report covering:

1. **Project layout and dev setup:** how to run the server and the client in dev mode, required Node version, ffmpeg requirements.
2. **Library item model:** how books, audio files/tracks, durations and chapters are represented. Where per-track **start offsets** on the book timeline are computed.
3. **Audio access:** which endpoints serve/stream/download an item's audio files, and how they authenticate (header token? query param? cookie?).
4. **Auth in the web client:** where the user's token lives and how API calls attach it.
5. **Per-item storage:** where ABS stores per-item metadata on disk (e.g. a metadata folder), and how it cleans up when an item is deleted.
6. **Routing and permissions:** how API routes, controllers, and permission checks (admin vs regular user, library access) are structured. Pick an existing endpoint to model ours on.
7. **Player:** which component(s) own playback, how `currentTime` is exposed (store, events, props), how seeking is done, and how multi-track playback maps to book time.
8. **UI conventions:** where item-page actions/buttons live, how modals are built, how settings pages and i18n strings work, theming/dark mode.
9. **Tests:** whether the repo has a test setup (server and/or client) and how to run it.
10. **Risks and open questions** you found.

**STOP:** give me the report plus a refined plan for Phases 1–4 adjusted to what you found. Wait for approval.

---

## Phase 1: Local transcription helper

Location: `tools/transcribe-helper/` (self-contained; no dependency on ABS code).

### Step 1.1: Environment and GPU check
- Python 3.10+ project with a pinned `requirements.txt` and a README with setup steps for **both Windows and Linux**.
- Use **faster-whisper** (CTranslate2). The RTX 5090 is Blackwell (sm_120): verify which CTranslate2 / CUDA / cuDNN versions actually support it, pin them, and document required NVIDIA driver and CUDA versions. If faster-whisper can't use the 5090 yet, tell me and propose an alternative (e.g. a PyTorch-based Whisper/WhisperX build with CUDA 12.8+).
- `check_gpu.py` (and a check on service startup): prints GPU name, CUDA availability, compute capability, and does a tiny test inference. Fails with a clear message if CUDA isn't usable.

**STOP:** tell me how to install and run the check. I'll confirm it works on my machine.

### Step 1.2: CLI transcription of one file
- `transcribe_cli.py <audio_file> --model large-v3-turbo --out out.json`
- Settings: `device="cuda"`, `compute_type="float16"`, `word_timestamps=True`, `vad_filter=True`, `condition_on_previous_text=False` (reduces repetition/hallucination loops on long audio), configurable `language` (default auto, but allow forcing), configurable `beam_size`.
- Output in the v1 format (offset 0 for a single file).
- Print progress (percentage of audio duration processed) and a real-time factor at the end.

**STOP:** tell me how to run it on a test file.

### Step 1.3: Multi-file books
- Accept a list of files plus their book-timeline start offsets; transcribe each and merge into one transcript with correct global timestamps.
- Sanity checks: segments are monotonically increasing, no segment crosses into the wrong file's range, final timestamp ≈ book duration.

### Step 1.4: HTTP service
A small local HTTP service (FastAPI or similar), bound to `127.0.0.1` on a configurable port (default e.g. `8765`).

Endpoints:
- `GET /health`: version, GPU name, loaded model, busy/idle.
- `POST /jobs`: body `{ absBaseUrl, libraryItemId, token, files: [{ url or path, startOffset, duration }], model?, language? }` → `{ jobId }`.
- `GET /jobs/{id}`: status (`queued | downloading | transcribing | done | error | cancelled`), overall progress %, current file index, ETA, error message.
- `GET /jobs/{id}/result`: the transcript JSON when done.
- `DELETE /jobs/{id}`: cancel.

Behavior:
- **One GPU job at a time**; additional jobs queue.
- Load the model once and keep it warm.
- Download audio files to a temp/cache dir using the provided token. Hold the token **in memory only for the job's lifetime**; never log it.
- Optional **path mapping**: if a configured mapping says the ABS library folder is also mounted locally (e.g. a NAS share), read files directly instead of downloading.
- **Resume:** cache per-file results keyed by (item ID, file identifier, model). If a job is restarted, skip files already done.
- Clean up downloaded audio after the job (configurable).

CORS and browser access:
- Allow only configured ABS origin(s).
- Handle Chrome's **Private Network Access** preflight (`Access-Control-Allow-Private-Network: true`), since the ABS page may be served over HTTPS from another host while calling `http://127.0.0.1`.

Config via a `config.toml` or env vars: port, allowed origins, model, cache dir, path mappings.

### Step 1.5: Helper tests
- Unit tests for offset merging and the format.
- A short end-to-end test with a small public-domain audio sample (download script or tiny fixture).

**STOP:** summarize Phase 1 and how to run the service.

---

## Phase 2: Server (ABS) transcript storage and API

Model everything on the existing patterns you found in Phase 0.

### Step 2.1: Storage
- Store `transcript.json` (or gzipped, if justified) alongside the item's existing metadata on disk, wherever ABS keeps per-item data. Do **not** write into the media folders unless that's how ABS stores similar data.
- Ensure it's removed when the item is deleted, following existing cleanup logic.

### Step 2.2: Endpoints
- `GET    /api/items/:id/transcript`: returns the transcript (404 if none). Support compression/ETag if ABS does so elsewhere.
- `PUT    /api/items/:id/transcript`: upload/replace.
- `DELETE /api/items/:id/transcript`: remove.
- `GET` requires access to the item. `PUT`/`DELETE` require whatever permission level ABS uses for editing item metadata (confirm with me if unclear).
- Validate uploads: correct `version`, `libraryItemId` matches the URL, timestamps are numbers and in range, sane size limit (raise the body limit for this route only if needed).
- Expose a lightweight `hasTranscript` flag on the item (wherever minimal item data is sent to the client), so the UI doesn't need an extra request to know.

### Step 2.3: Server tests
Add tests using the repo's existing test setup if there is one; otherwise give me `curl` commands to exercise each endpoint.

**STOP:** summarize and show how to test.

---

## Phase 3: Web client

### Step 3.1: Helper settings and detection
- A setting for the helper URL (default `http://127.0.0.1:8765`). It's per-browser, not a server setting, so store it client-side the same way ABS stores other per-device preferences.
- A small service/composable/store module that pings `GET /health` and caches whether the helper is available.

### Step 3.2: "Create transcript" flow
- Button on the book's page (match where similar actions live). Shown only when the helper is reachable and the user has permission to upload transcripts. Label changes to "Re-create transcript" if one exists (with a confirm dialog).
- On click: build the file list with book-timeline offsets from the item data, get the token the way the client already does, and `POST /jobs` to the helper.
- Progress UI (modal or toast, matching ABS conventions): status, %, ETA, current file, cancel button.
- On completion: fetch the result from the helper and `PUT` it to the ABS server. Show success/error.
- If I navigate away and come back, reconnect to an in-progress job (remember the job ID per item client-side).
- All user-facing strings go through ABS's i18n system.

### Step 3.3: Transcript panel in the player
- A toggle button in the player to open/close the panel (desktop: side or bottom panel; narrow screens: full-width drawer). Remember open/closed state.
- Fetch the transcript when the panel opens (only if `hasTranscript`).
- **Sync:** find the current word with binary search over word start times on each time update. Highlight the current sentence/segment and the current word. Avoid re-rendering the whole list on every tick.
- **Virtualize** the list. 150k words must stay smooth. Render segments (not individual word elements) outside the visible window.
- **Auto-scroll** to keep the current segment in view, but pause auto-scroll when I scroll manually, with a "Return to current position" button.
- **Click a word to seek** using the player's existing seek mechanism.
- Must work correctly with: multi-file books, playback speed changes (every speed the player offers), seeking, chapter jumps, pause/resume, and switching to another book.
- Respect theming (light/dark) and readable font sizing.

**STOP:** tell me how to test the full flow end to end.

---

## Phase 4: Polish

- Search within the transcript (jump to results).
- Show chapter titles as headings within the transcript, using existing chapter data.
- Clear error states: helper offline, GPU unavailable, download failed (auth/expired token), upload too large, transcript missing.
- Handle transcript/audio mismatch: if the item's audio files changed since the transcript was made (different durations or file count), show a warning suggesting re-creation. Store enough info in the transcript (e.g. file list with durations) to detect this.
- Update the helper README with screenshots-free, step-by-step setup for a new user.
- Write a short `docs/transcripts.md` explaining the feature, setup, and format.

**STOP:** final summary, list of all changed/added files, and known limitations.

---

## Phase 5 (later, separate session): Mobile app

Out of scope now. For future reference: in `advplyr/audiobookshelf-app`, add a read-only transcript view that fetches `GET /api/items/:id/transcript` and syncs to the native player's position. No transcription on mobile.

---

## Test checklist (use throughout)

- [ ] Single-file book (m4b or mp3)
- [ ] Multi-file book (many mp3s): highlighting stays in sync across file boundaries
- [ ] Book with chapters: chapter jumps keep sync
- [ ] Seeking forward/back, including far jumps
- [ ] **Every** playback speed the player offers (0.5x to 10x in 0.05/0.1 steps), not just a few
- [ ] Pause, resume, reload page mid-book
- [ ] 15+ hour book: panel scrolls smoothly, memory is reasonable
- [ ] Helper not running: button hidden or disabled with explanation
- [ ] Cancel mid-job, then restart: already-finished files are skipped
- [ ] Re-create transcript overwrites the old one
- [ ] Non-admin user: can view transcripts, can't upload unless permitted
- [ ] ABS served over HTTPS from another host: helper calls still work (CORS/PNA)
- [ ] Deleting a book removes its transcript

---

## Decisions after Phase 0 (approved 2026-10-09)

1. Upload is `POST /api/items/:id/transcript` (ABS has no PUT routes; matches cover/chapters uploads).
2. Upload requires `canUpdate` (same as editing chapters). Delete goes through the item middleware and requires `canDelete` (same as removing a cover).
3. The client gzips the transcript and uploads it as a multipart file (avoids the global 10 MB JSON body limit). Stored gzipped as `<MetadataPath>/items/<id>/transcript.json.gz`, regardless of "store metadata with item". Removed with the item's metadata folder; included in backups.
4. `hasTranscript` is derived from `libraryItem.extraData.transcript` (JSON column, no migration) and only exposed in the expanded item JSON (item page, player, socket `item_updated`).
5. The web client has no light/dark app theme; the panel uses the app's dark palette plus its own font size setting.
6. Format v1 additionally carries `files: [{ino, filename, startOffset, duration}]` and `helperVersion` (used for audio mismatch detection). `durationSec` is the sum of the included tracks, not `media.duration`.
7. Speed sync must hold at every speed the player offers (0.5x–10x); the panel uses its own requestAnimationFrame loop instead of the player's 1 Hz time updates.
