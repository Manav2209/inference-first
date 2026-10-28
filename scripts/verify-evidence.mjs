import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const directory = resolve(process.argv[2] || 'results/baseline');
const load = async name => JSON.parse((await readFile(resolve(directory, name), 'utf8')).replace(/^\uFEFF/, ''));
const metadata = await load('metadata.json');
const summary = await load('summary.json');
const rows = (await readFile(resolve(directory, 'requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
assert.ok(metadata.finished_at, 'Run must be complete');
assert.equal(rows.length, 2 + metadata.rounds * 6);
assert.equal(summary.total_requests, rows.length);
assert.equal(summary.failed_requests, rows.filter(r => r.status !== 'ok').length);
assert.equal(new Set(rows.map(r => r.request_id)).size, rows.length, 'Unique request IDs');
assert.deepEqual(metadata.prompt_sha256, metadata.prompts.map(p => createHash('sha256').update(p).digest('hex')));
const median = values => {
  const sorted = values.toSorted((a, b) => a - b);
  const n = sorted.length;
  return n % 2 ? sorted[(n-1)/2] : (sorted[n/2-1] + sorted[n/2])/2;
};
const equal = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
for (const row of rows) {
  assert.equal(row.status, 'ok');
  assert.ok(row.text.length && row.ttft_ms > 0 && row.ttft_ms < row.latency_ms);
  assert.ok(Number.isInteger(row.completion_tokens) && row.completion_tokens > 0);
  assert.ok(Number.isInteger(row.prompt_tokens) && row.prompt_tokens > 0);
  assert.ok(row.wave_wall_ms >= row.latency_ms);
  assert.ok(metadata.prompts[row.prompt_index]);
  equal(row.output_tokens_per_e2e_second, row.completion_tokens / (row.latency_ms / 1000));
}
for (const group of summary.warm) {
  const selected = rows.filter(r => r.phase === 'warm' && r.concurrency === group.concurrency);
  assert.equal(selected.length, group.concurrency * metadata.rounds);
  equal(group.ttft_ms.median, median(selected.map(r => r.ttft_ms)));
  equal(group.latency_ms.median, median(selected.map(r => r.latency_ms)));
  const waves = Array.from({ length: metadata.rounds }, (_, round) => selected.filter(r => r.round === round));
  const rates = waves.map(wave => {
    assert.equal(wave.length, group.concurrency);
    assert.equal(new Set(wave.map(r => r.wave_wall_ms)).size, 1);
    return wave.reduce((sum, r) => sum + r.completion_tokens, 0) / (wave[0].wave_wall_ms / 1000);
  });
  equal(group.wave_aggregate_tokens_per_second.median, median(rates));
}
assert.deepEqual(summary.cold, rows.find(r => r.phase === 'model-cold'));
assert.deepEqual(summary.warm_immediate, rows.find(r => r.phase === 'warm-immediate'));
console.log(`Verified ${rows.length} complete requests, prompt hashes, unique IDs, wave counts and summary calculations.`);
