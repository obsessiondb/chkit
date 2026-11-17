When `chkit migrate` times out waiting for a column change to apply, its next request, such as
releasing the migrate lock, no longer fails with "Attempt to execute concurrent queries within the same
session".
