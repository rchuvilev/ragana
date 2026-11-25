#!/bin/sh
# Сборка исполняемых файлов под все платформы.
#
#   sh tools/build.sh              для текущей системы
#   sh tools/build.sh windows      кросс-сборка под Windows
#   sh tools/build.sh all          всё, что возможно отсюда
#
# ВСЁ ВНУТРИ: модель эмбеддингов, WASM-рантайм ONNX и JS-библиотеки
# вшиваются в бинарь. Проверяется это не наличием файла, а запуском при
# УБРАННЫХ с диска models/ и node_modules/ — см. tools/verify-standalone.sh
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
VERSION="$(grep -o '"version": *"[^"]*"' "$ROOT/package.json" | head -1 | cut -d'"' -f4)"

cd "$ROOT"
mkdir -p "$DIST"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }

# vendor/ нужен до сборки: onnxruntime-common собирается в один файл
[ -f vendor/ort-common.mjs ] || sh tools/vendor.sh

TARGET="${1:-native}"

build_native() {
  say "сборка для текущей системы"
  bun build src/main.ts --compile --minify --outfile "$DIST/ragana"
  chmod +x "$DIST/ragana"
  printf '  %.1f МБ\n' "$(echo "$(wc -c < "$DIST/ragana") / 1048576" | bc -l)"
}

build_windows() {
  say "сборка для Windows x64"
  # 🔴 --windows-icon РАБОТАЕТ ТОЛЬКО ПРИ СБОРКЕ НА WINDOWS:
  # 'error: Using --windows-icon is only available when compiling on Windows'.
  # Отсюда иконка вшивается отдельным шагом через rcedit (см. ниже),
  # а метаданные задаются только на самой Windows.
  if [ "$(uname -s)" = "MINGW64_NT"* ] || [ -n "$WINDIR" ]; then
    bun build src/main.ts --compile --minify \
      --target=bun-windows-x64 \
      --windows-icon=./assets/ragana.ico \
      --windows-title="ragana" \
      --windows-publisher="hexstack" \
      --windows-version="${VERSION}.0" \
      --windows-description="Локальный RAG по вашим документам" \
      --outfile "$DIST/ragana.exe"
    echo "  иконка и метаданные вшиты нативно"
  else
    bun build src/main.ts --compile --minify \
      --target=bun-windows-x64 --outfile "$DIST/ragana.exe"
    warn "  иконка НЕ вшита: --windows-icon доступен только на Windows"
    echo "  чтобы добавить, выполните на Windows или через wine:"
    echo "    npx rcedit dist/ragana.exe \\"
    echo "      --set-icon assets/ragana.ico \\"
    echo "      --set-version-string ProductName ragana \\"
    echo "      --set-file-version ${VERSION}.0"
  fi
  printf '  %.1f МБ\n' "$(echo "$(wc -c < "$DIST/ragana.exe") / 1048576" | bc -l)"
}

build_macos() {
  say "сборка для macOS arm64"
  bun build src/main.ts --compile --minify \
    --target=bun-darwin-arm64 --outfile "$DIST/ragana-macos"
  chmod +x "$DIST/ragana-macos"
  # У Mach-O нет секции ресурсов, поэтому иконка живёт в бандле .app
  sh tools/make-app.sh "$DIST/ragana-macos" "$DIST/ragana.app" || true
  printf '  %.1f МБ\n' "$(echo "$(wc -c < "$DIST/ragana-macos") / 1048576" | bc -l)"
}

build_linux_desktop() {
  say "ярлык для Linux"
  # У ELF тоже нет места под иконку — её несёт .desktop-файл
  cat > "$DIST/ragana.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Version=1.0
Name=ragana
GenericName=Локальный поиск по документам
Comment=RAG по вашим файлам: цитаты с указанием страницы и времени
Exec=ragana --gui
Icon=ragana
Terminal=true
Categories=Utility;Office;
Keywords=rag;search;документы;поиск;
DESKTOP
  cp assets/ragana.png "$DIST/ragana.png"
  echo "  ragana.desktop + ragana.png"
  echo "  установка:"
  echo "    cp dist/ragana ~/.local/bin/"
  echo "    cp dist/ragana.png ~/.local/share/icons/hicolor/256x256/apps/"
  echo "    cp dist/ragana.desktop ~/.local/share/applications/"
}

case "$TARGET" in
  native)  build_native ;;
  windows) build_windows ;;
  macos)   build_macos ;;
  linux)   build_native; build_linux_desktop ;;
  all)     build_native; build_windows; build_macos; build_linux_desktop ;;
  *) echo "цель: native | windows | macos | linux | all"; exit 1 ;;
esac

echo
ls -la "$DIST" 2>/dev/null | awk 'NR>3 {printf "  %-24s %8.1f МБ\n", $9, $5/1048576}'
