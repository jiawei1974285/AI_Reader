#!/usr/bin/env python3
r"""手动下载 BGE-Small-ZH-V1.5 嵌入模型到 embed_cache 目录。

用途：
  当 AIreader 自动下载失败时（如 hf-mirror.com 返回 Content-Range 错误），
  运行此脚本手动下载模型文件，之后 AIreader 即可离线使用嵌入功能。

用法：
  python scripts/download-embed-model.py

  默认下载到 %APPDATA%/com.aireader.app/embed_cache/。
  也可指定目标目录：
  python scripts/download-embed-model.py --cache-dir D:\my_cache

依赖（按优先级）：
  1. huggingface_hub 库（推荐）：pip install huggingface_hub
     支持镜像设置，下载最快。
  2. 无 huggingface_hub 时使用 urllib 直接下载（无需额外依赖）。
     直接从 huggingface.co 下载，需要网络可达。

镜像设置：
  碰到网络问题时，设环境变量：
    set HF_ENDPOINT=https://hf-mirror.com
  或者：
    set HF_ENDPOINT=https://hf.steamfor.cn
  然后重新运行本脚本。
"""

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from urllib.parse import urljoin

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ── model identity ──────────────────────────────────────────────
MODEL_ID = "Xenova/bge-small-zh-v1.5"
# hf-hub 的缓存目录名规则：models--{org}--{name}
CACHE_REPO_DIR = "models--Xenova--bge-small-zh-v1.5"

# 模型必需文件。缺失任一文件，fastembed 初始化都会失败。
REQUIRED_FILES = [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "onnx/model.onnx",
]


def default_cache_dir() -> Path:
    """返回 AIreader 的默认 embed_cache 路径。"""
    appdata = os.environ.get("APPDATA", "")
    if appdata:
        return Path(appdata) / "com.aireader.app" / "embed_cache"
    # Linux / macOS fallback
    home = Path.home()
    return home / ".local" / "share" / "com.aireader.app" / "embed_cache"


def repo_cache_dir(cache_dir: Path) -> Path:
    """返回模型在 hf-hub 缓存中的目录。"""
    return cache_dir / CACHE_REPO_DIR


# ── 方法 1：使用 huggingface_hub ─────────────────────────────────

def download_via_hf_hub(cache_dir: Path) -> bool:
    """使用 huggingface_hub 下载模型。成功返回 True。"""
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        return False

    endpoint = os.environ.get("HF_ENDPOINT", "").strip()
    mirror_info = f"（镜像: {endpoint}）" if endpoint else ""

    print(f"使用 huggingface_hub 下载 {MODEL_ID} {mirror_info}")
    print("=" * 60)

    try:
        snapshot_path = snapshot_download(
            repo_id=MODEL_ID,
            cache_dir=str(cache_dir),
            resume_download=True,
            local_files_only=False,
        )
        print(f"\n✓ 下载完成: {snapshot_path}")
        return True
    except Exception as e:
        print(f"\n✗ huggingface_hub 下载失败: {e}")
        return False


# ── 方法 2：urllib 直接下载（无额外依赖）─────────────────────────

def download_via_urllib(cache_dir: Path) -> bool:
    """使用标准库 urllib 下载所有必需文件。"""
    import ssl
    import urllib.request

    base_url = os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")
    # HuggingFace raw file URL pattern
    raw_base = f"{base_url}/{MODEL_ID}/resolve/main/"

    # Create temp dir for download, then move to cache on success
    tmp_dir = Path(tempfile.mkdtemp(prefix="bge_dl_"))
    success = True
    failed_files = []

    print(f"使用 urllib 从 {base_url} 下载 {MODEL_ID}")
    print(f"临时目录: {tmp_dir}")
    print("=" * 60)

    # 忽略 TLS 证书验证（某些镜像证书可能有问题）
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    for rel_path in REQUIRED_FILES:
        url = urljoin(raw_base, rel_path)
        dest = tmp_dir / rel_path
        dest.parent.mkdir(parents=True, exist_ok=True)

        print(f"  [{len(failed_files) + 1}/{len(REQUIRED_FILES)}] {rel_path} …", end=" ")
        sys.stdout.flush()

        try:
            req = urllib.request.Request(url, headers={"User-Agent": "AIreader/1.0"})
            with urllib.request.urlopen(req, timeout=60, context=ctx) as resp:
                data = resp.read()
            dest.write_bytes(data)
            size_kb = len(data) / 1024
            print(f"✓ {size_kb:.0f} KB")
        except Exception as e:
            print(f"✗ {e}")
            failed_files.append(rel_path)
            success = False

    if not success:
        print(f"\n✗ {len(failed_files)} 个文件下载失败:")
        for f in failed_files:
            print(f"    - {f}")
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return False

    # 所有文件下载成功 → 移动到 hf-hub 缓存格式
    print("\n正在整理缓存目录结构...")
    try:
        _install_to_cache(tmp_dir, cache_dir)
        print("✓ 模型文件已安装到缓存")
        return True
    except Exception as e:
        print(f"✗ 安装失败: {e}")
        return False
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _install_to_cache(src_dir: Path, cache_dir: Path):
    """将下载的模型文件安装到 hf-hub 兼容的缓存结构。"""
    repo_dir = repo_cache_dir(cache_dir)
    repo_dir.mkdir(parents=True, exist_ok=True)

    # 计算 blob hash 并写入 blobs/
    blobs_dir = repo_dir / "blobs"
    blobs_dir.mkdir(parents=True, exist_ok=True)

    # 生成 snapshot hash（用文件列表 + 主分支 ref）
    snap_ref = hashlib.sha256(b"main").hexdigest()
    refs_dir = repo_dir / "refs"
    refs_dir.mkdir(parents=True, exist_ok=True)
    (refs_dir / "main").write_text(snap_ref)

    snap_dir = repo_dir / "snapshots" / snap_ref
    snap_dir.mkdir(parents=True, exist_ok=True)

    for rel_path in REQUIRED_FILES:
        src_file = src_dir / rel_path
        if not src_file.exists():
            continue

        data = src_file.read_bytes()
        blob_hash = hashlib.sha256(data).hexdigest()
        blob_path = blobs_dir / blob_hash

        if not blob_path.exists():
            blob_path.write_bytes(data)

        # 在 snapshot 目录中用符号链接或硬链接指向 blob
        snap_target = snap_dir / rel_path
        snap_target.parent.mkdir(parents=True, exist_ok=True)
        if not snap_target.exists():
            try:
                os.link(blob_path, snap_target)  # hardlink
            except OSError:
                shutil.copy2(blob_path, snap_target)


