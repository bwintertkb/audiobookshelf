"""The transcriber app without its window: sign in to an Audiobookshelf server, list its books, transcribe the
chosen ones on this computer's GPU one at a time (JobManager) and upload each transcript.

- The audio of a book is downloaded while the previous book is being transcribed (at most one book ahead), and
  deleted as soon as its transcript is complete. Files read through path_mappings are never deleted.
- A finished transcript is kept in cache/pending-uploads until the server accepted it, so a failed upload can be
  retried (also after restarting the app) without transcribing again.
- The password and tokens stay in memory (AbsClient); they are never logged or written to disk.
"""

import gzip
import json
import logging
import os
import shutil
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

from .abs_client import AbsClient, AbsError, Book
from .jobs import JobError, JobManager, _safe_name
from .languages import whisper_language_code

logger = logging.getLogger(__name__)

WAITING = "waiting"
PREPARING = "preparing"  # getting the book's details from the server
DOWNLOADING = "downloading"
QUEUED = "queued"  # audio downloaded, waiting for the GPU
TRANSCRIBING = "transcribing"
ALIGNING = "aligning"
UPLOADING = "uploading"
DONE = "done"
ERROR = "error"
UPLOAD_FAILED = "upload_failed"
CANCELLED = "cancelled"
ACTIVE = (WAITING, PREPARING, DOWNLOADING, QUEUED, TRANSCRIBING, ALIGNING, UPLOADING)
AHEAD = (PREPARING, DOWNLOADING, QUEUED)  # tasks waiting for the GPU with their audio (being) downloaded
FINISHED = (DONE, ERROR, UPLOAD_FAILED, CANCELLED)


@dataclass
class Task:
    book: Book
    mode: str  # "whisper" or "ebook"
    language: str = None  # Whisper code, None to detect
    status: str = WAITING
    progress: float = 0.0
    download_progress: float = 0.0
    eta_sec: float = None
    speed: float = None  # audio seconds per second while transcribing
    message: str = ""
    error: str = None
    job: object = field(default=None, repr=False)
    audio_files: list = field(default_factory=list)  # downloaded files, deleted when the transcript is complete
    audio_bytes: int = 0
    _speed_start: tuple = field(default=None, repr=False)


