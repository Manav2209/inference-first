import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createGateway, configFromEnv } from '../src/server.mjs';
import { SSEParser } from '../src/sse.mjs';

const model = 'test-model';
const message = content => ({ model, messages: [{ role: 'user', content }], stream: true, max_tokens: 8 });
const event = data => `data: ${JSON.stringify(data)}\n\n`;
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, overrides = {}) {
  const logs = [];
  let cancelled = false;
  let received;
  const backend = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: model }] }));
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks));
    res.on('close', () => { if (!res.writableFinished) cancelled = true; });
    const mode = received.messages[0].content;
    if (mode === 'bad-status') { res.writeHead(500); return res.end('private backend error'); }
    if (mode === 'stall') return;
    if (!received.stream) return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello' } }], usage: { completion_tokens: 1 } }));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.flushHeaders();
    res.write(event({ choices: [{ delta: { role: 'assistant' } }] }));
    if (mode === 'cancel') return;
    await delay(25);
    if (res.destroyed) return;
    if (mode === 'truncated') return res.end(event({ choices: [{ delta: { content: 'partial' } }] }));
    if (mode === 'backend-error') return res.end(event({ error: { message: 'failed' } }));
    const text = event({ choices: [{ delta: { content: 'héllo' } }] }) +
      event({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 3, prompt_tokens: 4 } }) + 'data: [DONE]\n\n';
    const bytes = Buffer.from(text);
    // Split both UTF-8 codepoints and SSE delimiters across network chunks.
    for (let offset = 0; offset < bytes.length; offset += 7) res.write(bytes.subarray(offset, offset + 7));
    res.end();
  });
  const backendURL = await listen(backend);
  const gateway = createGateway({ ...configFromEnv({ MODEL: model }), upstream: `${backendURL}/v1`, ...overrides }, { logger: line => logs.push(line) });
  const url = await listen(gateway);
  t.after(async () => {
    gateway.closeAllConnections(); backend.closeAllConnections();
    await Promise.all([new Promise(r => gateway.close(r)), new Promise(r => backend.close(r))]);
  });
  const post = (body = message('normal')) => fetch(`${url}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { url, post, logs, get cancelled() { return cancelled; }, get received() { return received; } };
}

test('SSE parser survives arbitrary UTF-8 and CRLF boundaries', () => {
  const values = [];
  const parser = new SSEParser(value => values.push(value));
  const bytes = Buffer.from(': comment\r\ndata: hé\r\ndata: llo\r\n\r\ndata: [DONE]\n\n');
  for (const byte of bytes) parser.push(Uint8Array.of(byte));
  parser.finish();
  assert.deepEqual(values, ['hé\nllo', '[DONE]']);
});
test('SSE parser rejects unbounded and incomplete events', () => {
  assert.throws(() => new SSEParser(() => {}, 4).push('12345'), /limit/);
  const parser = new SSEParser(() => {});
  parser.push('data: unfinished');
  assert.throws(() => parser.finish(), /Incomplete/);
});
test('streams text, completion marker and usage; excludes role event from TTFT', async t => {
  const f = await fixture(t);
  const response = await f.post();
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.match(response.headers.get('x-request-id'), /^[a-f0-9-]{36}$/);
  assert.match(text, /héllo/);
  assert.match(text, /\[DONE\]/);
  await delay(5);
  assert.equal(f.logs[0].outcome, 'completed');
  assert.ok(f.logs[0].ttft_ms >= 20);
  assert.equal(f.logs[0].usage.completion_tokens, 3);
  assert.equal(f.received.stream_options.include_usage, true);
  assert.ok(!JSON.stringify(f.logs).includes('héllo'));
});
test('supports nonstreaming chat completions', async t => {
  const f = await fixture(t);
  const response = await f.post({ ...message('normal'), stream: false });
  assert.equal((await response.json()).choices[0].message.content, 'hello');
});
test('rejects malformed JSON, oversized requests, unsupported models and invalid fields', async t => {
  const f = await fixture(t);
  for (const body of [null, [], { ...message('x'), model: 'unauthorized:cloud' },
    { ...message('x'), max_tokens: -1 }, { ...message('x'), stream: 'true' },
    { ...message('x'), temperature: 99 }, { ...message('x'), messages: [{ role: 'user', content: [] }] }]) {
    const response = await f.post(body);
    assert.equal(response.status, 400);
    await response.text();
  }
  const malformed = await fetch(`${f.url}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  await malformed.text();
  const huge = await f.post(message('x'.repeat(70000)));
  assert.equal(huge.status, 413);
  await huge.text();
  const health = await (await fetch(`${f.url}/healthz`)).json();
  assert.equal(health.inflight, 0);
});
test('readiness verifies configured model; liveness stays cheap', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.url}/readyz`)).status, 200);
  assert.equal((await (await fetch(`${f.url}/v1/models`)).json()).data[0].id, model);
  assert.equal((await fetch(`${f.url}/healthz`)).status, 200);
});
test('backend status becomes sanitized 502', async t => {
  const f = await fixture(t);
  const response = await f.post(message('bad-status'));
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('private backend error'));
});
test('deadline releases capacity and aborts the upstream request', async t => {
  const f = await fixture(t, { timeoutMs: 60 });
  const response = await f.post(message('stall'));
  assert.equal(response.status, 504);
  await response.text();
  await delay(25);
  assert.equal(f.cancelled, true);
  assert.equal((await (await fetch(`${f.url}/healthz`)).json()).inflight, 0);
});
test('deadline also applies while uploading request body', async t => {
  const f = await fixture(t, { timeoutMs: 60 });
  const response = await new Promise((resolve, reject) => {
    const req = http.request(`${f.url}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, resolve);
    req.on('error', reject);
    req.write('{');
  });
  assert.equal(response.statusCode, 504);
  response.resume();
});
test('rejects overload and cancels generation when client disconnects', async t => {
  const f = await fixture(t, { maxInflight: 1 });
  const controller = new AbortController();
  const first = await fetch(`${f.url}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message('cancel')), signal: controller.signal });
  assert.equal(first.status, 200);
  const excess = await f.post();
  assert.equal(excess.status, 429);
  await excess.text();
  controller.abort();
  await delay(50);
  assert.equal(f.cancelled, true);
  assert.equal(f.logs[0].outcome, 'cancelled');
  assert.equal((await (await fetch(`${f.url}/healthz`)).json()).inflight, 0);
});
test('incomplete backend streams are explicit errors without a fabricated DONE', async t => {
  const f = await fixture(t);
  const text = await (await f.post(message('truncated'))).text();
  assert.match(text, /without \[DONE\]/);
  assert.ok(!text.includes('data: [DONE]'));
});
test('backend error events are surfaced as failed streams', async t => {
  const f = await fixture(t);
  const text = await (await f.post(message('backend-error'))).text();
  assert.match(text, /streaming error/);
});
test('configuration rejects invalid URL and capacity settings', () => {
  assert.throws(() => configFromEnv({ UPSTREAM_BASE_URL: 'file:///tmp/x' }));
  assert.throws(() => configFromEnv({ MAX_INFLIGHT: '0' }));
});
