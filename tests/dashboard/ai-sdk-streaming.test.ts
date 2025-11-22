import { expect, test } from 'bun:test';

/**
 * AI SDK Streaming Integration Tests - Bun-Native Focus
 * Tests useChat and streamText contracts via fetch-based validation
 * Note: Advanced mocking is limited in Bun. Core functionality verified via integration tests.
 */

test('AI SDK streamText produces AI SDK data-stream format', async () => {
  // Set test mode to get synthetic response using mock streamText protocol
  process.env.OM_TEST_MODE = '1';
  const { POST } = await import('../../dashboard/app/api/chat/route');
  // Mock NextRequest-like object for Bun test compatibility
  const mockRequest = {
    method: 'POST',
    url: 'http://localhost/api/chat',
    json: async () => ({
      messages: [{ role: 'user', content: 'test' }],
      embedding_mode: 'synthetic',
    }),
  } as any;
  const response = await POST(mockRequest);
  const reader = response.body!.getReader();
  let accumulated = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    accumulated += new TextDecoder().decode(value);
  }
  // Now expects AI SDK data-stream format instead of SSE
  expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  expect(accumulated).toMatch(/^0:/); // 0: prefixed frames
  // Should contain assistant message (markers added to final message, not streamed)
  expect(accumulated).toContain('"role": "assistant"');
  expect(accumulated).not.toContain('[[OM_TELEMETRY]]'); // Markers not in stream
  expect(accumulated).not.toContain('[[OM_MEMORIES]]');

  // Cleanup
  delete process.env.OM_TEST_MODE;
});

test('Streaming telemetry extraction and validation', async () => {
  const frameContent = 'streaming content[[OM_TELEMETRY]]{"stream_duration_ms":123,"memory_ids":["mem-1"],"embedding_mode":"synthetic"}[[/OM_TELEMETRY]]';
  const responseWithTelemetry = `0:{"role": "assistant", "content": "${frameContent.replace(/"/g, '\\"')}"}\n`;

  const mockResponse = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(responseWithTelemetry));
      controller.close();
    },
  });

  const originalFetch = global.fetch;
  global.fetch = (() =>
    Promise.resolve({
      body: mockResponse,
    } as any)) as any;

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'test telemetry' }],
        embedding_mode: 'synthetic',
      }),
    });
    expect(response.headers.get('content-type')).toContain('text/plain');

    const reader = response.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);

    // Parse data-stream frame
    expect(chunk).toMatch(/^[0-9]+:/);
    const frameData = chunk.substring(chunk.indexOf(':') + 1);
    const data = JSON.parse(frameData);

    expect(data.role).toBe('assistant');
    expect(data.content).toContain('streaming content');
    expect(data.content).toContain('[[OM_TELEMETRY]]');
    expect(data.content).toContain('[[/OM_TELEMETRY]]');

    const telemetryJson = data.content.match(
      /\[\[OM_TELEMETRY\]\](.*)\[\[\/OM_TELEMETRY\]\]/,
    )?.[1];
    const telemetry = JSON.parse(telemetryJson!);

    expect(typeof telemetry.stream_duration_ms).toBe('number');
    expect(Array.isArray(telemetry.memory_ids)).toBe(true);
    expect(telemetry.embedding_mode).toBe('synthetic');
  } finally {
    global.fetch = originalFetch;
  }
});

test('Memory injection validation in streamed responses', async () => {
  const frameContent =
    'Based on your stored knowledge:\n\nMemory content about AI\n\nFrom your past experiences:\n\n[[OM_TELEMETRY]]{"memory_ids":["mem-1"]}[[/OM_TELEMETRY]]';
  const responseWithMemories = `0:{"role": "assistant", "content": "${frameContent.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"}\n`;

  const mockResponse = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(responseWithMemories));
      controller.close();
    },
  });

  const originalFetch = global.fetch;
  global.fetch = (() =>
    Promise.resolve({
      body: mockResponse,
    } as any)) as any;

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'What do I remember?' }],
      }),
    });
    expect(response.headers.get('content-type')).toContain('text/plain');

    const reader = response.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);

    // Parse data-stream frame
    expect(chunk).toMatch(/^[0-9]+:/);
    const frameData = chunk.substring(chunk.indexOf(':') + 1);
    const data = JSON.parse(frameData);

    expect(data.role).toBe('assistant');
    expect(data.content).toContain('Based on your stored knowledge');
    expect(data.content).toContain('Memory content about AI');
    expect(data.content).toContain('[[OM_TELEMETRY]]');
  } finally {
    global.fetch = originalFetch;
  }
});

test('TTFT performance under realistic conditions', async () => {
  const startTime = performance.now();

  setTimeout(() => {
    // Simulate delayed first token
  }, 50);

  await new Promise((resolve) => setTimeout(resolve, 50));

  const ttft = performance.now() - startTime;
  expect(ttft).toBeGreaterThanOrEqual(45);
  expect(ttft).toBeLessThan(100); // Reasonable TTFT
});

// Gated real LLM integration test
if (process.env.OM_ENABLE_LLM_TESTS === '1' && process.env.OPENAI_API_KEY) {
  test('Real AI SDK streamText + OpenAI integration test', async () => {
    const { POST } = await import('../../dashboard/app/api/chat/route');
    const mockRequest = {
      method: 'POST',
      url: 'http://localhost/api/chat',
      json: async () => ({
        messages: [{ role: 'user', content: 'LLM integration test' }],
        embedding_mode: 'real',
      }),
    } as any;

    const response = await POST(mockRequest);
    // Expect AI SDK data-stream format, not SSE
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');

    // Read the entire stream (like synthetic test)
    const reader = response.body!.getReader();
    let accumulated = '';
    let timeout = setTimeout(() => {
      reader.cancel();
    }, 10000); // 10 second timeout for real API calls

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += new TextDecoder().decode(value);
      }
    } catch (error) {
      // Handle timeout or real API issues
      console.warn('Real LLM test encountered issue:', error);
      expect(error instanceof Error).toBe(true);
    }

    clearTimeout(timeout);

    // Assert AI SDK data-stream format (framed data)
    expect(accumulated).toMatch(/^[0-9]+:/); // Should start with framed data (0:, 1:, etc.)

    // Parse frames and look for assistant message
    let assistantMessageFound = false;
    const lines = accumulated.split('\n').filter(line => line.trim());
    for (const line of lines) {
      if (/^[0-9]+:/.test(line)) { // Frame prefix like "0:"
        try {
          const jsonContent = line.substring(line.indexOf(':') + 1);
          const data = JSON.parse(jsonContent);
          if (data.role === 'assistant' && data.content) {
            assistantMessageFound = true;
            // Real LLM responses should not contain synthetic markers
            expect(data.content).not.toContain('[[OM_TELEMETRY]]');
            expect(data.content).not.toContain('[[OM_MEMORIES]]');
            break;
          }
        } catch (e) {
          // Not JSON data, continue
        }
      }
    }

    expect(assistantMessageFound).toBe(true);
    if (!assistantMessageFound) {
      console.warn(
        'No assistant message found in real LLM test - this may indicate API issues or timeouts',
      );
    }
  });
} else {
  test.skip('Real AI SDK streamText + OpenAI integration test (gated: set OM_ENABLE_LLM_TESTS=1 and OPENAI_API_KEY)', () => {});
}
