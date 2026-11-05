// Runs only in the QA copy of popup.html. Uses the existing read-only status API.
(() => {
  const report = { kind: 'native-status', startedAt: Date.now(), uidHash: null, updates: [], errors: 0 };
  let uid;
  let previous;
  let busy = false;
  const button = document.createElement('button');
  button.textContent = 'Скачать QA status';
  document.body.prepend(button);
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const { roomTabBindingsV2 = {} } = await chrome.storage.session.get('roomTabBindingsV2');
      const binding = Object.values(roomTabBindingsV2).find(value => value.key && value.target);
      if (!binding) return;
      const state = await chrome.runtime.sendMessage({ type: 'room-session', target: binding.target, action: 'status' });
      if (!state.uid || !state.room?.playback) return;
      if (uid && uid !== state.uid) throw new Error('UID changed');
      uid = state.uid;
      report.uidHash ??= Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uid))))
        .map(value => value.toString(16).padStart(2, '0')).join('');
      const { actorUid, commandId, ...playback } = state.room.playback;
      const value = { connected: state.connected, roomReady: state.roomReady, playback,
        ownActor: actorUid === uid, participants: Object.keys(state.room.presence ?? {}).length };
      const encoded = JSON.stringify(value);
      if (encoded !== previous) {
        report.updates.push({ at: performance.timeOrigin + performance.now(), ...value });
        previous = encoded;
      }
      button.textContent = `Скачать QA status (rev ${playback.revision})`;
    } catch { report.errors++; }
    finally { busy = false; }
  }, 100);
  button.onclick = () => {
    clearInterval(timer);
    report.finishedAt = Date.now();
    const url = URL.createObjectURL(new Blob([JSON.stringify(report)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `native-status-${report.uidHash?.slice(0, 8) ?? 'unknown'}.json`;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
})();
