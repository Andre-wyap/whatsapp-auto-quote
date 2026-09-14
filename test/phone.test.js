import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMalaysianNumber, PhoneNumberError } from '../src/phone.js'

const VALID_CASES = [
  ['60123456789', '60123456789'], // already correct format, passthrough
  ['0123456789', '60123456789'], // local with leading 0
  ['+60123456789', '60123456789'], // with +
  ['+60 12-345 6789', '60123456789'], // spaces and dashes
  ['(012) 345-6789', '60123456789'], // parentheses
  ['0111234567 8', '601112345678'], // 011-prefix, 8-digit trunk, stray space
  ['123456789', '60123456789'], // leading 0 already missing
]

for (const [input, expected] of VALID_CASES) {
  test(`normalizes "${input}" to "${expected}"`, () => {
    assert.equal(normalizeMalaysianNumber(input), expected)
  })
}

const INVALID_CASES = [
  ['', 'empty string'],
  ['   ', 'whitespace only'],
  ['0312345678', 'KL landline (03), not a mobile'],
  ['abc', 'no digits at all'],
  ['60', 'far too short'],
  ['601234567890123', 'far too long'],
]

for (const [input, why] of INVALID_CASES) {
  test(`rejects "${input}" (${why})`, () => {
    assert.throws(() => normalizeMalaysianNumber(input), PhoneNumberError)
  })
}

test('rejects non-string input', () => {
  assert.throws(() => normalizeMalaysianNumber(null), PhoneNumberError)
  assert.throws(() => normalizeMalaysianNumber(undefined), PhoneNumberError)
  assert.throws(() => normalizeMalaysianNumber(60123456789), PhoneNumberError)
})
