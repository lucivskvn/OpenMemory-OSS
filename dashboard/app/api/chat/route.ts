import { NextRequest } from 'next/server'
import { API_BASE_URL, getHeaders, getServerHeaders } from '@/lib/api'
import { streamText } from 'ai'

interface MemoryReference {
    id: string
    sector: string
    content: string
    salience: number
}

interface StreamChunk {
    type: 'memory' | 'thought' | 'response' | 'complete'
    content: string
    memories?: MemoryReference[]
    confidence?: 'high' | 'moderate' | 'low'
    memory_count?: number
    sector_count?: number
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

async function* generateResponseStream(
    query: string,
    memories: MemoryReference[],
    embeddingMode: string
): AsyncGenerator<string> {
    // Stream memory references first
    if (memories.length > 0) {
        const memoriesChunk: StreamChunk = {
            type: 'memory',
            content: `Processing ${memories.length} relevant memories...`,
            memories: memories.map(m => ({
                ...m,
                salience: Math.min(1.0, m.salience * getSectorWeightings(m.sector))
            }))
        }
        yield `data: ${JSON.stringify(memoriesChunk)}\n\n`
        await new Promise(resolve => setTimeout(resolve, 100))
    }

    // Stream thought process
    yield `data: ${JSON.stringify({
        type: 'thought' as const,
        content: `Analyzing your question about: "${query}"`
    })}\n\n`
    await new Promise(resolve => setTimeout(resolve, 200))

    // Group memories by sector
    const sectorGroups: Record<string, MemoryReference[]> = {}
    memories.forEach(mem => {
        if (!sectorGroups[mem.sector]) {
            sectorGroups[mem.sector] = []
        }
        sectorGroups[mem.sector].push(mem)
    })

    const sectors = Object.keys(sectorGroups)
    const hasSemantic = sectorGroups['semantic']?.length > 0
    const hasEpisodic = sectorGroups['episodic']?.length > 0
    const hasProcedural = sectorGroups['procedural']?.length > 0
    const hasEmotional = sectorGroups['emotional']?.length > 0
    const hasReflective = sectorGroups['reflective']?.length > 0

    // Determine if it's a question
    const queryLower = query.toLowerCase()
    const isQuestion = queryLower.includes('?') ||
        queryLower.startsWith('what') ||
        queryLower.startsWith('how') ||
        queryLower.startsWith('why') ||
        queryLower.startsWith('when') ||
        queryLower.startsWith('where') ||
        queryLower.startsWith('who') ||
        queryLower.startsWith('can') ||
        queryLower.startsWith('is') ||
        queryLower.startsWith('do') ||
        queryLower.startsWith('does')

    let response = ''

    // Generate response based on available memories
    if (isQuestion) {
        if (hasSemantic) {
            response += "Based on your stored knowledge:\n\n"
            const topSemantic = sectorGroups['semantic'].slice(0, 3)
            topSemantic.forEach((mem, idx) => {
                response += `${mem.content}`
                if (idx < topSemantic.length - 1) response += "\n\n"
            })
        } else if (hasEpisodic) {
            response += "From your past experiences:\n\n"
            const topEpisodic = sectorGroups['episodic'].slice(0, 2)
            topEpisodic.forEach((mem, idx) => {
                response += `${mem.content}`
                if (idx < topEpisodic.length - 1) response += "\n\n"
            })
        } else if (hasProcedural) {
            response += "Here's what I remember about the process:\n\n"
            const topProcedural = sectorGroups['procedural'].slice(0, 2)
            topProcedural.forEach((mem, idx) => {
                response += `${mem.content}`
                if (idx < topProcedural.length - 1) response += "\n\n"
            })
        }

        // Additional context from other memory types
        if (hasEpisodic && hasSemantic) {
            response += "\n\n**Related experience:**\n"
            response += sectorGroups['episodic'][0].content
        }

        if (hasProcedural && (hasSemantic || hasEpisodic)) {
            response += "\n\n**How to apply this:**\n"
            response += sectorGroups['procedural'][0].content
        }

        if (hasEmotional) {
            response += "\n\n**Emotional context:**\n"
            response += sectorGroups['emotional'][0].content
        }

        if (hasReflective) {
            response += "\n\n**Insight:**\n"
            response += sectorGroups['reflective'][0].content
        }
    } else {
        // For non-questions, combine multiple memory types
        const allMemories = memories.slice(0, 5)

        if (hasSemantic && hasEpisodic) {
            response += `${sectorGroups['semantic'][0].content}\n\n`
            response += `This connects to when ${sectorGroups['episodic'][0].content.toLowerCase()}`
        } else if (hasSemantic) {
            response += sectorGroups['semantic'].slice(0, 2).map(m => m.content).join('\n\n')
        } else if (hasEpisodic) {
            response += "Based on your experiences:\n\n"
            response += sectorGroups['episodic'].slice(0, 3).map(m => m.content).join('\n\n')
        } else {
            response += allMemories.map(m => m.content).join('\n\n')
        }

        if (hasProcedural && response.length < 500) {
            response += "\n\n**Steps involved:**\n"
            response += sectorGroups['procedural'][0].content
        }

        if (hasReflective && response.length < 600) {
            response += "\n\n**Reflection:**\n"
            response += sectorGroups['reflective'][0].content
        }
    }

    // Add metadata footer
    const avgSalience = memories.length > 0
        ? memories.reduce((sum, m) => sum + (m.salience * getSectorWeightings(m.sector)), 0) / memories.length
        : 0
    const confidence = avgSalience > 0.7 ? "high" : avgSalience > 0.4 ? "moderate" : "low"

    const memoryCount = memories.length
    const sectorCount = sectors.length

    response += `\n\n---\n*Retrieved ${memoryCount} ${memoryCount === 1 ? 'memory' : 'memories'} from ${sectorCount} ${sectorCount === 1 ? 'sector' : 'sectors'} • Confidence: ${confidence}*`

    // Stream response content in chunks
    const chunks = response.split('\n\n')
    for (let i = 0; i < chunks.length; i++) {
        yield `data: ${JSON.stringify({
            type: 'response' as const,
            content: chunks[i] + (i < chunks.length - 1 ? '\n\n' : '')
        })}\n\n`
        await new Promise(resolve => setTimeout(resolve, 50)) // Simulate thoughtful pause
    }

    // Final completion marker
    yield `data: ${JSON.stringify({
        type: 'complete' as const,
        content: '',
        confidence,
        memory_count: memoryCount,
        sector_count: sectorCount
    })}\n\n`
}

export async function POST(request: NextRequest) {
    try {
        const { messages, embedding_mode } = await request.json()
        const userMessage = messages.find((m: any) => m.role === 'user')
        const query = userMessage?.content || ''

        if (!query.trim()) {
            return new Response('No query provided', { status: 400 })
        }

        // Query memories from backend
        let memories: MemoryReference[] = []
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
            } else {
                console.warn('Memory query failed, proceeding with empty memories')
            }
        } catch (error) {
            console.error('Error querying memories:', error)
        }

