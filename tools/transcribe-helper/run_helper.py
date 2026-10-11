"""Start the local transcription helper service.

python run_helper.py [--config config.toml] [--port 8765] [--allow-origin https://abs.example.com]
"""

import argparse
import logging
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default=None, help="Path to config.toml (default: ./config.toml if it exists)")
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--allow-origin", action="append", default=[], help="Additional allowed ABS origin (repeatable)")
    parser.add_argument("--model", default=None, help="Default model (overrides config)")
    parser.add_argument("--device", default=None, help="cuda (default) or cpu")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    log = logging.getLogger("transcribe_helper")

    from transcribe_helper import __version__
    from transcribe_helper.config import load_config

    config = load_config(args.config)
    if args.port:
        config.port = args.port
    if args.model:
        config.model = args.model
        if config.model not in config.allowed_models:
            config.allowed_models.append(config.model)
    if args.device:
        config.device = args.device
    config.allowed_origins.extend(o.rstrip("/") for o in args.allow_origin)

    try:
        import truststore  # verify HTTPS to the ABS server with the OS certificate store

        truststore.inject_into_ssl()
    except ImportError:
        pass

    from transcribe_helper.gpu import get_gpu_info

    gpu_info = {"available": False, "error": "CPU mode"} if config.device == "cpu" else get_gpu_info()
    log.info("ABS transcribe helper v%s", __version__)
    if config.device == "cuda":
        if gpu_info["available"]:
            log.info("GPU: %s (compute capability %s, driver %s)", gpu_info.get("name"), gpu_info.get("computeCapability"), gpu_info.get("driverVersion"))
        else:
            log.error("CUDA is NOT usable: %s", gpu_info.get("error"))
            log.error("Jobs will fail until this is fixed. Run 'python check_gpu.py' for details.")
    log.info("Model: %s (%s, %s), loading in the background", config.model, config.device, config.effective_compute_type)
    log.info("Allowed origins: %s", ", ".join(config.allowed_origins) or "(none)")
    for mapping in config.path_mappings:
        log.info("Path mapping: %s -> %s", mapping.remote, mapping.local)

    from transcribe_helper.jobs import JobManager
    from transcribe_helper.server import create_app
    from transcribe_helper.transcriber import Transcriber, audio_preparer

    def transcriber_factory(model_name):
        if config.device == "cuda" and not gpu_info["available"]:
            raise RuntimeError(gpu_info.get("error") or "CUDA is not available")
        transcriber = Transcriber(model_name, device=config.device, compute_type=config.effective_compute_type, download_root=config.model_dir or None, batch_size=config.batch_size)
        log.info("Model %s ready (loaded in %.1fs)", model_name, transcriber.load_sec)
        return transcriber

    manager = JobManager(config, transcriber_factory, gpu_info=gpu_info, audio_preparer=audio_preparer(config.batch_size))
    app = create_app(config, manager)

    import uvicorn

    log.info("Listening on http://127.0.0.1:%d", config.port)
    uvicorn.run(app, host="127.0.0.1", port=config.port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
