import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve(process.argv[2] || 'results/baseline');
const metadata = JSON.parse(await readFile(resolve(directory, 'metadata.json'), 'utf8'));
if (!metadata.finished_at) throw new Error('Run is incomplete; do not publish it as a complete benchmark');
const rows = (await readFile(resolve(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
const median = values => {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const stats = values => values.length ? { n: values.length, median: median(values), min: Math.min(...values), max: Math.max(...values) } : null;
const warm = [1, 2, 3].map(concurrency => {
  const attempts = rows.filter(r => r.phase === 'warm' && r.concurrency === concurrency);
  const successes = attempts.filter(r => r.status === 'ok');
  const waves = [...new Set(attempts.map(r => r.round))].map(round => attempts.filter(r => r.round === round));
  return { concurrency, requests: attempts.length, failures: attempts.length - successes.length,
    ttft_ms: stats(successes.map(r => r.ttft_ms)), latency_ms: stats(successes.map(r => r.latency_ms)),
    per_request_e2e_tokens_per_second: stats(successes.map(r => r.output_tokens_per_e2e_second)),
    wave_aggregate_tokens_per_second: stats(waves.map(w => w.filter(r => r.status === 'ok').reduce((n, r) => n + r.completion_tokens, 0) / (w[0].wave_wall_ms / 1000))),
  };
});
const summary = { metadata, cold: rows.find(r => r.phase === 'model-cold'),
  warm_immediate: rows.find(r => r.phase === 'warm-immediate'), warm,
  total_requests: rows.length, failed_requests: rows.filter(r => r.status !== 'ok').length,
  caveat: 'Small, closed-loop samples. Report medians and ranges; do not present as production percentiles.' };
await writeFile(resolve(directory, 'summary.json'), JSON.stringify(summary, null, 2));
const columns = ['phase','round','concurrency','slot','status','ttft_ms','latency_ms','completion_tokens','prompt_tokens','wave_wall_ms','output_tokens_per_e2e_second','finish_reason','request_id'];
const csv = [columns.join(','), ...rows.map(row => columns.map(c => JSON.stringify(row[c] ?? '')).join(','))].join('\n');
await writeFile(resolve(directory, 'requests.csv'), `${csv}\n`);
console.log(JSON.stringify({ directory, warm, failed_requests: summary.failed_requests }, null, 2));
