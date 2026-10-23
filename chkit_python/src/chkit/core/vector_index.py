"""Vector similarity index rendering and parsing, in parity with TS ``vector-index.ts``."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from chkit.core.model import SkipIndexVectorSimilarity

VECTOR_INDEX_GRANULARITY = 100_000_000

# Accepted values, from MergeTreeIndexVectorSimilarity.cpp (ClickHouse 26.8).
METHODS = ("hnsw",)
DISTANCE_FUNCTIONS = ("L2Distance", "cosineDistance", "dotProduct")
QUANTIZATIONS = ("f64", "f32", "f16", "bf16", "i8", "b1")
_TUNING_FIELDS = (
    ("quantization", "quantization"),
    ("hnsw_max_connections_per_layer", "hnswMaxConnectionsPerLayer"),
    ("hnsw_candidate_list_size_for_construction", "hnswCandidateListSizeForConstruction"),
)
_MAX_SAFE_INTEGER = 2**53 - 1
_STRING_ARG = re.compile(r"^'([^'\\]*)'$")
_INTEGER_ARG = re.compile(r"^\d+$")


def render_vector_index_type(index: SkipIndexVectorSimilarity) -> str:
    """Render ``vector_similarity(...)``, raising ``ValueError`` on rejected arguments."""
    problem = vector_index_problem(index)
    if problem is not None:
        raise ValueError(problem)
    args = [f"'{index.method}'", f"'{index.distance_function}'"]
    if index.dimensions is not None:
        args.append(str(index.dimensions))
    if index.quantization is not None:
        args += [
            f"'{index.quantization}'",
            str(index.hnsw_max_connections_per_layer),
            str(index.hnsw_candidate_list_size_for_construction),
        ]
    return f"vector_similarity({', '.join(args)})"


def parse_vector_index_args(args: str) -> dict[str, object] | None:
    """Parse ``type_full`` arguments into model fields (aliases), or None to keep it raw."""
    parts = [part.strip() for part in args.split(",")]
    if len(parts) not in (2, 3, 5, 6):
        return None
    strings = [m.group(1) if (m := _STRING_ARG.match(part)) else None for part in parts]
    integers = [int(part) if _INTEGER_ARG.match(part) else None for part in parts]
    method, distance = strings[0], strings[1]
    if method not in METHODS or distance not in DISTANCE_FUNCTIONS:
        return None
    params: dict[str, object] = {"method": method, "distanceFunction": distance}
    has_dimensions = len(parts) in (3, 6)
    if has_dimensions:
        if integers[2] is None:
            return None
        params["dimensions"] = integers[2]
    tuning_at = 3 if has_dimensions else 2
    if len(parts) > tuning_at:
        quantization = strings[tuning_at]
        connections = integers[tuning_at + 1]
        candidates = integers[tuning_at + 2]
        if quantization not in QUANTIZATIONS or connections is None or candidates is None:
            return None
        params["quantization"] = quantization
        params["hnswMaxConnectionsPerLayer"] = connections
        params["hnswCandidateListSizeForConstruction"] = candidates
    return params if _problem(params) is None else None


def vector_index_problem(index: SkipIndexVectorSimilarity) -> str | None:
    """Why ClickHouse would reject the index, or None when it is valid."""
    return _problem(
        {
            "method": index.method,
            "distanceFunction": index.distance_function,
            "dimensions": index.dimensions,
            "quantization": index.quantization,
            "hnswMaxConnectionsPerLayer": index.hnsw_max_connections_per_layer,
            "hnswCandidateListSizeForConstruction": (
                index.hnsw_candidate_list_size_for_construction
            ),
            "granularity": index.granularity,
        }
    )


def _problem(params: dict[str, object]) -> str | None:  # noqa: PLR0911
    if params.get("method") not in METHODS:
        return f"method must be one of {', '.join(METHODS)}"
    distance = params.get("distanceFunction")
    if distance not in DISTANCE_FUNCTIONS:
        return f"distanceFunction must be one of {', '.join(DISTANCE_FUNCTIONS)}"
    dimensions = params.get("dimensions")
    if dimensions is not None and not _is_positive_integer(dimensions):
        return "dimensions must be a positive integer"
    set_fields = [alias for _, alias in _TUNING_FIELDS if params.get(alias) is not None]
    if 0 < len(set_fields) < len(_TUNING_FIELDS):
        names = ", ".join(alias for _, alias in _TUNING_FIELDS)
        return f"{names} are positional arguments: set all three or none"
    quantization = params.get("quantization")
    if quantization is not None:
        problem = _tuning_problem(params, quantization, distance, dimensions)
        if problem is not None:
            return problem
    granularity = params.get("granularity")
    if granularity is not None and not _is_positive_integer(granularity):
        return "granularity must be a positive integer"
    return None


def _tuning_problem(
    params: dict[str, object], quantization: object, distance: object, dimensions: object
) -> str | None:
    if quantization not in QUANTIZATIONS:
        return f"quantization must be one of {', '.join(QUANTIZATIONS)}"
    connections = params.get("hnswMaxConnectionsPerLayer")
    if not _is_non_negative_integer(connections) or connections == 1:
        return "hnswMaxConnectionsPerLayer must be 0 (library default) or an integer of at least 2"
    if not _is_non_negative_integer(params.get("hnswCandidateListSizeForConstruction")):
        return "hnswCandidateListSizeForConstruction must be a non-negative integer"
    if quantization == "b1":
        if distance != "cosineDistance":
            return "quantization 'b1' requires distanceFunction 'cosineDistance'"
        if isinstance(dimensions, int) and dimensions % 8 != 0:
            return "quantization 'b1' requires dimensions to be a multiple of 8"
    return None


def _is_positive_integer(value: object) -> bool:
    return type(value) is int and 0 < value <= _MAX_SAFE_INTEGER


def _is_non_negative_integer(value: object) -> bool:
    return type(value) is int and 0 <= value <= _MAX_SAFE_INTEGER
