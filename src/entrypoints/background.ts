import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { backendGeneration, firebaseConfig } from '../lib/firebase/config';
import { isInvitationPage } from '../lib/room/invitation';
import { isPopupSender } from '../lib/room/messages';
import { catalogRequestSchema } from '../lib/room/catalog-messages';
import { catalogError, catalogStorageKey, createCatalogRepository, type CatalogPopupSnapshot, type CatalogRoom } from '../lib/room/catalog';
import { isExtensionFrameSender, tabBindingsSchema, tabRequestSchema } from '../lib/room/tab-messages';
import { initialView, observeRoute, reconcileView } from '../lib/room/view';
import { getWatchVideoId } from '../lib/youtube-url';
import { z } from 'zod';

type Bindings = z.infer<typeof tabBindingsSchema>;

export default defineBackground(() => {
  const storageKey = `roomTabBindings:${firebaseConfig() ? catalogStorageKey(firebaseConfig()!) : 'unconfigured'}`;
  let pending: Promise<unknown> = Promise.resolve();
  const entries = new Map<string, string>();
  const entryMessage = z.object({ type: z.literal('room-entry'), action: z.enum(['begin', 'cancel']), operation: z.string().uuid(), target: z.string().uuid().optional() }).strict();
  const sourceKey = (sender: { tab?: { id?: number }; frameId?: number; url?: string }) => `${sender.tab?.id ?? 'popup'}:${sender.frameId ?? 0}:${sender.url}`;
  const entryLive = (source: string, operation?: string) => operation === undefined || entries.get(source) === operation;

  function serialize<T>(run: () => Promise<T>): Promise<T> {
    const operation = pending.then(run);
    pending = operation.catch(() => {});
    return operation;
  }
  let storageReady: Promise<void> | undefined;
  async function catalog() {
    // Никаких секретов в local до успешного ограничения доступа.
    storageReady ??= browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(error => {
      storageReady = undefined;
      throw error;
    });
    await storageReady;
    const config = firebaseConfig();
    if (!config) throw new Error('Подключение к серверу ещё не настроено.');
    return createCatalogRepository(browser.storage.local, catalogStorageKey(config));
  }
  async function bindings() {
    const stored = await browser.storage.session.get(storageKey);
    return tabBindingsSchema.parse(stored[storageKey] ?? {});
  }
  async function persist(rooms: Bindings) {
    await browser.storage.session.set({ [storageKey]: rooms });
  }
  async function saveRoom(rooms: Bindings, tabId: number, room: CatalogRoom) {
    const binding = rooms[tabId];
    if (!binding || !('key' in binding)) throw new Error('session/missing-binding');
    // Pending остаётся доступным session UI, если popup закроется при фокусе вкладки.
    binding.catalogPending = room;
    await persist(rooms);
    try {
      await (await catalog()).save(room);
      delete binding.catalogPending;
      await persist(rooms);
      return { catalogError: null };
    } catch { return { catalogError }; }
  }
  async function focus(rooms: Bindings, key: string, live: () => boolean = () => true) {
    for (const [id, binding] of Object.entries(rooms)) {
      if (!('key' in binding) || binding.key !== key || binding.backendGeneration !== backendGeneration) continue;
      let tab;
      try { tab = await browser.tabs.get(Number(id)); }
      catch { delete rooms[id]; continue; }
      if (!live()) return undefined;
      await browser.tabs.update(tab.id!, { active: true });
      await browser.windows.update(tab.windowId, { focused: true });
      await persist(rooms);
      return tab.id!;
    }
    await persist(rooms);
    return undefined;
  }
  async function open(rooms: Bindings, room: CatalogRoom, live: () => boolean = () => true) {
    if (!live()) return { opened: false };
    const existing = await focus(rooms, room.key, live);
    if (existing !== undefined) return { opened: true, ...await saveRoom(rooms, existing, room) };
    if (!live()) return { opened: false };
    const tab = await browser.tabs.create({ url: 'about:blank', active: false });
    rooms[tab.id!] = { ...room, view: initialView(room.videoId) };
    try {
      await persist(rooms);
      if (!live()) throw new Error('entry/cancelled');
      await browser.tabs.update(tab.id!, { url: `https://www.youtube.com/watch?v=${room.videoId}`, active: true });
    } catch (error) {
      delete rooms[tab.id!];
      await persist(rooms);
      await browser.tabs.remove(tab.id!);
      throw error;
    }
    return { opened: true, ...await saveRoom(rooms, tab.id!, room) };
  }

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const entry = entryMessage.safeParse(message);
    if (entry.success) {
      const config = firebaseConfig();
      if (!isPopupSender(sender, browser.runtime.id) && !(config && entry.data.target &&
        isExtensionFrameSender(sender, browser.runtime.id, 'invitation', entry.data.target) &&
        isInvitationPage(sender.tab?.url ?? '', config.invitationBaseUrl))) return;
      const source = sourceKey(sender);
      if (entry.data.action === 'begin') entries.set(source, entry.data.operation);
      else if (entries.get(source) === entry.data.operation) entries.delete(source);
      sendResponse({ accepted: true }); return;
    }
    const catalogAction = catalogRequestSchema.safeParse(message);
    if (catalogAction.success) {
      if (!isPopupSender(sender, browser.runtime.id)) return;
      serialize(async () => {
        const repository = await catalog();
        const action = catalogAction.data;
        if (action.action === 'list') {
          const [snapshot, rooms, tabs, [active]] = await Promise.all([
            repository.read(), bindings(), browser.tabs.query({}), browser.tabs.query({ active: true,
              ...(sender.tab ? { windowId: sender.tab.windowId } : { currentWindow: true }),
            }),
          ]);
          const tabStates: CatalogPopupSnapshot['tabStates'] = {};
          const keys = new Set(snapshot.entries.map(entry => entry.key));
          for (const tab of tabs) {
            const binding = rooms[tab.id!];
            if (!binding || !('key' in binding) || binding.backendGeneration !== backendGeneration || !keys.has(binding.key)) continue;
            tabStates[binding.key] = tab.id === active?.id ? 'current' : 'other';
          }
          return { ...snapshot, tabStates } satisfies CatalogPopupSnapshot;
        }
        const rooms = await bindings();
        if (action.action === 'remove') {
          await repository.remove(action.key);
          for (const binding of Object.values(rooms)) {
            if ('key' in binding && binding.key === action.key) delete binding.catalogPending;
          }
          await persist(rooms);
          return { accepted: true };
        }
        const key = action.action === 'open' ? action.room.key : action.key;
        const entry = (await repository.read()).entries.find(item => item.key === key);
        if (!entry) throw new Error('Комнаты нет в списке. Откройте popup ещё раз.');
        if (action.action === 'activate') {
          const id = await focus(rooms, key, () => entryLive(sourceKey(sender), action.operation));
          if (id === undefined) return { opened: false };
          return { opened: true, ...await saveRoom(rooms, id, { key, name: entry.name, videoId: entry.videoId, backendGeneration }) };
        }
        return open(rooms, action.room, () => entryLive(sourceKey(sender), action.operation));
      }).then(sendResponse, error => sendResponse({ error: error instanceof Error
        && /^(Формат списка|Комнаты нет|Подключение к серверу)/u.test(error.message) ? error.message : catalogError }));
      return true;
    }
    const parsed = tabRequestSchema.safeParse(message);
    if (!parsed.success) return;
    const action = parsed.data;
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number') return;
    const onYouTube = /^https:\/\/(www\.)?youtube\.com\//u.test(sender.tab?.url ?? '');
    if (action.type === 'room-tab-restore' || action.type === 'room-tab-attach' || action.type === 'room-tab-route') {
      if (sender.id !== browser.runtime.id || sender.frameId !== 0 || !onYouTube
        || (action.type !== 'room-tab-route' && !getWatchVideoId(sender.url))) return;
    } else if ((action.type === 'room-tab-open' || action.type === 'room-tab-activate')) {
      const config = firebaseConfig();
      if (!config || !isExtensionFrameSender(sender, browser.runtime.id, 'invitation', action.target)
        || !isInvitationPage(sender.tab?.url ?? '', config.invitationBaseUrl)) return;
    } else if (!isExtensionFrameSender(sender, browser.runtime.id, 'session', action.target)
      || !onYouTube) return;

    serialize(async () => {
      const rooms = await bindings();
      if (action.type === 'room-tab-restore') return { restore: !!rooms[tabId] && 'key' in rooms[tabId] };
      if (action.type === 'room-tab-attach') {
        const previous = rooms[tabId];
        rooms[tabId] = { ...previous, target: action.target, backendGeneration };
        if (previous && 'key' in previous) {
          previous.view = observeRoute(previous.view, { videoId: getWatchVideoId(sender.tab?.url), sequence: 0 }, previous.videoId, true);
          rooms[tabId] = { ...previous, target: action.target, backendGeneration };
        }
        await persist(rooms);
        return { accepted: true };
      }
      if (action.type === 'room-tab-activate') {
        if (!entryLive(sourceKey(sender), action.operation)) return { opened: false };
        const id = await focus(rooms, action.key, () => entryLive(sourceKey(sender), action.operation));
        if (id === undefined) return { opened: false };
        const binding = rooms[id]!;
        if (!('key' in binding)) return { opened: false };
        return { opened: true, ...await saveRoom(rooms, id, { key: binding.key, videoId: binding.videoId, name: binding.name, backendGeneration }) };
      }
      if (action.type === 'room-tab-open') return open(rooms, { key: action.key, videoId: action.videoId, name: action.name, backendGeneration }, () => entryLive(sourceKey(sender), action.operation));
      if (rooms[tabId]?.target !== action.target) throw new Error('session/stale-target');
      const binding = rooms[tabId];
      if (action.type === 'room-tab-route') {
        if (binding && 'key' in binding) {
          binding.view = observeRoute(binding.view, action.route, binding.videoId);
          await persist(rooms);
        }
        return { accepted: true };
      }
      if (action.type === 'room-tab-switch-pending') {
        if (!binding || !('key' in binding)) throw new Error('session/missing-binding');
        if (action.pending) binding.view.pendingSwitch = action.pending;
        else delete binding.view.pendingSwitch;
        await persist(rooms);
        return { accepted: true };
      }
      if (action.type === 'room-tab-view') {
        if (!binding || !('key' in binding)) throw new Error('session/missing-binding');
        if (action.route.sequence !== binding.view.route.sequence
          || action.route.videoId !== binding.view.route.videoId) return { stale: true };
        if (action.playback.revision < binding.view.revision) return { stale: true };
        binding.view = reconcileView(binding.view, action.playback, action.ownCommand, action.force);
        binding.videoId = action.playback.videoId;
        const currentTab = await browser.tabs.get(tabId);
        const actual = getWatchVideoId(currentTab.url);
        if (actual !== action.route.videoId) {
          binding.view = observeRoute(binding.view, { videoId: actual, sequence: action.route.sequence + 1 }, binding.videoId);
          await persist(rooms);
          return { stale: true };
        }
        const navigate = binding.view.mode === 'following' && actual !== binding.videoId;
        if (navigate) binding.view.pendingNavigation = {
          videoId: binding.videoId, videoRevision: binding.view.videoRevision,
          operationToken: crypto.randomUUID(), source: action.route,
        };
        await persist(rooms);
        if (navigate) {
          const check = await browser.tabs.get(tabId);
          if (getWatchVideoId(check.url) !== actual) {
            binding.view = observeRoute(binding.view, { videoId: getWatchVideoId(check.url), sequence: action.route.sequence + 1 }, binding.videoId);
            delete binding.view.pendingNavigation;
            await persist(rooms);
            return { stale: true };
          }
          await browser.tabs.update(tabId, { url: `https://www.youtube.com/watch?v=${binding.videoId}` });
        }
        return { view: binding.view, navigating: navigate };
      }
      if (action.type === 'room-tab-ready') {
        const binding = rooms[tabId];
        return 'key' in binding ? { binding } : {};
      }
      if (action.type === 'room-tab-catalog-status' || action.type === 'room-tab-catalog-retry') {
        const binding = rooms[tabId];
        if (!('key' in binding) || !binding.catalogPending) return { catalogError: null };
        return action.type === 'room-tab-catalog-status' ? { catalogError } : saveRoom(rooms, tabId, binding.catalogPending);
      }
      if (action.type === 'room-tab-bind') {
        const room = { key: action.key, videoId: action.videoId, name: action.name, backendGeneration };
        rooms[tabId] = { ...room, view: initialView(room.videoId), target: action.target };
        await persist(rooms);
        return { accepted: true, ...await saveRoom(rooms, tabId, room) };
      }
      rooms[tabId] = { target: action.target, backendGeneration };
      await persist(rooms);
      return { accepted: true };
    }).then(sendResponse, () => sendResponse({ error: 'Не удалось открыть вкладку комнаты. Повторите попытку.' }));
    return true;
  });

  browser.tabs.onRemoved.addListener(tabId => {
    void serialize(async () => {
      const rooms = await bindings();
      delete rooms[tabId];
      await persist(rooms);
    }).catch(() => {});
  });
});
