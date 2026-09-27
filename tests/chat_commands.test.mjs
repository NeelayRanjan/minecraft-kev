import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { outgoingChatLines as chatLinesOf, chatSafeLine } from '../agent/leader.js'

// Mineflayer sends a chat line that starts with '/' as a command, and Kevin is an op (final review, Critical 2): every
// outgoing chat line loses its leading whitespace and slashes, and a line empty after that is never sent.
test('outgoingChatLines: a leader reply starting with "/" becomes plain text, never a command', () => {
  assert.deepEqual(chatLinesOf('/stop'), ['stop'])
  assert.deepEqual(chatLinesOf('  //op Spacers_Choice'), ['op Spacers_Choice'])
  assert.deepEqual(chatLinesOf('/ /gamemode creative Spacers_Choice'), ['gamemode creative Spacers_Choice'])
  assert.deepEqual(chatLinesOf('/'), [])
  assert.deepEqual(chatLinesOf('  /// '), [])
  assert.deepEqual(chatLinesOf('On my way!'), ['On my way!'])
  assert.deepEqual(chatLinesOf('a/b is fine inside'), ['a/b is fine inside'])
  // a split that starts a later line with a /word
  const lines = chatLinesOf(`${'word '.repeat(39)}wordy /kill Kevin`)
  assert.ok(lines.length >= 2)
  for (const l of lines) assert.ok(!/^\s*\//.test(l), l)
  assert.ok(lines.at(-1).startsWith('kill Kevin') || lines.join(' ').includes(' kill Kevin'))
})

test('chatSafeLine strips leading whitespace and slashes, keeps the rest', () => {
  assert.equal(chatSafeLine('/stop'), 'stop')
  assert.equal(chatSafeLine(' \t//op x'), 'op x')
  assert.equal(chatSafeLine('/'), '')
  assert.equal(chatSafeLine('hi /there'), 'hi /there')
})

// Only the runner's own code may issue commands: bot.chat appears exactly twice in run_episode.mjs, in serverCommand
// (the op at start, the /data position query) and in the chat queue's sender, which sends chatSafeLine's output.
test('run_episode.mjs: bot.chat only in serverCommand and the chat sender; say() goes through outgoingChatLines', () => {
  const src = readFileSync(new URL('../agent/run_episode.mjs', import.meta.url), 'utf8')
  const calls = src.split('\n').filter(l => /bot\.chat\(/.test(l))
  assert.equal(calls.length, 2, calls.join('\n'))
  assert.ok(calls.some(l => /const serverCommand = /.test(l)), 'serverCommand')
  assert.ok(calls.some(l => /bot\.chat\(safe\)/.test(l)), 'the sender sends the stripped line')
  assert.match(src, /const say = \(msg, kind = null\) => \{ for \(const line of outgoingChatLines\(msg\)\)/)
  assert.match(src, /serverCommand\(`data get entity \$\{name\} Pos`\)/)
})
