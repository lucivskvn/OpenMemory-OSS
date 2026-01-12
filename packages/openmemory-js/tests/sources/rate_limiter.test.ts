import { expect, test } from "bun:test";
import { RateLimiter } from "../../src/sources/base";

test("RateLimiter - throttling concurrent requests", async () => {
    const rps = 10;
    const limiter = new RateLimiter(rps); // 10 requests per second = 1 every 100ms
    const start = Date.now();

    // Consume all tokens (10 starting tokens)
    const promises = [];
    for (let i = 0; i < 11; i++) {
        promises.push(limiter.acquire().then(() => Date.now() - start));
    }

    const times = await Promise.all(promises);

    // First 10 should be near 0ms
    for (let i = 0; i < 10; i++) {
        expect(times[i]).toBeLessThan(50);
    }

    // 11th should be near 100ms
    expect(times[10]).toBeGreaterThanOrEqual(95);
    expect(times[10]).toBeLessThan(200);
});

test("RateLimiter - sustained throughput", async () => {
    const rps = 5;
    const limiter = new RateLimiter(rps); // 1 request every 200ms
    const start = Date.now();

    // Request 10 tokens (5 start + 5 more)
    const promises = [];
    for (let i = 0; i < 10; i++) {
        promises.push(limiter.acquire().then(() => Date.now() - start));
    }

    const times = await Promise.all(promises);

    // Last request (10th) should be around 1000ms (5 starting consumed, then 5 generated in ~1000ms)
    // Actually, 5 consume immediately. 6th takes 200ms, 7th 400ms, 10th 1000ms.
    expect(times[9]).toBeGreaterThanOrEqual(950);
    expect(times[9]).toBeLessThan(1200);
});