# ── 验证 ─────────────────────────────────────────────────────────

def verify_cache(cache_dir: Path) -> bool:
    """检查缓存目录中是否包含所有必需文件。"""
    repo_dir = repo_cache_dir(cache_dir)
    if not repo_dir.is_dir():
        return False

    # 找到最新的 snapshot
    snapshots_dir = repo_dir / "snapshots"
    if not snapshots_dir.is_dir():
        return False

    snap_dirs = sorted(snapshots_dir.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
    if not snap_dirs:
        return False

    snap_dir = snap_dirs[0]
    missing = []
    for f in REQUIRED_FILES:
        if not (snap_dir / f).exists():
            missing.append(f)

    if missing:
        print(f"缓存不完整，缺失 {len(missing)} 个文件:")
        for f in missing:
            print(f"  - {f}")
        return False

    # 检查 onnx 文件大小（至少 30 MB，不完整的下载可能只有几 KB）
    onnx = snap_dir / "onnx" / "model.onnx"
    if onnx.exists():
        size_mb = onnx.stat().st_size / (1024 * 1024)
        if size_mb < 30:
            print(f"onnx/model.onnx 异常小 ({size_mb:.1f} MB)，可能下载不完整")
            return False

    return True


# ── main ─────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="下载 BGE-Small-ZH-V1.5 嵌入模型")
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=None,
        help=f"缓存目录（默认: {default_cache_dir()}）",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="强制重新下载，即使缓存已存在",
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="仅检查缓存是否完整，不下载",
    )
    args = parser.parse_args()

    cache_dir = args.cache_dir or default_cache_dir()
    print(f"缓存目录: {cache_dir}")
    print(f"模型: {MODEL_ID}\n")

    if args.check_only:
        ok = verify_cache(cache_dir)
        if ok:
            print("✓ 缓存完整，可以正常使用。")
        sys.exit(0 if ok else 1)

    if not args.force and verify_cache(cache_dir):
        print("✓ 缓存已存在且完整，无需下载。")
        print("  使用 --force 强制重新下载，使用 --check-only 仅检查。")
        return

    if args.force:
        repo_dir = repo_cache_dir(cache_dir)
        if repo_dir.exists():
            print("清理旧缓存...")
            shutil.rmtree(repo_dir)

    # 尝试 huggingface_hub（更快、更可靠）
    if download_via_hf_hub(cache_dir):
        pass
    else:
        print("\n回退到 urllib 直接下载...")
        if not download_via_urllib(cache_dir):
            print("\n" + "=" * 60)
            print("✗ 所有下载方式均失败。")
            print()
            print("请尝试以下操作：")
            print("  1. 设置 HF_ENDPOINT 环境变量切换镜像：")
            print("     set HF_ENDPOINT=https://hf.steamfor.cn")
            print("     然后重新运行本脚本")
            print("  2. 确保网络可以访问 huggingface.co 或其镜像")
            print("  3. 如使用代理，设置 HTTPS_PROXY 环境变量")
            sys.exit(1)

    # 验证
    print()
    if verify_cache(cache_dir):
        print("✓ 验证通过，模型可以使用了。")
        print("  重新启动 AIreader 即可使用 AI 索引功能。")
    else:
        print("✗ 验证失败：缓存不完整。")
        sys.exit(1)


if __name__ == "__main__":
    main()
