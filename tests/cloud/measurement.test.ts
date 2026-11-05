import { expect, it } from 'vitest';
import { applicationTime, percentile95, positionDifference, type Point } from './measurement';

const point = (at: number, overrides: Partial<Point> = {}): Point => ({
  at, position: 10, rate: 1, playing: false, ready: true, ad: false, buffering: false, ...overrides,
});

it('p95 использует ближайший ранг и не скрывает хвост из двух медленных команд', () => {
  expect(percentile95([])).toBeNull();
  expect(percentile95([...Array.from({ length: 30 }, () => 100), 1100, 2000])).toBe(1100);
});

it('ожидает готовое устойчивое совпадение, включая позицию и rate', () => {
  expect(applicationTime([point(50, { ready: false }), point(100, { rate: 1.25 }), point(150, { position: 11 }),
    point(200), point(250), point(300)], 0, point(0))).toBe(300);
});

it('учитывает ход играющего источника и отвергает совпадение после пропуска снимков', () => {
  const reference = point(0, { playing: true });
  expect(applicationTime([point(200, { playing: true, position: 10.2 }), point(300, { playing: true, position: 10.3 })], 0, reference)).toBe(300);
  expect(applicationTime([point(100), point(300)], 0, point(0))).toBeNull();
});

it('сравнивает позиции на одном времени вместо ложной ошибки от разных снимков', () => {
  expect(positionDifference(point(0, { playing: true, rate: 1.25 }), point(200, { playing: true, rate: 1.25, position: 10.25 }))).toBe(0);
  expect(positionDifference(point(0), point(200, { position: 10.6 }))).toBeCloseTo(0.6);
});
