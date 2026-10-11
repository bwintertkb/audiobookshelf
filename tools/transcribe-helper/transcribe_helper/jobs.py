"""Job queue: download audio from ABS, transcribe on the GPU one job at a time, merge into a v1 transcript.

Lifecycle: downloading -> queued -> transcribing [-> aligning] -> done | error | cancelled
- Audio is downloaded as soon as a job is submitted (ABS access tokens expire after ~1 hour), then the
  token is dropped from memory. Jobs wait for the single GPU worker in the "queued" state.
- With an audio_preparer, a queued job's audio is decoded and its speech found on the CPU ("stage":
  "preparing") while the GPU transcribes the job before it, so the GPU can start on it right away. Only one
  prepared job waits for the GPU at a time: a long book's audio takes gigabytes of memory. On the GPU, the
  stage is "starting" until the first words are transcribed.
- Per-file results are cached on disk keyed by (library item, file, model, requested language), so a
  cancelled or failed job that is submitted again skips files that were already transcribed. The cache
  for an item is cleared once a job for it completes.
- Ebook mode ("mode": "ebook") aligns the book's EPUB text with the Whisper words. If the item already
  has a Whisper transcript made from the same audio files ("baseTranscriptUrl"), it is reused and no
  audio is downloaded or transcribed.
"""

import gzip
import hashlib
import json
import logging
import os
import queue
import re
import shutil
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import OrderedDict
from pathlib import Path, PurePosixPath

from . import __version__
from .align import EbookAlignmentError, align_ebook
from .ebook import EbookError, read_epub
from .transcriber import TranscriptionCancelled
from .transcript import build_transcript, coverage_summary, merge_file_results, sanity_check

logger = logging.getLogger(__name__)

TERMINAL_STATUSES = ("done", "error", "cancelled")
DOWNLOAD_CHUNK = 1 << 16
MAX_EBOOK_BYTES = 200 * 1024 * 1024
MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024


class JobError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class _Cancelled(Exception):
    pass


class _SameOriginRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Follow redirects only within the same origin so the Authorization header never leaves the ABS server."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old = urllib.parse.urlsplit(req.full_url)
        new = urllib.parse.urlsplit(urllib.parse.urljoin(req.full_url, newurl))
        if (old.scheme, old.netloc) != (new.scheme, new.netloc):
            raise JobError("download_failed", f"ABS server redirected to another host ({new.netloc}); refusing to follow")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_SameOriginRedirectHandler)


def _safe_name(value):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", str(value))[:80] or "x"


def _now():
    return time.time()


def _iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts)) if ts else None


class Job:
    def __init__(self, request, model):
        self.id = uuid.uuid4().hex
        self.library_item_id = request["libraryItemId"]
        self.abs_base_url = request["absBaseUrl"].rstrip("/")
        self._token = request.get("token")  # dropped as soon as downloads finish; never logged
        self.files = [dict(f) for f in request["files"]]
        self.model = model
        self.language = request.get("language") or None
        self.beam_size = request.get("beamSize")
        self.force = bool(request.get("force"))
        self.mode = request.get("mode") or "whisper"
        self.ebook_url = request.get("ebookUrl")
        self.base_transcript_url = request.get("baseTranscriptUrl")
        self.ebook = None
        self.alignment = None
        self.status = "downloading"
        self.stage = None  # "preparing" (queued) or "starting" (transcribing), before the GPU transcribes words
        self.stage_progress = None
        self._ahead = False  # holds the JobManager's slot for a prepared job waiting for the GPU
        self.progress = 0.0
        self.download_progress = 0.0
        self.current_file_index = None
        self.eta_sec = None
        self.error = None
        self.error_code = None
        self.warnings = []
        self.detected_language = None
        self.realtime_factor = None
        self.created_at = _now()
        self.started_at = None
        self.finished_at = None
        self.cancel_event = threading.Event()
        self.result = None
        self.summary = None
        self.cached_files = 0

    @property
    def total_duration(self):
        return sum(float(f["duration"]) for f in self.files)

    @property
    def is_terminal(self):
        return self.status in TERMINAL_STATUSES

    def to_status(self):
        return {
            "id": self.id,
            "libraryItemId": self.library_item_id,
            "mode": self.mode,
            "status": self.status,
            "stage": self.stage,
            "stageProgress": None if self.stage_progress is None else round(self.stage_progress, 4),
            "progress": round(self.progress, 4),
            "downloadProgress": round(self.download_progress, 4),
            "currentFileIndex": self.current_file_index,
            "numFiles": len(self.files),
            "cachedFiles": self.cached_files,
            "etaSec": None if self.eta_sec is None else round(self.eta_sec),
            "model": self.model,
            "language": self.detected_language or self.language,
            "error": self.error,
            "errorCode": self.error_code,
            "warnings": self.warnings[:20],
            "realtimeFactor": self.realtime_factor,
            "summary": self.summary,
            "alignment": self.alignment,
            "createdAt": _iso(self.created_at),
            "startedAt": _iso(self.started_at),
            "finishedAt": _iso(self.finished_at),
        }


