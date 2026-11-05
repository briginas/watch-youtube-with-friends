// Статический скрипт Hosting: только публичный GET на собственный origin.
(() => {
  const status = document.querySelector('#generation-status');
  const installation = document.querySelector('#installation');
  if (!status || !installation) return; // privacy не запускает диагностику
  let controller;
  const keys = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
  const version = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) && value.split('.').every(part => Number.isSafeInteger(Number(part)));
  const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
  const generation = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value);
  function valid(value) {
    if (!keys(value, ['schemaVersion', 'revision', 'updatedAt', 'generations']) || value.schemaVersion !== 1 ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 || !date(value.updatedAt) || Date.parse(value.updatedAt) > Date.now() + 300000 || !Array.isArray(value.generations)) return false;
    const seen = new Set(); let active = 0;
    for (const entry of value.generations) {
      if (!entry || !['active', 'retired'].includes(entry.state) ||
        !keys(entry, entry.state === 'retired' ? ['generation', 'firstRelease', 'state', 'retiredAt'] : ['generation', 'firstRelease', 'state']) ||
        !generation(entry.generation) || !version(entry.firstRelease) || seen.has(entry.generation)) return false;
      seen.add(entry.generation);
      if (entry.state === 'retired' && (!date(entry.retiredAt) || Date.parse(entry.retiredAt) > Date.parse(value.updatedAt))) return false;
      if (entry.state === 'active' && ++active > 3) return false;
    }
    return true;
  }
  async function show() {
    controller?.abort(); controller = new AbortController(); const current = controller;
    delete installation.dataset.generationRetired;
    installation.hidden = installation.dataset.extensionReady === 'true';
    const params = new URLSearchParams(location.hash.slice(1));
    const id = params.get('generation'); // room/UID/token никогда не включаются в запрос
    if (params.size !== 2 || !generation(id) || !/^[A-Za-z0-9_-]{32,128}$/.test(params.get('room') ?? '')) {
      status.textContent = location.hash ? 'Приглашение повреждено или относится к прежнему формату. Попросите новую ссылку.' : '';
      return;
    }
    status.textContent = 'Проверяем поддержку комнаты…';
    const timer = setTimeout(() => current.abort(), 3000);
    try {
      const response = await fetch('/backend-generations.json', { signal: current.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
      const registry = response.ok ? await response.json() : null;
      if (current !== controller || current.signal.aborted) return;
      if (!valid(registry)) throw new Error('registry');
      const entry = registry.generations.find(item => item.generation === id);
      if (entry?.state === 'retired') {
        status.textContent = 'Поддержка этой комнаты завершена. Обновите расширение, откройте нужное видео и создайте новую комнату.';
        installation.dataset.generationRetired = 'true';
        installation.hidden = true;
      } else status.textContent = entry ? 'Поколение комнаты поддерживается. Для входа установите совместимую версию расширения.'
        : 'Поколение комнаты неизвестно. Поддержку подтвердить не удалось; обновите расширение или попросите новую ссылку.';
    } catch {
      if (current === controller) status.textContent = 'Не удалось проверить поддержку комнаты. Проверьте интернет и повторите позже.';
    } finally { clearTimeout(timer); }
  }
  addEventListener('hashchange', show);
  addEventListener('pagehide', () => controller?.abort());
  void show();
})();
