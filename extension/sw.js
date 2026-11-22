// Service worker расширения.
//
// Делает ровно одно: открывает приложение в полноценной вкладке по клику
// на иконку. Во всплывающем окне работать нельзя — оно закрывается при
// потере фокуса, а индексация идёт минутами, и её прерывание на середине
// оставило бы индекс рассогласованным со снимком.
//
// Вся работа идёт на странице app.html, а не здесь: service worker в MV3
// выгружается через ~30 секунд простоя, что несовместимо с долгой
// индексацией. IndexedDB при этом общая, так что состояние не теряется.

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('app.html');
  const existing = await chrome.tabs.query({ url });
  if (existing.length > 0 && existing[0]?.id !== undefined) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId !== undefined) {
      await chrome.windows.update(existing[0].windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url });
});
