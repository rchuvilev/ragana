# Веб-слой

Одна сборка работает в трёх средах:

| среда | как |
|---|---|
| браузер | `python3 -m http.server`, открыть `web/index.html` |
| Android WebView | виртуальный origin + `shouldInterceptRequest` (см. `android/`) |
| Chrome-расширение | страница расширения, `web_accessible_resources` |

## Почему не file://

`file://` даёт opaque origin: **IndexedDB не работает**, модульные воркеры
не загружаются. Отсюда виртуальный origin в Android-обёртке.

## Отличия от Node-слоя

Единственное — распаковка PDF: `DecompressionStream('deflate')` вместо
`node:zlib`. Проверено на реальном файле: оба пути дают **байт-в-байт
одинаковые 4354 символа**.

`numThreads` здесь ставится по числу ядер (в Node пришлось ставить 1,
потому что ORT создаёт воркер через `blob:`, а Node такое не грузит).
