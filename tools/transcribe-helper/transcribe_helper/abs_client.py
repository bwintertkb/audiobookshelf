"""Audiobookshelf API client for the transcriber app: sign in, list books, upload transcripts and ebooks.

The password, access token and refresh token are kept in memory only; they are never logged or written to disk.
"""

import gzip
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field

from . import __version__
from .jobs import JobError, _SameOriginRedirectHandler

PAGE_SIZE = 200
# Access tokens live about an hour; get a fresh one before handing it to a download that may take a while
TOKEN_REFRESH_AFTER_SEC = 20 * 60
UPLOAD_TIMEOUT_SEC = 600

_opener = urllib.request.build_opener(_SameOriginRedirectHandler)


class AbsError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


@dataclass
class Book:
    id: str
    library_id: str
    title: str
    author: str
    duration: float
    num_tracks: int
    ebook_format: str  # "epub", "pdf", ... or ""
    language: str
    has_transcript: bool
    raw: dict = field(repr=False, default_factory=dict)

    @property
    def has_epub(self):
        return self.ebook_format == "epub"

    @classmethod
    def from_json(cls, item):
        media = item.get("media") or {}
        metadata = media.get("metadata") or {}
        return cls(
            id=item["id"],
            library_id=item.get("libraryId") or "",
            title=metadata.get("title") or item.get("relPath") or item["id"],
            author=metadata.get("authorName") or "",
            duration=float(media.get("duration") or 0),
            num_tracks=int(media.get("numTracks") or media.get("numAudioFiles") or 0),
            ebook_format=(media.get("ebookFormat") or "").lower(),
            language=metadata.get("language") or "",
            has_transcript=bool(item.get("hasTranscript")),
            raw=item,
        )


def normalize_base_url(url):
    """'192.168.0.240:13378' -> 'http://192.168.0.240:13378', 'books.example.com/abs/' -> 'https://books.example.com/abs'"""
    url = (url or "").strip().rstrip("/")
    if not url:
        raise AbsError("Enter the address of your Audiobookshelf server")
    if "://" not in url:
        host = url.split("/")[0].split(":")[0]
        local = host == "localhost" or host.replace(".", "").isdigit() or host.endswith(".local")
        url = f"{'http' if local else 'https'}://{url}"
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise AbsError(f"'{url}' is not a valid server address")
    return url


