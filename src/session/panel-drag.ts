import { panelCancelSchema, type PanelDrag } from '../lib/room/panel-position';

/** Pointer capture удерживает мышь при движении самого cross-origin iframe. */
export function bindPanelDrag(toggle: HTMLButtonElement, target: string) {
  let gesture = 0;
  let sequence = 0;
  let pointer: { id: number; x: number; y: number; moving: boolean } | undefined;
  let suppressClick = false;
  const send = (phase: PanelDrag['phase'], dx = 0, dy = 0) => {
    window.parent.postMessage({ type: 'room-panel-drag', target, gesture,
      sequence: sequence++, phase, dx, dy } satisfies PanelDrag, '*');
  };
  function finish() {
    const previous = pointer;
    pointer = undefined;
    toggle.classList.remove('dragging');
    if (!previous) return;
    if (previous.moving) send('end');
    if (toggle.hasPointerCapture(previous.id)) toggle.releasePointerCapture(previous.id);
  }
  function down(event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary || event.pointerType !== 'mouse') return;
    finish();
    suppressClick = false;
    gesture++; sequence = 0;
    pointer = { id: event.pointerId, x: event.screenX, y: event.screenY, moving: false };
    toggle.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent) {
    if (!pointer || event.pointerId !== pointer.id) return;
    if (!(event.buttons & 1)) { finish(); return; }
    const dx = event.screenX - pointer.x;
    const dy = event.screenY - pointer.y;
    if (!pointer.moving) {
      if (Math.hypot(dx, dy) < 4) return;
      pointer.moving = true;
      suppressClick = true;
      toggle.classList.add('dragging');
      send('start');
    }
    event.preventDefault();
    send('move', dx, dy);
  }
  function click(event: MouseEvent) {
    if (suppressClick && event.detail !== 0) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
    suppressClick = false;
  }
  function key() { suppressClick = false; finish(); }
  function cancel(event: MessageEvent) {
    if (!event.isTrusted || event.source !== window.parent
      || !['https://www.youtube.com', 'https://youtube.com'].includes(event.origin)) return;
    const message = panelCancelSchema.safeParse(event.data);
    if (message.success && message.data.target === target) finish();
  }
  toggle.addEventListener('pointerdown', down);
  toggle.addEventListener('pointermove', move);
  toggle.addEventListener('pointerup', finish);
  toggle.addEventListener('pointercancel', finish);
  toggle.addEventListener('lostpointercapture', finish);
  toggle.addEventListener('click', click, true);
  toggle.addEventListener('keydown', key);
  window.addEventListener('blur', finish);
  window.addEventListener('message', cancel);
  return () => {
    finish();
    toggle.removeEventListener('pointerdown', down);
    toggle.removeEventListener('pointermove', move);
    toggle.removeEventListener('pointerup', finish);
    toggle.removeEventListener('pointercancel', finish);
    toggle.removeEventListener('lostpointercapture', finish);
    toggle.removeEventListener('click', click, true);
    toggle.removeEventListener('keydown', key);
    window.removeEventListener('blur', finish);
    window.removeEventListener('message', cancel);
  };
}
