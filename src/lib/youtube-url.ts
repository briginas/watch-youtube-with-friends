import { z } from 'zod';

export const videoIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{11}$/);

/** URL обычной страницы видео; доступность и тип ролика проверяет адаптер. */
export function getWatchVideoId(value: string | undefined): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !['www.youtube.com', 'youtube.com'].includes(url.hostname) ||
      url.port !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/watch'
    ) return null;

    const videoIds = url.searchParams.getAll('v');
    if (videoIds.length !== 1) return null;
    const result = videoIdSchema.safeParse(videoIds[0]);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
