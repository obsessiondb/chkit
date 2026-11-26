from pathlib import Path

from chkit.cli.safety_markers import extract_migration_operation_summaries
from chkit.core.sql_lexer import SQLToken, is_trivia, tokenize_sql
from chkit.core.sql_splitter import extract_executable_statements

_ADVICE = (
    "Data copies should usually run as resumable backfill jobs; "
    "small copies in migrations are acceptable."
)


def collect_data_copy_warnings(
    sql: str, source: str, operation_type: str | None = None, operation_mode: str | None = None
) -> list[str]:
    operations = extract_migration_operation_summaries(
        "\n".join(token.text for token in tokenize_sql(sql) if token.kind == "line_comment")
    )
    warnings = []
    for index, statement in enumerate(extract_executable_statements(sql)):
        tokens = _query_tokens(statement)
        depth = 0
        words = []
        for token in tokens:
            if token.kind == "punctuation" and token.text == "(":
                depth += 1
            elif token.kind == "punctuation" and token.text == ")":
                depth -= 1
            elif depth == 0 and token.kind == "identifier":
                words.append(token.text.upper())
        if not words or words[0] not in ("INSERT", "SELECT", "WITH", "FROM"):
            continue
        insert = "INSERT" in words
        select = "SELECT" in words
        kind = operation_type or (operations[index].type if index < len(operations) else None)
        mode = operation_mode or (operations[index].mode if index < len(operations) else None)
        barrier = mode == "barrier" and select and "INTO" not in words and "PARALLEL" not in words
        guard = _is_guard(tokens) and not any(
            word in words for word in ("INTO", "PARALLEL", "UNION", "EXCEPT", "INTERSECT")
        )
        if not insert and (
            kind == "assert_backfill"
            or barrier
            or guard
            or not select
            or ("FROM" not in words and "INTO" not in words)
        ):
            continue
        warnings.append(f"{source}, statement {index + 1}: {_ADVICE}")
    return warnings


def collect_migration_data_copy_warnings(
    migrations_dir: Path, files: list[str] | None = None
) -> list[str]:
    names = (
        files if files is not None else sorted(path.name for path in migrations_dir.glob("*.sql"))
    )
    return [
        warning
        for name in names
        for warning in collect_data_copy_warnings((migrations_dir / name).read_text(), name)
    ]


def _query_tokens(statement: str) -> list[SQLToken]:
    tokens = [
        token for token in tokenize_sql(statement) if not is_trivia(token) and token.text != ";"
    ]
    while tokens and tokens[0].text == "(" and tokens[-1].text == ")":
        depth = 0
        end = -1
        for index, token in enumerate(tokens):
            if token.kind == "punctuation":
                if token.text == "(":
                    depth += 1
                elif token.text == ")":
                    depth -= 1
            if depth == 0:
                end = index
                break
        if end != len(tokens) - 1:
            break
        tokens = tokens[1:-1]
    return tokens


def _is_guard(tokens: list[SQLToken]) -> bool:
    depth = 0
    select = -1
    for index, token in enumerate(tokens):
        if token.kind == "punctuation" and token.text == "(":
            depth += 1
        elif token.kind == "punctuation" and token.text == ")":
            depth -= 1
        elif depth == 0 and token.kind == "identifier" and token.text.upper() == "SELECT":
            select = index
            break
    if (
        select < 0
        or len(tokens) <= select + 2
        or tokens[select + 1].kind != "identifier"
        or tokens[select + 1].text.upper() != "THROWIF"
        or tokens[select + 2].text != "("
    ):
        return False
    depth = 0
    for index in range(select + 2, len(tokens)):
        token = tokens[index]
        if token.kind != "punctuation":
            continue
        if token.text == "(":
            depth += 1
        elif token.text == ")":
            depth -= 1
            if depth == 0:
                return index + 1 == len(tokens) or (
                    tokens[index + 1].kind == "identifier"
                    and tokens[index + 1].text.upper() == "FROM"
                )
    return False
