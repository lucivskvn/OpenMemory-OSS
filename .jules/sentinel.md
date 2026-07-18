# Sentinel's Journal - CRITICAL SECURITY LEARNINGS

## 2025-02-14 - Server-Side Request Forgery (SSRF) in ExtractURL and Web Crawler
**Vulnerability:** The `extractURL` and `web_crawler_source` functions fetched arbitrary user-supplied URLs without any validation of their destination. This allowed potential SSRF attacks, enabling users/attackers to hit internal/loopback ports, local subnets (RFC 1918), and cloud metadata endpoints (e.g. 169.254.169.254).
**Learning:** Raw fetches to user-controlled URLs present a severe SSRF risk, especially in microservice/agentic architectures where the agent has access to private network resources. DNS rebinding and multi-A-record responses must be resolved and checked comprehensively.
**Prevention:** Always validate protocol (strictly `http:` and `https:`) and resolve user-controlled URLs to their final IP addresses. Verify that neither the input domain/IP nor any of the DNS-resolved IP addresses belong to loopback, private, link-local, or multicast address ranges, failing closed on any errors.

## 2025-02-14 - IPv6 Subnet Parsing Gaps in SSRF Protection
**Vulnerability:** Simple string-based prefix checking (e.g., `.startsWith("fd00:")` or `.startsWith("fc00:")`) to identify private IPv6 unique local addresses (ULA) can be bypassed. For instance, a private ULA starting with `fd12:` will not match a simple `fd00:` check.
**Learning:** IPv6 subnets are designated by bitmasks (e.g., `fc00::/7`, `fe80::/10`, `ff00::/8`). Checking them requires parsing the first block as a hex integer and verifying that the numeric value falls within the proper boundaries.
**Prevention:** To validate IPv6 private subnets accurately:
- `fc00::/7` (ULA): verify the first group is between `0xfc00` and `0xfdff`.
- `fe80::/10` (Link-local): verify the first group is between `0xfe80` and `0xfebf`.
- `ff00::/8` (Multicast): verify the first group is between `0xff00` and `0xffff`.

## 2025-02-14 - Timing Attack and Key Length Leaks in API Key Verification
**Vulnerability:** Standard comparisons (e.g., `provided.length === expected.length` followed by comparing the actual strings) leak key length information through the early length-mismatch exit, making the system vulnerable to timing side-channel attacks.
**Learning:** Constant-time comparison is necessary to prevent timing attacks. However, simply using `crypto.timingSafeEqual` directly can throw on different-length inputs, tempting developers to use unsafe length guards.
**Prevention:** Hash both inputs using a cryptographically secure hash function (e.g., SHA-256) first. Since the digests are always identical in length, they can be compared using `crypto.timingSafeEqual` safely without any pre-comparison length guards, eliminating both length leakage and timing side-channels.
