// HTTP chunks, SSE events and model tokens are three different boundaries.
export class SSEParser {
  constructor(onData, maxEventBytes = 1024 * 1024) {
    this.onData = onData;
    this.buffer = '';
    this.decoder = new TextDecoder();
    this.maxEventBytes = maxEventBytes;
  }
  push(bytes) {
    this.buffer += typeof bytes === 'string' ? bytes : this.decoder.decode(bytes, { stream: true });
    this.consume();
  }
  consume() {
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;
      const event = this.buffer.slice(0, match.index);
      if (Buffer.byteLength(event) > this.maxEventBytes) throw new Error('SSE event exceeds limit');
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (data) this.onData(data);
    }
    if (Buffer.byteLength(this.buffer) > this.maxEventBytes) throw new Error('SSE event exceeds limit');
  }
  finish() {
    this.buffer += this.decoder.decode();
    this.consume();
    if (this.buffer.trim()) throw new Error('Incomplete SSE event at end of response');
  }
}
