#!/bin/sh
# Готовит иконки под три платформы из assets/icon-source.jpg.
#
# ПОЧЕМУ РАЗНЫЕ СПОСОБЫ: иконку можно вшить в исполняемый файл только на
# Windows — там PE-формат имеет секцию ресурсов. У Mach-O (macOS) и ELF
# (Linux) такого поля нет вовсе, поэтому иконка принадлежит не файлу, а
# обёртке: бандлу .app либо ярлыку .desktop.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/assets/icon-source.jpg"
OUT="$ROOT/assets"

[ -f "$SRC" ] || { echo "нет исходника: $SRC"; exit 1; }

say() { printf '\033[1m%s\033[0m\n' "$*"; }

# Квадратность проверяется до работы: несквадратный исходник даст
# растянутую иконку, и заметно это станет уже в системе.
W=$(magick identify -format '%w' "$SRC")
H=$(magick identify -format '%h' "$SRC")
[ "$W" = "$H" ] || echo "ПРЕДУПРЕЖДЕНИЕ: исходник $W×$H не квадратный"

say "1/4 PNG-набор"
mkdir -p "$OUT/png"
for s in 16 24 32 48 64 128 256 512 1024; do
  magick "$SRC" -resize "${s}x${s}" -strip "$OUT/png/icon-${s}.png"
done
echo "  $(ls "$OUT/png" | wc -l) размеров"

say "2/4 Windows .ico"
# В .ico кладутся все размеры до 256 включительно: Windows сам выбирает
# нужный для контекста (список файлов, панель задач, Alt+Tab).
magick "$OUT/png/icon-16.png" "$OUT/png/icon-24.png" "$OUT/png/icon-32.png" \
       "$OUT/png/icon-48.png" "$OUT/png/icon-64.png" "$OUT/png/icon-128.png" \
       "$OUT/png/icon-256.png" "$OUT/ragana.ico"
echo "  ragana.ico: $(magick identify "$OUT/ragana.ico" | wc -l) изображений"

say "3/4 macOS .icns"
ICONSET="$OUT/ragana.iconset"
rm -rf "$ICONSET"; mkdir -p "$ICONSET"
# Имена строго по требованиям Apple, иначе iconutil откажется собирать
magick "$SRC" -resize 16x16     "$ICONSET/icon_16x16.png"
magick "$SRC" -resize 32x32     "$ICONSET/icon_16x16@2x.png"
magick "$SRC" -resize 32x32     "$ICONSET/icon_32x32.png"
magick "$SRC" -resize 64x64     "$ICONSET/icon_32x32@2x.png"
magick "$SRC" -resize 128x128   "$ICONSET/icon_128x128.png"
magick "$SRC" -resize 256x256   "$ICONSET/icon_128x128@2x.png"
magick "$SRC" -resize 256x256   "$ICONSET/icon_256x256.png"
magick "$SRC" -resize 512x512   "$ICONSET/icon_256x256@2x.png"
magick "$SRC" -resize 512x512   "$ICONSET/icon_512x512.png"
magick "$SRC" -resize 1024x1024 "$ICONSET/icon_512x512@2x.png"

if command -v iconutil > /dev/null 2>&1; then
  iconutil -c icns "$ICONSET" -o "$OUT/ragana.icns"
  echo "  ragana.icns собран"
else
  # iconutil есть только на macOS. ImageMagick умеет писать .icns, но
  # не все размеры — поэтому честно помечаем результат как запасной.
  magick "$OUT/png/icon-512.png" "$OUT/ragana.icns" 2>/dev/null \
    && echo "  ragana.icns собран через magick (iconutil недоступен)" \
    || echo "  .icns не собран: нужен iconutil на macOS"
fi

say "4/4 Linux"
cp "$OUT/png/icon-256.png" "$OUT/ragana.png"
echo "  ragana.png (256×256)"

echo
ls -la "$OUT"/ragana.* 2>/dev/null | awk '{printf "  %-28s %8.1f КБ\n", $9, $5/1024}'
