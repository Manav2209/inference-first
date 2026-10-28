import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { SSEParser } from '../src/sse.mjs';

const base = process.env.GATEWAY_URL || 'http://127.0.0.1:3000';
const ollama = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const model = process.env.MODEL || 'inference-lab:qwen05-cpu';
const rounds = Number(process.env.ROUNDS || 5);
const maxTokens = Number(process.env.MAX_TOKENS || 96);
if (!Number.isInteger(rounds) || rounds < 1 || !Number.isInteger(maxTokens) || maxTokens < 2) throw new Error('Invalid benchmark settings');
const prompts = JSON.parse(await readFile(new URL('./workloads.json', import.meta.url), 'utf8'));
const directory = resolve(process.env.RESULTS_DIR || `results/${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(directory, { recursive: true });
const rawPath = resolve(directory, 'requests.jsonl');
// Never silently append a new experiment to an old run.
await writeFile(rawPath, '', { flag: 'wx' });
const startTime = new Date().toISOString();
const metadata = {
  started_at: startTime, model, gateway_url: base, ollama_url: ollama,
  rounds, max_tokens: maxTokens, concurrency_levels: [1, 2, 3],
  schedule: 'rotating closed-loop waves: [1,2,3], [3,1,2], [2,3,1]',
  temperature: 0, seed: 42, node_version: process.version,
  platform: process.platform, cpu_model: os.cpus()[0].model, logical_cpus: os.cpus().length,
  total_memory_bytes: os.totalmem(), available_memory_at_start_bytes: os.freemem(),
  ttft_definition: 'client request start to first nonempty delta.content; role-only and headers excluded',
  throughput_definition: 'sum of provider completion_tokens / actual wave wall time',
  prompts, prompt_sha256: prompts.map(text => createHash('sha256').update(text).digest('hex')),
  limitations: ['closed-loop microbenchmark; not a capacity or open-loop load test',
    'model-cold means unloaded; Windows filesystem cache is not flushed',
    'warm requests may reuse cached prompt prefixes', 'background desktop apps remain running'],
};
await writeFile(resolve(directory, 'metadata.json'), JSON.stringify(metadata, null, 2));
async function api(path, data) {
  const response = await fetch(`${ollama}${path}`, data === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
await writeFile(resolve(directory, 'ollama-version.json'), JSON.stringify(await api('/api/version'), null, 2));
const { modelfile: generatedModelfile, ...modelDetails } = await api('/api/show', { model });
modelDetails.collection_note = 'Generated modelfile omitted because it contains absolute local paths. See the versioned root Modelfile and models.json for configuration and digest.';
await writeFile(resolve(directory, 'model.json'), JSON.stringify(modelDetails, null, 2));
await writeFile(resolve(directory, 'models.json'), JSON.stringify(await api('/api/tags'), null, 2));
async function request({ phase, round, concurrency, slot, promptIndex }) {
  const started = performance.now();
  const row = { phase, round, concurrency, slot, prompt_index: promptIndex, started_at: new Date().toISOString(),
    ttft_ms: null, latency_ms: null, completion_tokens: null, prompt_tokens: null,
    content_events: 0, first_text_to_last_text_ms: null, text: '', status: 'error' };
  let first = null;
  let last = null;
  let done = false;
  let finished = false;
  let usage = null;
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompts[promptIndex] }],
        stream: true, temperature: 0, seed: 42, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(120000),
    });
    row.http_status = response.status;
    row.request_id = response.headers.get('x-request-id');
    row.headers_ms = performance.now() - started;
    if (!response.ok) throw new Error(await response.text());
    const parser = new SSEParser(data => {
      if (data === '[DONE]') { done = true; return; }
      const event = JSON.parse(data);
      if (event.error) throw new Error(event.error.message);
      if (event.usage) usage = event.usage;
      const choice = event.choices?.[0];
      if (choice?.finish_reason) { finished = true; row.finish_reason = choice.finish_reason; }
      const content = choice?.delta?.content;
      if (typeof content === 'string' && content.length) {
        const now = performance.now();
        first ??= now;
        last = now;
        row.text += content;
        row.content_events++;
      }
    });
    for await (const chunk of response.body) parser.push(chunk);
    parser.finish();
    if (!done || !finished || first === null) throw new Error('Incomplete response or missing generated text');
    if (!Number.isInteger(usage?.completion_tokens) || usage.completion_tokens < 1) throw new Error('Provider did not report token usage');
    row.ttft_ms = first - started;
    row.latency_ms = performance.now() - started;
    row.first_text_to_last_text_ms = last - first;
    row.completion_tokens = usage.completion_tokens;
    row.prompt_tokens = usage.prompt_tokens;
    row.output_tokens_per_e2e_second = usage.completion_tokens / (row.latency_ms / 1000);
    row.status = 'ok';
  } catch (error) { row.error = error.message; row.latency_ms = performance.now() - started; }
  row.finished_at = new Date().toISOString();
  return row;
}
async function wave(phase, round, concurrency) {
  const started = performance.now();
  const rows = await Promise.all(Array.from({ length: concurrency }, (_, slot) => request({
    phase, round, concurrency, slot, promptIndex: (round + slot) % prompts.length,
  })));
  const wall = performance.now() - started;
  for (const row of rows) {
    row.wave_wall_ms = wall;
    await appendFile(rawPath, `${JSON.stringify(row)}\n`);
  }
  console.log(JSON.stringify({ phase, round, concurrency, wall_ms: Math.round(wall),
    ttft_ms: rows.map(r => r.ttft_ms === null ? null : Math.round(r.ttft_ms)), statuses: rows.map(r => r.status) }));
  if (rows.some(r => r.status !== 'ok')) throw new Error('Benchmark request failed; see raw results');
}

const ready = await fetch(`${base}/readyz`);
if (!ready.ok) throw new Error('Gateway is not ready; create the model and start the server');
await api('/api/generate', { model, keep_alive: 0 });
const before = await api('/api/ps');
if (before.models?.some(m => m.name === model || m.model === model)) throw new Error('Model did not unload');
await writeFile(resolve(directory, 'before-cold.json'), JSON.stringify(before, null, 2));
await wave('model-cold', 0, 1);
await wave('warm-immediate', 0, 1);
// Separate unreported warm-up, not mixed into measured groups.
const warmup = await request({ phase: 'warmup', round: 0, concurrency: 1, slot: 0, promptIndex: 1 });
if (warmup.status !== 'ok') throw new Error('Warmup request failed');
for (let round = 0; round < rounds; round++) {
  const orders = [[1, 2, 3], [3, 1, 2], [2, 3, 1]];
  for (const concurrency of orders[round % orders.length]) await wave('warm', round, concurrency);
}
await writeFile(resolve(directory, 'after-warm.json'), JSON.stringify(await api('/api/ps'), null, 2));
// Native API provides engine timings that the compatibility API does not expose.
await api('/api/generate', { model, keep_alive: 0 });
const native = [];
for (const state of ['model-cold', 'warm']) {
  const result = await api('/api/chat', { model, messages: [{ role: 'user', content: prompts[0] }], stream: false,
    options: { num_predict: maxTokens, temperature: 0, seed: 42 }, keep_alive: '5m' });
  native.push({ state, ...result, engine_decode_tokens_per_second: result.eval_count / (result.eval_duration / 1e9) });
}
await writeFile(resolve(directory, 'native-timings.json'), JSON.stringify(native, null, 2));
const health = await (await fetch(`${base}/healthz`)).json();
await writeFile(resolve(directory, 'gateway-health-after.json'), JSON.stringify(health, null, 2));
metadata.finished_at = new Date().toISOString();
metadata.available_memory_at_end_bytes = os.freemem();
await writeFile(resolve(directory, 'metadata.json'), JSON.stringify(metadata, null, 2));
console.log(`Saved complete run: ${directory}`);
