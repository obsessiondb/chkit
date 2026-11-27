import { expect, spyOn, test } from 'bun:test'

import { renderNothingPending } from '../../../commands/migrate/command.js'
import { resolveTableScope } from '../../../runtime/table-scope.js'

for (const noScopeMatch of [false, true]) {
  test.serial(`recovery completion failure emits no success JSON (scope miss: ${noScopeMatch})`, async () => {
    const output = spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await expect(renderNothingPending({
        jsonMode: true, mode: 'execute', tableScope: resolveTableScope(undefined, []),
        async completeRecovery() { throw new Error('journal proof failed') },
      }, { noScopeMatch, retry: undefined })).rejects.toThrow('journal proof failed')
      expect(output).not.toHaveBeenCalled()
    } finally { output.mockRestore() }
  })
}

test.serial('success JSON follows acknowledged recovery completion', async () => {
  const events: string[] = []
  const output = spyOn(process.stdout, 'write').mockImplementation(() => { events.push('success JSON'); return true })
  try {
    await renderNothingPending({
      jsonMode: true, mode: 'execute', tableScope: resolveTableScope(undefined, []),
      async completeRecovery() { events.push('recovery ACK') },
    }, { noScopeMatch: false, retry: undefined })
    expect(events).toEqual(['recovery ACK', 'success JSON'])
  } finally { output.mockRestore() }
})
