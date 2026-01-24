/**
 * @file Security Middleware for API Endpoints
 * Provides comprehensive security validation and protection
 */

import { Elysia } from "elysia";
import { SecurityError } from "../../core/security";
import { AppError } from "../errors";
import { logger } from "../../utils/logger";
import { sanitizeString, detectSuspiciousActivity } from "../../utils/inputSanitization";

/**
 * Security configuration
 */
const SECURITY_CONFIG = {
    maxRequestSize: 10 * 1024 * 1024, // 10MB
    maxHeaderSize: 8192, // 8KB
    maxUrlLength: 2048,
    maxQueryParams: 50,
    rateLimitWindow: 60 * 1000, // 1 minute
    rateLimitMax: 100, // requests per window
    suspiciousActivityThreshold: 5, // suspicious requests before blocking
};

/**
 * Request tracking for rate limiting and suspicious activity detection
 */
const requestTracker = new Map<string, {
    count: number;
    suspiciousCount: number;
    firstRequest: number;
    lastRequest: number;
}>();

/**
 * Clean up old request tracking data
 */
function cleanupRequestTracker() {
    const now = Date.now();
    const cutoff = now - SECURITY_CONFIG.rateLimitWindow;
    
    for (const [key, data] of requestTracker.entries()) {
        if (data.lastRequest < cutoff) {
            requestTracker.delete(key);
        }
    }
}

/**
 * Get client identifier for rate limiting
 */
function getClientId(request: Request): string {
    // Try to get real IP from headers
    const forwardedFor = request.headers.get('x-forwarded-for');
    const realIp = request.headers.get('x-real-ip');
    const cfConnectingIp = request.headers.get('cf-connecting-ip');
    
    const ip = forwardedFor?.split(',')[0]?.trim() || 
               realIp || 
               cfConnectingIp || 
               'unknown';
    
    // Include user agent for better tracking
    const userAgent = request.headers.get('user-agent') || 'unknown';
    const hash = Buffer.from(`${ip}:${userAgent}`).toString('base64').slice(0, 16);
    
    return hash;
}

/**
 * Check rate limiting for a client
 */
function checkRateLimit(clientId: string): boolean {
    const now = Date.now();
    const data = requestTracker.get(clientId);
    
    if (!data) {
        requestTracker.set(clientId, {
            count: 1,
            suspiciousCount: 0,
            firstRequest: now,
            lastRequest: now,
        });
        return true;
    }
    
    // Reset counter if window has passed
    if (now - data.firstRequest > SECURITY_CONFIG.rateLimitWindow) {
        data.count = 1;
        data.firstRequest = now;
        data.lastRequest = now;
        return true;
    }
    
    data.count++;
    data.lastRequest = now;
    
    return data.count <= SECURITY_CONFIG.rateLimitMax;
}

/**
 * Track suspicious activity
 */
function trackSuspiciousActivity(clientId: string): boolean {
    const data = requestTracker.get(clientId);
    if (!data) return false;
    
    data.suspiciousCount++;
    
    return data.suspiciousCount >= SECURITY_CONFIG.suspiciousActivityThreshold;
}

/**
 * Validate request headers for security issues
 */
function validateHeaders(request: Request): void {
    const headers = request.headers;
    
    // Check for oversized headers
    let totalHeaderSize = 0;
    headers.forEach((value, key) => {
        totalHeaderSize += key.length + value.length;
    });
    
    if (totalHeaderSize > SECURITY_CONFIG.maxHeaderSize) {
        throw new SecurityError("Request headers too large");
    }
    
    // Check for suspicious header values
    headers.forEach((value, key) => {
        if (detectSuspiciousActivity(value) || detectSuspiciousActivity(key)) {
            throw new SecurityError("Suspicious header content detected");
        }
    });
    
    // Validate specific security headers
    const contentType = headers.get('content-type');
    if (contentType && contentType.includes('multipart/form-data')) {
        // Additional validation for file uploads could go here
        logger.debug("[Security] File upload detected", { contentType });
    }
}

/**
 * Validate request URL and query parameters
 */
