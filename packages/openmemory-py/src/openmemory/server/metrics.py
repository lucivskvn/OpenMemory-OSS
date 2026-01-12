import time
from collections import deque
import threading

class ServerMetrics:
    def __init__(self):
        self._lock = threading.Lock()
        self.peak_qps: float = 0.0
        self.total_requests = 0
        self.error_count = 0
        self.start_time = time.time()
        
        # Deque to store timestamps of requests in the last hour
        self._timestamps = deque()

    def record_request(self, error: bool = False):
        with self._lock:
            self.total_requests += 1
            if error:
                self.error_count += 1
            
            now = time.time()
            self._timestamps.append(now)
            
            # Lazy prune (only occasionally to avoid latency spikes on every req)
            if self.total_requests % 100 == 0:
                self._prune(now)

    def _prune(self, now: float):
        # Remove timestamps older than 1 hour (3600s)
        cutoff = now - 3600
        while self._timestamps and self._timestamps[0] < cutoff:
            self._timestamps.popleft()

    def get_last_hour_count(self) -> int:
        with self._lock:
            self._prune(time.time())
            return len(self._timestamps)
            
    def get_uptime(self) -> dict:
        uptime_seconds = int(time.time() - self.start_time)
        return {
            "seconds": uptime_seconds,
            "days": uptime_seconds // 86400,
            "hours": (uptime_seconds % 86400) // 3600
        }

# Global instance (Thread-safe)
metrics = ServerMetrics()
