# Sentinel's Journal - CRITICAL SECURITY LEARNINGS

## 2025-02-14 - Server-Side Request Forgery (SSRF) in ExtractURL and Web Crawler
**Vulnerability:** The `extractURL` and `web_crawler_source` functions fetched arbitrary user-supplied URLs without any validation of their destination. This allowed potential SSRF attacks, enabling users/attackers to hit internal/loopback ports, local subnets (RFC 1918), and cloud metadata endpoints (e.g. 169.254.169.254).
**Learning:** Raw fetches to user-controlled URLs present a severe SSRF risk, especially in microservice/agentic architectures where the agent has access to private network resources. DNS rebinding and multi-A-record responses must be resolved and checked comprehensively.
**Prevention:** Always validate protocol (strictly `http:` and `https:`) and resolve user-controlled URLs to their final IP addresses. Verify that neither the input domain/IP nor any of the DNS-resolved IP addresses belong to loopback, private, link-local, or multicast address ranges, failing closed on any errors.
