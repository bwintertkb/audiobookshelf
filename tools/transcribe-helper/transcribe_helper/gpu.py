"""GPU / CUDA diagnostics shared by check_gpu.py and the service startup check."""

import shutil
import subprocess
import time

from .cuda_setup import setup_cuda_libraries


class GpuCheckError(RuntimeError):
    pass


def query_nvidia_smi():
    """Return a list of {name, computeCapability, driverVersion, memoryTotalMiB} or [] if nvidia-smi is unavailable."""
    exe = shutil.which("nvidia-smi")
    if not exe:
        return []
    fields = "name,compute_cap,driver_version,memory.total"
    try:
        out = subprocess.run(
            [exe, f"--query-gpu={fields}", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if out.returncode != 0:
        return []
    gpus = []
    for line in out.stdout.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 4:
            continue
        gpus.append(
            {
                "name": parts[0],
                "computeCapability": parts[1],
                "driverVersion": parts[2],
                "memoryTotalMiB": int(parts[3]) if parts[3].isdigit() else None,
            }
        )
    return gpus


def get_gpu_info(device_index=0):
    """Cheap check (no model load): is CUDA usable by CTranslate2 and does it support float16?"""
    setup_cuda_libraries()
    info = {"available": False, "name": None, "computeCapability": None, "driverVersion": None, "error": None}

    smi = query_nvidia_smi()
    if len(smi) > device_index:
        info.update({k: smi[device_index][k] for k in ("name", "computeCapability", "driverVersion")})

    try:
        import ctranslate2
    except Exception as error:  # pragma: no cover - import failure is environment specific
        info["error"] = f"Failed to import ctranslate2: {error}"
        return info

    info["ctranslate2Version"] = ctranslate2.__version__
    try:
        count = ctranslate2.get_cuda_device_count()
    except Exception as error:
        info["error"] = f"CTranslate2 could not query CUDA devices: {error}"
        return info
    if count <= device_index:
        info["error"] = "No CUDA device is visible to CTranslate2. Check that the NVIDIA driver is installed and up to date."
        return info

    compute_types = sorted(ctranslate2.get_supported_compute_types("cuda", device_index))
    info["computeTypes"] = compute_types
    if "float16" not in compute_types:
        info["error"] = f"CUDA device does not support float16 in CTranslate2 (supported: {', '.join(compute_types)})"
        return info

    info["available"] = True
    return info


def run_test_inference(model_name="tiny", device="cuda", compute_type="float16", download_root=None):
    """Load a Whisper model and run it on two seconds of synthetic audio.
    This exercises cuBLAS and cuDNN, which a device count alone does not."""
    setup_cuda_libraries()
    import numpy as np

    from .transcriber import load_whisper_model

    t0 = time.perf_counter()
    try:
        model = load_whisper_model(model_name, device=device, compute_type=compute_type, download_root=download_root)
    except Exception as error:
        raise GpuCheckError(f"Failed to load model '{model_name}' on {device} ({compute_type}): {error}") from error
    load_sec = time.perf_counter() - t0

    sample_rate = 16000
    t = np.arange(sample_rate * 2, dtype=np.float32) / sample_rate
    audio = (0.1 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)

    t1 = time.perf_counter()
    try:
        segments, _info = model.transcribe(audio, language="en", beam_size=1, vad_filter=False, word_timestamps=True)
        list(segments)  # transcription is lazy; consume the generator to actually run it
    except Exception as error:
        raise GpuCheckError(f"Test inference failed on {device}: {error}") from error
    infer_sec = time.perf_counter() - t1

    return {"model": model_name, "loadSec": round(load_sec, 2), "inferenceSec": round(infer_sec, 2)}
