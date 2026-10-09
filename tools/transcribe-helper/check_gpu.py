"""Check that this machine can run faster-whisper on the GPU.

Usage: python check_gpu.py [--model tiny]
Exit code 0 = OK, 1 = CUDA not usable.
"""

import argparse
import sys

from transcribe_helper.gpu import GpuCheckError, get_gpu_info, run_test_inference


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default="tiny", help="Whisper model for the test inference (default: tiny, ~75 MB download)")
    parser.add_argument("--model-dir", default=None, help="Directory to download/cache models in (default: Hugging Face cache)")
    args = parser.parse_args()

    info = get_gpu_info()
    print(f"GPU name:            {info.get('name') or 'unknown (nvidia-smi not found)'}")
    print(f"Compute capability:  {info.get('computeCapability') or 'unknown'}")
    print(f"NVIDIA driver:       {info.get('driverVersion') or 'unknown'}")
    print(f"CTranslate2:         {info.get('ctranslate2Version') or 'not importable'}")
    print(f"CUDA compute types:  {', '.join(info.get('computeTypes', [])) or '-'}")
    print(f"CUDA available:      {'yes' if info['available'] else 'NO'}")

    if not info["available"]:
        print(f"\nERROR: {info['error']}", file=sys.stderr)
        return 1

    print(f"\nRunning test inference with model '{args.model}' (float16 on CUDA)...")
    try:
        result = run_test_inference(args.model, download_root=args.model_dir)
    except GpuCheckError as error:
        print(f"\nERROR: {error}", file=sys.stderr)
        print("See README.md > Troubleshooting (missing cuBLAS/cuDNN libraries or an outdated driver are the usual causes).", file=sys.stderr)
        return 1

    print(f"Model load:          {result['loadSec']} s")
    print(f"Test inference:      {result['inferenceSec']} s")
    print("\nOK: CUDA is usable for transcription.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
