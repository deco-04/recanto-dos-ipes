'use strict';

/**
 * Normalize a phone number to E.164 format.
 * Brazilian numbers (10-11 digits without +): prepend +55
 * Numbers with + prefix: keep as-is (strip non-digits after +)
 * All others: prepend +
 */
function toE164(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) return '+' + digits;
  // 10 or 11 digits without country code → Brazilian number
  if (digits.length === 10 || digits.length === 11) return '+55' + digits;
  // Otherwise assume full international digits provided
  return '+' + digits;
}

module.exports = { toE164 };
