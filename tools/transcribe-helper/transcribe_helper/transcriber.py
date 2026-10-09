"""Thin wrapper around faster-whisper that keeps one model loaded and transcribes a single file."""

import logging
import threading
import time

from .cuda_setup import setup_cuda_libraries

logger = logging.getLogger(__name__)


class TranscriptionCancelled(Exception):
    pass


def load_whisper_model(model_name, device="cuda", compute_type="float16", download_root=None):
    """Load a faster-whisper model from the local model cache. Only when it has never been downloaded
    are the weights fetched (once) from Hugging Face; transcription itself never uses the network."""
    setup_cuda_libraries()
    from faster_whisper import WhisperModel
    from huggingface_hub.errors import LocalEntryNotFoundError

    try:
        return WhisperModel(model_name, device=device, compute_type=compute_type, download_root=download_root, local_files_only=True)
    except LocalEntryNotFoundError:
        logger.info("Model %s is not in the local cache yet; downloading its weights from Hugging Face (one time)", model_name)
        return WhisperModel(model_name, device=device, compute_type=compute_type, download_root=download_root)


class Transcriber:
    """Loads a faster-whisper model once and reuses it for every file.

    Settings follow the plan: word timestamps, VAD filter and condition_on_previous_text=False
    (avoids repetition/hallucination loops on long audio).
    """

    def __init__(self, model_name, device="cuda", compute_type="float16", download_root=None, batch_size=0):
        setup_cuda_libraries()
        from faster_whisper import BatchedInferencePipeline

        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self.batch_size = batch_size
        t0 = time.perf_counter()
        self.model = load_whisper_model(model_name, device=device, compute_type=compute_type, download_root=download_root)
        self.pipeline = BatchedInferencePipeline(model=self.model) if batch_size and batch_size > 1 else None
        self.load_sec = time.perf_counter() - t0
        logger.info("Loaded model %s on %s (%s) in %.1fs", model_name, device, compute_type, self.load_sec)

    def transcribe_file(self, audio_path, language=None, beam_size=5, progress_cb=None, cancel_event=None):
        """Transcribe one audio file. Times are local to the file (seconds from its start).

        progress_cb(processed_sec, duration_sec) is called after every segment.
        cancel_event (threading.Event) is checked between segments; raises TranscriptionCancelled.

        Returns {"language", "languageProbability", "duration", "segments": [{start, end, text, words: [{w, start, end}]}]}
        """
        options = dict(
            language=language or None,
            beam_size=beam_size,
            word_timestamps=True,
            vad_filter=True,
        )
        if self.pipeline:
            segments_iter, info = self.pipeline.transcribe(str(audio_path), batch_size=self.batch_size, **options)
        else:
            segments_iter, info = self.model.transcribe(str(audio_path), condition_on_previous_text=False, **options)

        duration = float(info.duration or 0)
        segments = []
        for segment in segments_iter:
            if cancel_event is not None and cancel_event.is_set():
                raise TranscriptionCancelled()
            words = []
            for word in segment.words or []:
                text = word.word.strip()
                if not text:
                    continue
                words.append({"w": text, "start": float(word.start), "end": float(word.end)})
            text = segment.text.strip()
            if text or words:
                segments.append({"start": float(segment.start), "end": float(segment.end), "text": text, "words": words})
            if progress_cb:
                progress_cb(min(float(segment.end), duration) if duration else float(segment.end), duration)

        if cancel_event is not None and cancel_event.is_set():
            raise TranscriptionCancelled()
        if progress_cb:
            progress_cb(duration, duration)

        return {
            "language": info.language,
            "languageProbability": round(float(info.language_probability or 0), 4),
            "duration": duration,
            "segments": segments,
        }


def new_cancel_event():
    return threading.Event()
