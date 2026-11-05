import { expect, type BrowserContext, type Page } from '@playwright/test';
import { frameOf, popup, setup, watch } from './fixtures';
import type { Playback } from '../../src/lib/playback/model';

export function playerFixture() {
  const length = 120 * 8000;
  const wav = Buffer.alloc(44 + length, 128);
  wav.write('RIFF'); wav.writeUInt32LE(36 + length, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(length, 40);
  return `<!doctype html><title>Shared playback fixture</title>
  <div id="movie_player" tabindex="0" style="position:absolute;top:0;left:0">
    <video class="html5-main-video" preload="auto" src="data:audio/wav;base64,${wav.toString('base64')}"></video>
    <button class="ytp-play-button">Play/pause</button>
    <div class="ytp-progress-bar" tabindex="0" style="width:400px;height:30px;background:#999">Seek</div>
    <button class="ytp-variable-speed-panel-button">Rate</button>
    <button class="ytp-mute-button">Mute</button>
    <div class="ytp-volume-panel" role="slider" aria-label="Volume" tabindex="0">Volume</div>
    <button class="ytp-subtitles-button" aria-pressed="false">Subtitles</button>
    <div class="ytp-quality-menu ytp-panel-menu">
      <button role="menuitemradio" aria-checked="true"><span class="ytp-menuitem-label">144p</span></button>
      <button role="menuitemradio" aria-checked="false"><span class="ytp-menuitem-label">360p</span></button>
      <button role="menuitemradio" aria-checked="false"><span class="ytp-menuitem-label">720p</span></button>
    </div>
  </div>
  <script>
    const video = document.querySelector('video');
    const player = document.querySelector('#movie_player');
    let playerRate = 1;
    player.getPlaybackRate = () => playerRate;
    player.setPlaybackRate = rate => { playerRate = rate; video.playbackRate = rate; };
    document.querySelector('.ytp-play-button').onclick = () => video.paused ? video.play() : video.pause();
    document.querySelector('.ytp-progress-bar').onpointerdown = () => video.currentTime = 12;
    document.querySelector('.ytp-progress-bar').onpointermove = e => { if (e.buttons) video.currentTime = 30; };
    document.querySelector('.ytp-variable-speed-panel-button').onclick = () => player.setPlaybackRate(playerRate === 1.5 ? 1.75 : 1.5);
    document.querySelector('.ytp-mute-button').onclick = () => video.muted = !video.muted;
    const track = video.addTextTrack('captions', 'English', 'en');
    track.mode = 'disabled';
    const captions = document.querySelector('.ytp-subtitles-button');
    captions.onclick = () => {
      track.mode = track.mode === 'showing' ? 'disabled' : 'showing';
      captions.setAttribute('aria-pressed', String(track.mode === 'showing'));
    };
    document.querySelectorAll('.ytp-quality-menu button').forEach(button => button.onclick = () => {
      document.querySelectorAll('.ytp-quality-menu button').forEach(item => item.setAttribute('aria-checked', String(item === button)));
      // Управляемый переход качества: системная буферизация не является командой.
      video.dispatchEvent(new Event('waiting'));
      setTimeout(() => video.dispatchEvent(new Event('canplay')), 200);
    });
    document.addEventListener('keydown', e => {
      if (e.target.closest('.ytp-volume-panel')) {
        if (e.key === 'ArrowLeft') video.volume = Math.max(0, video.volume - 0.1);
        if (e.key === 'ArrowRight') video.volume = Math.min(1, video.volume + 0.1);
        return;
      }
      if (e.key === 'c') captions.click();
      if (e.key === 'k') video.paused ? video.play() : video.pause();
      if (e.key === 'ArrowRight') video.currentTime += 5;
      if (e.key === 'ArrowLeft') video.currentTime -= 5;
      if (e.key === '>') player.setPlaybackRate(playerRate + 0.25);
      if (e.key === '<') player.setPlaybackRate(playerRate - 0.25);
    });
  </script>`;
}

export async function sample(page: Page) {
  return page.locator('#movie_player video.html5-main-video').first().evaluate((v: HTMLVideoElement) => ({
    positionSeconds: v.currentTime, playbackRate: v.playbackRate, isPlaying: !v.paused,
  }));
}

export async function readyPlayer(page: Page) {
  await expect.poll(() => page.locator('#movie_player video.html5-main-video').first().evaluate((v: HTMLVideoElement) =>
    v.readyState >= 3 && !v.seeking && !v.closest('.ad-showing, .ad-interrupting')), { timeout: 30_000 }).toBe(true);
}


export async function withPlaybackPair(run: (value: {
  a: Page; b: Page; room: () => Promise<{ playback: Playback; presence?: Record<string, unknown> }>;
}) => Promise<void>, configure?: (context: BrowserContext) => Promise<void>) {
  const first = await setup(false, playerFixture());
  const second = await setup(false, playerFixture());
  try {
    await configure?.(second.context);
    const a = await first.context.newPage();
    await a.goto(watch);
    await readyPlayer(a);
    const control = await popup(first.context, a, first.extensionId);
    const session = await frameOf(a);
    const target = new URL(session.url()).hash.slice(1);
    await expect.poll(async () => (await control.request(target)).connected).toBe(true);
    const created = await control.request(target, 'create', { metadata: { name: 'Fixture', createdWithVersion: '0.2.0', backendGeneration: 'emulator-v1' }, playback: {
      videoId: 'aqz-KE-bpKQ', positionSeconds: 10, playbackRate: 1, isPlaying: false,
    } });
    expect(!!created.invitation).toBe(true);
    const key = new URLSearchParams(new URL(created.invitation!).hash.slice(1)).get('room')!;
    const room = async () => {
      const response = await fetch(`http://127.0.0.1:9000/rooms/${key}.json?ns=demo-watch-together-default-rtdb`, {
        headers: { Authorization: 'Bearer owner' },
      });
      expect(response.ok).toBe(true);
      return response.json();
    };
    await control.close();
    const invitation = await second.context.newPage();
    await invitation.goto(created.invitation!);
    await expect.poll(() => invitation.frames().some(f => f.url().includes('/invitation.html#'))).toBe(true);
    const opened = second.context.waitForEvent('page');
    await invitation.frames().find(f => f.url().includes('/invitation.html#'))!
      .getByRole('button', { name: 'Присоединиться', exact: true }).click();
    const b = await opened;
    await expect.poll(async () => Object.keys((await room()).presence ?? {}).length).toBe(2);
    for (const page of [a, b]) {
      await expect((await frameOf(page)).locator('[role="status"]')).toContainText(/Смотрим вместе|Ожидаем|Локальный просмотр|Нажмите play/);
      await expect.poll(() => sample(page)).toMatchObject({ isPlaying: false, playbackRate: 1, positionSeconds: 10 });
    }
    await b.waitForTimeout(300);
    await run({ a, b, room });
  } finally {
    await second.context.close();
    await first.context.close();
  }
}

