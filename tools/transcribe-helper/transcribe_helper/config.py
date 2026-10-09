"""Helper configuration: config.toml (optional) overridden by environment variables.

Environment variables:
  TRANSCRIBE_HELPER_CONFIG           path to a TOML config file (default: ./config.toml next to run_helper.py)
  TRANSCRIBE_HELPER_PORT             port (default 8765)
  TRANSCRIBE_HELPER_ALLOWED_ORIGINS  comma separated ABS origins allowed to call the helper
  TRANSCRIBE_HELPER_MODEL            default model (default large-v3-turbo)
  TRANSCRIBE_HELPER_CACHE_DIR        cache directory for downloads and per-file results
  TRANSCRIBE_HELPER_DEVICE           cuda (default) or cpu
"""

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover
    import tomli as tomllib

HELPER_DIR = Path(__file__).resolve().parent.parent
DEFAULT_ALLOWED_ORIGINS = ["http://localhost:3333", "http://127.0.0.1:3333", "http://localhost:3000", "http://127.0.0.1:3000"]
DEFAULT_ALLOWED_MODELS = ["tiny", "base", "small", "medium", "large-v2", "large-v3", "large-v3-turbo", "distil-large-v3"]


@dataclass
class PathMapping:
    remote: str  # path prefix as the ABS server sees it, e.g. /audiobooks
    local: str  # the same folder as mounted on this machine, e.g. Z:\audiobooks


@dataclass
class Config:
    # The helper only ever binds to loopback; the host is intentionally not configurable
    host: str = "127.0.0.1"
    port: int = 8765
    allowed_origins: list = field(default_factory=lambda: list(DEFAULT_ALLOWED_ORIGINS))
    model: str = "large-v3-turbo"
    allowed_models: list = field(default_factory=lambda: list(DEFAULT_ALLOWED_MODELS))
    device: str = "cuda"
    compute_type: str = ""  # default: float16 on cuda, int8 on cpu
    beam_size: int = 5
    batch_size: int = 0  # >1 uses faster-whisper's batched pipeline
    model_dir: str = ""  # model download directory (default: Hugging Face cache)
    cache_dir: str = str(HELPER_DIR / "cache")
    keep_downloads: bool = False
    job_retention_hours: float = 24
    path_mappings: list = field(default_factory=list)

    @property
    def effective_compute_type(self):
        if self.compute_type:
            return self.compute_type
        return "float16" if self.device == "cuda" else "int8"


def _normalize_origin(origin):
    return origin.strip().rstrip("/")


def load_config(path=None, env=None):
    env = os.environ if env is None else env
    config = Config()

    config_path = path or env.get("TRANSCRIBE_HELPER_CONFIG") or str(HELPER_DIR / "config.toml")
    if config_path and Path(config_path).is_file():
        with open(config_path, "rb") as f:
            data = tomllib.load(f)
        for key in ("port", "model", "device", "compute_type", "beam_size", "batch_size", "model_dir", "cache_dir", "keep_downloads", "job_retention_hours"):
            if key in data:
                setattr(config, key, data[key])
        if "allowed_origins" in data:
            config.allowed_origins = [_normalize_origin(o) for o in data["allowed_origins"]]
        if "allowed_models" in data:
            config.allowed_models = list(data["allowed_models"])
        config.path_mappings = [PathMapping(remote=m["remote"], local=m["local"]) for m in data.get("path_mappings", [])]
        if not Path(config.cache_dir).is_absolute():
            config.cache_dir = str((Path(config_path).parent / config.cache_dir).resolve())

    if env.get("TRANSCRIBE_HELPER_PORT"):
        config.port = int(env["TRANSCRIBE_HELPER_PORT"])
    if env.get("TRANSCRIBE_HELPER_ALLOWED_ORIGINS"):
        config.allowed_origins = [_normalize_origin(o) for o in env["TRANSCRIBE_HELPER_ALLOWED_ORIGINS"].split(",") if o.strip()]
    if env.get("TRANSCRIBE_HELPER_MODEL"):
        config.model = env["TRANSCRIBE_HELPER_MODEL"]
    if env.get("TRANSCRIBE_HELPER_CACHE_DIR"):
        config.cache_dir = env["TRANSCRIBE_HELPER_CACHE_DIR"]
    if env.get("TRANSCRIBE_HELPER_DEVICE"):
        config.device = env["TRANSCRIBE_HELPER_DEVICE"]

    if config.model not in config.allowed_models:
        config.allowed_models.append(config.model)
    return config