function validateUrl(request: Request): void {
    const url = new URL(request.url);
    
    // Check URL length
    if (url.href.length > SECURITY_CONFIG.maxUrlLength) {
        throw new SecurityError("Request URL too long");
    }
    
    // Check query parameter count
    const paramCount = Array.from(url.searchParams.keys()).length;
    if (paramCount > SECURITY_CONFIG.maxQueryParams) {
        throw new SecurityError("Too many query parameters");
    }
    
    // Validate query parameter values
    url.searchParams.forEach((value, key) => {
        try {
            sanitizeString(key, { maxLength: 255 });
            sanitizeString(value, { maxLength: 2048 });
        } catch (error) {
            throw new SecurityError(`Invalid query parameter: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
        
        if (detectSuspiciousActivity(value) || detectSuspiciousActivity(key)) {
            throw new SecurityError("Suspicious query parameter detected");
        }
    });
}

/**
 * Security middleware plugin for Elysia
 */
export const securityMiddleware = (app: Elysia) => app
    .onRequest(({ request, set }) => {
        try {
            // Clean up old tracking data periodically
            if (Math.random() < 0.01) { // 1% chance
                cleanupRequestTracker();
            }
            
            const clientId = getClientId(request);
            
            // Rate limiting check
            if (!checkRateLimit(clientId)) {
                logger.warn("[Security] Rate limit exceeded", { clientId });
                set.status = 429;
                throw new AppError(429, "RATE_LIMIT_EXCEEDED", "Too many requests");
            }
            
            // Validate headers
            validateHeaders(request);
            
            // Validate URL and query parameters
            validateUrl(request);
            
            // Check for suspicious patterns in URL
            if (detectSuspiciousActivity(request.url)) {
                trackSuspiciousActivity(clientId);
                logger.warn("[Security] Suspicious URL pattern detected", { 
                    clientId, 
                    url: request.url.slice(0, 200) // Log first 200 chars only
                });
                
                if (trackSuspiciousActivity(clientId)) {
                    logger.error("[Security] Client blocked due to suspicious activity", { clientId });
                    set.status = 403;
                    throw new AppError(403, "SUSPICIOUS_ACTIVITY", "Suspicious activity detected");
                }
            }
            
        } catch (error) {
            if (error instanceof SecurityError) {
                logger.warn("[Security] Security validation failed", { 
                    error: error.message,
                    url: request.url.slice(0, 200)
                });
                set.status = 400;
                throw new AppError(400, "SECURITY_VALIDATION_FAILED", error.message);
            }
            throw error;
        }
    })
    .onError(({ error, set }) => {
        if (error instanceof SecurityError) {
            logger.error("[Security] Security error", { error: error.message });
            set.status = 400;
            return {
                error: "Security validation failed",
                message: error.message,
                code: "SECURITY_ERROR"
            };
        }
    });

/**
 * Enhanced security middleware with additional protections
 */
export const enhancedSecurityMiddleware = (app: Elysia) => app
    .use(securityMiddleware)
    .derive(({ request }) => {
        // Add security context to request
        const clientId = getClientId(request);
        const securityContext = {
            clientId,
            timestamp: Date.now(),
            userAgent: request.headers.get('user-agent') || 'unknown',
            ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 
                request.headers.get('x-real-ip') || 
                'unknown'
        };
        
        return { securityContext };
    });

/**
 * Get current security statistics
 */
export function getSecurityStats() {
    const now = Date.now();
    const activeClients = Array.from(requestTracker.entries())
        .filter(([_, data]) => now - data.lastRequest < SECURITY_CONFIG.rateLimitWindow)
        .length;
    
    const suspiciousClients = Array.from(requestTracker.values())
        .filter(data => data.suspiciousCount > 0)
        .length;
    
    const totalRequests = Array.from(requestTracker.values())
        .reduce((sum, data) => sum + data.count, 0);
    
    return {
        activeClients,
        suspiciousClients,
        totalRequests,
        rateLimitWindow: SECURITY_CONFIG.rateLimitWindow,
        rateLimitMax: SECURITY_CONFIG.rateLimitMax,
    };
}

/**
 * Reset security tracking (for testing or maintenance)
 */
export function resetSecurityTracking() {
    requestTracker.clear();
    logger.info("[Security] Security tracking reset");
}