#!/bin/sh
# Сборка единого исполняемого файла через bun build --compile.
#
# Проверено на этом устройстве: aarch64/musl, бинарь ~75 МБ (туда входит
# сам рантайм Bun — это цена отсутствия зависимостей у пользователя).
#
# 🔴 МОДЕЛЬ И БИБЛИОТЕКА В БИНАРЬ НЕ ВШИВАЮТСЯ: onnxruntime-web тянет
# .wasm, а модель — 113 МБ, и оба грузятся по путям во время работы.
# Поэтому рядом с бинарём должен лежать каталог с ними, либо путь
# задаётся через RAGANA_LIB_ROOT.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/ragana}"

cd "$ROOT"

say() { printf '\033[1m%s\033[0m\n' "$*"; }

say "сборка $OUT"
bun build src/main.ts \
  --compile \
  --minify \
  --target bun \
  --outfile "$OUT"

say "проверка"
# Проверяем не факт существования файла, а то, что он ОТВЕЧАЕТ:
# битый бинарь существует ровно так же, как рабочий.
if ! "$OUT" --help > /dev/null 2>&1; then
  echo "бинарь не отвечает на --help"
  exit 1
fi

SIZE=$(wc -c < "$OUT")
echo "  размер: $(echo "$SIZE" | awk '{printf "%.1f МБ", $1/1048576}')"
echo "  --help: ok"

# Позитивный контроль: несуществующий флаг не должен молча проглатываться
if "$OUT" --такого-флага-нет > /dev/null 2>&1; then
  echo "  предупреждение: неизвестный флаг принят без возражений"
fi

echo
echo "готово: $OUT"
echo
echo "Рядом с бинарём нужны (или задайте RAGANA_LIB_ROOT):"
echo "  models/multilingual-e5-small/   модель эмбеддингов (113 МБ)"
echo "  node_modules/onnxruntime-web/   рантайм WASM"
echo "  node/embedder.mjs               загрузчик модели"
