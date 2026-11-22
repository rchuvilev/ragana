#!/bin/sh
# Собирает распакованное Chrome-расширение в extension/dist/.
#
# Расширение использует ТЕ ЖЕ core/*.mjs и веб-слой, что APK и браузер —
# копируются, а не дублируются. Отличия только в manifest.json и sw.js.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/extension/dist"

rm -rf "$DIST"
mkdir -p "$DIST/core"

cp "$ROOT/extension/manifest.json" "$ROOT/extension/sw.js" "$DIST/"
cp "$ROOT/web/style.css" "$ROOT/web/app.js" "$ROOT/web/pdf-web.js" "$DIST/"
cp "$ROOT"/core/*.mjs "$DIST/core/"

# app.html вместо index.html — так называет его manifest
cp "$ROOT/web/index.html" "$DIST/app.html"

# В расширении раскладка плоская: '../core/' -> './core/'
sed -i "s#from '../core/#from './core/#g" "$DIST/app.js"

# 🔴 MV3 ЗАПРЕЩАЕТ ЗАГРУЗКУ СКРИПТОВ С ВНЕШНИХ ДОМЕНОВ.
# import() с cdn.jsdelivr.net будет заблокирован CSP, поэтому
# библиотека обязана лежать локально.
VENDOR="$ROOT/node_modules/@huggingface/transformers/dist/transformers.web.js"
if [ -f "$VENDOR" ]; then
  mkdir -p "$DIST/vendor"
  cp "$VENDOR" "$DIST/vendor/transformers.js"
  # Только базовый SIMD-вариант: jsep (WebGPU), jspi и asyncify весят
  # по ~20 МБ каждый и на телефоне не используются — WASM-путь берёт
  # ort-wasm-simd-threaded.wasm.
  cp "$ROOT"/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm "$DIST/vendor/" 2>/dev/null || true
  sed -i "s#'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2'#'./vendor/transformers.js'#" "$DIST/app.js"
  echo "библиотека вложена локально (требование CSP MV3)"
else
  echo "ВНИМАНИЕ: нет $VENDOR — расширение не сможет загрузить модель"
fi

COUNT=$(find "$DIST" -type f | wc -l)
SIZE=$(du -sh "$DIST" | cut -f1)
echo "готово: $DIST ($COUNT файлов, $SIZE)"
echo
echo "Установка: chrome://extensions -> Режим разработчика -> Загрузить распакованное -> $DIST"
