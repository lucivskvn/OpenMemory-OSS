import { trace, propagation } from "@opentelemetry/api";

/**
 * Enhanced fetch with OpenTelemetry trace context propagation.
 */
export async function fetchWithTrace(
    url: string | URL | Request,
    init?: RequestInit
): Promise<Response> {
    const headers = new Headers(init?.headers);

    // Inject current trace context into headers
    propagation.inject(trace.getActiveSpan()?.spanContext() ? trace.setSpanContext(propagation.active(), trace.getActiveSpan()!.spanContext()) : propagation.active(), headers, {
        set: (h, k, v) => h.set(k, v)
    });

    return fetch(url, {
        ...init,
        headers
    });
}
