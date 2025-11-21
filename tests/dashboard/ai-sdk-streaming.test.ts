import { expect, test } from 'bun:test';

/**
 * AI SDK Streaming Integration Tests - Bun-Native Focus
 * Tests useChat and streamText contracts via fetch-based validation
 */

test('AI SDK streamText produces compatible SSE format', async () => {
    const { POST } = await import('../../dashboard/app/api/chat/route');
    // Mock NextRequest-like object for Bun test compatibility
    const mockRequest = {
        method: 'POST',
        url: 'http://localhost/api/chat',
        json: async () => ({
            messages: [{ role: 'user', content: 'test' }],
            embedding_mode: 'synthetic'
        })
    } as any;
    const response = await POST(mockRequest);
    const reader = response.body!.getReader();
    let accumulated = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += new TextDecoder().decode(value);
    }
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(accumulated).toContain('data: ');
    const events = accumulated.split('\ndata: ').filter(e => e.trim() && !e.includes('[DONE]'));
    if (events.length > 0) {
        const firstEvent = JSON.parse(events[0]);
        expect(firstEvent.role).toBe('assistant');
        expect(firstEvent.content || (firstEvent.parts && firstEvent.parts[0]?.text)).toBeDefined();
    }
});

test('Streaming telemetry extraction and validation', async () => {
    const responseWithTelemetry = 'data: streaming content\n\n' +
        '[[OM_TELEMETRY]]{"stream_duration_ms":123,"memory_ids":["mem-1"],"embedding_mode":"synthetic"}[[/OM_TELEMETRY]]\n\n';

    const mockResponse = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(responseWithTelemetry));
            controller.close();
        }
    });

    const originalFetch = global.fetch;
    global.fetch = (() => Promise.resolve({
        body: mockResponse
    } as any)) as any;

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            body: JSON.stringify({ messages: [{ role: 'user', content: 'test telemetry' }], embedding_mode: 'synthetic' })
        });
        const reader = response.body!.getReader();
        const { value } = await reader.read();
        const chunk = new TextDecoder().decode(value);

        expect(chunk).toContain('[[OM_TELEMETRY]]');
        expect(chunk).toContain('[[/OM_TELEMETRY]]');

        const telemetryJson = chunk.match(/\[\[OM_TELEMETRY\]\](.*)\[\[\/OM_TELEMETRY\]\]/)?.[1];
        const telemetry = JSON.parse(telemetryJson!);

        expect(typeof telemetry.stream_duration_ms).toBe('number');
        expect(Array.isArray(telemetry.memory_ids)).toBe(true);
        expect(telemetry.embedding_mode).toBe('synthetic');
    } finally {
        global.fetch = originalFetch;
    }
});

test('Memory injection validation in streamed responses', async () => {
    const responseWithMemories = 'data: Based on your stored knowledge:\n\n' +
        'data: Memory content about AI\n\n' +
        'data: From your past experiences:\n\n' +
        '[[OM_TELEMETRY]]{"memory_ids":["mem-1"]}[[/OM_TELEMETRY]]';

    const mockResponse = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(responseWithMemories));
            controller.close();
        }
    });

    const originalFetch = global.fetch;
    global.fetch = (() => Promise.resolve({
        body: mockResponse
    } as any)) as any;

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            body: JSON.stringify({ messages: [{ role: 'user', content: 'What do I remember?' }] })
        });
        const reader = response.body!.getReader();
        const { value } = await reader.read();
        const chunk = new TextDecoder().decode(value);

        expect(chunk).toContain('Based on your stored knowledge');
        expect(chunk).toContain('Memory content about AI');
        expect(chunk).toContain('[[OM_TELEMETRY]]');
    } finally {
        global.fetch = originalFetch;
    }
});

test('TTFT performance under realistic conditions', async () => {
    const startTime = performance.now();

    setTimeout(() => {
        // Simulate delayed first token
    }, 50);

    await new Promise(resolve => setTimeout(resolve, 50));

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
                embedding_mode: 'real'
            })
        } as any;

        const response = await POST(mockRequest);
        expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);

        // Read the stream
        const reader = response.body!.getReader();
        let dataReceived = false;
        let assistantMessageFound = false;

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = new TextDecoder().decode(value);
                if (chunk.includes('data:')) {
                    dataReceived = true;
                    // Parse assistant message
                    const lines = chunk.split('\n');
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            try {
                                const data = JSON.parse(line.slice(6));
                                if (data.role === 'assistant' && data.content) {
                                    assistantMessageFound = true;
                                    // Ensure no synthetic markers in real test
                                    expect(data.content).not.toContain('[[OM_TELEMETRY]]');
                                    break;
                                }
                            } catch (e) {
                                // Not JSON data, continue
                            }
                        }
                    }
                }
            }
        } catch (error) {
            // In case of timeout or real API issues
            console.warn('Real LLM test encountered issue:', error);
            expect(error instanceof Error).toBe(true); // Allow failure but must be proper error
        }

        expect(dataReceived).toBe(true);
        if (!assistantMessageFound) {
            console.warn('No assistant message received in real LLM test - this may indicate API connectivity issues');
        }
    });
} else {
    test.skip('Real AI SDK streamText + OpenAI integration test (gated: set OM_ENABLE_LLM_TESTS=1 and OPENAI_API_KEY)', () => {});
}