        // Try AI SDK streaming if available; it may be stubbed or not present in
        // every environment. This is a best-effort integration: if the AI SDK
        // is present and the `streamText` function is available, use it and
        // return `toUIMessageStreamResponse()`. Otherwise fall back to the
        // existing ReadableStream SSE-based fallback.
        if (typeof streamText === 'function') {
            try {
                // Use a memoryModel that reproduces the same behavior as the
                // SSE fallback. The provider integration is optional, so we
                // cast to `any` here to avoid type errors for some providers.
                const memoryModel = {
                    api: async () => ({
                        shouldStream: true,
                        supportsStructuredOutputs: false
                    }),
                }

                const result = await streamText({
                    model: memoryModel as any,
                    prompt: `Generate a memory-augmented response for: "${query}"`,
                })

                if (result && typeof result.toUIMessageStreamResponse === 'function') {
                    return result.toUIMessageStreamResponse()
                }
            } catch (err) {
                console.warn('AI SDK streaming integration skipped (streamText call failed):', String(err))
            }
        }

        // For now, use the original approach since AI SDK v5 streaming is complex
        // This creates a Response that streams the memory-based content
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    for await (const chunk of generateResponseStream(query, memories, embedding_mode || 'unknown')) {
                        controller.enqueue(new TextEncoder().encode(chunk))
                    }
                    controller.close()
                } catch (error) {
                    console.error('Streaming error:', error)
                    controller.error(error)
                }
            }
        })

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
            }
        })

    } catch (error) {
        console.error('Chat API error:', error)
        return new Response('Internal server error', { status: 500 })
    }
}
