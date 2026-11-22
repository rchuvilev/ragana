#!/bin/sh
# Скачивает multilingual-e5-small и готовит Transformers.js к запуску
# в Alpine/musl/aarch64.
#
# Квантованная модель 113 МБ против 449 МБ fp32 — на телефоне это разница
# между «работает» и «не влезает».
set -e

MODEL="Xenova/multilingual-e5-small"
DIR="${1:-models/multilingual-e5-small}"
BASE="https://huggingface.co/$MODEL/resolve/main"

mkdir -p "$DIR/onnx"

fetch() {
  out="$DIR/$1"
  [ -s "$out" ] && { echo "есть: $1"; return; }
  echo "качаю: $1"
  curl -fsSL "$BASE/$1" -o "$out" || { echo "НЕ СКАЧАЛОСЬ: $1"; return 1; }
  # Проверка размера: HuggingFace отдаёт html-редиректы при ошибке,
  # и 300-байтный "файл модели" потом падает невнятно
  sz=$(wc -c < "$out")
  [ "$sz" -lt 1000 ] && echo "ПОДОЗРИТЕЛЬНО МАЛЫЙ ($sz Б): $1"
  true
}

fetch config.json
fetch tokenizer.json
fetch tokenizer_config.json
fetch special_tokens_map.json
fetch onnx/model_quantized.onnx

echo
echo "--- убираем native onnxruntime-node"
# Error relocating libonnxruntime.so.1: __getauxval: symbol not found
# это glibc-символ, здесь musl. Папку надо просто убрать.
rm -rf node_modules/onnxruntime-node && echo "убран" || echo "уже нет"

echo
echo "итог:"
du -sh "$DIR" 2>/dev/null
ls -la "$DIR/onnx" 2>/dev/null
