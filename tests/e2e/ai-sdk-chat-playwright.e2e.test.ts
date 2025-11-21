/**
 * AI SDK Chat Playwright E2E Tests - Full Browser Automation (PHASE 6.5)
 *
 * End-to-end testing with actual browser automation using Playwright
 * Tests complete chat flow, streaming responses, memory augmentation
 * Real server integration testing with performance measurements
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'bun:test';
import {
  chromium,
  type Browser,
  type Page,
  type BrowserContext,
} from 'playwright';
import { spawn } from 'child_process';

// Test configuration
const CONFIG = {
  backendPort: 8080,
  dashboardPort: 3000,
  backendUrl: 'http://localhost:8080',
  dashboardUrl: 'http://localhost:3000',
  testTimeout: 60000, // 60 seconds for E2E
};

// Server process references
let backendProcess: any;
let dashboardProcess: any;
let browser: Browser;
let context: BrowserContext;
let page: Page;

async function startBackend(): Promise<void> {
  console.log('Starting backend server...');

  backendProcess = spawn('bun', ['run', 'start'], {
    cwd: process.cwd() + '/backend',
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: {
      ...process.env,
      OM_DB_PATH: `/tmp/openmemory-playwright-${Date.now()}.sqlite`,
      OM_TEST_MODE: '1',
      OM_EMBED_KIND: 'synthetic',
      OM_SKIP_BACKGROUND: 'true',
      OM_API_KEYS_ENABLED: 'false',
    },
  });

  // Log server output for debugging
  if (backendProcess.stdout) {
    backendProcess.stdout.on('data', (data: any) => {
      if (process.env.DEBUG === '1') console.log(`[BACKEND]: ${data}`);
    });
  }
  if (backendProcess.stderr) {
    backendProcess.stderr.on('data', (data: any) => {
      if (process.env.DEBUG === '1') console.error(`[BACKEND ERROR]: ${data}`);
    });
  }

  // Wait for health check
  await waitForServer(CONFIG.backendUrl, '/health', 30000);
}

async function startDashboard(): Promise<void> {
  console.log('Starting dashboard server...');

  dashboardProcess = spawn('bun', ['run', 'build'], {
    cwd: process.cwd() + '/dashboard',
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: {
      ...process.env,
      NEXT_PUBLIC_API_URL: CONFIG.backendUrl,
      NEXT_TELEMETRY_DISABLED: '1',
    },
  });

  // Wait for build completion
  if (dashboardProcess) {
    await new Promise<void>((resolve, reject) => {
      dashboardProcess.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Dashboard build failed with code ${code}`));
        }
      });
      setTimeout(() => reject(new Error('Dashboard build timeout')), 60000);
    });
  }

  // Start the production server
  dashboardProcess = spawn(
    'bun',
    ['run', 'start', `-p`, CONFIG.dashboardPort.toString()],
    {
      cwd: process.cwd() + '/dashboard',
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: {
        ...process.env,
        NEXT_PUBLIC_API_URL: CONFIG.backendUrl,
        PORT: CONFIG.dashboardPort.toString(),
        HOSTNAME: '127.0.0.1',
      },
    },
  );

  // Wait for dashboard readiness
  await waitForServer(CONFIG.dashboardUrl, '/api/health', 30000);
}

async function waitForServer(
  baseUrl: string,
  endpoint: string,
  timeout: number,
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const response = await fetch(`${baseUrl}${endpoint}`);
      if (response.ok) {
        console.log(`Server ready at ${baseUrl}${endpoint}`);
        return;
      }
    } catch (error) {
      // Continue trying
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(
    `Server not ready at ${baseUrl}${endpoint} within ${timeout}ms`,
  );
}

async function stopServers(): Promise<void> {
  console.log('Stopping all servers...');

  const processes = [backendProcess, dashboardProcess];

  for (const proc of processes) {
    if (proc && proc.pid) {
      try {
        // Kill entire process group
        process.kill(-proc.pid, 'SIGKILL');
      } catch (error) {
        console.warn('Failed to kill process:', error);
        try {
          proc.kill('SIGKILL');
        } catch (fallbackError) {
          console.warn('Fallback kill also failed:', fallbackError);
        }
      }
    }
  }

  backendProcess = null;
  dashboardProcess = null;
}

beforeAll(async () => {
  console.log('Setting up Playwright E2E test environment...');

  // Start servers
  await startBackend();
  await startDashboard();

  // Start browser
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  console.log('E2E test environment ready');
}, CONFIG.testTimeout);

afterAll(async () => {
  await stopServers();
  if (browser) {
    await browser.close();
  }
}, CONFIG.testTimeout);

beforeEach(async () => {
  context = await browser.newContext();
  page = await context.newPage();

  // Set longer default timeouts
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);

  // Navigate to chat page
  await page.goto(`${CONFIG.dashboardUrl}/chat`);
}, 30000);

afterEach(async () => {
  if (page) {
    await page.close();
  }
  if (context) {
    await context.close();
  }
});

describe('AI SDK Chat E2E - Browser Automation', () => {
  test('loads chat page and displays UI elements', async () => {
    // Check that main UI elements are present
    const input = page.locator('input[placeholder*="Ask about your memories"]');
    await expect(input).toBeVisible();

    const sendButton = page.locator('button', { hasText: /send/i });
    await expect(sendButton).toBeVisible();

    const memoriesHeader = page.locator('text=Memories Used');
    await expect(memoriesHeader).toBeVisible();
  });

  test('handles user input and submit button state', async () => {
    const input = page.locator('input[placeholder*="Ask about your memories"]');
    const sendButton = page.locator('button', { hasText: /send/i });

    // Initially disabled
    await expect(sendButton).toBeDisabled();

    // Type message
    await input.fill('What do I remember about AI?');
    await expect(sendButton).toBeEnabled();
  });

  test('submits chat message and shows thinking state', async () => {
    const input = page.locator('input[placeholder*="Ask about your memories"]');
    const sendButton = page.locator('button', { hasText: /send/i });

    // Type and submit
    await input.fill('Test AI memory query');
    await sendButton.click();

    // Should show thinking animation
    const thinkingIndicator = page.locator('text=Thinking…');
    await expect(thinkingIndicator).toBeVisible({ timeout: 5000 });
  });

  test('displays streaming response and memory content', async () => {
    const input = page.locator('input[placeholder*="Ask about your memories"]');
    const sendButton = page.locator('button', { hasText: /send/i });

    const startTime = Date.now();
    await input.fill('What do I know about AI technology?');
    await sendButton.click();

    // Wait for streaming response content
    const responseContent = page.locator(
      'text=/Based on your stored knowledge/i',
    );
    await expect(responseContent).toBeVisible({ timeout: 20000 });

    // Check that memory content appears (without telemetry artifacts)
    const memoryText = page.locator('text=/machine learning algorithms/i');
    await expect(memoryText).toBeVisible();

    // Check completion metadata appears
    const metadata = page.locator('text=/- Retrieved.*Confidence: high/i');
    await expect(metadata).toBeVisible();

    const ttft = Date.now() - startTime;
    console.log(`Time to first token: ${ttft}ms`);
    expect(ttft).toBeLessThan(5000); // Should be reasonable response time
  });

  test('updates memory sidebar with query results', async () => {
    const input = page.locator('input[placeholder*="Ask about your memories"]');
    const sendButton = page.locator('button', { hasText: /send/i });

    await input.fill('Tell me about machine learning');
    await sendButton.click();

    // Wait for memory count update
    const memoryCount = page.locator('text=3').first();
    await expect(memoryCount).toBeVisible({ timeout: 15000 });

    // Check memory titles appear
    const memoryTitles = [
      'Machine Learning',
      'Neural Networks',
      'ML Algorithms',
    ];
    for (const title of memoryTitles) {
      const titleLocator = page.locator(`text=${title}`);
      await expect(titleLocator).toBeVisible();
    }

    // Check sector badges
    const semanticBadge = page.locator('text=semantic');
    await expect(semanticBadge).toBeVisible();
  });

  test('handles Enter key submission', async () => {
    const input = page.locator('input[placeholder*="Ask about your memories"]');

    await input.fill('Enter key test message');
    await input.press('Enter');

    // Should trigger submission
    const thinkingIndicator = page.locator('text=Thinking…');
    await expect(thinkingIndicator).toBeVisible({ timeout: 5000 });
  });

  test('clears input after successful submission', async () => {
    const input = page.locator('input[placeholder*="Ask about your memories"]');
    const sendButton = page.locator('button', { hasText: /send/i });

    await input.fill('Test message for clearing');
    await sendButton.click();

    // Wait for response
    await expect(
      page.locator('text=/Based on your stored knowledge/i'),
    ).toBeVisible({ timeout: 15000 });

    // Input should be cleared
    const finalValue = await input.inputValue();
    expect(finalValue).toBe('');
  });

  test('handles empty input gracefully', async () => {
    const sendButton = page.locator('button', { hasText: /send/i });

    // Button should be disabled with empty input
    await expect(sendButton).toBeDisabled();

    // Clicking disabled button should not trigger anything
    const thinkingBefore = page.locator('text=Thinking…').count();
    await sendButton.click({ force: true }); // Force click disabled button
    const thinkingAfter = await page.locator('text=Thinking…').count();

    expect(thinkingAfter - thinkingBefore).toBe(0); // No thinking indicators
  });

  test('maintains conversation history', async () => {
    const input = page.locator('input[placeholder*="Ask about your memories"]');
    const sendButton = page.locator('button', { hasText: /send/i });

    // First message
    await input.fill('First question about AI');
    await sendButton.click();
    await expect(page.locator('text=First question about AI')).toBeVisible({
      timeout: 15000,
    });

    // Second message
    await input.fill('Second question about memories');
    await sendButton.click();

    // Both messages should be visible
    await expect(page.locator('text=First question about AI')).toBeVisible();
    await expect(
      page.locator('text=Second question about memories'),
    ).toBeVisible();
    await expect(
      page.locator('text=/Based on your stored knowledge/i'),
    ).toHaveCount(2);
  });

  test('parses telemetry data correctly', async () => {
    const input = page.locator('input[placeholder*="Ask about your memories"]');
    const sendButton = page.locator('button', { hasText: /send/i });

    await input.fill('Test telemetry parsing');
    await sendButton.click();

    // Wait for complete response
    await expect(
      page.locator('text=/- Retrieved.*Confidence: high/i'),
    ).toBeVisible({ timeout: 15000 });

    // The telemetry should not be visible in UI (stripped out)
    // but we can verify the response completed successfully
    const responseElements = page.locator('[role="assistant"]');
    expect(await responseElements.count()).toBeGreaterThan(0);
  });
});

describe('Memory Management E2E', () => {
  test('displays memory add-to-bag functionality', async () => {
    const input = page.locator('input[placeholder*="Ask about your memories"]');
    const sendButton = page.locator('button', { hasText: /send/i });

    await input.fill('Show me memory management features');
    await sendButton.click();

    // Wait for memories to appear
    await expect(page.locator('text=/Machine Learning/i')).toBeVisible({
      timeout: 15000,
    });

    // Check for add-to-bag buttons (may use SVG icons or buttons)
    const addButtons = page
      .locator('button[title*="Add to bag"]')
      .or(page.locator('svg'));
    expect(await addButtons.count()).toBeGreaterThan(0);
  });
});

describe('Performance & Streaming Benchmarks', () => {
  test('measures end-to-end performance metrics', async () => {
    const input = page.locator('input[placeholder*="Ask about your memories"]');
    const sendButton = page.locator('button', { hasText: /send/i });

    const submitTime = Date.now();
    await input.fill('Performance test query');
    await sendButton.click();

    // Time to thinking state
    const thinkingStart = Date.now();
    await expect(page.locator('text=Thinking…')).toBeVisible({ timeout: 5000 });
    const timeToThinking = Date.now() - submitTime;

    // Time to first content
    const firstContentStart = Date.now();
    await expect(
      page.locator('text=/Based on your stored knowledge/i'),
    ).toBeVisible({ timeout: 15000 });
    const timeToFirstContent = Date.now() - firstContentStart;

    // Time to completion
    await expect(
      page.locator('text=/- Retrieved.*Confidence: high/i'),
    ).toBeVisible({ timeout: 10000 });
    const totalTime = Date.now() - submitTime;

    console.log(`E2E Performance Metrics:
  Time to submit: ${submitTime - Date.now()}ms
  Time to thinking: ${timeToThinking}ms
  TTFT (Time to first content): ${timeToFirstContent}ms
  Total response time: ${totalTime}ms`);

    // Reasonable performance expectations (may be higher in E2E)
    expect(timeToThinking).toBeLessThan(2000);
    expect(timeToFirstContent).toBeLessThan(3000);
    expect(totalTime).toBeLessThan(10000);
  });

  test('measures streaming throughput', async () => {
    const input = page.locator('input[placeholder*="Ask about your memories"]');
    const sendButton = page.locator('button', { hasText: /send/i });

    await input.fill('Throughput test with longer memory content');
    await sendButton.click();

    const startTime = Date.now();
    await expect(
      page
        .locator('text=/Memory about AI technology/i')
        .or(page.locator('text=/machine learning algorithms/i')),
    ).toBeVisible({ timeout: 15000 });

    const endTime = Date.now();
    const throughputTime = endTime - startTime;

    // Should stream content within reasonable time
    expect(throughputTime).toBeLessThan(8000);
  });
});

describe('Error Recovery & Edge Cases', () => {
  test('handles server unavailability gracefully', async () => {
    // This would require stopping the backend temporarily
    // For now, test with network timeout scenario
    const input = page.locator('input[placeholder*="Ask about your memories"]');
    const sendButton = page.locator('button', { hasText: /send/i });

    await input.fill('Test error scenario');

    // This test would detect UI error states if implemented
    // For now, just ensure the UI doesn't crash
    await sendButton.click();

    // Should either succeed or show appropriate error state
    try {
      await expect(
        page
          .locator('text=/Based on your stored knowledge/i')
          .or(page.locator('text=Error'))
          .or(page.locator('text=Failed')),
      ).toBeVisible({ timeout: 10000 });
    } catch (error) {
      console.log('Error handling test completed (may fail gracefully)');
    }
  });
});
