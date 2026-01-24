/**
 * @file Enhanced PII Detection and Scrubbing
 * Provides comprehensive detection and scrubbing of Personally Identifiable Information (PII)
 * and sensitive data across various formats and contexts.
 */

/**
 * PII Categories and Patterns
 */
export interface PIIPattern {
    name: string;
    pattern: RegExp;
    replacement: string;
    category: PIICategory;
    confidence: number; // 0-1, how confident we are this is PII
}

export enum PIICategory {
    FINANCIAL = "financial",
    PERSONAL = "personal", 
    AUTHENTICATION = "authentication",
    CONTACT = "contact",
    GOVERNMENT = "government",
    MEDICAL = "medical",
    TECHNICAL = "technical",
}

/**
 * Comprehensive PII patterns with confidence scores
 */
export const PII_PATTERNS: PIIPattern[] = [
    // Financial Information
    {
        name: "credit_card",
        pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3[0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
        replacement: "[CREDIT_CARD]",
        category: PIICategory.FINANCIAL,
        confidence: 0.95,
    },
    {
        name: "bank_account",
        pattern: /\b\d{8,17}\b/g, // Bank account numbers (8-17 digits)
        replacement: "[BANK_ACCOUNT]",
        category: PIICategory.FINANCIAL,
        confidence: 0.7,
    },
    {
        name: "routing_number",
        pattern: /\b[0-9]{9}\b/g, // US routing numbers
        replacement: "[ROUTING_NUMBER]",
        category: PIICategory.FINANCIAL,
        confidence: 0.8,
    },

    // Personal Information
    {
        name: "ssn",
        pattern: /\b(?:\d{3}-?\d{2}-?\d{4})\b/g,
        replacement: "[SSN]",
        category: PIICategory.GOVERNMENT,
        confidence: 0.9,
    },
    {
        name: "email",
        pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
        r