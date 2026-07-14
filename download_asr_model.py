"""Download only the files required by the local Paraformer INT8 runtime."""

from __future__ import annotations

import concurrent.futures
import math
import os
import shutil
import subprocess
import urllib.request
from pathlib import Path

import onnx
import yaml


PROJECT_ROOT = Path(__file__).resolve().parent
MODEL_NAME = "sherpa-onnx-streaming-paraformer-bilingual-zh-en"
MODEL_DIR = PROJECT_ROOT / "models" / MODEL_NAME
HF_BASE_URL = "https://huggingface.co/csukuangfj/streaming-paraformer-zh/resolve/main"
MODEL_FILES = {
    "encoder.int8.onnx": f"{HF_BASE_URL}/model_quant.onnx",
    "decoder.int8.onnx": f"{HF_BASE_URL}/decoder_quant.onnx",
    "tokens.txt": f"{HF_BASE_URL}/tokens.txt",
    "config.yaml": f"{HF_BASE_URL}/config.yaml",
    "am.mvn": f"{HF_BASE_URL}/am.mvn",
}
RUNTIME_FILES = ("encoder.int8.onnx", "decoder.int8.onnx", "tokens.txt")


def model_is_ready() -> bool:
    return all((MODEL_DIR / name).is_file() for name in RUNTIME_FILES)


def tokens_have_ids() -> bool:
    tokens = MODEL_DIR / "tokens.txt"
    if not tokens.is_file():
        return False
    lines = tokens.read_text(encoding="utf-8").splitlines()
    if not lines:
        return False
    for expected_id, line in enumerate(lines):
        fields = line.rsplit(maxsplit=1)
        if len(fields) != 2 or not fields[1].isdigit() or int(fields[1]) != expected_id:
            return False
    return True


def add_token_ids() -> None:
    """Convert the model repository's one-token-per-line file for sherpa-onnx."""
    tokens = MODEL_DIR / "tokens.txt"
    lines = tokens.read_text(encoding="utf-8").splitlines()
    if not lines or any(not line for line in lines):
        raise RuntimeError("tokens.txt is empty or contains an empty token")
    tokens.write_text(
        "".join(f"{token} {token_id}\n" for token_id, token in enumerate(lines)),
        encoding="utf-8",
    )
    print("Added numeric IDs to tokens.txt")


def encoder_has_metadata() -> bool:
    encoder = MODEL_DIR / "encoder.int8.onnx"
    if not encoder.is_file():
        return False
    model = onnx.load(encoder, load_external_data=False)
    metadata = {item.key: item.value for item in model.metadata_props}
    return metadata.get("model_type") == "paraformer" and "vocab_size" in metadata


def add_encoder_metadata() -> None:
    """Apply the metadata used by the model author's conversion script."""
    encoder = MODEL_DIR / "encoder.int8.onnx"
    config = yaml.safe_load((MODEL_DIR / "config.yaml").read_text(encoding="utf-8"))

    neg_mean = None
    inv_stddev = None
    for line in (MODEL_DIR / "am.mvn").read_text(encoding="utf-8").splitlines():
        if not line.startswith("<LearnRateCoef>"):
            continue
        values = ",".join(line.split()[3:-1])
        if neg_mean is None:
            neg_mean = values
        else:
            inv_stddev = values

    if not neg_mean or not inv_stddev:
        raise RuntimeError("Unable to parse CMVN values from am.mvn")

    frontend = config["frontend_conf"]
    encoder_config = config["encoder_conf"]
    decoder_config = config["decoder_conf"]
    metadata = {
        "lfr_window_size": frontend["lfr_m"],
        "lfr_window_shift": frontend["lfr_n"],
        "neg_mean": neg_mean,
        "inv_stddev": inv_stddev,
        "encoder_output_size": encoder_config["output_size"],
        "decoder_num_blocks": decoder_config["num_blocks"],
        "decoder_kernel_size": decoder_config["kernel_size"],
        "model_type": "paraformer",
        "version": "1",
        "model_author": "damo",
        "maintainer": "k2-fsa",
        "vocab_size": len((MODEL_DIR / "tokens.txt").read_text(encoding="utf-8").splitlines()),
        "comment": "speech_paraformer_asr_nat-zh-cn-16k-common-vocab8404-online",
    }

    model = onnx.load(encoder)
    existing = {item.key: item for item in model.metadata_props}
    for key, value in metadata.items():
        item = existing.get(key) or model.metadata_props.add()
        item.key = key
        item.value = str(value)

    updated = encoder.with_suffix(".metadata.part")
    try:
        onnx.save(model, updated)
        updated.replace(encoder)
    finally:
        updated.unlink(missing_ok=True)
    print("Added sherpa-onnx metadata to encoder.int8.onnx")


