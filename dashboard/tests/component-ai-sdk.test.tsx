// Scoped augmentation is applied via tests/test-augmentations.d.ts; remove global ts-nocheck
/**
 * AI SDK Component Tests - React Component Integration (PHASE 6.5)
 *
 * Real React Testing Library tests for ChatInner component with actual rendering
 * - useChat hook integration with streaming
 * - Memory augmentation UI updates
 * - Error handling and recovery
 * - MSW mocking for /api/chat and memory endpoints
 */

import { describe, test, expect, beforeAll, afterAll, afterEach, mock } from 'bun:test'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import ChatInner from '../app/chat/ChatInner'
import userEvent from '@testing-library/user-event'
import * as msw from 'msw'
import { setupServer } from 'msw/node'
/// <reference types="@testing-library/jest-dom" />
import { chromium } from 'playwright'

// Mock the API functions using Bun's mock
mock.module('../lib/api', () => ({
    API_BASE_URL: 'http://localhost:8080',
    getHeaders: () => ({ 'Content-Type': 'application/json' }),
    getEmbeddingConfig: async () => ({
        kind: 'synthetic',
        provider: 'synthetic',
        dimensions: 256,
        mode: 'simple',
        batchMode: 'simple',
        embed_delay_ms: 0,
        router_enabled: false,
        simd_enabled: false,
        fallback_enabled: false,
        cache_ttl_ms: 30000,
        sector_models: {},
        performance: {
            expected_p95_ms: 100,
            expected_simd_improvement: 0,
            memory_usage_gb: 2.0
        },
        ollama_required: false,
        cached: false
    }),
    buildEmbeddingTelemetry: () => ({
        meta_version: 1,
        provider: 'synthetic',
        batch_mode: 'simple',
        simd_global_enabled: true
    })
}))

// E2E test server URLs
const BACKEND_URL = 'http://localhost:8080'
const DASHBOARD_URL = 'http://localhost:3000'

// Global browser instance
let browser: any
let context: any

beforeAll(async () => {
    browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    })
})

// Start MSW server for API stubbing used by component tests
const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