class AbsClient:
    def __init__(self, base_url, timeout=60):
        self.base_url = normalize_base_url(base_url)
        self.timeout = timeout
        self.user = None
        self._access_token = None
        self._refresh_token = None
        self._token_time = 0.0

    # ------------------------------------------------------------------ HTTP
    def _send(self, method, path, body=None, headers=None, auth=True, timeout=None):
        url = path if path.startswith("http") else f"{self.base_url}{path}"
        headers = {"User-Agent": f"abs-transcriber/{__version__}", **(headers or {})}
        if auth and self._access_token:
            headers["Authorization"] = f"Bearer {self._access_token}"
        request = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:
            with _opener.open(request, timeout=timeout or self.timeout) as response:
                data = response.read()
                if response.headers.get("Content-Encoding", "").lower() == "gzip":
                    data = gzip.decompress(data)
                return response.status, data
        except urllib.error.HTTPError as error:
            detail = error.read()[:300].decode("utf-8", errors="replace").strip()
            return error.code, detail.encode("utf-8")
        except JobError as error:  # redirect to another host
            raise AbsError(str(error)) from None
        except urllib.error.URLError as error:
            raise AbsError(f"Could not reach {self.base_url}: {error.reason}") from None
        except TimeoutError:
            raise AbsError(f"{self.base_url} did not answer in time") from None

    def _request(self, method, path, body=None, headers=None, timeout=None):
        """Authenticated request; refreshes the session once when the access token has expired"""
        status, data = self._send(method, path, body, headers, timeout=timeout)
        if status == 401 and self._refresh_token:
            self.refresh()
            status, data = self._send(method, path, body, headers, timeout=timeout)
        if status == 401:
            raise AbsError("The server ended the session; sign in again", 401)
        if status >= 400:
            message = data.decode("utf-8", errors="replace") or f"HTTP {status}"
            raise AbsError(f"{method} {path} failed: {message}", status)
        return data

    def _json(self, method, path, payload=None):
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        data = self._request(method, path, body, {"Content-Type": "application/json"} if body else None)
        return json.loads(data) if data else None

    # ------------------------------------------------------------------ session
    def check_server(self):
        status, data = self._send("GET", "/status", auth=False)
        try:
            info = json.loads(data) if status == 200 else None
        except ValueError:
            info = None
        if not info or info.get("app") != "audiobookshelf":
            raise AbsError(f"{self.base_url} is not an Audiobookshelf server")
        return info

    def sign_in(self, username, password):
        self.check_server()
        body = json.dumps({"username": username, "password": password}).encode("utf-8")
        status, data = self._send("POST", "/login", body, {"Content-Type": "application/json", "x-return-tokens": "true"}, auth=False)
        if status == 401:
            raise AbsError("Wrong username or password", 401)
        if status == 429:
            raise AbsError("Too many sign-in attempts; wait a minute and try again", 429)
        if status >= 400:
            raise AbsError(f"Sign-in failed: {data.decode('utf-8', errors='replace') or status}", status)
        self._set_session(json.loads(data)["user"])
        return self.user

    def _set_session(self, user):
        self._access_token = user.get("accessToken") or user.get("token")
        self._refresh_token = user.get("refreshToken") or self._refresh_token
        self._token_time = time.monotonic()
        self.user = {"id": user.get("id"), "username": user.get("username"), "type": user.get("type"), "permissions": user.get("permissions") or {}}

    def refresh(self):
        status, data = self._send("POST", "/auth/refresh", b"", {"x-refresh-token": self._refresh_token or "", "x-return-tokens": "true"}, auth=False)
        if status >= 400:
            self._access_token = None
            raise AbsError("The session expired; sign in again", 401)
        self._set_session(json.loads(data)["user"])

    def fresh_token(self):
        """An access token valid for a while yet (for audio downloads)"""
        if self._refresh_token and time.monotonic() - self._token_time > TOKEN_REFRESH_AFTER_SEC:
            self.refresh()
        if not self._access_token:
            raise AbsError("Not signed in", 401)
        return self._access_token

    def sign_out(self):
        if self._refresh_token:
            try:
                self._send("POST", "/logout", b"", {"x-refresh-token": self._refresh_token})
            except AbsError:
                pass
        self._access_token = self._refresh_token = None
        self.user = None

    @property
    def signed_in(self):
        return bool(self._access_token)

    @property
    def can_upload(self):
        """Uploading a transcript needs permission to update items"""
        user = self.user or {}
        return user.get("type") in ("root", "admin") or bool(user.get("permissions", {}).get("update"))

    @property
    def can_add_ebooks(self):
        """Adding an ebook file to a book needs permission to upload and to update items (root always has both)"""
        user = self.user or {}
        permissions = user.get("permissions", {})
        return user.get("type") == "root" or (bool(permissions.get("update")) and bool(permissions.get("upload")))

    # ------------------------------------------------------------------ data
    def book_libraries(self):
        return [library for library in self._json("GET", "/api/libraries")["libraries"] if library.get("mediaType") == "book"]

    def books(self, library_id):
        books = []
        page = 0
        while True:
            query = urllib.parse.urlencode({"limit": PAGE_SIZE, "page": page, "minified": 1, "sort": "media.metadata.title"})
            data = self._json("GET", f"/api/libraries/{library_id}/items?{query}")
            results = data.get("results") or []
            books.extend(Book.from_json(item) for item in results if item.get("mediaType", "book") == "book")
            page += 1
            if not results or page * int(data.get("limit") or PAGE_SIZE) >= int(data.get("total") or 0):
                return books

    def item(self, item_id):
        return self._json("GET", f"/api/items/{urllib.parse.quote(item_id)}?expanded=1")

    def _upload_file(self, path, field_name, filename, content, content_type, timeout=None):
        """POST one file as multipart/form-data; returns the JSON answer"""
        boundary = f"----abs-transcriber-{uuid.uuid4().hex}"
        filename = filename.replace('"', "'").replace("\r", "").replace("\n", "")
        body = (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\nContent-Type: {content_type}\r\n\r\n'.encode("utf-8")
            + content
            + f"\r\n--{boundary}--\r\n".encode("utf-8")
        )
        data = self._request("POST", path, body, {"Content-Type": f"multipart/form-data; boundary={boundary}"}, timeout=timeout)
        return json.loads(data) if data else {}

    def upload_transcript(self, item_id, transcript):
        """Upload a v1 transcript (gzipped JSON, like the web client)"""
        content = gzip.compress(json.dumps(transcript, separators=(",", ":")).encode("utf-8"))
        return self._upload_file(f"/api/items/{urllib.parse.quote(item_id)}/transcript", "transcript", "transcript.json.gz", content, "application/gzip")

    def upload_ebook(self, item_id, path):
        """Add an ebook file to the book's folder on the server (POST /api/items/:id/ebook); returns the expanded item"""
        with open(path, "rb") as f:
            content = f.read()
        return self._upload_file(f"/api/items/{urllib.parse.quote(item_id)}/ebook", "ebook", os.path.basename(path), content, "application/epub+zip", timeout=UPLOAD_TIMEOUT_SEC)

    def set_primary_ebook(self, item_id, ino):
        """Make a supplementary ebook file of the book its main ebook (the main one becomes supplementary)"""
        self._request("PATCH", f"/api/items/{urllib.parse.quote(item_id)}/ebook/{urllib.parse.quote(ino)}/status")
