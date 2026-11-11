import { z } from 'zod';

// Только геометрия; сообщения не содержат данные комнаты.
export const panelDragSchema = z.object({
  type: z.literal('room-panel-drag'), target: z.string().uuid(),
  gesture: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  phase: z.enum(['start', 'move', 'end']),
  dx: z.number().finite().min(-100_000).max(100_000),
  dy: z.number().finite().min(-100_000).max(100_000),
}).strict();

export type PanelDrag = z.infer<typeof panelDragSchema>;

export const panelCancelSchema = z.object({
  type: z.literal('room-panel-cancel'), target: z.string().uuid(),
}).strict();

export const panelLayoutSchema = z.object({
  type: z.literal('room-panel-layout'), target: z.string().uuid(),
  availableHeight: z.number().int().min(1).max(100_000),
}).strict();
