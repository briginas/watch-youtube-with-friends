// Test-only isolated content script. No commands, Firebase, or runtime bridge.
(() => {
  let timer;
  let report;
  let lastInput;
  const now = () => performance.timeOrigin + performance.now();
  const read = () => {
    const root = document.querySelector('#movie_player');
    const video = root?.querySelector('video.html5-main-video');
    if (!video) return null;
    const ad = root.matches('.ad-showing, .ad-interrupting');
    return { at: now(), position: video.currentTime, rate: video.playbackRate,
      playing: !video.paused && !video.ended, ready: video.readyState >= 3 && !video.seeking && !video.error && !ad,
      ad, buffering: video.readyState < 3 };
  };
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'closed' });
  host.style.cssText = 'position:fixed;right:8px;top:76px;z-index:2147483647';
  shadow.innerHTML = '<style>div{background:#fff;color:#111;padding:6px;font:13px sans-serif;border:2px solid #d40}button{margin:3px}</style><div>Native QA <button>A: начать</button><button>B: начать</button><button>Скачать media</button><span></span></div>';
  document.documentElement.append(host);
  const [a, b, download] = shadow.querySelectorAll('button');
  const label = shadow.querySelector('span');
  function start(client) {
    clearInterval(timer);
    lastInput = null;
    report = { kind: 'native-media', client, startedAt: now(), browser: navigator.userAgent,
      videoId: new URL(location.href).searchParams.get('v'), points: [], inputs: [], changes: [], gestures: [] };
    timer = setInterval(() => {
      const point = read();
      if (point) report.points.push(point);
      if (report.points.length >= 120_000) clearInterval(timer);
    }, 10);
    label.textContent = `${client}: запись`;
  }
  a.onclick = () => start('A'); b.onclick = () => start('B');
  document.addEventListener('keydown', event => {
    if (!report || !event.isTrusted || !(event.target instanceof Element)
      || !event.target.closest('#movie_player') || event.ctrlKey || event.altKey || event.metaKey) return;
    lastInput = { at: now(), key: event.key, code: event.code, shift: event.shiftKey, trusted: event.isTrusted, repeat: event.repeat };
    report.inputs.push(lastInput);
    label.textContent = `${report.client}: ${report.inputs.length} клавиш`;
  }, true);
  for (const name of ['keydown', 'keyup', 'pointerdown', 'pointerup', 'pointercancel', 'blur']) {
    (name === 'blur' ? window : document).addEventListener(name, event => {
      if (!report || !event.isTrusted) return;
      const target = event.target instanceof Element ? event.target : null;
      if (name !== 'blur' && !target?.closest('#movie_player')) return;
      report.gestures.push({ at: now(), type: name, key: event.key, code: event.code,
        repeat: event.repeat, x: event.clientX, y: event.clientY,
        seekControl: !!target?.closest('.ytp-progress-bar, .ytp-scrubber-container'), point: read() });
    }, true);
  }
  for (const name of ['play', 'pause', 'seeking', 'ratechange']) document.addEventListener(name, event => {
    if (!report || !lastInput || now() - lastInput.at > 1500
      || !(event.target instanceof HTMLVideoElement) || !event.target.matches('#movie_player video.html5-main-video')) return;
    report.changes.push({ inputAt: lastInput.at, event: name, point: read() });
  }, true);
  download.onclick = () => {
    if (!report) return;
    clearInterval(timer);
    report.finishedAt = now();
    const url = URL.createObjectURL(new Blob([JSON.stringify(report)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `native-media-${report.client}.json`;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
    label.textContent = `${report.client}: сохранено`;
  };
})();
