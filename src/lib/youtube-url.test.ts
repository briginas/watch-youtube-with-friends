import { describe, expect, it } from 'vitest';
import { getWatchVideoId } from './youtube-url';

describe('getWatchVideoId', () => {
  it.each([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?list=PL123&v=dQw4w9WgXcQ&t=42#comments',
  ])('читает videoId из обычной страницы видео: %s', (url) => {
    expect(getWatchVideoId(url)).toBe('dQw4w9WgXcQ');
  });

  it.each([
    undefined,
    'not a URL',
    'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.example.org/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com@evil.example/watch?v=dQw4w9WgXcQ',
    'https://user@www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
    'https://www.youtube.com/',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=invalid',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&v=abcdefghijk',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ%2F',
  ])('не принимает неподдерживаемую страницу: %s', (url) => {
    expect(getWatchVideoId(url)).toBeNull();
  });
});
