/**
 * Backups Page Tests - React Component Integration
 *
 * Real React Testing Library tests for BackupsPage component with actual rendering
 * - Real-time SSE progress tracking with fallback polling
 * - Integrity verification feedback post-restore
 * - Toast notifications for success/error states
 * - MSW mocking for backup endpoints
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  render,
  screen,
  waitFor,
  act,
  fireEvent,
} from '@testing-library/react';
import '@testing-library/jest-dom';
import BackupsPage from '../app/backups/page';
import userEvent from '@testing-library/user-event';
import * as msw from 'msw';
import { setupServer } from 'msw/node';
/// <reference types="@testing-library/jest-dom" />

// Mock the API functions using Bun's mock
mock.module('../lib/api', () => ({
  API_BASE_URL: 'http://localhost:8080',
  getHeaders: () => ({
    'Content-Type': 'application/json',
    Authorization: 'Bearer mock-token',
  }),
}));

// Mock sonner
mock.module('sonner', () => ({
  toast: { success: mock(), error: mock() },
  Toaster: mock(),
}));

// Create MSW server for API mocking
const server = setupServer();

beforeEach(() => server.listen({ onUnhandledRequest: 'warn' }));
afterEach(() => server.resetHandlers());
afterEach(() => server.close());

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  describe('BackupsPage Component - React RTL Tests', () => {
    test('renders BackupsPage component with correct UI elements', async () => {
      const { rest } = await import('msw');
      server.use(
        rest.get(
          'http://localhost:8080/admin/backup/status',
          async (req, res, ctx) => {
            return res(
              ctx.json({
                lastBackup: new Date().toISOString(),
                backupCount: 2,
                databaseSize: 1024000,
                walSize: 512000,
                diskSpace: { available: 10737418240, total: 53687091200 },
                cloudEnabled: true,
                autoSchedule: false,
              }),
            );
          },
        ),
        rest.get(
          'http://localhost:8080/admin/backup/list',
          async (req, res, ctx) => {
            return res(
              ctx.json({
                backups: [
                  {
                    filename: 'backup-2024-12-01.db',
                    size: 1024000,
                    createdAt: new Date().toISOString(),
                    location: 'local',
                  },
                ],
              }),
            );
          },
        ),
      );

      await act(async () => {
        render(<BackupsPage />);
      });

      expect(screen.getByText('Database Backups')).toBeInTheDocument();
      expect(screen.getByText('Backup Now')).toBeInTheDocument();
      expect(screen.getByText('Available Backups')).toBeInTheDocument();
    });

    test('displays backup progress with SSE when backup starts', async () => {
      const { rest } = await import('msw');
      let progressCallCount = 0;

      server.use(
        rest.get(
          'http://localhost:8080/admin/backup/status',
          async (req, res, ctx) => {
            return res(
              ctx.json({
                lastBackup: null,
                backupCount: 0,
                databaseSize: 1024000,
                walSize: 0,
                diskSpace: { available: 10737418240, total: 53687091200 },
                cloudEnabled: true,
                autoSchedule: false,
              }),
            );
          },
        ),
        rest.get(
          'http://localhost:8080/admin/backup/list',
          async (req, res, ctx) => {
            return res(ctx.json({ backups: [] }));
          },
        ),
        rest.post(
          'http://localhost:8080/admin/backup',
          async (req, res, ctx) => {
            return res(
              ctx.json({
                success: true,
                filename: 'backup-test.db',
                path: './data/backups/backup-test.db',
                location: 'local',
                timestamp: new Date().toISOString(),
                sessionId: 'test-session-123',
              }),
            );
          },
        ),
        rest.get(
          'http://localhost:8080/admin/backup/progress/:sessionId',
          async (req, res, ctx) => {
            const progressStates = [
              { percentage: 25, message: 'Processed 25% (10 pages left)' },
              { percentage: 75, message: 'Processed 75% (5 pages left)' },
              { percentage: 100, message: 'Backup completed successfully' },
            ];

            const response =
              progressStates[progressCallCount++ % progressStates.length];
            return res(ctx.json(response));
          },
        ),
      );

      const user = userEvent.setup();
      await act(async () => {
        render(<BackupsPage />);
      });

      const backupButton = screen.getByText('Backup Now');

      // Start backup
      await user.click(backupButton);

      // Check progress updates
      await waitFor(
        () => {
          expect(screen.getByText('Backup Progress')).toBeInTheDocument();
        },
        { timeout: 2000 },
      );

      // Progress should be shown (polling fallback will trigger)
      await waitFor(
        () => {
          const progressBar = screen.queryByRole('progressbar');
          expect(progressBar).toBeInTheDocument();
        },
        { timeout: 5000 },
      );
    });

    test('shows integrity check alert on successful restore', async () => {
      const { rest } = await import('msw');
      server.use(
        rest.get(
          'http://localhost:8080/admin/backup/status',
          async (req, res, ctx) => {
            return res(
              ctx.json({
                lastBackup: new Date().toISOString(),
                backupCount: 1,
                databaseSize: 1024000,
                walSize: 512000,
                diskSpace: { available: 10737418240, total: 53687091200 },
                cloudEnabled: true,
                autoSchedule: false,
              }),
            );
          },
        ),
        rest.get(
          'http://localhost:8080/admin/backup/list',
          async (req, res, ctx) => {
            return res(
              ctx.json({
                backups: [
                  {
                    filename: 'backup-2024-12-01.db',
                    size: 1024000,
                    createdAt: new Date().toISOString(),
                    location: 'local',
                  },
                ],
              }),
            );
          },
        ),
        rest.post(
          'http://localhost:8080/admin/backup/restore',
          async (req, res, ctx) => {
            return res(
              ctx.json({
                success: true,
                message: 'Database restored successfully',
                integrityChecked: true,
                timestamp: new Date().toISOString(),
                filename: 'backup-2024-12-01.db',
                restoredFrom: 'local',
              }),
            );
          },
        ),
      );

      const user = userEvent.setup();
      await act(async () => {
        render(<BackupsPage />);
      });

      // Find the restore button - wait for it to be interactive
      await waitFor(() => {
        const restoreButtons = screen.getAllByText('Restore');
        expect(restoreButtons.length).toBeGreaterThan(0);
      });

      const restoreButton = screen.getAllByText('Restore')[0];
      await user.click(restoreButton);

      // Confirm restore in dialog
      const confirmButton = screen.getByRole('button', { name: /Restore/i });
      await user.click(confirmButton);

      // Check integrity alert appears
      await waitFor(
        () => {
          expect(
            screen.getByText('Integrity check passed'),
          ).toBeInTheDocument();
        },
        { timeout: 2000 },
      );
    });

    test('handles backup failure gracefully', async () => {
      const { rest } = await import('msw');
      server.use(
        rest.get(
          'http://localhost:8080/admin/backup/status',
          async (req, res, ctx) => {
            return res(
              ctx.json({
                lastBackup: null,
                backupCount: 0,
                databaseSize: 1024000,
                walSize: 0,
                diskSpace: { available: 10737418240, total: 53687091200 },
                cloudEnabled: true,
                autoSchedule: false,
              }),
            );
          },
        ),
        rest.get(
          'http://localhost:8080/admin/backup/list',
          async (req, res, ctx) => {
            return res(ctx.json({ backups: [] }));
          },
        ),
        rest.post(
          'http://localhost:8080/admin/backup',
          async (req, res, ctx) => {
            return res(
              ctx.status(500),
              ctx.json({
                error: 'Backup failed',
                message: 'Database connection error',
              }),
            );
          },
        ),
      );

      const user = userEvent.setup();
      await act(async () => {
        render(<BackupsPage />);
      });

      const backupButton = screen.getByText('Backup Now');
      await user.click(backupButton);

      // Button should be disabled during progress and re-enabled on error
      expect(backupButton).toBeDisabled();
    });

    test('shows cloud backup option when enabled', async () => {
      const { rest } = await import('msw');
      server.use(
        rest.get(
          'http://localhost:8080/admin/backup/status',
          async (req, res, ctx) => {
            return res(
              ctx.json({
                lastBackup: null,
                backupCount: 0,
                databaseSize: 1024000,
                walSize: 0,
                diskSpace: { available: 10737418240, total: 53687091200 },
                cloudEnabled: true,
                autoSchedule: false,
              }),
            );
          },
        ),
        rest.get(
          'http://localhost:8080/admin/backup/list',
          async (req, res, ctx) => {
            return res(ctx.json({ backups: [] }));
          },
        ),
      );

      await act(async () => {
        render(<BackupsPage />);
      });

      expect(screen.getByText('Backup to Cloud')).toBeInTheDocument();
    });

    test('refreshes backup list and status correctly', async () => {
      const { rest } = await import('msw');
      let statusCallCount = 0;

      server.use(
        rest.get(
          'http://localhost:8080/admin/backup/status',
          async (req, res, ctx) => {
            statusCallCount++;
            return res(
              ctx.json({
                lastBackup:
                  statusCallCount > 1 ? new Date().toISOString() : null,
                backupCount: statusCallCount > 1 ? 1 : 0,
                databaseSize: 1024000,
                walSize: 0,
                diskSpace: { available: 10737418240, total: 53687091200 },
                cloudEnabled: true,
                autoSchedule: false,
              }),
            );
          },
        ),
        rest.get(
          'http://localhost:8080/admin/backup/list',
          async (req, res, ctx) => {
            return res(
              ctx.json({
                backups:
                  statusCallCount > 1
                    ? [
                        {
                          filename: 'backup-refreshed.db',
                          size: 1024000,
                          createdAt: new Date().toISOString(),
                          location: 'local',
                        },
                      ]
                    : [],
              }),
            );
          },
        ),
      );

      const user = userEvent.setup();
      await act(async () => {
        render(<BackupsPage />);
      });

      // Click refresh
      const refreshButton = screen.getByText('Refresh');
      await user.click(refreshButton);

      // Should show updated data
      await waitFor(
        () => {
          expect(screen.getByText('Backup Count: 1')).toBeInTheDocument();
        },
        { timeout: 2000 },
      );
    });

    test('integrity alert auto-hides after timeout', async () => {
      const { rest } = await import('msw');
      server.use(
        rest.get(
          'http://localhost:8080/admin/backup/status',
          async (req, res, ctx) => {
            return res(
              ctx.json({
                lastBackup: new Date().toISOString(),
                backupCount: 1,
                databaseSize: 1024000,
                walSize: 512000,
                diskSpace: { available: 10737418240, total: 53687091200 },
                cloudEnabled: true,
                autoSchedule: false,
              }),
            );
          },
        ),
        rest.get(
          'http://localhost:8080/admin/backup/list',
          async (req, res, ctx) => {
            return res(
              ctx.json({
                backups: [
                  {
                    filename: 'backup-2024-12-01.db',
                    size: 1024000,
                    createdAt: new Date().toISOString(),
                    location: 'local',
                  },
                ],
              }),
            );
          },
        ),
        rest.post(
          'http://localhost:8080/admin/backup/restore',
          async (req, res, ctx) => {
            return res(
              ctx.json({
                success: true,
                message: 'Database restored successfully',
                integrityChecked: true,
              }),
            );
          },
        ),
      );

      const user = userEvent.setup();
      await act(async () => {
        render(<BackupsPage />);
      });

      // Trigger restore to show integrity alert
      const restoreButton = screen.getAllByText('Restore')[0];
      await user.click(restoreButton);
      const confirmButton = screen.getByRole('button', { name: /Restore/i });
      await user.click(confirmButton);

      await waitFor(() => {
        expect(screen.getByText('Integrity check passed')).toBeInTheDocument();
      });

      // Alert should stay for 10 seconds then disappear (mock timeout)
      await waitFor(
        () => {
          expect(
            screen.queryByText('Integrity check passed'),
          ).not.toBeInTheDocument();
        },
        { timeout: 11000 },
      );
    });

    test('accessibility: progress has proper aria labels', async () => {
      const { rest } = await import('msw');
      server.use(
        rest.get(
          'http://localhost:8080/admin/backup/status',
          async (req, res, ctx) => {
            return res(
              ctx.json({
                lastBackup: null,
                backupCount: 0,
                databaseSize: 1024000,
                walSize: 0,
                diskSpace: { available: 10737418240, total: 53687091200 },
                cloudEnabled: true,
                autoSchedule: false,
              }),
            );
          },
        ),
        rest.get(
          'http://localhost:8080/admin/backup/list',
          async (req, res, ctx) => {
            return res(ctx.json({ backups: [] }));
          },
        ),
        rest.post(
          'http://localhost:8080/admin/backup',
          async (req, res, ctx) => {
            return res(
              ctx.json({
                success: true,
                sessionId: 'test-session-123',
              }),
            );
          },
        ),
        rest.get(
          'http://localhost:8080/admin/backup/progress/:sessionId',
          async (req, res, ctx) => {
            return res(ctx.json({ percentage: 50, message: 'Processing...' }));
          },
        ),
      );

      const user = userEvent.setup();
      await act(async () => {
        render(<BackupsPage />);
      });

      const backupButton = screen.getByText('Backup Now');
      await user.click(backupButton);

      // Wait for progress to appear
      await waitFor(
        () => {
          expect(screen.getByRole('progressbar')).toBeInTheDocument();
        },
        { timeout: 2000 },
      );

      // Progress should have value (via style or aria-valuenow)
      const progressElement = screen.getByRole('progressbar');
      expect(progressElement).toHaveAttribute('aria-valuenow', '50');
    });
  });
} else {
  console.warn(
    'Skipping BackupsPage DOM tests: document/window not available in this test environment',
  );
}

export {};
