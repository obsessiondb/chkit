`chkit obsessiondb service alias set` rejects an alias that starts with `-`, which the
command line would read as a flag (#491). An alias saved earlier still loads and is
listed, but `alias remove` cannot name it; delete it from `.chkit/obsessiondb.json`.
