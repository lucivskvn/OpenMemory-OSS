/**
* @file Background Task Scheduler for OpenMemory.
* Manages periodic maintenance jobs, handles execution locks, and tracks task health.
*/
import { DistributedLock } from "../utils/lock";
import { now } from "../utils";
import { logger } from "../utils/logger";

/**
 * Registry for background intervals to ensure they can be cleared centrally.
 */
type Timer = ReturnType<typeof setInterval>;

interface TaskStats {
    lastRun: number;
    lastDuration: number;
    totalRuns: number;
    failures: number;
    consecutiveFailures: number;
    lastError?: string;
    running: boolean;
    timeoutMs?: number;
}

const intervals: Map<string, Timer> = new Map();
const intervalStats: Map<string, TaskStats> = new Map();
const callbacks: Map<string, (signal?: AbortSignal) => void | Promise<void>> = new Map();

/**
 * Registers an interval with the maintenance manager.
 * If an interval with the same ID already exists, it is cleared and replaced.
 * Automatically wraps the callback in a try-catch block for resilience.
 * Prevents overlapping executions by tracking the 'running' state.
 * 
 * @param id Unique identifier for the task
 * @param cb Callback function (sync or async)
 * @param ms Interval in milliseconds
 * @param opts Optional configuration (timeout)
 * @returns The task ID
 */
export function registerInterval(
    id: string,
    cb: (signal?: AbortSignal) => void | Promise<void>,
    ms: number,
    opts?: { timeoutMs?: number },
): string {
    if (intervals.has(id)) {
        clearInterval(intervals.get(id));
    }

    callbacks.set(id, cb);
    intervalStats.set(id, {
        lastRun: 0,
        lastDuration: 0,
        totalRuns: 0,
        failures: 0,
        consecutiveFailures: 0,
        running: false,
        timeoutMs: opts?.timeoutMs,
    });

    // Initial Delay Jitter: Spread the start of tasks within +/- 10%
    // to prevent thundering herds on startup
    const jitter = ms * 0.1;
    const initialDelay = Math.random() * jitter;

    setTimeout(() => {
        // Internal wrapper for consistent intervals
        const timer = setInterval(() => {
            void executeTask(id);
        }, ms);

        intervals.set(id, timer);
        // Run once immediately after initial jittered delay
        void executeTask(id);
    }, initialDelay);

    logger.info(`[Scheduler] Registered task '${id}' (interval: ${ms}ms, jitter: ~${Math.round(initialDelay)}ms)`);
    return id;
}

/**
 * Internal executor that handles locking, timing, and error logging.
 */
async function executeTask(id: string) {
    const stats = intervalStats.get(id);
    const cb = callbacks.get(id);
    if (!stats || !cb || stats.running) return;

    // Integrity: Distributed Lock to prevent multi-node contention
    // Use a lock TTL slightly longer than the task timeout
    const taskTimeout = stats.timeoutMs || 300000; // Default 5 minute safety timeout
    const lock = new DistributedLock(`job:${id}`);

    // Attempt to acquire lock. If failed, another instance is running this job.
    if (!(await lock.acquire(taskTimeout + 5000))) {
        // Silent return is acceptable for distributed scheduler
        return;
    }

    const startTime = now();

    try {
        stats.running = true;

        const controller = new AbortController();
        const { signal } = controller;

        // Execute task with timeout protection
        const timeoutId = setTimeout(() => {
            controller.abort(new Error(`Task timeout after ${taskTimeout}ms`));
        }, taskTimeout);

        try {
            // Pass signal to callback if it accepts it
            await cb(signal);
        } finally {
            clearTimeout(timeoutId);
        }

        stats.lastRun = now();
        stats.lastDuration = stats.lastRun - startTime;
        stats.totalRuns++;
        stats.consecutiveFailures = 0;
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        // Don't log as error if it was just an abort/timeout we triggered? 
        // Actually timeout IS an error for us.
        logger.error(`[Scheduler] Task '${id}' failed:`, { error: msg });
        stats.failures++;
        stats.consecutiveFailures++;
        stats.lastError = msg;
    } finally {
        if (stats) stats.running = false;
        // Always release the lock
        await lock.release();
    }
}

/**
 * Manually triggers a maintenance task by ID immediately.
 * Respects the 'running' lock to prevent overlaps.
 * 
 * @param id The ID of the task to trigger
 */
export async function triggerMaintenance(id: string) {
    const stats = intervalStats.get(id);
    if (stats && !stats.running) {
        logger.debug(`[Scheduler] Event-driven trigger for '${id}'`);
        void executeTask(id);
    }
}

/**
 * Unregisters an interval from the manager and clears it.
 * 
 * @param id The ID of the task to unregister
 */
export function unregisterInterval(id: string) {
    if (intervals.has(id)) {
        clearInterval(intervals.get(id));
        intervals.delete(id);
        intervalStats.delete(id);
        callbacks.delete(id);
        logger.info(`[Scheduler] Unregistered task '${id}'`);
    }
}

/**
 * Returns a list of currently active maintenance interval IDs.
 */
export function getRunningIntervals(): string[] {
    return Array.from(intervals.keys());
}

/**
 * Returns status of all maintenance tasks.
 */
export function getMaintenanceStatus(): Record<string, TaskStats> {
    return Object.fromEntries(intervalStats);
}

/**
 * Alias for getMaintenanceStatus to match various naming conventions.
 */
export const getSchedulerStats = getMaintenanceStatus;

/**
 * Checks if a specific maintenance task is currently active.
 * 
 * @param id The ID of the task to check
 */
export function isMaintenanceActive(id: string): boolean {
    return intervals.has(id);
}

/**
 * Stops all background tasks across the entire application.
 * Waits for active tasks to complete up to the specified timeout.
 * 
 * @param timeoutMs Maximum time to wait for running tasks to finish
 */
export const stopAllMaintenance = async (timeoutMs = 5000) => {
    logger.info(`[Scheduler] Stopping all background tasks...`);
    for (const [, timer] of intervals) {
        clearInterval(timer);
    }

    const start = now();
    while (now() - start < timeoutMs) {
        const anyRunning = Array.from(intervalStats.values()).some((s) => s.running);
        if (!anyRunning) break;
        await new Promise((r) => setTimeout(r, 100));
    }

    intervals.clear();
    intervalStats.clear();
    callbacks.clear();
    logger.info(`[Scheduler] All background tasks stopped.`);
};
