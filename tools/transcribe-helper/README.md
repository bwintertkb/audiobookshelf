# ABS transcribe helper

A small local service that creates read-along transcripts for Audiobookshelf books on **your own GPU**.
The ABS web client sends it a job, the helper downloads the book's audio from your ABS server,
transcribes it with [faster-whisper](https://github.com/SYSTRAN/faster-whisper) and hands the
transcript back to the browser, which uploads it to ABS. Nothing runs on the ABS server.

- Listens on `127.0.0.1` only (default port `8765`).
- One GPU job at a time; further jobs queue. The model stays loaded between jobs.
- Your ABS access token is kept in memory only while audio is downloading, and is never logged or written to disk.

## Everything runs locally on your GPU

- Transcription runs on **your NVIDIA GPU** with faster-whisper (CTranslate2). "Whisper" is the name of
  the open-weights speech model; **no OpenAI (or any other cloud) API is used**, and no audio or text
  leaves your machine.
- The helper never falls back to the CPU on its own: if CUDA is not usable, jobs fail with
  `gpu_unavailable` (CPU only runs if you explicitly set `device = "cpu"`).
- Network access is limited to:
  - your ABS server, to download the book's audio (skipped for files reachable through `path_mappings`);
  - Hugging Face, **only the first time** a model is used, to download its weights (~1.6 GB for
    `large-v3-turbo`). After that the model is loaded from the local cache without any network request
    (`check_gpu.py` downloads the small `tiny` model the same way). Telemetry is disabled.

## Requirements

| | |
|---|---|
| GPU | NVIDIA GPU with CUDA support. Tested on an RTX 5090 (Blackwell, compute capability 12.0). |
| NVIDIA driver | **570 or newer** for RTX 50xx (Blackwell needs CUDA 12.8+); 525+ for older GPUs. Tested with 610.88. |
| CUDA toolkit | **Not needed.** cuBLAS comes from NVIDIA's pip wheel; cuDNN 9 is bundled with CTranslate2 on Windows and installed from pip on Linux. |
| Python | 3.10 – 3.12 (64-bit). Tested with 3.12. |
| ffmpeg | Not needed (audio is decoded by PyAV, which bundles its own ffmpeg libraries). |
| Disk | ~1.6 GB for the `large-v3-turbo` model, plus room for one book's audio while it is transcribed. |

Version notes (why things are pinned): CTranslate2 added CUDA 12.8 / Blackwell support in 4.6.3
(INT8 is disabled on sm_120, so the helper uses float16). faster-whisper 1.2.1 is incompatible with
PyAV 19, so PyAV is pinned to 18.1.

## Setup on Windows

Open PowerShell in this folder (`tools\transcribe-helper`):

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python -m pip install --upgrade pip
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python check_gpu.py
```

`check_gpu.py` prints the GPU name, compute capability, driver and CTranslate2 versions, then runs a
tiny test inference (downloads the ~75 MB `tiny` model once). It ends with `OK: CUDA is usable for
transcription.` or a clear error and exit code 1.

## Setup on Linux

```bash
cd tools/transcribe-helper
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python check_gpu.py
```

The helper preloads cuBLAS and cuDNN from the `nvidia-*` pip packages, so `LD_LIBRARY_PATH` is not
needed. (Linux has not been tested on real hardware yet; if CTranslate2 still cannot find
`libcudnn*.so.9` or `libcublas.so.12`, add the `lib` folders under
`.venv/lib/python3.*/site-packages/nvidia/*/` to `LD_LIBRARY_PATH`.)

## Transcribe files from the command line

```powershell
# One file (book timeline offset 0)
.\.venv\Scripts\python transcribe_cli.py chapter01.mp3 --out chapter01.json

# A multi-file book: files in book order, offsets = running sum of durations
.\.venv\Scripts\python transcribe_cli.py 01.mp3 02.mp3 03.mp3 --out book.json

# Exact offsets (e.g. copied from ABS media.tracks): manifest = [{"path", "startOffset", "duration"}]
.\.venv\Scripts\python transcribe_cli.py --manifest files.json --out book.json
```

Options: `--model` (default `large-v3-turbo`), `--language en` (default: detect on the first file and
use it for the whole book), `--beam-size` (default 5), `--device cpu`. Progress is printed as a
percentage of the audio; at the end you get the real-time factor and a sanity check of the merged
timestamps.

To try it on public-domain audio: `python scripts/fetch_sample.py --all` downloads LibriVox's
"The Raven and Other Poems" (12 short MP3s) into `tests/fixtures/audio`. On an RTX 5090 the 35 minutes
transcribe in ~22 s with `large-v3-turbo` (~100x real time).

## Run the service

```powershell
.\.venv\Scripts\python run_helper.py
```

It logs the GPU, the model (loaded in the background) and the allowed origins, then listens on
`http://127.0.0.1:8765`. Check it with `curl http://127.0.0.1:8765/health`.

### Configure

Copy `config.example.toml` to `config.toml` and edit it. The important setting is
**`allowed_origins`**: the address you open ABS at in your browser, for example
`https://abs.example.com` or `http://192.168.1.10:13378` (scheme, host and port; no path). Requests
from any other web page are rejected. You can also pass `--allow-origin https://abs.example.com` on
the command line.

Other settings: `port`, `model`, `beam_size`, `cache_dir`, `keep_downloads`, and `path_mappings`
(if the ABS library folder is also mounted on this PC, e.g. a NAS share, files are read from there
instead of downloaded). Environment variables `TRANSCRIBE_HELPER_PORT`,
`TRANSCRIBE_HELPER_ALLOWED_ORIGINS`, `TRANSCRIBE_HELPER_MODEL`, `TRANSCRIBE_HELPER_CACHE_DIR`,
`TRANSCRIBE_HELPER_DEVICE` and `TRANSCRIBE_HELPER_CONFIG` override the file.

### Use it from ABS

1. Start the helper on the PC you use ABS from.
2. In the ABS web player, open **Player settings** (the gear icon in the player) and check that the
   transcription helper URL is `http://127.0.0.1:8765`; the status next to it should say it is connected.
3. On a book's page, open the **⋮** menu and choose **Create transcript**. Progress is shown on the
   page; you can navigate away and come back. When it finishes, the transcript is uploaded to ABS.
4. Play the book and press the transcript button in the player.

Browser notes:
- **Chrome / Edge 142+**: if ABS is served from a public address, the browser asks once for
  permission to access devices on your local network (the helper on `127.0.0.1`). Allow it. ABS on
  `localhost` or a LAN address does not trigger the prompt.
- **Firefox** allows HTTPS pages to call `http://127.0.0.1`.
- **Safari** blocks HTTPS pages from calling `http://127.0.0.1`; use Chrome, Edge or Firefox to
  create transcripts (viewing transcripts works everywhere).

## API

| Method | Path | |
|---|---|---|
| GET | `/health` | version, GPU info, model and its state (`loading`, `ready`, `error`), busy/idle, queue length |
| POST | `/jobs` | `{absBaseUrl, libraryItemId, token, files: [{url?, path?, ino?, filename?, startOffset, duration}], model?, language?, beamSize?, force?}` → `201 {jobId}` (or `200` with `existing: true` if a job for that item is already running) |
| GET | `/jobs` | all jobs (status only) |
| GET | `/jobs/{id}` | `status` (`downloading`, `queued`, `transcribing`, `done`, `error`, `cancelled`), `progress` 0–1, `downloadProgress`, `currentFileIndex`, `numFiles`, `etaSec`, `error`, `errorCode`, `warnings` |
| GET | `/jobs/{id}/result` | v1 transcript JSON once `done` (409 before) |
| DELETE | `/jobs/{id}` | cancel |

Error codes: `auth_expired` (the ABS token was rejected; start the job again), `forbidden`,
`not_found`, `download_failed`, `gpu_unavailable`, `transcription_failed`, `invalid_request`.

Behaviour details:
- Audio is downloaded right after a job is submitted (ABS access tokens expire after about an hour),
  then the token is dropped. Every file URL must be on `absBaseUrl`, and redirects to other hosts are
  refused, so the token can only reach the ABS server it came from.
- Results are cached per file (item, file, model, language). If a job is cancelled or fails, submitting
  it again skips files that were already transcribed. The cache for a book is cleared when a job for it
  completes, so "Re-create transcript" always transcribes again. `force: true` ignores the cache.
- The language is detected on the first file and then used for the rest of the book (unless forced).

## Tests

```powershell
.\.venv\Scripts\python -m pip install -r requirements-dev.txt
.\.venv\Scripts\python scripts\fetch_sample.py     # sample audio for the end-to-end test
.\.venv\Scripts\python -m pytest
```

Unit tests cover offset merging, clamping, monotonic ordering, the format and sanity checks; job and
API tests use a fake ABS server and a fake transcriber (downloads, auth errors, cancel/resume,
one-job-at-a-time, path mapping, CORS/PNA, host checks). `tests/test_e2e.py` runs a real model
(`tiny` by default, `TRANSCRIBE_HELPER_E2E_MODEL=large-v3-turbo` to change) on three LibriVox tracks
served by the fake ABS server; it is skipped when the samples or CUDA are missing.

## Troubleshooting

- **`check_gpu.py`: "No CUDA device is visible"**: install or update the NVIDIA driver (570+ for RTX 50xx).
- **`Could not load library cublas64_12.dll` / `libcublas.so.12`**: reinstall the requirements
  (`nvidia-cublas-cu12` provides it). Make sure you run the venv's Python.
- **`no kernel image is available for execution on the device`**: CTranslate2 is too old for your GPU;
  use the pinned version (4.8.2).
- **ABS says the helper is not reachable**: is `run_helper.py` running, and is the ABS address in
  `allowed_origins`? The helper log shows rejected origins as HTTP 403.
- **Job error `auth_expired`**: your ABS session token expired before the audio was downloaded.
  Start the job again; files already transcribed are skipped.
