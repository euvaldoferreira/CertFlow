#!/usr/bin/env bash
# Monta dist-firefox/ e/ou dist-chrome/ com o manifesto certo em cada pasta.
# Todo o código-fonte (background.js, content/, lib/, popup/, options/,
# icons/) é o mesmo para os dois navegadores — só o manifest.json muda.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TARGET="${1:-all}"

SHARED_ITEMS=(background.js content lib popup options icons)

build_target() {
  local browser="$1"
  local manifest_src="$2"
  local out_dir="$ROOT_DIR/dist-$browser"

  echo "==> Construindo dist-$browser/"
  rm -rf "$out_dir"
  mkdir -p "$out_dir"

  for item in "${SHARED_ITEMS[@]}"; do
    cp -r "$ROOT_DIR/$item" "$out_dir/"
  done

  cp "$ROOT_DIR/$manifest_src" "$out_dir/manifest.json"
  echo "    pronto: $out_dir (carregue como extensão \"não empacotada\")"
}

case "$TARGET" in
  firefox)
    build_target firefox manifest.json
    ;;
  chrome)
    build_target chrome manifest.chrome.json
    ;;
  all)
    build_target firefox manifest.json
    build_target chrome manifest.chrome.json
    ;;
  *)
    echo "Uso: $0 [firefox|chrome|all]" >&2
    exit 1
    ;;
esac
