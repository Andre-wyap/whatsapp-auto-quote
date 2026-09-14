// Normalizes phone numbers to WhatsApp's Malaysia format: 60XXXXXXXXX
// (country code, no leading 0, no +, no spaces/dashes).
//
// Malaysian mobile numbers always start with 01X locally:
//   local:         01X-XXXXXXX(X)   → 10 or 11 digits, leading 0
//   international: 601X-XXXXXXX(X)  → 11 or 12 digits, no leading 0
// Landlines (03, 04, 05...) don't carry WhatsApp, so they're rejected here
// rather than silently normalized — a wrong "success" is worse than a clear 400.

export class PhoneNumberError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PhoneNumberError'
  }
}

const MY_MOBILE = /^601\d{8,9}$/

/**
 * @param {string} input
 * @returns {string} normalized number, e.g. "60123456789"
 */
export function normalizeMalaysianNumber(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new PhoneNumberError('number must be a non-empty string')
  }

  const digits = input.replace(/\D/g, '')

  let normalized
  if (digits.startsWith('60')) {
    normalized = digits
  } else if (digits.startsWith('0')) {
    normalized = '60' + digits.slice(1)
  } else if (digits.startsWith('1')) {
    // Leading 0 already missing (e.g. "123456789") — treat as a bare local number.
    normalized = '60' + digits
  } else {
    throw new PhoneNumberError(`could not normalize phone number: "${input}"`)
  }

  if (!MY_MOBILE.test(normalized)) {
    throw new PhoneNumberError(
      `not a valid Malaysian mobile number: "${input}" (normalized to "${normalized}")`
    )
  }

  return normalized
}
