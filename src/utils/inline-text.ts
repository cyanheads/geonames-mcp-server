/**
 * @fileoverview Markdown-safe rendering of upstream-authored and caller-echoed text.
 * GeoNames names, labels, and status text are community-edited, so `format()` and
 * composed messages print them only through these helpers. `structuredContent`
 * keeps every string as received.
 * @module utils/inline-text
 */

/** CR, LF, tab, and the Unicode line and paragraph separators: flattened to a space. */
const LINE_BREAKS = /[\r\n\t\u{2028}\u{2029}]/gu;

/** C0 and C1 controls, DEL, and the bidi marks, embeddings, overrides, and isolates. */
const INVISIBLE = /[\p{Cc}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{061c}]/gu;

/** Characters a plain-text URL percent-encodes so it cannot break out of its slot. */
const URL_UNSAFE =
  /[\s\p{Cc}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{061c}<>[\]\\|`"]/gu;

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Renders text for an inline markdown slot (heading, bold label, list item, notice):
 * line breaks become spaces, control and bidi characters are dropped, backslash is
 * escaped before `[` and `]`, and `<` / `>` become entities.
 */
export function inlineText(value: string): string {
  return value
    .replace(LINE_BREAKS, ' ')
    .replace(INVISIBLE, '')
    .replace(/\\/g, '\\\\')
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
