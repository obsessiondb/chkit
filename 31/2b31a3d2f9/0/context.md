# Session Context

## User Prompts

### Prompt 1

i just ran publish, but chkit was published with dependencies linking to workspace:* instead fo the published version

### Prompt 2

can you unpublish chkit beta5 for me

### Prompt 3

is it not better, to have all at the same version? beta.6 ?

### Prompt 4

the ` (fail) @chkit/cli drift depth env e2e > respects failOnDrift=false policy when drift exists [8498.92ms]` test fails. i have a lot of trouble with the tests on this repo for releases. this test seems to be flaky, check why. dont necessary fix it, just check it let me know why its flaky, and why its importqnt

### Prompt 5

but that alone should not lead to flaky tests. our remote clickhouse is super stable.\
This was the error:\
```\
@chkit/plugin-pull:test: Ran 14 tests across 2 files. [5.73s]
chkit:test: 270 |         const generated = runCli(fixture.dir, ['generate', '--config', fixture.configPath, '--json'])
chkit:test: 271 |         expect(generated.exitCode).toBe(0)
chkit:test: 272 | 
chkit:test: 273 |         const executed = runCli(fixture.dir, ['migrate', '--config', fixture.configPath, '--execute', '--js...

