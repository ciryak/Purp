"""
infrastructure/cache.py
Thread-safe TTL cache replacing the manual threading.Lock pattern from services.py.
Dict reads are atomic in CPython; lock is held only on writes to prevent torn updates.
"""
import time
import threading
from typing import Any


class TTLCache:
    def __init__(self, ttl: int = 60):
        self._store: dict[str, tuple[Any, float, int]] = {}
        self._lock = threading.Lock()
        self.ttl = ttl

    def get(self, key: str) -> Any | None:
        entry = self._store.get(key)
        if not entry:
            return None
        value, stored_at, ttl_used = entry
        if time.time() - stored_at >= ttl_used:
            return None
        return value

    def set(self, key: str, value: Any, ttl_override: int | None = None) -> None:
        effective_ttl = ttl_override if ttl_override is not None else self.ttl
        with self._lock:
            self._store[key] = (value, time.time(), effective_ttl)

    def invalidate(self, key: str) -> None:
        with self._lock:
            self._store.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._store.clear()


# Singleton used throughout the application
price_cache = TTLCache(ttl=15)
