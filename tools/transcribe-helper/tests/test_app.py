"""The transcriber app's server client and controller, against a fake Audiobookshelf server"""

import email
import email.policy
import gzip
import http.server
import json
import threading
import urllib.parse
from pathlib import Path

import pytest

from conftest import FakeTranscriber, wait_for
from transcribe_helper.abs_client import AbsClient, AbsError, normalize_base_url
from transcribe_helper.app_controller import CANCELLED, DONE, ERROR, UPLOAD_FAILED, TranscriberController

PASSWORD = "secret"


def make_item(item_id, title, durations, ebook=False, has_transcript=False, language="English"):
    offsets = [sum(durations[:i]) for i in range(len(durations))]
    tracks = [
        {"ino": f"{item_id}-ino{i}", "contentUrl": f"/api/items/{item_id}/file/{item_id}-ino{i}", "startOffset": offsets[i], "duration": d, "metadata": {"filename": f"{i + 1:02d}.mp3", "path": f"/audiobooks/{title}/{i + 1:02d}.mp3"}}
        for i, d in enumerate(durations)
    ]
    media = {"metadata": {"title": title, "authorName": "Author", "language": language}, "duration": sum(durations), "numTracks": len(tracks), "ebookFormat": "epub" if ebook else None, "tracks": tracks}
    if ebook:
        media["ebookFile"] = {"ebookFormat": "epub", "metadata": {"filename": f"{title}.epub"}}
    return {"id": item_id, "libraryId": "lib1", "mediaType": "book", "hasTranscript": has_transcript, "media": media}


class FakeAbs:
    """Just enough of the ABS API: status, login, refresh, libraries, items, audio files and transcript uploads"""

    def __init__(self, items, page_limit=None):
        self.items = {item["id"]: item for item in items}
        self.page_limit = page_limit
        self.access = "access-1"
        self.refresh_token = "refresh-1"
        self.uploads = {}
        self.requests = []
        self.fail_uploads = 0
        self.expire_next = False
        fake = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def _reply(self, status, body=b"", content_type="application/json"):
                data = json.dumps(body).encode() if isinstance(body, (dict, list)) else body
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _authorized(self):
                if fake.expire_next and self.path.startswith("/abs/api/"):
                    fake.expire_next = False
                    fake.access = "access-expired"
                return self.headers.get("Authorization") == f"Bearer {fake.access}"

            def _session(self):
                n = int(fake.access.split("-")[-1]) + 1 if fake.access[-1].isdigit() else 2
                fake.access, fake.refresh_token = f"access-{n}", f"refresh-{n}"
                return {"user": {"id": "u1", "username": "root", "type": "root", "permissions": {}, "accessToken": fake.access, "refreshToken": fake.refresh_token}}

            def do_GET(self):
                fake.requests.append(("GET", self.path, self.headers.get("Authorization")))
                path = urllib.parse.urlsplit(self.path).path
                query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                if path == "/abs/status":
                    return self._reply(200, {"app": "audiobookshelf", "serverVersion": "2.37.1"})
                if not self._authorized():
                    return self._reply(401, b"Unauthorized", "text/plain")
                if path == "/abs/api/libraries":
                    return self._reply(200, {"libraries": [{"id": "lib1", "mediaType": "book"}, {"id": "pod", "mediaType": "podcast"}]})
                if path == "/abs/api/libraries/lib1/items":
                    limit, page = int(query["limit"][0]), int(query["page"][0])
                    if fake.page_limit:
                        limit = fake.page_limit
                    items = sorted(fake.items.values(), key=lambda i: i["media"]["metadata"]["title"])
                    minified = [{k: v for k, v in i.items()} | {"media": {k: v for k, v in i["media"].items() if k not in ("tracks", "ebookFile")}} for i in items]
                    return self._reply(200, {"results": minified[page * limit : (page + 1) * limit], "total": len(items), "limit": limit, "page": page})
                parts = path.split("/")
                if len(parts) == 5 and parts[3] == "items" and parts[4] in fake.items:
                    return self._reply(200, fake.items[parts[4]])
                if len(parts) == 7 and parts[5] == "file":
                    return self._reply(200, f"audio {parts[6]}".encode() * 50, "audio/mpeg")
                return self._reply(404, b"Not found", "text/plain")

            def do_POST(self):
                fake.requests.append(("POST", self.path, self.headers.get("Authorization")))
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length)
                if self.path == "/abs/login":
                    data = json.loads(body)
                    if data != {"username": "root", "password": PASSWORD}:
                        return self._reply(401, b"Invalid username or password", "text/plain")
                    return self._reply(200, self._session())
                if self.path == "/abs/auth/refresh":
                    if self.headers.get("x-refresh-token") != fake.refresh_token:
                        return self._reply(401, b"Invalid refresh token", "text/plain")
                    return self._reply(200, self._session())
                if self.path == "/abs/logout":
                    fake.refresh_token = None
                    return self._reply(200, {})
                if not self._authorized():
                    return self._reply(401, b"Unauthorized", "text/plain")
                parts = self.path.split("/")
                if len(parts) == 6 and parts[5] == "transcript":
                    if fake.fail_uploads:
                        fake.fail_uploads -= 1
                        return self._reply(500, b"Upload failed", "text/plain")
                    message = email.message_from_bytes(f"Content-Type: {self.headers['Content-Type']}\r\n\r\n".encode() + body, policy=email.policy.HTTP)
                    field = next(part for part in message.iter_parts() if part.get_param("name", header="content-disposition") == "transcript")
                    transcript = json.loads(gzip.decompress(field.get_payload(decode=True)))
                    fake.uploads[parts[4]] = {"filename": field.get_filename(), "transcript": transcript}
                    fake.items[parts[4]]["hasTranscript"] = True
                    return self._reply(200, {"success": True, "transcript": {"numWords": sum(len(s["words"]) for s in transcript["segments"])}})
                return self._reply(404, b"Not found", "text/plain")

            def log_message(self, *args):
                pass

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    @property
    def base_url(self):
        return f"http://127.0.0.1:{self.httpd.server_address[1]}/abs"

    def close(self):
        self.httpd.shutdown()


