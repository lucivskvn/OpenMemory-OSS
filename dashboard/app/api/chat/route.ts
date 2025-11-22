import { NextRequest } from 'next/server';
import { API_BASE_URL, getServerHeaders } from '@/lib/api';
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';

interface MemoryReference {
  id: string;
  sector: string;
  content: string;
  salience: number;
}

function getSectorWeightings(sector: string): number {
  const weights: Record<string, number> = {
    episodic: 1.3,
    semantic: 1.0,
    procedural: 1.2,
    emotional: 1.4,
    reflective: 0.9,
  };
  return weights[sector] || 1.0;
}

function augmentMessageWithTelemetryAndMemories(
  baseContent: string,
  startTime: number,
  memoryIds: string[],
  memories: MemoryReference[],
  embedding_mode: string,
  confidence: string,
): string {
  let content = baseContent;

  content += `\n\n[[OM_TELEMETRY]]${JSON.stringify({
    stream_duration_ms: Date.now() - startTime,
    memory_ids: memoryIds,
    embedding_mode,
    confidence,
    memory_count: memories.length,
    sector_count: new Set(memories.map((m) => m.sector)).size,
  })}[[/OM_TELEMETRY]]`;

  content += `\n\n[[OM_MEMORIES]]${JSON.stringify(
    memories.map((m) => ({
      id: m.id,
      sector: m.sector,
      content: m.content.substring(0, 100),
      salience: m.salience,
      title: m.content.substring(0, 50) + (m.content.length > 50 ? '...' : ''),
    })),
  )}[[/OM_MEMORIES]]`;

  return content;
}

export async function POST(request: NextRequest) {
  try {
    const startTime = Date.now();
    const { messages: requestMessages, embedding_mode } = await request.json();
    const userMessage = [...requestMessages]
      .reverse()
      .find((m: any) => m.role === 'user');
    const query = userMessage?.content || '';

    if (!query.trim()) {
      return new Response('No query provided', { status: 400 });
    }

    // Query memories from backend
    let memories: MemoryReference[] = [];
    let memoryIds: string[] = [];
    try {
      const response = await fetch(`${API_BASE_URL}/memory/query`, {
        method: 'POST',
        headers: getServerHeaders(),
        body: JSON.stringify({
          query,
          k: 10,
          filters: {},
          metadata: { embedding_mode: embedding_mode || 'unknown' },
        }),
      });

      if (response.ok) {
        const data = await response.json();
        memories = data.matches.map((match: any) => ({
          id: match.id,
          sector: match.primary_sector || 'semantic',
          content: match.content,
          salience: match.salience || match.score,
        }));
        memoryIds = memories.map((m) => m.id);
      } else {
        console.warn('Memory query failed, proceeding with empty memories');
      }
    } catch (error) {
      console.error('Error querying memories:', error);
    }

    // Compute telemetry data
    const avgSalience =
      memories.length > 0
        ? memories.reduce(
          (sum, m) => sum + m.salience * getSectorWeightings(m.sector),
          0,
        ) / memories.length
        : 0;
    const confidence =
      avgSalience > 0.7 ? 'high' : avgSalience > 0.4 ? 'moderate' : 'low';

    // Construct prompt with memory context
    const memoryContext =
      memories.length > 0
        ? `Given the following relevant memories:\n\n${memories
          .map(
            (m, i) =>
              `[${i + 1}] ${m.content} (sector: ${m.sector}, relevance: ${(m.salience * 100).toFixed(1)}%)`,
          )
          .join('\n\n')}\n\n`
        : 'No relevant memories found.\n\n';

    // Build messages array for AI SDK
    const apiMessages: any[] = [
      {
        role: 'system' as const,
        content: `Context from ${memories.length} memories:\n\n${memoryContext}`,
      },
      {
        role: 'user' as const,
        content: query,
      },
    ];

    // Create AI model (using OpenAI)
    const isTestMode = process.env.OM_TEST_MODE === '1';
    const model = process.env.OPENAI_API_KEY ? openai('gpt-4o-mini') : null;
    if (!model) {
      if (isTestMode) {
        // Synthetic test mode: use mock streamText result to match real path protocol
        // Stream unaugmented content, onFinish augments the final message content
        const syntheticContent = `Synthetic response to: ${query}`;
        const mockMessage = { content: syntheticContent } as any;

        const mockResult = {
          toUIMessageStreamResponse: (options: any) => {
            const onFinishCallback = options?.onFinish;

            const stream = new ReadableStream({
              start(controller) {
                // Use AI SDK data-stream format (0: prefix) with unaugmented content
                const payload = `0:{"role": "assistant", "content": "${mockMessage.content.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"}`;
                controller.enqueue(new TextEncoder().encode(payload));
                controller.close();
              },
            });

            // After stream is set up (synchronously), call onFinish to augment the message
            if (onFinishCallback) {
              onFinishCallback(mockMessage);
            }

            return new Response(stream, {
              headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            });
          },
        };

        return mockResult.toUIMessageStreamResponse({
          onFinish: (message: any) => {
            (message as any).content = augmentMessageWithTelemetryAndMemories(
              (message as any).content,
              startTime,
              memoryIds,
              memories,
              embedding_mode || 'unknown',
              confidence,
            );
          },
        });
      } else {
        return new Response(
          JSON.stringify({
            error:
              'Chat generation disabled - LLM provider (e.g., OPENAI_API_KEY) not configured. Use synthetic mode for testing.',
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        );
      }
    }

    const result = streamText({
      model: model as any,
      messages: apiMessages,
      temperature: 0.7,
    });

    return result.toUIMessageStreamResponse({
      onFinish: (message: any) => {
        (message as any).content = augmentMessageWithTelemetryAndMemories(
          (message as any).content,
          startTime,
          memoryIds,
          memories,
          embedding_mode || 'unknown',
          confidence,
        );
      },
    });
  } catch (error) {
    console.error('Chat API error:', error);
    return new Response('Internal server error', { status: 500 });
  }
}
