/**
 * @fileoverview Markdown-safe rendering of upstream-authored and caller-echoed text.
 * GeoNames names, labels, and status text are community-edited, so `format()` and
 * composed messages print them only through these helpers. `structuredContent`
 * keeps every string as received, less the Unicode tag characters the service drops
 * when it decodes a response.
 * @module utils/inline-text
 */

/** CR, LF, tab, and the Unicode line and paragraph separators: flattened to a space. */
const LINE_BREAKS = /[\r\n\t\u{2028}\u{2029}]/gu;

/**
 * Controls and format characters (bidi marks, zero-width space, word joiner, BOM, soft
 * hyphen, tag characters), except ZWNJ and ZWJ, which Persian, Arabic, and Indic
 * names need to spell correctly.
 */
const INVISIBLE = /(?![\u{200c}\u{200d}])[\p{Cc}\p{Cf}]/gu;

/** The `:` of an http, https, or ftp URL and the `.` after `www`: where GFM starts an autolink. */
const AUTOLINK_TRIGGER = /(?<=https?|ftp):(?=\/\/)|(?<=www)\./giu;

/** An `&` that opens a named or numeric character reference, which renderers decode. */
const CHARACTER_REFERENCE = /&(?=#\d+;|#x[\da-f]+;|[a-z][a-z\d]*;)/giu;

/** Characters a plain-text URL percent-encodes so it cannot break out of its slot. */
const URL_UNSAFE = /[\s\p{Cc}\p{Cf}<>[\]\\|`"]/gu;

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Renders text for an inline markdown slot (heading, bold label, list item, notice):
 * line breaks become spaces, control and format characters are dropped, a bare URL's
 * `://` or `www.` is bracketed (`https[:]//`, `www[.]`) so no renderer autolinks it,
 * backslash is escaped, then a character reference's `&` and `[` `]`, and `<` / `>`
 * become entities.
 */
export function inlineText(value: string): string {
  return value
    .replace(LINE_BREAKS, ' ')
    .replace(INVISIBLE, '')
    .replace(AUTOLINK_TRIGGER, '[$&]')
    .replace(/\\/g, '\\\\')
    .replace(CHARACTER_REFERENCE, '\\&')
    .replace(/[[\]]/g, '\\$&')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** {@link inlineText} plus `|` escaped, for a markdown table cell. */
export function tableCell(value: string): string {
  return inlineText(value).replace(/\|/g, '\\|');
}

/**
 * Renders a URL as plain text, never as a markdown link. A scheme-less value
 * (GeoNames' `wikipediaURL`) gets `https://`; an `http`/`https` URL prints with
 * unsafe characters percent-encoded; any other scheme prints as escaped text.
 */
export function plainUrl(value: string): string {
  const trimmed = value.trim();
  const scheme = SCHEME.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== 'http' && scheme !== 'https') {
    return tableCell(trimmed);
  }
  const url = scheme === undefined ? `https://${trimmed}` : trimmed;
  return url.replace(URL_UNSAFE, (char) => encodeURIComponent(char));
}
