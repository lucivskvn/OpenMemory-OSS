import ipaddress
import urllib.parse
from typing import Tuple

import asyncio
import socket

async def validate_url(url: str) -> Tuple[bool, str]:
    """
    Validates a URL for SSRF protection.
    Returns (is_valid, error_message).
    
    Blocks:
    - Non-HTTP/HTTPS protocols
    - Private IP ranges (RFC 1918, RFC 4193, RFC 4291)
    - Loopback addresses
    - Link-local addresses
    - Resolves domains to check their IPs
    """
    try:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ["http", "https"]:
            return False, f"Invalid protocol: {parsed.scheme}. Only http and https are allowed."

        hostname = parsed.hostname
        if not hostname:
            return False, "Invalid hostname."

        if not parsed.port and parsed.scheme == "http":
            port = 80
        elif not parsed.port and parsed.scheme == "https":
            port = 443
        else:
            port = parsed.port

        # Resolve hostname asynchronously
        try:
             # Use loop.getaddrinfo to resolve
            loop = asyncio.get_running_loop()
            # This resolves to (family, type, proto, canonname, sockaddr)
            # sockaddr is (address, port) for AF_INET
            infos = await loop.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
            
            for info in infos:
                ip_str = info[4][0]
                ip = ipaddress.ip_address(ip_str)
                if ip.is_private or ip.is_loopback or ip.is_link_local:
                     return False, f"Domain resolved to blocked IP: {hostname} -> {ip_str}"
                     
        except socket.gaierror:
             # DNS failure
             return False, f"DNS resolution failed for {hostname}"

        return True, ""
    except Exception as e:
        return False, f"URL validation error: {str(e)}"