def get_remote_size(url: str) -> int:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "QW-InterviewAssistant"},
        method="HEAD",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return int(response.headers.get("Content-Length", "0"))


def download_with_curl(curl: str, filename: str, url: str, partial: Path) -> None:
    total = get_remote_size(url)
    requested_workers = max(1, int(os.getenv("ASR_DOWNLOAD_CONNECTIONS", "8")))
    chunk_size = max(1, int(os.getenv("ASR_DOWNLOAD_CHUNK_MIB", "1"))) * 1024 * 1024
    workers = min(requested_workers, max(1, math.ceil(total / chunk_size)))

    if total == 0 or workers == 1:
        subprocess.run(
            [
                curl,
                "--location",
                "--fail",
                "--retry",
                "3",
                "--show-error",
                "--output",
                str(partial),
                url,
            ],
            check=True,
        )
        return

    parts: list[tuple[int, int, Path]] = []
    part_count = math.ceil(total / chunk_size)
    for index in range(part_count):
        start = index * chunk_size
        end = min(total - 1, start + chunk_size - 1)
        if start > end:
            break
        parts.append((start, end, partial.with_name(f"{partial.name}.{index:03d}")))

    def download_part(part: tuple[int, int, Path]) -> Path:
        start, end, part_path = part
        expected_size = end - start + 1
        subprocess.run(
            [
                curl,
                "--location",
                "--fail",
                "--retry",
                "3",
                "--silent",
                "--show-error",
                "--range",
                f"{start}-{end}",
                "--output",
                str(part_path),
                url,
            ],
            check=True,
        )
        actual_size = part_path.stat().st_size
        if actual_size != expected_size:
            raise RuntimeError(
                f"Range download failed for {filename}: expected {expected_size}, got {actual_size}"
            )
        return part_path

    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
            downloaded_parts = []
            for completed, part_path in enumerate(executor.map(download_part, parts), start=1):
                downloaded_parts.append(part_path)
                if completed == len(parts) or completed % 10 == 0:
                    print(f"{filename}: {completed}/{len(parts)} chunks")

        with partial.open("wb") as output:
            for part_path in downloaded_parts:
                with part_path.open("rb") as source:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
        if partial.stat().st_size != total:
            raise RuntimeError(
                f"Combined download failed for {filename}: expected {total}, got {partial.stat().st_size}"
            )
    finally:
        for _, _, part_path in parts:
            part_path.unlink(missing_ok=True)


def download_file(filename: str, url: str) -> None:
    destination = MODEL_DIR / filename
    partial = destination.with_suffix(destination.suffix + ".part")

    curl = shutil.which("curl.exe") or shutil.which("curl")
    if curl:
        download_with_curl(curl, filename, url, partial)
        if not partial.is_file() or partial.stat().st_size == 0:
            partial.unlink(missing_ok=True)
            raise RuntimeError(f"Downloaded an empty file: {filename}")
        partial.replace(destination)
        return

    request = urllib.request.Request(url, headers={"User-Agent": "QW-InterviewAssistant"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response, partial.open("wb") as output:
            total = int(response.headers.get("Content-Length", "0"))
            downloaded = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
                downloaded += len(chunk)
                total_text = f" / {total / 1024 / 1024:.1f} MiB" if total else ""
                print(
                    f"\r{filename}: {downloaded / 1024 / 1024:.1f} MiB{total_text}",
                    end="",
                    flush=True,
                )
        print()
        if total and downloaded != total:
            raise RuntimeError(
                f"Incomplete download for {filename}: expected {total}, got {downloaded} bytes"
            )
        partial.replace(destination)
    except Exception:
        partial.unlink(missing_ok=True)
        raise


def main() -> None:
    if model_is_ready() and tokens_have_ids() and encoder_has_metadata():
        print(f"Local ASR model is already ready: {MODEL_DIR}")
        return

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    print("Downloading the local bilingual Streaming Paraformer INT8 model...")
    for filename, url in MODEL_FILES.items():
        destination = MODEL_DIR / filename
        if destination.is_file():
            print(f"Using existing file: {destination}")
            continue
        download_file(filename, url)

    if not model_is_ready():
        missing = "\n".join(
            str(MODEL_DIR / name)
            for name in MODEL_FILES
            if not (MODEL_DIR / name).is_file()
        )
        raise RuntimeError(f"Model download completed but files are missing:\n{missing}")

    if not tokens_have_ids():
        add_token_ids()
    if not encoder_has_metadata():
        add_encoder_metadata()
    if not tokens_have_ids() or not encoder_has_metadata():
        raise RuntimeError("Model metadata update failed")
    print(f"Local ASR model is ready: {MODEL_DIR}")


if __name__ == "__main__":
    main()
