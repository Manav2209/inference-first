import { SSEParser } from '../src/sse.mjs';
const base = process.env.GATEWAY_URL || 'http://127.0.0.1:3000';
const response = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: process.env.MODEL || 'inference-lab:qwen05-cpu',
    messages: [{ role: 'user', content: process.argv.slice(2).join(' ') || 'Explain what a model serving gateway does.' }],
    stream: true, max_tokens: 128 }),
  signal: AbortSignal.timeout(120000),
});
if (!response.ok) throw new Error(await response.text());
let done = false;
const parser = new SSEParser(data => {
  if (data === '[DONE]') { done = true; return; }
  const event = JSON.parse(data);
  if (event.error) throw new Error(event.error.message);
  if (event.choices?.[0]?.delta?.content) process.stdout.write(event.choices[0].delta.content);
});
for await (const chunk of response.body) parser.push(chunk);
parser.finish();
if (!done) throw new Error('Response did not complete');
process.stdout.write('\n');
