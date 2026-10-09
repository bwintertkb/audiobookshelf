"""HTTP API of the transcription helper (bound to 127.0.0.1 only).

GET    /health             version, GPU, model, busy/idle
POST   /jobs               start a job -> {jobId}
GET    /jobs               list jobs (status only)
GET    /jobs/{id}          job status
GET    /jobs/{id}/result   v1 transcript JSON once done
DELETE /jobs/{id}          cancel
"""

import json
import logging
from contextlib import asynccontextmanager
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from . import __version__
from .jobs import JobError, JobManager

logger = logging.getLogger(__name__)

ERROR_STATUS = {"invalid_request": 400, "gpu_unavailable": 503}


class JobFile(BaseModel):
    url: Optional[str] = None
    path: Optional[str] = None  # path as the ABS server sees it, used with path mappings
    ino: Optional[str] = None
    filename: Optional[str] = None
    startOffset: float = Field(ge=0)
    duration: float = Field(gt=0)


class JobRequest(BaseModel):
    absBaseUrl: str = Field(min_length=1, max_length=2048)
    libraryItemId: str = Field(min_length=1, max_length=128)
    token: Optional[str] = Field(default=None, max_length=8192)
    files: List[JobFile] = Field(min_length=1, max_length=10000)
    model: Optional[str] = Field(default=None, max_length=100)
    language: Optional[str] = Field(default=None, max_length=16)
    beamSize: Optional[int] = Field(default=None, ge=1, le=10)
    force: bool = False


class LocalAccessMiddleware:
    """Pure ASGI middleware:
    - rejects requests whose Host is not loopback (DNS rebinding protection)
    - rejects requests from browser origins that are not configured (Origin header present but not allowed)
    - answers CORS preflights, including Private Network Access (Access-Control-Request-Private-Network)
    """

    def __init__(self, app, allowed_origins, port):
        self.app = app
        self.allowed_origins = set(allowed_origins)
        self.allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}", "127.0.0.1", "localhost", "[::1]"}

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        host = headers.get("host", "").lower()
        if host not in self.allowed_hosts:
            return await self._plain(send, 403, "Invalid Host header")

        origin = headers.get("origin")
        if origin is not None and origin.rstrip("/") not in self.allowed_origins:
            return await self._plain(send, 403, f"Origin {origin} is not allowed. Add it to allowed_origins in the helper config.")

        is_preflight = scope["method"] == "OPTIONS" and "access-control-request-method" in headers
        if is_preflight:
            response_headers = [
                (b"access-control-allow-origin", origin.encode("latin-1")),
                (b"access-control-allow-methods", b"GET, POST, DELETE, OPTIONS"),
                (b"access-control-allow-headers", headers.get("access-control-request-headers", "content-type").encode("latin-1")),
                (b"access-control-max-age", b"600"),
                (b"vary", b"Origin"),
            ]
            if headers.get("access-control-request-private-network") == "true":
                response_headers.append((b"access-control-allow-private-network", b"true"))
            if headers.get("access-control-request-local-network") == "true":
                response_headers.append((b"access-control-allow-local-network", b"true"))
            await send({"type": "http.response.start", "status": 204, "headers": response_headers})
            await send({"type": "http.response.body", "body": b""})
            return

        if origin is None:
            return await self.app(scope, receive, send)

        async def send_with_cors(message):
            if message["type"] == "http.response.start":
                message.setdefault("headers", [])
                message["headers"] = list(message["headers"]) + [(b"access-control-allow-origin", origin.encode("latin-1")), (b"vary", b"Origin")]
            await send(message)

        return await self.app(scope, receive, send_with_cors)

    @staticmethod
    async def _plain(send, status, text):
        body = json.dumps({"error": text}).encode("utf-8")
        await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


def create_app(config, manager: JobManager, start_manager=True):
    @asynccontextmanager
    async def lifespan(_app):
        if start_manager:
            manager.start()
        yield
        if start_manager:
            manager.stop()

    app = FastAPI(title="ABS transcribe helper", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(LocalAccessMiddleware, allowed_origins=config.allowed_origins, port=config.port)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request, exc):
        # Do not echo request input back (it may contain the ABS token)
        errors = [{"loc": e.get("loc"), "msg": e.get("msg")} for e in exc.errors()]
        return JSONResponse(status_code=422, content={"error": "Invalid request", "errorCode": "invalid_request", "details": errors})

    @app.get("/health")
    def health():
        return manager.health()

    @app.post("/jobs")
    def create_job(body: JobRequest):
        request = body.model_dump()
        try:
            job, existing = manager.submit(request)
        except JobError as error:
            return JSONResponse(status_code=ERROR_STATUS.get(error.code, 400), content={"error": str(error), "errorCode": error.code})
        return JSONResponse(status_code=200 if existing else 201, content={"jobId": job.id, "existing": existing, "job": job.to_status()})

    @app.get("/jobs")
    def list_jobs():
        return {"jobs": manager.list()}

    def _get_job(job_id):
        job = manager.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        return job

    @app.get("/jobs/{job_id}")
    def job_status(job_id: str):
        return _get_job(job_id).to_status()

    @app.get("/jobs/{job_id}/result")
    def job_result(job_id: str):
        job = _get_job(job_id)
        if job.status != "done" or job.result is None:
            return JSONResponse(status_code=409, content={"error": f"Job is {job.status}", "errorCode": "not_done", "status": job.status})
        body = json.dumps(job.result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        return Response(content=body, media_type="application/json")

    @app.delete("/jobs/{job_id}")
    def cancel_job(job_id: str):
        job = manager.cancel(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        return job.to_status()

    return app
