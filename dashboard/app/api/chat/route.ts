import { NextRequest } from 'next/server'
import { API_BASE_URL, getServerHeaders } from '@/lib/api'
import { streamText } from 'ai'
import { openai } from '@ai-sdk/openai'

interface MemoryReference {
    id: string
    sector: string
    content: string
    salience: number
}

function getSectorWeightings(sector: string): number {
    const weights: Record<string, number> = {
        episodic: 1.3,
        semantic: 1.0,
        procedural: 1.2,
        emotional: 1.4,
        reflective: 0.9,
    }
    return weights[sector] || 1.0
}

export async function POST(request: NextRequest) {
    try {
        const startTime = Date.now()
        const { messages: requestMessages, embedding_mode } = await request.json()
        const userMessage = [...requestMessages].reverse().find((m: any) => m.role === 'user')
        const query = userMessage?.content || ''

        if (!query.trim()) {
            return new Response('No query provided', { status: 400 })
        }

        // Query memories from backend
        let memories: MemoryReference[] = []
        let memoryIds: string[] = []
        try {
            const response = await fetch(`${API_BASE_URL}/memory/query`, {
                method: "POST",
                headers: getServerHeaders(),
                body: JSON.stringify({
                    query,
                    k: 10,
                    filters: {},
                    metadata: { embedding_mode: embedding_mode || 'unknown' }
                })
            })

            if (response.ok) {
                const data = await response.json()
                memories = data.matches.map((match: any) => ({
                    id: match.id,
                    sector: match.primary_sector || "semantic",
                    content: match.content,
                    salience: match.salience || match.score,
                }))
                memoryIds = memories.map(m => m.id)
            } else {
                console.warn('Memory query failed, proceeding with empty memories')
            }
        } catch (error) {
            console.error('Error querying memories:', error)
        }

        // Compute telemetry data
        const avgSalience = memories.length > 0 ? memories.reduce((sum, m) => sum + (m.salience * getSectorWeightings(m.sector)), 0) / memories.length : 0
        const confidence = avgSalience > 0.7 ? 'high' : avgSalience > 0.4 ? 'moderate' : 'low'

        // Construct prompt with memory context
        const memoryContext = memories.length > 0
            ? `Given the following relevant memories:\n\n${memories.map((m, i) =>
                `[${i + 1}] ${m.content} (sector: ${m.sector}, relevance: ${(m.salience * 100).toFixed(1)}%)`
            ).join('\n\n')}\n\n`
            : 'No relevant memories found.\n\n'

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
        ]

        // Create AI model (using OpenAI)
        const isTestMode = process.env.OM_TEST_MODE === '1'
        const model = process.env.OPENAI_API_KEY ? openai('gpt-4o-mini') : null
        if (!model) {
            if (isTestMode) {
                // Synthetic response for testing
                const syntheticContent = `Synthetic response to: ${query}`;
                const message = { content: syntheticContent } as any;
                // Add telemetry and memories markers
                message.content += `\n\n[[OM_TELEMETRY]]${JSON.stringify({
                    stream_duration_ms: Date.now() - startTime,
                    memory_ids: memoryIds,
                    embedding_mode: embedding_mode || 'unknown',
                    confidence,
                    memory_count: memories.length,
                    sector_count: new Set(memories.map(m => m.sector)).size
                })}[[/OM_TELEMETRY]]`;
                message.content += `\n\n[[OM_MEMORIES]]${JSON.stringify(memories.map(m => ({
                    id: m.id,
                    sector: m.sector,
                    content: m.content.substring(0, 100),
                    salience: m.salience,
                    title: m.content.substring(0, 50) + (m.content.length > 50 ? "..." : "")
                })))}[[/OM_MEMORIES]]`;

                const syntheticResponse = `data: ${JSON.stringify({
                    role: 'assistant',
                    content: message.content,
                    id: `synthetic-${Date.now()}`,
                    type: 'text',
                    toolCalls: []
                })}\n\ndata: [DONE]\n\n`;

                const stream = new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode(syntheticResponse));
                        controller.close();
                    }
                });

                return new Response(stream, {
                    headers: { 'Content-Type': 'text/event-stream' }
                });
            } else {
                return new Response(JSON.stringify({ error: 'Chat generation disabled - LLM provider (e.g., OPENAI_API_KEY) not configured. Use synthetic mode for testing.' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
            }
        }

        const result = await streamText({
            model: model as any,
            messages: apiMessages,
            temperature: 0.7,
        })

        return result.toUIMessageStreamResponse({
            onFinish: (message) => {
                (message as any).content += `\n\n[[OM_TELEMETRY]]${JSON.stringify({
                    stream_duration_ms: Date.now() - startTime,
                    memory_ids: memoryIds,
                    embedding_mode: embedding_mode || 'unknown',
                    confidence,
                    memory_count: memories.length,
                    sector_count: new Set(memories.map(m => m.sector)).size
                })}[[/OM_TELEMETRY]]`
                    ; (message as any).content += `\n\n[[OM_MEMORIES]]${JSON.stringify(memories.map(m => ({
                        id: m.id,
                        sector: m.sector,
                        content: m.content.substring(0, 100),
                        salience: m.salience,
                        title: m.content.substring(0, 50) + (m.content.length > 50 ? "..." : "")
                    })))}[[/OM_MEMORIES]]`
            }
        })
    } catch (error) {
        console.error('Chat API error:', error)
        return new Response('Internal server error', { status: 500 })
    }
}
