#!/bin/sh
# Готовит vendor/ — зависимости, собранные в одиночные файлы.
#
# onnxruntime-common состоит из 21 ES-модуля с относительными импортами.
# Копировать их по одному и чинить пути внутри каждого — хрупко, поэтому
# пакет предварительно собирается в один самодостаточный файл.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p vendor
bun build node_modules/onnxruntime-common/dist/esm/index.js \
  --target browser --format esm --outfile vendor/ort-common.mjs
# Контроль: в собранном файле не должно остаться импортов по ИМЕНАМ —
# иначе он снова потребует node_modules на машине пользователя.
if grep -qE "from['\"][a-z@][^'\"]*['\"]" vendor/ort-common.mjs; then
  echo "ОШИБКА: в vendor/ort-common.mjs остались внешние импорты"
  exit 1
fi
printf 'vendor/ort-common.mjs: %s КБ\n' "$(( $(wc -c < vendor/ort-common.mjs) / 1024 ))"
