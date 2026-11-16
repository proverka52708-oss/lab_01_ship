import assert from 'node:assert/strict'
import { test } from 'vitest'
import { parseServerMessage } from '../src/net/socket-client.ts'

test('parses the server shutdown control message', () => {
  assert.deepEqual(
    parseServerMessage({
      type: 'shutdown',
      message: 'The server is restarting.',
    }),
    {
      type: 'shutdown',
      message: 'The server is restarting.',
    },
  )
})

test('rejects malformed shutdown control messages', () => {
  assert.throws(
    () => parseServerMessage({ type: 'shutdown', message: 0 }),
    /shutdown message is invalid/,
  )
})
