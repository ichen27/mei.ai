/**
 * Caller-supplied text on one line. A name or a note is whatever the caller
 * said, so line breaks and control characters are removed and the length is
 * capped. Otherwise it could add its own lines to a ticket or a message.
 */
export function oneLine(value: string, max: number): string {
  // Cc: control characters. Zl, Zp: the Unicode line and paragraph separators.
  const cleaned = value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}
