"""Make CUDA libraries installed from NVIDIA pip wheels (nvidia-cublas-cu12, nvidia-cudnn-cu12)
loadable by CTranslate2 without a system-wide CUDA toolkit.

Windows: register the wheels' bin/ folders as DLL directories (and prepend them to PATH).
Linux: preload the shared libraries with RTLD_GLOBAL so dlopen() by soname succeeds.
"""

import ctypes
import glob
import os
import sys

_done = False


def setup_cuda_libraries():
    global _done
    if _done:
        return
    _done = True

    # Windows without Developer Mode can't create symlinks; HF Hub falls back to copies and warns on every load
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    # Hugging Face is only contacted to download model weights the first time; never send telemetry
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

    try:
        import nvidia  # namespace package provided by the nvidia-* wheels
    except ImportError:
        return

    for root in list(getattr(nvidia, "__path__", [])):
        if sys.platform == "win32":
            for bin_dir in sorted(glob.glob(os.path.join(root, "*", "bin"))):
                os.add_dll_directory(bin_dir)
                os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
        else:
            patterns = (
                "cublas/lib/libcublasLt.so.*",
                "cublas/lib/libcublas.so.*",
                "cudnn/lib/libcudnn*.so.*",
            )
            for pattern in patterns:
                for lib in sorted(glob.glob(os.path.join(root, pattern))):
                    try:
                        ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)
                    except OSError:
                        pass