@pytest.fixture
def fake_server():
    server = FakeAbs([make_item("b1", "Alpha", [100.0, 50.0]), make_item("b2", "Beta", [30.0], has_transcript=True), make_item("b3", "Gamma", [40.0], ebook=True)])
    yield server
    server.close()


@pytest.fixture
def controller_factory(make_config):
    controllers = []

    def _make(transcriber=None, **config_overrides):
        transcriber = transcriber or FakeTranscriber({"audio": 50.0})
        controller = TranscriberController(make_config(**config_overrides), lambda model: transcriber, gpu_info={"available": True, "name": "Fake GPU"})
        controller.start()
        controllers.append(controller)
        return controller, transcriber

    yield _make
    for controller in controllers:
        controller.stop()


# ---------------------------------------------------------------------------------------------- client
def test_normalize_base_url():
    assert normalize_base_url(" 192.168.0.240:13378/ ") == "http://192.168.0.240:13378"
    assert normalize_base_url("books.example.com/audiobookshelf") == "https://books.example.com/audiobookshelf"
    assert normalize_base_url("http://localhost:3333") == "http://localhost:3333"
    with pytest.raises(AbsError):
        normalize_base_url("")


def test_client_signs_in_lists_books_over_pages_and_refreshes(fake_server):
    fake_server.page_limit = 2
    client = AbsClient(fake_server.base_url)
    with pytest.raises(AbsError, match="Wrong username or password"):
        client.sign_in("root", "wrong")
    client.sign_in("root", PASSWORD)
    assert client.can_upload
    books = client.books("lib1")
    assert [b.title for b in books] == ["Alpha", "Beta", "Gamma"]
    assert [b.has_transcript for b in books] == [False, True, False]
    assert books[2].has_epub and not books[0].has_epub
    assert books[0].duration == 150.0 and books[0].num_tracks == 2

    # The access token expires: the client refreshes the session once and repeats the request
    fake_server.expire_next = True
    assert client.item("b1")["id"] == "b1"
    assert client._access_token == fake_server.access

    client.sign_out()
    assert not client.signed_in and fake_server.refresh_token is None


def test_client_rejects_a_server_that_is_not_audiobookshelf(fake_server):
    with pytest.raises(AbsError, match="not an Audiobookshelf server"):
        AbsClient(fake_server.base_url + "/nothing").sign_in("root", PASSWORD)


# ---------------------------------------------------------------------------------------------- controller
def test_transcribes_a_book_uploads_it_and_deletes_the_audio(fake_server, controller_factory):
    controller, transcriber = controller_factory(FakeTranscriber({"audio": 50.0}, delay=0.3))
    controller.sign_in(fake_server.base_url, "root", PASSWORD)
    books = controller.load_books()
    task = controller.add(books[0])
    assert task.mode == "whisper" and task.language == "en"

    assert wait_for(lambda: task.status == DONE, 15), (task.status, task.error)
    upload = fake_server.uploads["b1"]
    assert upload["filename"] == "transcript.json.gz"
    assert upload["transcript"]["libraryItemId"] == "b1"
    assert [f["ino"] for f in upload["transcript"]["files"]] == ["b1-ino0", "b1-ino1"]
    assert books[0].has_transcript
    assert task.message == "8 words"
    # The downloaded audio and the kept transcript are gone; the token only went to the ABS server
    assert task.audio_bytes > 0
    assert not any(controller.manager.downloads_dir.rglob("*"))
    assert not any(controller.pending_dir.iterdir())
    assert all(auth is None or auth.startswith("Bearer access-") for _, _, auth in fake_server.requests)
    assert any("deleted the downloaded audio" in text for _, text in controller.messages)


