import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const fixtureCredential = 'p0-local-fixture-only';
const event = (type, fields) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;

export async function startFixture(markers) {
  const requests = [];
  const failures = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      assert.match(req.url, /\/v1\/messages(?:\?.*)?$/u);
      assert.equal(req.headers['x-api-key'], fixtureCredential);
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        assert.ok(bytes <= 1_048_576);
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks));
      assert.ok(input.stream);
      const messages = JSON.stringify(input.messages);
      const present = markers.filter(marker => messages.includes(marker));
      assert.equal(present.length, 1, 'Request must contain exactly one tenant marker');
      const marker = present[0];
      const resume = messages.includes('P0_RECALL');
      if (resume) {
        assert.ok(messages.includes(`P0_HELLO ${marker}`), 'Original user message missing after resume');
        assert.ok(messages.includes(`P0_REPLY ${marker}`), 'Original assistant reply missing after resume');
      }
      const text = `P0_REPLY ${marker}`;
      requests.push({ marker, resume });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        event('message_start', { message: {
          id: `msg_p0_${requests.length}`, type: 'message', role: 'assistant',
          model: input.model, content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        } }) +
        event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
        event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }) +
        event('content_block_stop', { index: 0 }) +
        event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } }) +
        event('message_stop', {}),
      );
    } catch (error) {
      failures.push(error instanceof assert.AssertionError ? error.message : error.name);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"type":"error","error":{"type":"invalid_request_error","message":"P0 fixture contract rejected"}}');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    requests,
    failures,
    credential: fixtureCredential,
    baseUrl: `http://127.0.0.1:${server.address().port}/anthropic`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
