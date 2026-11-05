import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { applicationTime, percentile95, positionDifference } from '../tests/cloud/measurement.ts';

const [output, ...files] = process.argv.slice(2);
if (!output || (files.length !== 4 && !(files.length === 2 && files[0] === '--raw')))
  throw new Error('Usage: summarize-native.mjs output.json media-A.json media-B.json status-A.json status-B.json | output.json --raw report.raw.json.gz');
const raw = files[0] === '--raw' ? JSON.parse(gunzipSync(await readFile(files[1])).toString()) : null;
const [a, b, sa, sb] = raw ? [...raw.media, ...raw.status]
  : await Promise.all(files.map(async file => JSON.parse(await readFile(file, 'utf8'))));
if (a.kind !== 'native-media' || b.kind !== 'native-media' || a.client !== 'A' || b.client !== 'B'
  || sa.kind !== 'native-status' || sb.kind !== 'native-status') throw new Error('Wrong report order/types');
const media = [a, b]; const status = [sa, sb];
const inputs = media.flatMap((report, client) => report.inputs.filter(input =>
  [' ', 'k', 'K', 'ArrowLeft', 'ArrowRight', '<', '>'].includes(input.key)
  || (input.shift && ['Comma', 'Period'].includes(input.code)))
  .map(input => ({ ...input, client }))).sort((a, b) => a.at - b.at);
const initialRevisions = status.map(report => report.updates.filter(update => update.at < inputs[0]?.at).at(-1)?.playback.revision);
if (initialRevisions[0] === undefined || initialRevisions[0] !== initialRevisions[1]) throw new Error('No common initial revision before the first command');
const observations = inputs.map((input, index) => {
  const source = media[input.client]; const remote = media[1 - input.client];
  const reference = source.changes.find(change => change.inputAt === input.at)?.point;
  const at3s = media.map(report => report.points.find(point => point.at >= input.at + 3000));
  const points = media.flatMap(report => report.points.filter(point => point.at >= input.at && point.at <= input.at + 3000));
  const timingValid = at3s.every(point => point && point.at - input.at <= 3050)
    && (inputs[index + 1]?.at ?? Infinity) > input.at + 3100;
  const eligible = timingValid && points.length > 0 && points.every(point => !point.ad && !point.buffering)
    && at3s.every(point => point.ready);
  const states = status.map(report => report.updates.filter(update => update.at <= input.at + 3100).at(-1));
  const revision = initialRevisions[0] + index + 1;
  const acceptedOnce = input.trusted && states.every((state, client) => state?.connected && state.roomReady
    && state.participants === 2 && state.playback.revision === revision && state.ownActor === (client === input.client));
  const matchingStates = at3s.every((point, client) => point && states[client]
    && point.playing === states[client].playback.isPlaying && point.rate === states[client].playback.playbackRate);
  return { revision, source: input.client + 1, key: input.key, code: input.code, shift: input.shift, trusted: input.trusted,
    event: source.changes.find(change => change.inputAt === input.at)?.event,
    inputAt: input.at, eligible, timingValid, acceptedOnce, matchingStates,
    latencyMs: reference ? applicationTime(remote.points.filter(point => point.at <= input.at + 3100), input.at, reference) : null,
    differenceSeconds: at3s.every(Boolean) ? positionDifference(at3s[0], at3s[1]) : null,
    samplesAt3s: at3s, sampleDelayMs: at3s.map(point => point ? point.at - input.at : null),
    buffering: points.some(point => point.buffering), ad: points.some(point => point.ad) };
});
const eligible = observations.filter(value => value.eligible);
const latencies = eligible.flatMap(value => value.latencyMs === null ? [] : [value.latencyMs]);
const p95Ms = latencies.length === eligible.length ? percentile95(latencies) : null;
const distinctUids = !!sa.uidHash && !!sb.uidHash && sa.uidHash !== sb.uidHash;
const finalRevisions = status.map(report => report.updates.at(-1)?.playback.revision);
const acceptedOnce = observations.every(value => value.acceptedOnce) && finalRevisions.every(value => value === initialRevisions[0] + inputs.length);
const summary = { collected: observations.length, eligible: eligible.length, applied: latencies.length, p95Ms,
  maxDifferenceSeconds: eligible.length ? Math.max(...eligible.map(value => value.differenceSeconds)) : null,
  distinctUids, acceptedOnce, matchingStates: observations.every(value => value.matchingStates),
  statusErrors: [sa.errors, sb.errors], initialRevisions, finalRevisions,
  meetsLatencyTarget: latencies.length >= 30 && p95Ms !== null && p95Ms <= 1000,
  meetsPositionTarget: eligible.length >= 30 && eligible.every(value => value.differenceSeconds <= 0.5) };
const report = { mode: 'ordinary Chrome; native input; QA-only observation in extension',
  environment: { browsers: media.map(value => value.browser), videoIds: media.map(value => value.videoId),
    clients: 'two independent profiles on the same Mac; shared route', network: 'unchanged; access type, geography and VPN unknown',
    firebaseProject: process.env.CLOUD_FIREBASE_PROJECT_ID ?? 'not recorded',
    firebaseRegion: process.env.CLOUD_FIREBASE_REGION ?? 'not recorded' },
  methodology: { samplingPeriodMs: 10, stableApplicationMs: 100, maximumSampleDelayMs: 50,
    minimumEligible: 30, percentile: 'nearest rank ceil(0.95*N)',
    status: 'existing read-only popup API; UID hashes compared only for distinctness; one revision per input; no extra final revisions',
    eligibility: 'same as cloud measurement: no ads/readyState<3 during first 3s, both ready at sample; commands >3.1s apart' },
  summary, observations, raw: { media, status } };
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (!summary.meetsLatencyTarget || !summary.meetsPositionTarget || !distinctUids || !acceptedOnce || !summary.matchingStates
  || status.some(value => value.errors)) process.exitCode = 1;
