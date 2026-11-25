// Интерфейс на React без шага сборки.
//
// 🔴 React 19 НЕ ЭКСПОРТИРУЕТ `h` — только `createElement`. Проверено
// исполнением: `import { h } from 'react'` даёт undefined, и htm.bind(h)
// молча не рендерит ничего. Поэтому биндим createElement.
//
// htm даёт JSX-подобный синтаксис через шаблонные строки — компиляция не
// нужна, файл грузится браузером как есть. Это сохраняет главное
// свойство сборки: те же файлы работают в браузере, Android WebView и
// Chrome-расширении без бандлера.
//
// Зависимости тянутся с CDN и кэшируются браузером; при офлайне после
// первого визита их отдаёт service worker.

import { createElement, useState, useCallback, useRef } from 'https://esm.sh/react@19';
import { createRoot } from 'https://esm.sh/react-dom@19/client';
import htm from 'https://esm.sh/htm@3';

// 🔴 При `import htm from ...` значение УЖЕ является функцией.
// Обращение к .default давало undefined и падение
// 'Cannot read properties of undefined (reading bind)' — при
// ДИНАМИЧЕСКОМ импорте default нужен, при статическом нет.
// Поймано исполнением: сравнили оба способа в браузере.
const html = htm.bind(createElement);

/** Подпись источника с координатой: страница либо таймкод. */
function sourceOf(chunk) {
  const name = chunk.path;
  if (chunk.label) return `${name} (${chunk.label})`;
  if (chunk.page !== undefined && chunk.page !== null) return `${name} (с. ${chunk.page})`;
  return name;
}

const VIA_LABEL = { hybrid: 'смысл + слова', vector: 'смысл', lexical: 'слова' };

/**
 * Подсветка совпадений.
 *
 * 🔴 Граница слова через \p{L}, а НЕ \b: последний определён через
 * [A-Za-z0-9_] и с кириллицей не работает — проверено замером, из-за
 * этого 17 правил синонимов однажды молча не срабатывали.
 *
 * Возвращает массив узлов, а не HTML-строку: dangerouslySetInnerHTML на
 * пользовательском тексте — это внедрение разметки из документа.
 */
function highlight(text, terms) {
  const safe = terms
    .filter((t) => t.length > 3)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (safe.length === 0) return [text];

  const re = new RegExp(`(?:^|[^\\p{L}])((?:${safe.join('|')})\\p{L}*)`, 'giu');
  const nodes = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = (m.index ?? 0) + m[0].length - (m[1] ?? '').length;
    if (idx > last) nodes.push(text.slice(last, idx));
    nodes.push(html`<mark>${m[1]}</mark>`);
    last = idx + (m[1] ?? '').length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function Citation({ cite, index, terms }) {
  const { chunk, score, via } = cite;
  return html`
    <article class="hit ${via}">
      <div class="hit-head">
        <span class="hit-src">${index}. ${sourceOf(chunk)}</span>
        <span class="hit-meta">${VIA_LABEL[via] ?? via} · ${score.toFixed(4)}</span>
      </div>
      <div class="hit-text">${highlight(chunk.text, terms)}</div>
    </article>
  `;
}

/**
 * Панель поиска.
 *
 * Многострочное поле вместо однострочного: запрос может быть длинным
 * вопросом, а в input его не видно целиком. Enter отправляет,
 * Shift+Enter переносит строку — как принято в чатах.
 */
function SearchPanel({ onSearch, busy, disabled }) {
  const [query, setQuery] = useState('');
  const [expand, setExpand] = useState(true);
  const [mode, setMode] = useState('hybrid');
  const area = useRef(null);

  const submit = useCallback(() => {
    const q = query.trim();
    if (q && !busy) onSearch(q, { expand, mode });
  }, [query, expand, mode, busy, onSearch]);

  const onKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }, [submit]);

  return html`
    <section class="card">
      <textarea
        ref=${area}
        class="prompt"
        rows="3"
        placeholder="Задайте вопрос по документам. Enter — найти, Shift+Enter — новая строка."
        value=${query}
        disabled=${disabled}
        onInput=${(e) => setQuery(e.target.value)}
        onKeyDown=${onKeyDown}
      />
      <div class="ask-row">
        <button class="primary" onClick=${submit} disabled=${busy || disabled || !query.trim()}>
          ${busy ? 'Ищу…' : 'Найти'}
        </button>
        <label class="muted small">
          <input type="checkbox" checked=${expand} onChange=${(e) => setExpand(e.target.checked)} />
          расширять запрос
        </label>
        <label class="muted small">
          режим
          <select value=${mode} onChange=${(e) => setMode(e.target.value)}>
            <option value="vector">смысл</option>
            <option value="hybrid">смысл + слова</option>
            <option value="lexical">только слова</option>
          </select>
        </label>
      </div>
    </section>
  `;
}

function Results({ result, terms }) {
  if (!result) return null;

  if (result.citations.length === 0) {
    return html`<div class="card muted">Ничего не найдено по запросу «${result.prompt}»</div>`;
  }

  return html`
    <section>
      ${result.queries && result.queries.length > 1 && html`
        <div class="muted small split-note">
          вопрос разбит на ${result.queries.length}: ${result.queries.join(' | ')}
        </div>
      `}
      ${result.added && result.added.length > 0 && html`
        <div class="muted small split-note">+ ${result.added.join(' ')}</div>
      `}
      ${result.citations.map((c, i) => html`
        <${Citation} key=${c.chunk.id ?? i} cite=${c} index=${i + 1} terms=${terms} />
      `)}
      <div class="muted small split-note">
        ${result.citations.length} цитат за ${Math.round(result.tookMs)} мс
      </div>
    </section>
  `;
}

/**
 * Монтирует панель поиска.
 *
 * Вызывается из app.js после готовности движка: React отвечает ТОЛЬКО за
 * поиск и вывод, а выбор папки с индексацией остаются на обычном DOM —
 * переписывать работающее ради единообразия незачем.
 */
export function mountSearch(container, { onSearch }) {
  let setStateExternal = null;

  function Root() {
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState(null);
    const [terms, setTerms] = useState([]);
    const [disabled, setDisabled] = useState(false);

    setStateExternal = { setBusy, setResult, setTerms, setDisabled };

    const handle = useCallback(async (q, opts) => {
      setBusy(true);
      try {
        const r = await onSearch(q, opts);
        setResult(r);
        setTerms([...q.split(/\s+/), ...(r.added ?? [])]);
      } finally {
        setBusy(false);
      }
    }, []);

    return html`
      <${SearchPanel} onSearch=${handle} busy=${busy} disabled=${disabled} />
      <${Results} result=${result} terms=${terms} />
    `;
  }

  createRoot(container).render(createElement(Root));

  return {
    /** Сброс выдачи — например, после очистки индекса. */
    clear() {
      setStateExternal?.setResult(null);
    },
    setDisabled(v) {
      setStateExternal?.setDisabled(v);
    },
  };
}
