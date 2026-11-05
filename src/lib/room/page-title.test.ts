import { afterEach, expect, it, vi } from 'vitest';
import { createPageTitle } from './page-title';
afterEach(() => vi.unstubAllGlobals());
function fixture(title: string) {
  let mutation = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) { mutation = callback; }
    observe() {}
    disconnect = disconnect;
  });
  const doc = { title, head: {} } as Document;
  return { doc, changed: () => mutation(), disconnect };
}
it('сохраняет внешние похожие префиксы и последний title при выходе', () => {
  const f = fixture('Комната | собственный title');
  const controller = createPageTitle(f.doc);
  controller.set('Комната');
  expect(f.doc.title).toBe('Комната | Комната | собственный title');
  f.changed(); f.changed();
  expect(f.doc.title).toBe('Комната | Комната | собственный title');
  f.doc.title = 'Новый ролик'; f.changed();
  expect(f.doc.title).toBe('Комната | Новый ролик');
  controller.set(null); expect(f.doc.title).toBe('Новый ролик');
  f.doc.title = 'После выхода'; f.changed(); expect(f.doc.title).toBe('После выхода');
});
it('не восстанавливает старый title поверх ещё не обработанной внешней записи', () => {
  const f = fixture('Первый'); const controller = createPageTitle(f.doc);
  controller.set('<b>текст</b>');
  f.doc.title = 'Последний'; controller.dispose();
  expect(f.doc.title).toBe('Последний'); expect(f.disconnect).toHaveBeenCalledOnce();
});
it('распознаёт свою запись после нормализации пробелов HTML title', () => {
  const f = fixture('Видео');
  let title = f.doc.title;
  let writes = 0;
  Object.defineProperty(f.doc, 'title', {
    get: () => title,
    set: (value: string) => { writes++; title = value.replace(/[\t\n\f\r ]+/g, ' ').trim(); },
  });
  const controller = createPageTitle(f.doc);
  controller.set('Имя  \n комнаты');
  f.changed(); f.changed();
  expect(f.doc.title).toBe('Имя комнаты | Видео');
  expect(writes).toBe(1);
  controller.set('Другая');
  expect(f.doc.title).toBe('Другая | Видео');
  controller.set(null);
  expect(f.doc.title).toBe('Видео');
});
