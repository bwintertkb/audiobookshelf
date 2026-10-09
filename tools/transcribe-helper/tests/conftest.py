import http.server
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from transcribe_helper.config import Config  # noqa: E402
from transcribe_helper.transcriber import TranscriptionCancelled  # noqa: E402

GOOD_TOKEN = "good-token"
FIXTURE_AUDIO = Path(__file__).resolve().parent / "fixtures" / "audio"


class FakeAbsServer:
    """Serves /audiobookshelf/api/items/<item>/file/<ino> like ABS, requiring a Bearer token."""

    def __init__(self, files, headers=None):
        self.files = files  # {last path segment (ino, "ebook", "transcript"): bytes}
        self.headers = headers or {}  # {last path segment: {header: value}}
        self.requests = []
        manager = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                manager.requests.append({"path": self.path, "authorization": self.headers.get("Authorization")})
                if self.headers.get("Authorization") != f"Bearer {GOOD_TOKEN}":
                    self.send_response(401)
                    self.end_headers()
                    return
                ino = self.path.rsplit("/", 1)[-1]
                if ino not in manager.files:
                    self.send_response(404)
                    self.end_headers()
                    return
                body = manager.files[ino]
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                for name, value in manager.headers.get(ino, {}).items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self):
        return f"http://127.0.0.1:{self.httpd.server_address[1]}/audiobookshelf"

    def file_url(self, item_id, ino):
        return f"{self.base_url}/api/items/{item_id}/file/{ino}"

    def close(self):
        self.httpd.shutdown()


@pytest.fixture
def fake_abs():
    server = FakeAbsServer({"ino1": b"audio-one" * 100, "ino2": b"audio-two" * 100, "ino3": b"audio-three" * 100})
    yield server
    server.close()


class FakeTranscriber:
    """Produces two segments per file at fixed local times. Records calls and max concurrency."""

    lock = threading.Lock()

    def __init__(self, durations, delay=0.0, fail_on=None):
        self.durations = durations  # {file content prefix or name fragment: duration}
        self.delay = delay
        self.fail_on = fail_on
        self.calls = []
        self.active = 0
        self.max_active = 0

    def _duration_for(self, path):
        data = Path(path).read_bytes()
        for key, duration in self.durations.items():
            if data.startswith(key.encode()) or key in str(path):
                return duration
        return 10.0

    def transcribe_file(self, audio_path, language=None, beam_size=5, progress_cb=None, cancel_event=None):
        with FakeTranscriber.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            self.calls.append({"path": str(audio_path), "language": language})
            if self.fail_on and self.fail_on in Path(audio_path).read_bytes().decode(errors="ignore"):
                raise RuntimeError("boom")
            duration = self._duration_for(audio_path)
            segments = []
            for i, (start, end) in enumerate([(0.5, 2.0), (2.5, duration + 0.3)]):  # second segment overshoots the end
                if cancel_event is not None and cancel_event.is_set():
                    raise TranscriptionCancelled()
                time.sleep(self.delay)
                words = [{"w": f"w{i}a", "start": start, "end": start + 0.4}, {"w": f"w{i}b", "start": start + 0.5, "end": end}]
                segments.append({"start": start, "end": end, "text": f"w{i}a w{i}b", "words": words})
                if progress_cb:
                    progress_cb(min(end, duration), duration)
            if cancel_event is not None and cancel_event.is_set():
                raise TranscriptionCancelled()
            return {"language": language or "en", "languageProbability": 0.99, "duration": duration, "segments": segments}
        finally:
            with FakeTranscriber.lock:
                self.active -= 1


@pytest.fixture
def make_config(tmp_path):
    def _make(**overrides):
        config = Config(cache_dir=str(tmp_path / "cache"))
        for key, value in overrides.items():
            setattr(config, key, value)
        return config

    return _make


def wait_for(predicate, timeout=10.0, interval=0.02):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False