def test_downloads_at_most_one_book_ahead_of_the_gpu(fake_server, controller_factory):
    controller, transcriber = controller_factory(FakeTranscriber({"audio": 50.0}, delay=0.3))
    controller.sign_in(fake_server.base_url, "root", PASSWORD)
    books = controller.load_books()
    tasks = [controller.add(book, use_ebook=False) for book in books]
    downloads_seen = []

    def check():
        downloading = [t for t in tasks if t.job is not None and t.status not in (DONE,)]
        downloads_seen.append(len(downloading))
        return all(t.status == DONE for t in tasks)

    assert wait_for(check, 30), [(t.status, t.error) for t in tasks]
    assert max(downloads_seen) <= 2  # one on the GPU, one downloaded ahead
    assert transcriber.max_active == 1
    assert set(fake_server.uploads) == {"b1", "b2", "b3"}


def test_ebook_mode_for_books_with_an_epub(fake_server, controller_factory):
    controller, _ = controller_factory()
    controller.sign_in(fake_server.base_url, "root", PASSWORD)
    books = {b.title: b for b in controller.load_books()}
    assert controller.add(books["Gamma"], use_ebook=True).mode == "ebook"
    assert controller.add(books["Alpha"], use_ebook=True).mode == "whisper"  # no EPUB
    assert controller.add(books["Beta"], use_ebook=False, language="detect").language is None
    assert controller.add(books["Beta"]) is None  # already queued


def test_a_failed_upload_keeps_the_transcript_for_a_retry(fake_server, controller_factory, make_config):
    controller, transcriber = controller_factory()
    controller.sign_in(fake_server.base_url, "root", PASSWORD)
    fake_server.fail_uploads = 1
    task = controller.add(controller.load_books()[0])
    assert wait_for(lambda: task.status == UPLOAD_FAILED, 15), (task.status, task.error)
    assert "Upload failed" in task.error
    assert len(list(controller.pending_dir.glob("*.json.gz"))) == 1
    assert not any(controller.manager.downloads_dir.rglob("*.mp3"))  # the transcript is complete: audio deleted
    calls = len(transcriber.calls)

    controller.retry(task)
    assert wait_for(lambda: task.status == DONE, 15), (task.status, task.error)
    assert len(transcriber.calls) == calls  # not transcribed again
    assert "b1" in fake_server.uploads


def test_a_transcript_left_from_last_time_is_uploaded_after_signing_in(fake_server, controller_factory, make_config):
    controller, _ = controller_factory()
    controller.sign_in(fake_server.base_url, "root", PASSWORD)
    fake_server.fail_uploads = 1
    task = controller.add(controller.load_books()[0])
    assert wait_for(lambda: task.status == UPLOAD_FAILED, 15)
    cache_dir = controller.config.cache_dir
    controller.stop()

    again = TranscriberController(make_config(cache_dir=cache_dir), lambda model: FakeTranscriber({}), gpu_info={"available": True})
    again.start()
    try:
        again.sign_in(fake_server.base_url, "root", PASSWORD)
        assert wait_for(lambda: "b1" in fake_server.uploads and again.tasks and again.tasks[0].status == DONE, 15)
        assert not any(again.pending_dir.iterdir())
    finally:
        again.stop()


def test_cancel_and_errors(fake_server, controller_factory):
    controller, transcriber = controller_factory(FakeTranscriber({"audio": 50.0}, delay=0.5))
    controller.sign_in(fake_server.base_url, "root", PASSWORD)
    books = controller.load_books()
    first = controller.add(books[0])
    assert wait_for(lambda: first.status == "transcribing", 10)
    controller.cancel(first)
    assert first.status == CANCELLED
    assert wait_for(lambda: first.job.status == "cancelled", 10)
    assert wait_for(lambda: not any(controller.manager.downloads_dir.rglob("*.mp3")), 5)

    # A book the server no longer has
    del fake_server.items["b2"]
    missing = controller.add(books[1])
    assert wait_for(lambda: missing.status == ERROR, 10)
    assert "404" in missing.error or "Not found" in missing.error


def test_users_who_cannot_update_books_are_refused(fake_server, controller_factory):
    controller, _ = controller_factory()

    class ReadOnlyClient(AbsClient):
        @property
        def can_upload(self):
            return False

    controller.client_factory = ReadOnlyClient
    with pytest.raises(AbsError, match="may not change books"):
        controller.sign_in(fake_server.base_url, "root", PASSWORD)
    assert controller.client is None


def test_leftover_downloads_are_deleted_on_start(make_config):
    config = make_config()
    leftover = Path(config.cache_dir) / "downloads" / "old-item"
    leftover.mkdir(parents=True)
    (leftover / "01.mp3").write_bytes(b"x")
    controller = TranscriberController(config, lambda model: FakeTranscriber({}), gpu_info={})
    controller.start(preload_model=False)
    try:
        assert not leftover.exists()
    finally:
        controller.stop()
