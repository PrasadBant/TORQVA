"""Min/Max Decimation for TORQVA Time-Series Telemetry.

Downsamples high-frequency telemetry (10 Hz) across large windows (e.g. 3 min / 5 min)
while preserving exact peak extremes (transient spikes) and missing data gaps (nulls).
"""
from __future__ import annotations

import math
from typing import Any, Callable, Dict, List, Optional, Tuple


def decimate_min_max(
    points: List[Any],
    max_points: int = 400,
    time_fn: Optional[Callable[[Any], float]] = None,
    value_fn: Optional[Callable[[Any], Optional[float]]] = None,
) -> List[Any]:
    """Downsample points using min/max decimation.

    Points can be tuples `(t, v)` or dicts `{...}`.
    If len(points) <= max_points, returns points unchanged.
    Preserves None (invalid/gap) markers faithfully so gaps are never hidden.
    """
    if len(points) <= max_points or max_points < 4:
        return list(points)

    if time_fn is None:
        def time_fn(p):
            if isinstance(p, (list, tuple)):
                return float(p[0]) if p[0] is not None else 0.0
            return float(p.get("t", 0.0))

    if value_fn is None:
        def value_fn(p):
            if isinstance(p, (list, tuple)):
                v = p[1]
            else:
                v = p.get("v") if "v" in p else p.get("rpm")
            if v is None:
                return None
            try:
                f = float(v)
                return f if math.isfinite(f) else None
            except (ValueError, TypeError):
                return None

    n_buckets = max_points // 2
    bucket_size = len(points) / n_buckets

    decimated: List[Any] = []

    for b in range(n_buckets):
        start_idx = int(b * bucket_size)
        end_idx = int((b + 1) * bucket_size) if b < n_buckets - 1 else len(points)
        chunk = points[start_idx:end_idx]
        if not chunk:
            continue

        # Check for gap (None value) in chunk
        gap_item = None
        min_item = None
        min_val = float("inf")
        max_item = None
        max_val = float("-inf")

        for item in chunk:
            v = value_fn(item)
            if v is None:
                gap_item = item
            else:
                if v < min_val:
                    min_val = v
                    min_item = item
                if v > max_val:
                    max_val = v
                    max_item = item

        # Emit points in chronological order
        selected = []
        if min_item is not None:
            selected.append(min_item)
        if max_item is not None and max_item is not min_item:
            selected.append(max_item)
        if gap_item is not None and gap_item not in selected:
            selected.append(gap_item)

        # Sort by time
        selected.sort(key=time_fn)
        for s in selected:
            decimated.append(s)

    return decimated
