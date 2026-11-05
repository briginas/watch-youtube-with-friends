import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { percentile95 } from '../tests/cloud/measurement.ts';

const [output, ...inputs] = process.argv.slice(2);
if (!output || !inputs.length) throw new Error('summarize-cloud.mjs <output.json> <measurements.json> [...]');
const runs = inputs.flatMap(path => {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  return value.runs ?? [{ label: basename(path), report: value }];
});
const first = runs[0].report;
for (const { report } of runs) {
  if (report.rehearsal || !report.liveYouTube || JSON.stringify(report.environment) !== JSON.stringify(first.environment)) {
    throw new Error('Агрегировать можно только облачные YouTube-замеры с одинаковыми условиями.');
  }
}
const observations = runs.flatMap(({ report }) => report.observations);
const eligible = observations.filter(value => value.eligible);
const latencies = eligible.flatMap(value => typeof value.latencyMs === 'number' ? [value.latencyMs] : []);
const p95Ms = latencies.length === eligible.length ? percentile95(latencies) : null;
const differences = eligible.map(value => value.differenceSeconds);
let statesAt3sMatch = true;
for (const { report } of runs) {
  let playing = false;
  let rate = 1;
  for (const value of report.observations) {
    if (value.action === 'play') playing = true;
    if (value.action === 'pause') playing = false;
    if (value.action === 'rate-up') rate = 1.25;
    if (value.action === 'rate-normal') rate = 1;
    if (value.eligible && !value.samplesAt3s.every(point => point.playing === playing && Math.abs(point.rate - rate) < 0.01)) {
      statesAt3sMatch = false;
    }
  }
}
const byAction = {};
for (const value of eligible) byAction[value.action] = (byAction[value.action] ?? 0) + 1;
const acceptedOnceAll = observations.every(value => value.acceptedOnce);
const summary = {
  runs: runs.length, completeRuns: runs.filter(value => value.report.stage === 'complete').length,
  collected: observations.length, eligible: eligible.length, excluded: observations.length - eligible.length,
  applied: latencies.length, p95Ms,
  maxDifferenceSeconds: differences.length ? Math.max(...differences) : null,
  acceptedOnceAll, statesAt3sMatch, byAction,
  bySource: [1, 2].map(source => ({ source, eligible: eligible.filter(value => value.source === source).length })),
  maxDifferenceIncludingRestrictions: observations.length ? Math.max(...observations.map(value => value.differenceSeconds)) : null,
  meetsLatencyTarget: acceptedOnceAll && statesAt3sMatch && eligible.length >= 30 && p95Ms !== null && p95Ms <= 1000,
  meetsPositionTarget: acceptedOnceAll && statesAt3sMatch && differences.length >= 30 && differences.every(value => value <= 0.5),
};
writeFileSync(output, JSON.stringify({
  environment: first.environment,
  methodology: 'Все переданные сессии с одинаковыми условиями; пригодность каждого замера сохранена из исходного отчёта. Неполные сессии и исключённые команды не удаляются. Цели оцениваются только для готовых плееров; completeRuns приводится отдельно.',
  summary, runs,
}, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
