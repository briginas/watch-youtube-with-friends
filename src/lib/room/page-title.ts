/** Хранит только собственную приставку, не удаляет похожие части title YouTube. */
export function createPageTitle(doc: Document) {
  let name: string | null = null;
  let base = doc.title;
  let own: string | null = null;
  function update(force = false) {
    const ownVisible = own !== null && doc.title === own;
    if (ownVisible && !force) return;
    if (!ownVisible) base = doc.title;
    if (name !== null) {
      own = `${name} | ${base}`;
      if (doc.title !== own) doc.title = own;
      // HTML title нормализует пробелы при чтении. Запоминаем фактический
      // результат, иначе такая нормализация выглядит как внешняя запись.
      own = doc.title;
    }
  }
  const observer = new MutationObserver(() => update());
  observer.observe(doc.head, { subtree: true, characterData: true, childList: true });
  return {
    set(next: string | null) {
      if (name === next) return;
      if (next === null) {
        name = null;
        if (own !== null && doc.title === own) doc.title = base;
        own = null;
      } else { name = next; update(true); }
    },
    dispose() {
      observer.disconnect();
      if (own !== null && doc.title === own) doc.title = base;
      own = null; name = null;
    },
  };
}
