import { z } from 'zod';

// Секрет — один непредсказуемый ключ, не произвольный RTDB path.
export const roomKeySchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
