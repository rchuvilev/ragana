# Android-обёртка

`sh tools/build-apk.sh` → `ragana.apk` (59 КБ, подписан v2+v3).

## Почему не file://

Ассеты **нельзя** отдавать через `file://`: документ получает opaque
origin, из-за чего **не работает IndexedDB** и не грузятся модульные
воркеры. А IndexedDB — единственное хранилище, общее для WebView,
Chrome-расширения и браузера, то есть то, ради чего и затевалась одна
кодовая база.

Решение: виртуальный origin `https://ragana.localhost` +
`shouldInterceptRequest`. Там же выставляются COOP/COEP — без них нет
`SharedArrayBuffer`, а без него onnxruntime-web не может в многопоточный
WASM.

## Почему нужен мост

В WebView нет File System Access API. Поэтому:

| задача | решение |
|---|---|
| выбрать папку | `ACTION_OPEN_DOCUMENT_TREE` (SAF) |
| обойти дерево | `DocumentsContract` в Java |
| прочитать файл | `ContentResolver` → **base64** (JS-мост не умеет бинарь) |

Весь веб-код обращается к мосту только под проверкой `hasNative()`, так
что та же сборка работает в обычном браузере без изменений.

## Сборка без Gradle

🔴 `aapt2` и `zipalign` существуют **только под x86-64** — Google Maven не
публикует их для linux-aarch64 (проверено 8.2.0/8.1.0/7.4.2 → 404).
Запускаются через `qemu-x86_64 -L /opt/x86root`. Java-инструменты
(`d8`, `apksigner`) кроссплатформенны и работают нативно.

🔴 `-bootclasspath` несовместим с `-target 11` в JDK 17. Правильно:
`javac --release 11 -classpath android.jar`.

## Что ещё не сделано

Модель (113 МБ) пока тянется с CDN при первом запуске. Чтобы приложение
было офлайн с первого старта, её надо положить в `assets/vendor/`.