afterAll(async () => {
    if (browser) {
        await browser.close()
    }
})

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    describe('ChatInner Component - React RTL Tests', () => {
        test('renders ChatInner component with correct UI elements', async () => {
            await act(async () => {
                // Render the client ChatInner component
                const ChatInner = (await import('../app/chat/ChatInner')).default
                render(<ChatInner />)
            })

            expect(screen.getByPlaceholderText('Ask about your memories...')).toBeInTheDocument()
            expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument()
            expect(screen.getByText('Memories Used')).toBeInTheDocument()
        })

        test('handles user input and shows disabled state correctly', async () => {
            const user = userEvent.setup()
            await act(async () => {
                render(<ChatInner />)
            })

            const input = screen.getByPlaceholderText('Ask about your memories...')
            const submitButton = screen.getByRole('button', { name: /send/i })

            // Initially disabled
            expect(submitButton).toBeDisabled()

            // Type message
            await user.type(input, 'What do I know about AI?')
            expect(input).toHaveValue('What do I know about AI?')

            // Now enabled
            expect(submitButton).not.toBeDisabled()
        })

        test('submits form and shows thinking state', async () => {
            const user = userEvent.setup()
            await act(async () => {
                render(<ChatInner />)
            })

            const input = screen.getByPlaceholderText('Ask about your memories...')
            const submitButton = screen.getByRole('button', { name: /send/i })

            await user.type(input, 'Test AI memory query')
            await user.click(submitButton)

            // Should show thinking animation
            await waitFor(() => {
                expect(screen.getByText('Thinking…')).toBeInTheDocument()
            }, { timeout: 1000 })
        })

        test('displays streaming response with memory content', async () => {
            const user = userEvent.setup()
            await act(async () => {
                render(<ChatInner />)
            })

            const input = screen.getByPlaceholderText('Ask about your memories...')
            const submitButton = screen.getByRole('button', { name: /send/i })

            await user.type(input, 'What do I know about AI?')
            await user.click(submitButton)

            // Wait for response to appear
            await waitFor(() => {
                expect(screen.getByText(/Based on your stored knowledge/i)).toBeInTheDocument()
            }, { timeout: 15000 })

            // Check memory content is displayed (should not include telemetry artifacts)
            expect(screen.getByText(/AI technology involves machine learning algorithms/i)).toBeInTheDocument()
            expect(screen.getByText(/and neural network architectures/i)).toBeInTheDocument()

            // Check completion metadata
            expect(screen.getByText(/- Retrieved 2 memories from 1 sectors • Confidence: high/i)).toBeInTheDocument()
        })

        test('updates memory sidebar with query results', async () => {
            const user = userEvent.setup()
            await act(async () => {
                render(<ChatInner />)
            })

            const input = screen.getByPlaceholderText('Ask about your memories...')
            const submitButton = screen.getByRole('button', { name: /send/i })

            await user.type(input, 'AI technology')
            await user.click(submitButton)

            // Wait for memory sidebar to update
            await waitFor(() => {
                expect(screen.getByText('2')).toBeInTheDocument() // Memory count
            }, { timeout: 10000 })

            // Check memory titles are displayed
            expect(screen.getByText('Machine Learning')).toBeInTheDocument()
            expect(screen.getByText('Neural Networks')).toBeInTheDocument()

            // Check sector badges
            expect(screen.getByText('semantic')).toBeInTheDocument()
        })

        test('handles Enter key submission', async () => {
            const user = userEvent.setup()
            await act(async () => {
                render(<ChatInner />)
            })

            const input = screen.getByPlaceholderText('Ask about your memories...')

            await user.type(input, 'Enter key test query')
            fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })

            // Should trigger submission
            await waitFor(() => {
                expect(screen.getByText('Thinking…')).toBeInTheDocument()
            }, { timeout: 2000 })
        })

        test('clears input after successful submission', async () => {
            const user = userEvent.setup()
            await act(async () => {
                render(<ChatInner />)
            })

            const input = screen.getByPlaceholderText('Ask about your memories...')
            const submitButton = screen.getByRole('button', { name: /send/i })

            await user.type(input, 'Test message')
            await user.click(submitButton)

            // Wait for response
            await waitFor(() => {
                expect(screen.getByText(/Based on your stored knowledge/i)).toBeInTheDocument()
            }, { timeout: 10000 })

            // Input should be cleared
            expect(input).toHaveValue('')
        })

        test('handles empty input gracefully', async () => {
            const user = userEvent.setup()
            await act(async () => {
                render(<ChatInner />)
            })

            const input = screen.getByPlaceholderText('Ask about your memories...')
            const submitButton = screen.getByRole('button', { name: /send/i })

            // Click submit with empty input
            await user.click(submitButton)

            // Should not trigger any submission
            expect(screen.queryByText('Thinking…')).not.toBeInTheDocument()
            expect(submitButton).toBeDisabled()
        })

        test('maintains message history across submissions', async () => {
            const user = userEvent.setup()
            await act(async () => {
                render(<ChatInner />)
            })

            const input = screen.getByPlaceholderText('Ask about your memories...')
            const submitButton = screen.getByRole('button', { name: /send/i })

            // First message
            await user.type(input, 'First question')
            await user.click(submitButton)

            await waitFor(() => {
                expect(screen.getByText('First question')).toBeInTheDocument()
            }, { timeout: 10000 })

            // Second message
            await user.type(input, 'Second question')
            await user.click(submitButton)

            await waitFor(() => {
                expect(screen.getAllByText(/First question/i)).toHaveLength(1)
                expect(screen.getByText('Second question')).toBeInTheDocument()
            }, { timeout: 15000 })
        })

        test('handles API errors gracefully', async () => {
            // Update server to return error
            const { rest } = await import('msw')
            server.use(
                rest.post('/api/chat', async (req, res, ctx) => {
                    return res(ctx.status(500), ctx.text('Server error'))
                })
            )

            const user = userEvent.setup()
            await act(async () => {
                render(<ChatInner />)
            })

            const input = screen.getByPlaceholderText('Ask about your memories...')
            const submitButton = screen.getByRole('button', { name: /send/i })

            await user.type(input, 'Test error handling')
            await user.click(submitButton)

            // Should not crash and input should still be available
            expect(input).toHaveValue('Test error handling')
            expect(screen.queryByText('Thinking…')).not.toBeInTheDocument()
        })
    })
} else {
    console.warn('Skipping ChatInner DOM tests: document/window not available in this test environment')
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    describe('Memory Sidebar Integration', () => {
        test('displays memory metadata correctly', async () => {
            const user = userEvent.setup()
            await act(async () => {
                render(<ChatInner />)
            })

            const input = screen.getByPlaceholderText('Ask about your memories...')
            const submitButton = screen.getByRole('button', { name: /send/i })

            await user.type(input, 'Test metadata display')
            await user.click(submitButton)

            // Wait for memory sidebar to populate
            await waitFor(() => {
                expect(screen.getByText('2')).toBeInTheDocument()
            }, { timeout: 10000 })

            // Test that add-to-bag buttons are present
            const addButtons = screen.getAllByTitle('Add to bag')
            expect(addButtons.length).toBeGreaterThan(0)
        })

        test('updates multiple times with different queries', async () => {
            const user = userEvent.setup()
            await act(async () => {
                render(<ChatInner />)
            })

            const input = screen.getByPlaceholderText('Ask about your memories...')
            let submitButton = screen.getByRole('button', { name: /send/i })

            // First query
            await user.type(input, 'Query 1')
            await user.click(submitButton)

            await waitFor(() => {
                expect(screen.getByText('2')).toBeInTheDocument()
            }, { timeout: 10000 })

            // Second query (should clear and update)
            submitButton = screen.getByRole('button', { name: /send/i })
            await user.type(input, 'Query 2')
            await user.click(submitButton)

            await waitFor(() => {
                expect(screen.getByText('2')).toBeInTheDocument() // Still 2 memories
            }, { timeout: 15000 })
        })
    })
} else {
    console.warn('Skipping Memory Sidebar DOM tests: document/window not available')
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    describe('Performance Benchmarks', () => {
        test('measures TTFT accurately', async () => {
            const startTime = performance.now()
            const user = userEvent.setup()

            await act(async () => {
                render(<ChatInner />)
            })

            const input = screen.getByPlaceholderText('Ask about your memories...')
            const submitButton = screen.getByRole('button', { name: /send/i })

            await user.type(input, 'Performance test')
            await user.click(submitButton)

            // Measure time to first response chunk
            await waitFor(() => {
                const element = screen.queryByText(/Based on your stored knowledge/i)
                if (element) {
                    const ttft = performance.now() - startTime
                    expect(ttft).toBeGreaterThan(50) // At least some processing time
                    expect(ttft).toBeLessThan(5000) // Should be reasonable
                    return element
                }
                return false
            }, { timeout: 5000 })
        })
    })
} else {
    console.warn('Skipping Performance Benchmarks: DOM not available')
}

export { }
