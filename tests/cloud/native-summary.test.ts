import { expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Point } from './measurement';

function fixture() {
  const media = ['A', 'B'].map(client => ({ kind: 'native-media', client, browser: 'test', videoId: 'aqz-KE-bpKQ',
    points: [] as Point[], inputs: [] as { at: number; key: string; code: string; shift: boolean; trusted: boolean }[],
    changes: [] as { inputAt: number; event: string; point: Point }[] }));
  const statuses = ['uid-a-hash', 'uid-b-hash'].map(uidHash => ({ kind: 'native-status', uidHash, errors: 0,
    updates: [{ at: 999, connected: true, roomReady: true, participants: 2, ownActor: false,
      playback: { revision: 10, isPlaying: false, playbackRate: 1 } }] }));
  for (let index = 0; index < 32; index++) {
    const at = 1000 + index * 4000;
    const source = index % 2;
    const rate = index % 2 ? 1 : 1.25;
    const previous = index % 2 ? 1.25 : 1;
    const reference: Point = { at: at + 20, position: 5, rate, playing: false, ready: true, ad: false, buffering: false };
    media[source]!.inputs.push({ at, key: index % 2 ? '<' : '>', code: index % 2 ? 'Comma' : 'Period', shift: true, trusted: true });
    media[source]!.changes.push({ inputAt: at, event: 'ratechange', point: reference });
    for (let client = 0; client < 2; client++) {
      for (let offset = 0; offset <= 3100; offset += 50) media[client]!.points.push({ ...reference,
        at: at + offset, rate: offset >= (client === source ? 20 : 200) ? rate : previous });
      statuses[client]!.updates.push({ at: at + 150, connected: true, roomReady: true, participants: 2,
        ownActor: client === source, playback: { revision: 11 + index, isPlaying: false, playbackRate: rate } });
    }
  }
  return [media[0]!, media[1]!, statuses[0]!, statuses[1]!] as const;
}

function run(reports: ReturnType<typeof fixture>) {
  const dir = mkdtempSync(join(tmpdir(), 'native-summary-test-'));
  try {
    const paths = reports.map((report, index) => {
      const path = join(dir, `${index}.json`); writeFileSync(path, JSON.stringify(report)); return path;
    });
    const output = join(dir, 'result.json');
    const result = spawnSync(process.execPath, [resolve('scripts/summarize-native.mjs'), output, ...paths], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    return { code: result.status, summary: JSON.parse(readFileSync(output, 'utf8')).summary };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('native acceptance: nonzero baseline, both authors and stable 300ms application', () => {
  const { code, summary } = run(fixture());
  expect(code).toBe(0);
  expect(summary).toMatchObject({ collected: 32, eligible: 32, applied: 32, p95Ms: 300,
    maxDifferenceSeconds: 0, initialRevisions: [10, 10], finalRevisions: [42, 42],
    distinctUids: true, acceptedOnce: true, matchingStates: true, meetsLatencyTarget: true, meetsPositionTarget: true });
});

test('a frozen status tab cannot confirm per-command authorship', () => {
  const reports = fixture(); reports[2].updates.splice(1, 31);
  const { code, summary } = run(reports);
  expect(code).toBe(1); expect(summary.acceptedOnce).toBe(false);
});

test('missing remote application remains eligible but makes p95 unavailable', () => {
  const reports = fixture();
  for (const point of reports[1].points) if (point.at < 4200) point.rate = 1;
  // Later samples must not rescue an application outside the command window.
  const { code, summary } = run(reports);
  expect(code).toBe(1); expect(summary.p95Ms).toBeNull(); expect(summary.applied).toBeLessThan(summary.eligible);
});

test('fewer than 30 timely position samples cannot pass the targets', () => {
  const reports = fixture();
  reports[1].points = reports[1].points.filter(point => ![4000, 8000, 12000].some(at => point.at >= at && point.at < at + 100));
  const { code, summary } = run(reports);
  expect(code).toBe(1); expect(summary.eligible).toBe(29);
  expect(summary.meetsLatencyTarget).toBe(false); expect(summary.meetsPositionTarget).toBe(false);
});

test('an extra final revision cannot be hidden by otherwise successful measurements', () => {
  const reports = fixture();
  reports[2].updates.push({ ...reports[2].updates.at(-1)!, at: 130000, playback: { revision: 43, isPlaying: false, playbackRate: 1 } });
  const { code, summary } = run(reports);
  expect(code).toBe(1); expect(summary.acceptedOnce).toBe(false);
});
