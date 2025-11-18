"""Resource monitoring for test suite to identify exhaustion points."""

import asyncio
import logging
import os
import psutil
from datetime import datetime
from typing import Dict, Optional

logger = logging.getLogger(__name__)


class ResourceMonitor:
    """Monitor system and application resources during test execution."""

    def __init__(self):
        self.process = psutil.Process(os.getpid())
        self.baseline: Optional[Dict] = None

    def get_stats(self) -> Dict:
        """Get current resource statistics."""
        try:
            # Process-level stats
            mem_info = self.process.memory_info()
            connections = self.process.net_connections(kind='inet')
            open_files = len(self.process.open_files())
            threads = self.process.num_threads()

            # System-level stats
            cpu_percent = self.process.cpu_percent()

            stats = {
                'timestamp': datetime.now().isoformat(),
                'memory_rss_mb': mem_info.rss / 1024 / 1024,
                'memory_vms_mb': mem_info.vms / 1024 / 1024,
                'open_connections': len(connections),
                'established_connections': len([c for c in connections if c.status == 'ESTABLISHED']),
                'time_wait_connections': len([c for c in connections if c.status == 'TIME_WAIT']),
                'close_wait_connections': len([c for c in connections if c.status == 'CLOSE_WAIT']),
                'open_files': open_files,
                'threads': threads,
                'cpu_percent': cpu_percent,
            }

            # Add delta from baseline if available
            if self.baseline:
                stats['delta_connections'] = stats['open_connections'] - self.baseline['open_connections']
                stats['delta_files'] = stats['open_files'] - self.baseline['open_files']
                stats['delta_memory_mb'] = stats['memory_rss_mb'] - self.baseline['memory_rss_mb']

            return stats
        except (psutil.NoSuchProcess, psutil.AccessDenied) as e:
            logger.warning(f"Failed to get process stats: {e}")
            return {}

    def set_baseline(self):
        """Set baseline stats for comparison."""
        self.baseline = self.get_stats()
        logger.info(f"Baseline set: {self.format_stats(self.baseline)}")

    def format_stats(self, stats: Dict) -> str:
        """Format stats for logging."""
        if not stats:
            return "No stats available"

        parts = [
            f"mem={stats.get('memory_rss_mb', 0):.1f}MB",
            f"conn={stats.get('open_connections', 0)}",
            f"est={stats.get('established_connections', 0)}",
            f"tw={stats.get('time_wait_connections', 0)}",
            f"files={stats.get('open_files', 0)}",
            f"threads={stats.get('threads', 0)}",
        ]

        if 'delta_connections' in stats:
            parts.append(f"Δconn={stats['delta_connections']:+d}")
        if 'delta_memory_mb' in stats:
            parts.append(f"Δmem={stats['delta_memory_mb']:+.1f}MB")

        return ' '.join(parts)

    def check_thresholds(self, stats: Dict) -> Dict[str, str]:
        """Check if any resource exceeds warning thresholds."""
        warnings = {}

        if stats.get('open_connections', 0) > 200:
            warnings['connections'] = f"High connection count: {stats['open_connections']}"

        if stats.get('close_wait_connections', 0) > 50:
            warnings['close_wait'] = f"Many CLOSE_WAIT connections: {stats['close_wait_connections']}"

        if stats.get('time_wait_connections', 0) > 100:
            warnings['time_wait'] = f"Many TIME_WAIT connections: {stats['time_wait_connections']}"

        if stats.get('open_files', 0) > 500:
            warnings['files'] = f"Many open files: {stats['open_files']}"

        if stats.get('memory_rss_mb', 0) > 1000:
            warnings['memory'] = f"High memory usage: {stats['memory_rss_mb']:.1f}MB"

        if self.baseline and stats.get('delta_connections', 0) > 50:
            warnings['connection_leak'] = f"Connection leak detected: +{stats['delta_connections']} since baseline"

        return warnings


async def get_aiohttp_connector_stats() -> Dict:
    """Get aiohttp connector pool statistics from active clients."""
    # This requires accessing the AsyncGameClient instances
    # We'll need to track them globally or pass them in
    stats = {
        'note': 'aiohttp connector stats require client tracking',
    }
    return stats


async def get_postgres_connection_stats() -> Dict:
    """Get PostgreSQL connection pool statistics."""
    try:
        from utils.supabase_client import AsyncGameClient

        # Create temporary client to query DB stats
        client = AsyncGameClient(
            base_url=os.environ.get('SUPABASE_URL', 'http://127.0.0.1:54321'),
            character_id='resource_monitor'
        )

        try:
            # Query pg_stat_activity via REST API
            result = await client._request('admin.query_pg_stat_activity', {})

            if result and 'connections' in result:
                return {
                    'total_connections': len(result['connections']),
                    'active_connections': len([c for c in result['connections'] if c.get('state') == 'active']),
                    'idle_connections': len([c for c in result['connections'] if c.get('state') == 'idle']),
                    'idle_in_transaction': len([c for c in result['connections'] if c.get('state') == 'idle in transaction']),
                }
        finally:
            await client.close()

    except Exception as e:
        logger.debug(f"Failed to get postgres stats: {e}")

    return {}


def log_resource_summary(monitor: ResourceMonitor, prefix: str = ""):
    """Log a summary of current resource usage."""
    stats = monitor.get_stats()
    formatted = monitor.format_stats(stats)

    warnings = monitor.check_thresholds(stats)
    if warnings:
        logger.warning(f"{prefix}Resource warnings: {formatted}")
        for key, msg in warnings.items():
            logger.warning(f"  - {msg}")
    else:
        logger.info(f"{prefix}{formatted}")


# Global monitor instance for test suite
_global_monitor: Optional[ResourceMonitor] = None


def get_monitor() -> ResourceMonitor:
    """Get or create the global resource monitor."""
    global _global_monitor
    if _global_monitor is None:
        _global_monitor = ResourceMonitor()
    return _global_monitor
