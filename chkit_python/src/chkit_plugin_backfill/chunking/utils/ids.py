"""Plan / chunk / token id generation — port of ``chunking/utils/ids.ts``."""

from __future__ import annotations

from chkit_plugin_backfill.state import hash_id, random_plan_id


def generate_plan_id() -> str:
    return random_plan_id()


def generate_chunk_id(plan_id: str, partition_id: str, index: int) -> str:
    return hash_id(f"chunk:{plan_id}:{partition_id}:{index}")[:16]


def generate_idempotency_token(plan_id: str, chunk_id: str) -> str:
    return hash_id(f"token:{plan_id}:{chunk_id}")


__all__ = ["generate_chunk_id", "generate_idempotency_token", "generate_plan_id"]