class JobManager:
    def __init__(self, config, transcriber_factory, gpu_info=None, audio_preparer=None):
        """transcriber_factory(model_name) -> object with transcribe_file(audio, language, beam_size, progress_cb, cancel_event)
        audio_preparer(path, progress_cb=, cancel_event=) -> the audio transcribe_file takes, prepared on the CPU ahead of
        the GPU (transcriber.audio_preparer); without it, transcribe_file gets the file's path"""
        self.config = config
        self._transcriber_factory = transcriber_factory
        self._audio_preparer = audio_preparer
        self._audio_queue = queue.Queue()
        self._ahead_slot = threading.Semaphore(1)
        self._audio_thread = None
        self._transcriber = None
        self.loaded_model = None
        self.model_state = "not_loaded"  # loading | ready | error
        self.model_error = None
        self.gpu_info = gpu_info or {}
        self.jobs = OrderedDict()
        self._lock = threading.Lock()
        self._gpu_queue = queue.Queue()
        self._stop = threading.Event()
        self._worker = None
        self.active_job = None
        self.cache_dir = Path(config.cache_dir)
        self.downloads_dir = self.cache_dir / "downloads"
        self.results_dir = self.cache_dir / "results"

    # ------------------------------------------------------------------ lifecycle
    def start(self, preload_model=True):
        self.downloads_dir.mkdir(parents=True, exist_ok=True)
        self.results_dir.mkdir(parents=True, exist_ok=True)
        self._worker = threading.Thread(target=self._gpu_worker, args=(preload_model,), name="gpu-worker", daemon=True)
        self._worker.start()
        if self._audio_preparer:
            self._audio_thread = threading.Thread(target=self._audio_worker, name="audio-worker", daemon=True)
            self._audio_thread.start()

    def stop(self):
        self._stop.set()
        for job in list(self.jobs.values()):
            if not job.is_terminal:
                job.cancel_event.set()
        self._gpu_queue.put(None)
        self._audio_queue.put(None)
        if self._worker:
            self._worker.join(timeout=10)
        if self._audio_thread:
            self._audio_thread.join(timeout=10)

    # ------------------------------------------------------------------ public API
    def health(self):
        with self._lock:
            waiting = [j for j in self.jobs.values() if j.status in ("downloading", "queued")]
            return {
                "app": "abs-transcribe-helper",
                "version": __version__,
                "gpu": self.gpu_info,
                "device": self.config.device,
                "computeType": self.config.effective_compute_type,
                "model": self.loaded_model or self.config.model,
                "defaultModel": self.config.model,
                "allowedModels": self.config.allowed_models,
                "modelState": self.model_state,
                "modelError": self.model_error,
                "busy": self.active_job is not None,
                "activeJobId": self.active_job.id if self.active_job else None,
                "queueLength": len(waiting),
            }

    def submit(self, request):
        """Returns (job, existing). Raises JobError for invalid requests."""
        if self.model_state == "error":
            raise JobError("gpu_unavailable", f"The transcription model could not be loaded: {self.model_error}")

        model = request.get("model") or self.config.model
        if model not in self.config.allowed_models:
            raise JobError("invalid_request", f"Model '{model}' is not allowed (allowed: {', '.join(self.config.allowed_models)})")
        self._validate_files(request)

        with self._lock:
            self._prune_old_jobs()
            for job in self.jobs.values():
                if job.library_item_id == request["libraryItemId"] and not job.is_terminal:
                    return job, True
            job = Job(request, model)
            self.jobs[job.id] = job

        logger.info("Job %s submitted for item %s (%d files, %.0f s of audio, model %s)", job.id, job.library_item_id, len(job.files), job.total_duration, model)
        threading.Thread(target=self._prepare_job, args=(job,), name=f"prepare-{job.id[:8]}", daemon=True).start()
        return job, False

    def get(self, job_id):
        return self.jobs.get(job_id)

    def list(self):
        return [j.to_status() for j in self.jobs.values()]

    def cancel(self, job_id):
        job = self.jobs.get(job_id)
        if not job:
            return None
        job.cancel_event.set()
        with self._lock:
            not_on_gpu = job.status in ("downloading", "queued")
        if not_on_gpu:
            # The prepare thread / GPU worker notice the event too, but report the cancellation right away
            self._finish(job, "cancelled")
        return job

    # ------------------------------------------------------------------ validation and paths
    def _validate_files(self, request):
        base = urllib.parse.urlsplit(request.get("absBaseUrl") or "")
        if base.scheme not in ("http", "https") or not base.netloc:
            raise JobError("invalid_request", "absBaseUrl must be an http(s) URL")
        base_prefix = request["absBaseUrl"].rstrip("/") + "/"
        last_offset = -1.0
        for f in request["files"]:
            if float(f["startOffset"]) < last_offset:
                raise JobError("invalid_request", "files must be ordered by startOffset")
            last_offset = float(f["startOffset"])
            if f.get("url") and not f["url"].startswith(base_prefix):
                # The token is only ever sent to the ABS server it was issued by
                raise JobError("invalid_request", "every file url must be on absBaseUrl")
            if not f.get("url") and not self._map_local_path(f.get("path")):
                raise JobError("invalid_request", f"file {f.get('filename') or f.get('ino')} has no url and no mapped local path")
        mode = request.get("mode") or "whisper"
        if mode not in ("whisper", "ebook"):
            raise JobError("invalid_request", f"Unknown mode '{mode}'")
        if mode == "ebook" and not request.get("ebookUrl"):
            raise JobError("invalid_request", "ebookUrl is required in ebook mode")
        for key in ("ebookUrl", "baseTranscriptUrl"):
            if request.get(key) and not request[key].startswith(base_prefix):
                raise JobError("invalid_request", f"{key} must be on absBaseUrl")

    def _map_local_path(self, server_path):
        """Translate a path as seen by the ABS server to a local file through configured path mappings.
        Only files inside a mapped local folder are ever read."""
        if not server_path:
            return None
        posix = str(PurePosixPath(server_path.replace("\\", "/")))
        for mapping in self.config.path_mappings:
            remote = str(PurePosixPath(mapping.remote.replace("\\", "/"))).rstrip("/")
            if posix != remote and not posix.startswith(remote + "/"):
                continue
            relative = posix[len(remote):].lstrip("/")
            local_root = Path(mapping.local).resolve()
            candidate = (local_root / Path(*relative.split("/"))).resolve() if relative else local_root
            try:
                candidate.relative_to(local_root)
            except ValueError:
                continue
            if candidate.is_file():
                return candidate
        return None

    def _cache_key(self, job, f):
        file_id = f.get("ino") or hashlib.sha1((f.get("url") or f.get("path") or "").encode("utf-8")).hexdigest()[:16]
        return f"{_safe_name(file_id)}__{_safe_name(job.model)}__{_safe_name(job.language or 'auto')}.json"

    def _item_results_dir(self, job):
        return self.results_dir / _safe_name(job.library_item_id)

    def _load_cached_result(self, job, f):
        path = self._item_results_dir(job) / self._cache_key(job, f)
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        # Ignore the cache if the file changed (different duration)
        if abs(float(data.get("duration", -1)) - float(f["duration"])) > 0.05:
            return None
        return data.get("result")

    def _save_cached_result(self, job, f, result):
        directory = self._item_results_dir(job)
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / self._cache_key(job, f)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"duration": float(f["duration"]), "model": job.model, "result": result}), encoding="utf-8")
        os.replace(tmp, path)

    # ------------------------------------------------------------------ download phase
    def _prepare_job(self, job):
        try:
            if job.mode == "ebook":
                data = self._fetch_bytes(job, job.ebook_url, "the ebook", MAX_EBOOK_BYTES)
                try:
                    job.ebook = read_epub(data)
                except EbookError as error:
                    raise JobError("ebook_unsupported", f"{error}. Only EPUB ebooks are supported.") from None
                base = self._load_base_transcript(job)
                if base is not None:
                    # The audio was transcribed before: align against that, no audio download or GPU needed
                    job._token = None
                    with self._lock:
                        if job.is_terminal:
                            return
                        job.status = "aligning"
                        job.started_at = _now()
                    self._complete(job, base, reused_base=True)
                    return

            for f in job.files:
                f["_cached"] = None if job.force else self._load_cached_result(job, f)
            job.cached_files = sum(1 for f in job.files if f["_cached"] is not None)
            if job.force:
                shutil.rmtree(self._item_results_dir(job), ignore_errors=True)

            to_fetch = [f for f in job.files if f["_cached"] is None]
            total = len(to_fetch) or 1
            for index, f in enumerate(to_fetch):
                if job.cancel_event.is_set():
                    raise _Cancelled()
                local = self._map_local_path(f.get("path"))
                if local:
                    f["_local"] = str(local)
                    f["_downloaded"] = False
                else:
                    f["_local"] = str(self._download(job, f, lambda frac, index=index: setattr(job, "download_progress", (index + frac) / total)))
                    f["_downloaded"] = True
                job.download_progress = (index + 1) / total
            job.download_progress = 1.0
        except _Cancelled:
            self._finish(job, "cancelled")
            self._cleanup_downloads(job)
            return
        except JobError as error:
            self._finish(job, "error", error.code, str(error))
            self._cleanup_downloads(job)
            return
        except Exception as error:  # pragma: no cover - unexpected
            logger.exception("Job %s failed while preparing", job.id)
            self._finish(job, "error", "download_failed", str(error))
            self._cleanup_downloads(job)
            return
        finally:
            job._token = None  # the token is not needed once audio is local

        with self._lock:
            if job.is_terminal:
                return
            job.status = "queued"
        if self._audio_preparer and any(f["_cached"] is None for f in job.files):
            self._audio_queue.put(job)
        else:
            self._gpu_queue.put(job)

    # ------------------------------------------------------------------ audio phase
    def _audio_worker(self):
        """Prepares the audio of the next job (CPU) while the GPU transcribes the one before"""
        while not self._stop.is_set():
            job = self._audio_queue.get()
            if job is None:
                break
            while not self._ahead_slot.acquire(timeout=0.5):  # the job prepared before is still waiting for the GPU
                if self._stop.is_set():
                    return
            if self._prepare_audio(job):
                job._ahead = True  # the GPU worker frees the slot when it takes the job
                self._gpu_queue.put(job)
            else:
                self._drop_audio(job)
                self._ahead_slot.release()

    def _prepare_audio(self, job):
        """Prepare the audio of the job's files that are not transcribed yet. False if the job is not going to the GPU."""
        files = [f for f in job.files if f["_cached"] is None]
        total = sum(float(f["duration"]) for f in files) or 1.0
        done = 0.0
        t0 = time.perf_counter()
        try:
            for f in files:
                if job.is_terminal:
                    return False
                job.stage, job.stage_progress = "preparing", done / total

                def progress(fraction, done=done, duration=float(f["duration"])):
                    job.stage_progress = min(1.0, (done + fraction * duration) / total)

                f["_audio"] = self._audio_preparer(f["_local"], progress_cb=progress, cancel_event=job.cancel_event)
                done += float(f["duration"])
        except TranscriptionCancelled:
            self._finish(job, "cancelled")
            return False
        except Exception as error:
            logger.exception("Job %s: preparing the audio failed", job.id)
            self._finish(job, "error", "transcription_failed", f"Could not read the audio: {error}")
            return False
        finally:
            job.stage, job.stage_progress = None, None
        logger.info("Job %s: prepared %.0f s of audio in %.1fs", job.id, done, time.perf_counter() - t0)
        with self._lock:
            return not job.is_terminal

    def _drop_audio(self, job):
        """Prepared audio takes gigabytes for a long book: let it go as soon as it is not needed"""
        for f in job.files:
            f.pop("_audio", None)

    def _open(self, job, url, name):
        if not job._token:
            raise JobError("auth_required", "No ABS token was provided to download from the server")
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {job._token}", "User-Agent": f"abs-transcribe-helper/{__version__}"})
        try:
            return _opener.open(request, timeout=60)
        except urllib.error.HTTPError as error:
            if error.code == 401:
                raise JobError("auth_expired", "The ABS server rejected the access token (HTTP 401). It has probably expired; start the job again.") from None
            if error.code == 403:
                raise JobError("forbidden", f"The ABS server refused access to {name} (HTTP 403)") from None
            if error.code == 404:
                raise JobError("not_found", f"{name} was not found on the ABS server (HTTP 404)") from None
            raise JobError("download_failed", f"Downloading {name} failed with HTTP {error.code}") from None
        except urllib.error.URLError as error:
            raise JobError("download_failed", f"Could not reach the ABS server: {error.reason}") from None

    def _fetch_bytes(self, job, url, name, limit):
        with self._open(job, url, name) as response:
            data = response.read(limit + 1)
            if len(data) > limit:
                raise JobError("download_failed", f"{name} is too large")
            if response.headers.get("Content-Encoding", "").lower() == "gzip":
                data = gzip.decompress(data)
        return data

    def _load_base_transcript(self, job):
        """The item's existing Whisper transcript, if it was made from exactly these audio files."""
        if not job.base_transcript_url or job.force:
            return None
        try:
            base = json.loads(self._fetch_bytes(job, job.base_transcript_url, "the existing transcript", MAX_TRANSCRIPT_BYTES))
        except JobError as error:
            if error.code == "not_found":
                return None
            raise
        except ValueError:
            return None
        files = base.get("files") or []
        if base.get("version") != 1 or base.get("source") != "whisper" or len(files) != len(job.files):
            return None
        for existing, current in zip(files, job.files):
            if existing.get("ino") and current.get("ino") and existing["ino"] != current["ino"]:
                return None
            if abs(float(existing.get("duration") or 0) - float(current["duration"])) > 0.05:
                return None
        logger.info("Job %s: reusing the existing Whisper transcript, no transcription needed", job.id)
        return base

    def _download(self, job, f, on_progress):
        url = f["url"]
        suffix = Path(f.get("filename") or "").suffix or Path(urllib.parse.urlsplit(url).path).suffix or ".audio"
        directory = self.downloads_dir / _safe_name(job.library_item_id)
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / f"{_safe_name(f.get('ino') or uuid.uuid4().hex)}{suffix}"
        tmp = target.with_name(target.name + ".part")
        name = f.get("filename") or f.get("ino") or "audio file"
        response = self._open(job, url, name)

        try:
            length = int(response.headers.get("Content-Length") or 0)
            received = 0
            with response, open(tmp, "wb") as out:
                while True:
                    if job.cancel_event.is_set():
                        raise _Cancelled()
                    chunk = response.read(DOWNLOAD_CHUNK)
                    if not chunk:
                        break
                    out.write(chunk)
                    received += len(chunk)
                    if length:
                        on_progress(min(1.0, received / length))
            if length and received < length:
                raise JobError("download_failed", f"Download of {name} was incomplete ({received} of {length} bytes)")
            os.replace(tmp, target)
        except (OSError, _Cancelled, JobError):
            tmp.unlink(missing_ok=True)
            raise
        return target

    # ------------------------------------------------------------------ GPU phase
    def _load_model(self, model_name):
        if self._transcriber is not None and self.loaded_model == model_name:
            return
        self.model_state = "loading"
        self.model_error = None
        self._transcriber = None
        try:
            self._transcriber = self._transcriber_factory(model_name)
            self.loaded_model = model_name
            self.model_state = "ready"
        except Exception as error:
            self.model_state = "error"
            self.model_error = str(error)
            logger.error("Failed to load model %s: %s", model_name, error)
            raise JobError("gpu_unavailable", f"Failed to load model {model_name}: {error}") from None

    def _gpu_worker(self, preload_model):
        if preload_model:
            try:
                self._load_model(self.config.model)
            except JobError:
                pass  # reported through /health and when jobs are submitted
        while not self._stop.is_set():
            job = self._gpu_queue.get()
            if job is None:
                break
            if job._ahead:
                job._ahead = False
                self._ahead_slot.release()  # the next job's audio can be prepared while this one is transcribed
            if job.is_terminal:
                self._drop_audio(job)
                continue
            with self._lock:
                self.active_job = job
            try:
                self._run_job(job)
            finally:
                with self._lock:
                    self.active_job = None

    def _run_job(self, job):
        with self._lock:
            if job.is_terminal:
                return
            job.status = "transcribing"
            job.started_at = _now()
        try:
            self._load_model(job.model)
            total = job.total_duration or 1.0
            done_audio = sum(float(f["duration"]) for f in job.files if f.get("_cached") is not None)
            processed_this_run = 0.0
            t0 = time.perf_counter()
            language = job.language
            results = []

            for index, f in enumerate(job.files):
                if job.cancel_event.is_set():
                    raise TranscriptionCancelled()
                job.current_file_index = index
                cached = f.get("_cached")
                if cached is not None:
                    language = language or cached.get("language")
                    results.append(cached)
                    continue

                spec_duration = float(f["duration"])
                started_at = time.perf_counter()
                job.stage = "starting"

                def progress(processed, decoded_duration, done_audio=done_audio, spec_duration=spec_duration):
                    job.stage = None
                    fraction = min(1.0, processed / decoded_duration) if decoded_duration else 0.0
                    current = done_audio + fraction * spec_duration
                    job.progress = min(1.0, current / total)
                    elapsed = time.perf_counter() - t0
                    audio_done_now = processed_this_run + fraction * spec_duration
                    if elapsed > 2 and audio_done_now > 0:
                        speed = audio_done_now / elapsed
                        job.eta_sec = max(0.0, (total - current) / speed)

                audio = f.pop("_audio", None)
                result = self._transcriber.transcribe_file(f["_local"] if audio is None else audio, language=language, beam_size=job.beam_size or self.config.beam_size, progress_cb=progress, cancel_event=job.cancel_event)
                del audio
                job.stage = None
                language = language or result.get("language")
                job.detected_language = language
                results.append(result)
                self._save_cached_result(job, f, result)
                done_audio += spec_duration
                processed_this_run += spec_duration
                logger.info("Job %s: file %d/%d transcribed in %.1fs", job.id, index + 1, len(job.files), time.perf_counter() - started_at)

            segments = merge_file_results(results, job.files)
            transcript = build_transcript(segments, job.files, job.library_item_id, job.model, language)
            elapsed = time.perf_counter() - t0
            job.realtime_factor = round(elapsed / processed_this_run, 4) if processed_this_run else None
            job.detected_language = language
        except TranscriptionCancelled:
            self._finish(job, "cancelled")
            return
        except JobError as error:
            self._finish(job, "error", error.code, str(error))
            return
        except Exception as error:
            logger.exception("Job %s failed", job.id)
            self._finish(job, "error", "transcription_failed", str(error))
            return
        finally:
            job.stage = None
            self._drop_audio(job)
        self._complete(job, transcript)

    def _complete(self, job, transcript, reused_base=False):
        """Final step for a Whisper transcript: align it with the ebook in ebook mode, then finish."""
        try:
            if job.mode == "ebook":
                with self._lock:
                    if job.is_terminal:
                        return
                    job.status = "aligning"
                t0 = time.perf_counter()
                try:
                    transcript = align_ebook(transcript, job.ebook)
                except EbookAlignmentError as error:
                    raise JobError("ebook_mismatch", str(error)) from None
                transcript["libraryItemId"] = job.library_item_id
                job.alignment = transcript.get("alignment")
                logger.info("Job %s: aligned the ebook in %.1fs (%s)", job.id, time.perf_counter() - t0, job.alignment)
            job.warnings = sanity_check(transcript)
            for warning in job.warnings[:20]:
                logger.warning("Job %s sanity check: %s", job.id, warning)
            job.detected_language = job.detected_language or transcript.get("language")
            job.summary = coverage_summary(transcript)
            job.result = transcript
            job.progress = 1.0
            job.eta_sec = 0
            # Completed: per-file cache no longer needed (re-creating should transcribe again)
            shutil.rmtree(self._item_results_dir(job), ignore_errors=True)
            self._finish(job, "done")
        except JobError as error:
            # Per-file results stay cached, so retrying (e.g. with the right ebook) skips transcription
            self._finish(job, "error", error.code, str(error))
        except Exception as error:
            logger.exception("Job %s failed", job.id)
            self._finish(job, "error", "alignment_failed" if job.mode == "ebook" else "transcription_failed", str(error))

    # ------------------------------------------------------------------ helpers
    def _finish(self, job, status, error_code=None, error=None):
        with self._lock:
            if job.is_terminal:
                return
            job.status = status
            job.error_code = error_code
            job.error = error
            job.finished_at = _now()
            job._token = None
        if status == "error":
            logger.warning("Job %s failed (%s): %s", job.id, error_code, error)
        else:
            logger.info("Job %s %s", job.id, status)
        self._drop_audio(job)
        self._cleanup_downloads(job)

    def _cleanup_downloads(self, job):
        if self.config.keep_downloads:
            return
        for f in job.files:
            if f.get("_downloaded") and f.get("_local"):
                try:
                    Path(f["_local"]).unlink(missing_ok=True)
                except OSError:
                    pass  # e.g. still open on Windows; removed by a later cleanup
        directory = self.downloads_dir / _safe_name(job.library_item_id)
        try:
            directory.rmdir()  # only if empty
        except OSError:
            pass

    def _prune_old_jobs(self):
        cutoff = _now() - self.config.job_retention_hours * 3600
        for job_id in [j.id for j in self.jobs.values() if j.is_terminal and (j.finished_at or 0) < cutoff]:
            del self.jobs[job_id]
