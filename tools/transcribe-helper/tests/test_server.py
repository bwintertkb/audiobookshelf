import pytest
from fastapi.testclient import TestClient

from conftest import GOOD_TOKEN, FakeTranscriber, wait_for
from test_jobs import DURATIONS, make_request
from transcribe_helper.jobs import JobManager
from transcribe_helper.server import create_app

ABS_ORIGIN = "https://abs.example.com"


@pytest.fixture
def client(make_config):
    config = make_config(allowed_origins=[ABS_ORIGIN], port=8765)
    manager = JobManager(config, lambda model: FakeTranscriber(DURATIONS), gpu_info={"available": True, "name": "Fake GPU"})
    app = create_app(config, manager)
    with TestClient(app, base_url="http://127.0.0.1:8765") as test_client:
        yield test_client


def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["app"] == "abs-transcribe-helper"
    assert body["gpu"]["name"] == "Fake GPU"
    assert body["busy"] is False


def test_rejects_non_loopback_host(client):
    response = client.get("/health", headers={"Host": "attacker.example.com"})
    assert response.status_code == 403


def test_rejects_unknown_origin(client):
    response = client.get("/health", headers={"Origin": "https://evil.example.com"})
    assert response.status_code == 403
    assert "access-control-allow-origin" not in response.headers


def test_allowed_origin_gets_cors_headers(client):
    response = client.get("/health", headers={"Origin": ABS_ORIGIN})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == ABS_ORIGIN


def test_preflight_with_private_network_access(client):
    response = client.options(
        "/jobs",
        headers={
            "Origin": ABS_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
            "Access-Control-Request-Private-Network": "true",
        },
    )
    assert response.status_code == 204
    assert response.headers["access-control-allow-origin"] == ABS_ORIGIN
    assert response.headers["access-control-allow-private-network"] == "true"
    assert "POST" in response.headers["access-control-allow-methods"]


def test_validation_errors_do_not_echo_the_token(client):
    response = client.post("/jobs", json={"token": "secret-token-value", "files": []})
    assert response.status_code == 422
    assert "secret-token-value" not in response.text


def test_full_job_flow(client, fake_abs):
    response = client.post("/jobs", json=make_request(fake_abs), headers={"Origin": ABS_ORIGIN})
    assert response.status_code == 201
    job_id = response.json()["jobId"]

    early = client.get(f"/jobs/{job_id}/result")
    assert early.status_code in (200, 409)

    assert wait_for(lambda: client.get(f"/jobs/{job_id}").json()["status"] == "done")
    status = client.get(f"/jobs/{job_id}").json()
    assert status["progress"] == 1.0
    assert status["numFiles"] == 3
    assert "token" not in str(status).lower()

    result = client.get(f"/jobs/{job_id}/result")
    assert result.status_code == 200
    transcript = result.json()
    assert transcript["version"] == 1
    assert transcript["libraryItemId"] == "item-1"
    assert len(transcript["segments"]) == 6

    jobs = client.get("/jobs").json()["jobs"]
    assert [j["id"] for j in jobs] == [job_id]


def test_cancel_and_unknown_job(client, fake_abs):
    assert client.get("/jobs/nope").status_code == 404
    assert client.delete("/jobs/nope").status_code == 404
    job_id = client.post("/jobs", json=make_request(fake_abs, token="expired")).json()["jobId"]
    assert wait_for(lambda: client.get(f"/jobs/{job_id}").json()["status"] == "error")
    assert client.get(f"/jobs/{job_id}").json()["errorCode"] == "auth_expired"
    assert client.delete(f"/jobs/{job_id}").status_code == 200


def test_invalid_job_request(client, fake_abs):
    request = make_request(fake_abs)
    request["files"][0]["url"] = "http://elsewhere.example.com/file"
    response = client.post("/jobs", json=request)
    assert response.status_code == 400
    assert response.json()["errorCode"] == "invalid_request"
