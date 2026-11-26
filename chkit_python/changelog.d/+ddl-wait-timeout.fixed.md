`migrate` waits up to 30 seconds for DDL on every replica and repeats an unfinished propagation wait on resume; stalled requests stop at the deadline, programming errors fail immediately, and a timed-out column wait preserves the definition mismatch and releases its session.

- Breaking: a propagation timeout now fails the migration instead of warning and recording it as applied.