class TranscriberController:
    def __init__(self, config, transcriber_factory, gpu_info=None, client_factory=AbsClient):
        config.keep_downloads = False  # the app always deletes downloaded audio
        self.config = config
        self.gpu_info = gpu_info or {}
        self.manager = JobManager(config, transcriber_factory, gpu_info=self.gpu_info)
        self.client_factory = client_factory
        self.client = None
        self.books = []
        self.tasks = []
        self.messages = deque(maxlen=300)  # (time, text) for the window's log
        self.pending_dir = Path(config.cache_dir) / "pending-uploads"
        self._lock = threading.RLock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread = None

    # ------------------------------------------------------------------ lifecycle
    def start(self, preload_model=True):
        self.pending_dir.mkdir(parents=True, exist_ok=True)
        self._delete_leftover_downloads()
        self.manager.start(preload_model=preload_model)
        self._thread = threading.Thread(target=self._run, name="transcriber-app", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._wake.set()
        with self._lock:
            for task in self.tasks:
                if task.status in ACTIVE:
                    self._cancel(task)
        if self._thread:
            self._thread.join(timeout=10)
        self.manager.stop()
        for task in self.tasks:
            self._delete_audio(task)
        if self.client:
            self.client.sign_out()

    def note(self, text, level=logging.INFO):
        self.messages.append((time.time(), text))
        logger.log(level, text)

    @property
    def model_status(self):
        return {"state": self.manager.model_state, "error": self.manager.model_error, "model": self.manager.loaded_model or self.config.model, "gpu": self.gpu_info}

    # ------------------------------------------------------------------ server
    def sign_in(self, base_url, username, password):
        client = self.client_factory(base_url)
        client.sign_in(username, password)
        if not client.can_upload:
            client.sign_out()
            raise AbsError(f"'{username}' may not change books, so transcripts cannot be uploaded. Sign in as an admin or a user who can update items.")
        with self._lock:
            if self.client:
                self.client.sign_out()
            self.client = client
        self.note(f"Signed in to {client.base_url} as {username}")
        self._resume_pending_uploads()
        self._wake.set()
        return client.user

    def sign_out(self):
        with self._lock:
            client, self.client = self.client, None
            self.books = []
        if client:
            client.sign_out()

    def load_books(self):
        client = self._require_client()
        books = []
        for library in client.book_libraries():
            books.extend(client.books(library["id"]))
        books.sort(key=lambda b: (b.title.lower(), b.author.lower()))
        with self._lock:
            self.books = books
        self.note(f"{len(books)} books, {sum(1 for b in books if b.has_transcript)} with a transcript")
        return books

    def _require_client(self):
        if not self.client or not self.client.signed_in:
            raise AbsError("Not signed in")
        return self.client

    # ------------------------------------------------------------------ tasks
    def add(self, book, use_ebook=True, language="book"):
        """Queue a book. language: "book" (the book's metadata language, else detect), "detect", or a Whisper code"""
        with self._lock:
            if any(t.book.id == book.id and t.status in ACTIVE for t in self.tasks):
                return None
            mode = "ebook" if use_ebook and book.has_epub else "whisper"
            if language == "book":
                code = whisper_language_code(book.language)
            elif language == "detect":
                code = None
            else:
                code = language
            task = Task(book=book, mode=mode, language=code)
            self.tasks.append(task)
        self.note(f"Queued '{book.title}' ({'ebook text' if mode == 'ebook' else 'speech'}, language {code or 'detected from the audio'})")
        self._wake.set()
        return task

    def cancel(self, task):
        with self._lock:
            self._cancel(task)
        self._wake.set()

    def _cancel(self, task):
        if task.status not in ACTIVE or task.status == UPLOADING:
            return
        if task.job is not None:
            self.manager.cancel(task.job.id)
        task.status = CANCELLED
        task.eta_sec = None
        self.note(f"Cancelled '{task.book.title}'")

    def retry(self, task):
        """Upload again (the transcript is kept) or transcribe again (finished files are kept)"""
        with self._lock:
            if task.status == UPLOAD_FAILED:
                task.status = UPLOADING
                task.error = None
            elif task.status in (ERROR, CANCELLED):
                task.status, task.error, task.job, task.progress, task.message = WAITING, None, None, 0.0, ""
            else:
                return
        self._wake.set()

    def clear_finished(self):
        with self._lock:
            self.tasks = [t for t in self.tasks if t.status not in (DONE, CANCELLED)]

    # ------------------------------------------------------------------ worker
    def _run(self):
        while not self._stop.is_set():
            try:
                self._step()
            except Exception:  # pragma: no cover - keep the app running
                logger.exception("Transcriber app step failed")
            self._wake.wait(0.5)
            self._wake.clear()

    def _step(self):
        with self._lock:
            tasks = list(self.tasks)
            client = self.client
        for task in tasks:
            if task.job is not None and task.status not in FINISHED:
                self._sync(task)
        # Uploads first (the transcript is complete), then start the next book if nothing is waiting for the GPU
        for task in tasks:
            if task.status == UPLOADING and client:
                self._upload(task, client)
        if client and not any(t.status in AHEAD for t in tasks):
            next_task = next((t for t in tasks if t.status == WAITING), None)
            if next_task:
                self._submit(next_task, client)

    def _submit(self, task, client):
        task.status = PREPARING
        try:
            item = client.item(task.book.id)
            media = item.get("media") or {}
            tracks = media.get("tracks") or []
            if not tracks:
                raise AbsError("This book has no audio files")
            files = [
                {
                    "url": f"{client.base_url}{track['contentUrl']}",
                    "path": (track.get("metadata") or {}).get("path"),
                    "ino": track.get("ino"),
                    "filename": (track.get("metadata") or {}).get("filename") or track.get("title"),
                    "startOffset": track["startOffset"],
                    "duration": track["duration"],
                }
                for track in tracks
            ]
            request = {"absBaseUrl": client.base_url, "libraryItemId": task.book.id, "token": client.fresh_token(), "files": files, "mode": task.mode, "language": task.language}
            if task.mode == "ebook":
                if not (media.get("ebookFile") or {}).get("ebookFormat", "").lower() == "epub":
                    raise AbsError("The book's ebook is not an EPUB")
                request["ebookUrl"] = f"{client.base_url}/api/items/{task.book.id}/ebook"
                if item.get("hasTranscript"):
                    request["baseTranscriptUrl"] = f"{client.base_url}/api/items/{task.book.id}/transcript"
            with self._lock:
                if task.status != PREPARING:  # cancelled meanwhile
                    return
                job, existing = self.manager.submit(request)
                task.job = job
                task.status = DOWNLOADING
            self.note(f"Downloading the audio of '{task.book.title}' ({len(files)} file{'s' if len(files) != 1 else ''})")
        except (AbsError, JobError) as error:
            self._fail(task, str(error))

    def _sync(self, task):
        job = task.job
        status = job.status
        task.download_progress = job.download_progress
        for f in job.files:  # files downloaded so far (deleted when the transcript is complete)
            local = f.get("_local") if f.get("_downloaded") else None
            if local and local not in task.audio_files and Path(local).exists():
                task.audio_files.append(local)
                task.audio_bytes += Path(local).stat().st_size
        if status == "downloading":
            task.status = DOWNLOADING
        elif status == "queued":
            task.status = QUEUED
        elif status == "transcribing":
            if task.status != TRANSCRIBING:
                self.note(f"Transcribing '{task.book.title}'" + (f" ({job.cached_files} file(s) already done)" if job.cached_files else ""))
            task.status = TRANSCRIBING
            task.progress = job.progress
            task.eta_sec = job.eta_sec
            self._update_speed(task)
        elif status == "aligning":
            task.status = ALIGNING
            task.progress = 1.0
        elif status == "done":
            self._delete_audio(task)
            self._save_pending(task, job.result)
            task.progress = 1.0
            task.eta_sec = None
            task.status = UPLOADING
        elif status == "cancelled":
            task.status = CANCELLED
            self._delete_audio(task)
        elif status == "error":
            self._delete_audio(task)
            self._fail(task, job.error or job.error_code or "Transcription failed")

    def _update_speed(self, task):
        now = time.monotonic()
        audio = task.progress * task.book.duration
        if task._speed_start is None or audio < task._speed_start[1]:
            task._speed_start = (now, audio)
        elif now - task._speed_start[0] > 5:
            task.speed = (audio - task._speed_start[1]) / (now - task._speed_start[0])

    def _fail(self, task, message):
        task.status = ERROR
        task.error = message
        task.eta_sec = None
        self.note(f"'{task.book.title}' failed: {message}", logging.WARNING)

    # ------------------------------------------------------------------ results
    def _pending_path(self, item_id):
        return self.pending_dir / f"{_safe_name(item_id)}.json.gz"

    def _save_pending(self, task, transcript):
        path = self._pending_path(task.book.id)
        tmp = path.with_suffix(".tmp")
        payload = {"baseUrl": self.client.base_url if self.client else None, "book": task.book.raw, "mode": task.mode, "transcript": transcript}
        tmp.write_bytes(gzip.compress(json.dumps(payload).encode("utf-8")))
        os.replace(tmp, path)

    def _upload(self, task, client):
        path = self._pending_path(task.book.id)
        try:
            payload = json.loads(gzip.decompress(path.read_bytes()))
            result = client.upload_transcript(task.book.id, payload["transcript"])
        except (OSError, ValueError) as error:
            task.status = UPLOAD_FAILED
            task.error = f"The finished transcript could not be read: {error}"
            return
        except AbsError as error:
            task.status = UPLOAD_FAILED
            task.error = str(error)
            self.note(f"Uploading the transcript of '{task.book.title}' failed: {error}", logging.WARNING)
            return
        path.unlink(missing_ok=True)
        task.book.has_transcript = True
        task.status = DONE
        info = (result or {}).get("transcript") or {}
        freed = f"; deleted the downloaded audio ({task.audio_bytes / 1e6:,.0f} MB)" if task.audio_bytes else ""
        task.message = f"{info.get('numWords', '?'):,} words" if isinstance(info.get("numWords"), int) else ""
        self.note(f"Uploaded the transcript of '{task.book.title}'{freed}")

    def _resume_pending_uploads(self):
        """Transcripts finished earlier whose upload did not go through"""
        for path in sorted(self.pending_dir.glob("*.json.gz")):
            try:
                payload = json.loads(gzip.decompress(path.read_bytes()))
            except (OSError, ValueError):
                continue
            if payload.get("baseUrl") != self.client.base_url:
                continue
            book = Book.from_json(payload["book"])
            with self._lock:
                if any(t.book.id == book.id and t.status in ACTIVE for t in self.tasks):
                    continue
                self.tasks.append(Task(book=book, mode=payload.get("mode") or "whisper", status=UPLOADING, progress=1.0))
            self.note(f"Uploading the transcript of '{book.title}' that was finished earlier")

    # ------------------------------------------------------------------ downloaded audio
    def _delete_audio(self, task):
        """Delete the book's downloaded audio (never files read in place through path mappings)"""
        remaining = []
        for path in task.audio_files:
            for attempt in range(5):
                try:
                    Path(path).unlink(missing_ok=True)
                    break
                except OSError:
                    time.sleep(0.2 * (attempt + 1))  # e.g. still open on Windows
            else:
                remaining.append(path)
        if remaining:
            self.note(f"Could not delete {len(remaining)} downloaded file(s) of '{task.book.title}' yet; they are removed the next time the app starts", logging.WARNING)
        task.audio_files = remaining
        directory = self.manager.downloads_dir / _safe_name(task.book.id)
        if directory.is_dir() and not any(directory.iterdir()):
            directory.rmdir()

    def _delete_leftover_downloads(self):
        """Audio left by an app that was closed or crashed while transcribing"""
        downloads = self.manager.downloads_dir
        if not downloads.is_dir():
            return
        for directory in downloads.iterdir():
            shutil.rmtree(directory, ignore_errors=True) if directory.is_dir() else directory.unlink(missing_ok=True)
