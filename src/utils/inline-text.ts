/**
 * @fileoverview Markdown-safe rendering of upstream-authored and caller-echoed text.
 * GeoNames names, labels, and status text are community-edited, so `format()` and each
 * `enrichmentTrailer` render print them, and the caller text echoed beside them, only
 * through these helpers. Three mechanisms keep that text from opening a link, autolink,
 * HTML tag, emphasis, code span, strikethrough, or character reference, or a block where it
 * opens a line: a backslash before the markdown punctuation that would start one, `&lt;` and
 * `&gt;` for `<` and `>`, and brackets around a bare URL's trigger (`https[:]//`,
 * `www[.]`). The framework trailer prints enrichment verbatim, so a notice or
 * `effectiveQuery` reaches `structuredContent` raw and is escaped only by its render. An
 * error message is one string on both surfaces: the GeoNames text an
 * `upstream_rejected_parameter` message forwards goes through {@link inlineText} as the
 * message is composed, and the caller values other error messages echo are enum members,
 * codes, and numbers that the schema has already limited to characters markdown does not
 * read inside a line. Every other string reaches `structuredContent` as received, less the
 * Unicode tag characters the service drops when it decodes a response.
 *
 * A slot takes its helper by where the text stands in its line:
 * - after server-written text on the same line (a bold label's value, a value inside a
 *   composed sentence): {@link inlineText}; a markdown table cell: {@link tableCell};
 * - at the start of a line's content (a heading, a list item, a block-quote line, a
 *   line of its own): {@link blockStartText};
 * - a URL, in either position: {@link plainUrl}.
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

/** `*` and `~`, which emphasis and strikethrough read even inside a bare URL. */
const URL_DELIMITERS = /[*~]/g;

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/** Link brackets and the emphasis, code-span, and strikethrough delimiters, escaped wherever they stand. */
const DELIMITERS = /[[\]*`~]/g;

/** A letter, digit, or combining mark. */
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

/** CommonMark punctuation: the Unicode P and S categories. */
const PUNCTUATION = /[\p{P}\p{S}]/u;

/** CommonMark whitespace, where the edge of the text (`''`) counts as whitespace. */
const isSpace = (char: string) => char === '' || /\s/u.test(char);
const isPunctuation = (char: string) => PUNCTUATION.test(char);

/** Spaces at the start: four or more open an indented code block, and fewer never render. */
const LEADING_SPACES = /^ +/;

/**
 * At the start: an ATX heading `#` run, a `+` or `-` bullet or empty item marker, or a
 * line of dashes (a thematic break or setext underline).
 */
const LEADING_MARKER = /^(?=(?:#{1,6}|[+-])(?: |$)|-[- ]*$)/;

/** At the start: an ordered-list marker, one to nine digits then `.` or `)`. */
const LEADING_ORDINAL = /^(\d{1,9})([.)])(?= |$)/;

/** A run of `#` at the end, alone or after a space, which an ATX heading drops as its closing sequence. */
const CLOSING_HASHES = /(?<=^| )#+(?= *$)/;

/**
 * The code points just before `start` and at `end`, each taken whole, so a letter
 * outside the BMP counts as one (V8 misses a trailing astral code point under `[…]$`).
 * The edge of the text reads as `''`.
 */
function neighbors(text: string, start: number, end: number): [before: string, after: string] {
  return [
    [...text.slice(Math.max(0, start - 2), start)].at(-1) ?? '',
    [...text.slice(end, end + 2)][0] ?? '',
  ];
}

/**
 * Escapes a run of underscores unless it stands between two letters, digits, or marks,
 * where CommonMark never reads it as emphasis (`W14_01`, `America/Los_Angeles`).
 */
function escapeUnderscoreRun(run: string, offset: number, text: string): string {
  const [before, after] = neighbors(text, offset, offset + run.length);
  return WORD_CHAR.test(before) && WORD_CHAR.test(after) ? run : run.replaceAll('_', '\\_');
}

/** Whether an underscore run between `before` and `after` can open or close emphasis, by CommonMark's flanking rules. */
function underscoreFlanking(before: string, after: string): { closes: boolean; opens: boolean } {
  const left =
    !isSpace(after) && (!isPunctuation(after) || isSpace(before) || isPunctuation(before));
  const right =
    !isSpace(before) && (!isPunctuation(before) || isSpace(after) || isPunctuation(after));
  return {
    opens: left && (!right || isPunctuation(before)),
    closes: right && (!left || isPunctuation(after)),
  };
}

/**
 * Percent-encodes a URL's underscore runs when one can open emphasis and a later one can
 * close it, the only way they render as emphasis; otherwise every underscore stays
 * (`Springfield,_Illinois`, `Paris_(Texas)`). `%5F` names the same resource as `_`.
 */
function encodeEmphasisUnderscores(url: string): string {
  const runs = [...url.matchAll(/_+/g)].map(({ 0: run, index }) =>
    underscoreFlanking(...neighbors(url, index, index + run.length)),
  );
  const opener = runs.findIndex(({ opens }) => opens);
  if (opener === -1 || !runs.slice(opener + 1).some(({ closes }) => closes)) return url;
  let next = 0;
  return url.replace(/_+/g, (run) => {
    const flanking = runs[next++];
    return flanking?.opens || flanking?.closes ? '%5F'.repeat(run.length) : run;
  });
}

/**
 * Renders text for a slot inside a line, after server-written text: a bold label's value
 * (`**Toponym name:** …`, and the `**effectiveQuery:** …` an `enrichmentTrailer` render
 * writes) or a value inside a composed sentence. Line breaks become spaces, control and
 * format characters are dropped, a bare URL's `://` or `www.` is bracketed
 * (`https[:]//`, `www[.]`) so no renderer autolinks it, backslash is escaped, then a
 * character reference's `&`, `[` `]`, `*`, `` ` ``, `~`, and every `_` not between two
 * letters, digits, or marks, and `<` / `>` become entities. A block opens only at the
 * start of a line, so `#`, `+`, `-`, ordinals, and spaces print as written (`#####`,
 * `4. Wiener Gemeindebezirk`).
 */
export function inlineText(value: string): string {
  return value
    .replace(LINE_BREAKS, ' ')
    .replace(INVISIBLE, '')
    .replace(AUTOLINK_TRIGGER, '[$&]')
    .replace(/\\/g, '\\\\')
    .replace(CHARACTER_REFERENCE, '\\&')
    .replace(DELIMITERS, '\\$&')
    .replace(/_+/g, escapeUnderscoreRun)
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * {@link inlineText} for text that opens a line's content: a heading (`## …`), a list
 * item (`- …`), a block-quote line (`> …`, the slot a notice's `enrichmentTrailer`
 * render writes), or a line of its own. On top of the inline rules it drops the leading
 * spaces, escapes a leading block marker (a `#` heading run, a `+` or `-` bullet, a line
 * of dashes, or the `.` / `)` of a one-to-nine-digit ordinal), and escapes a closing `#`
 * run, which a heading drops. `Route 4. North`, `4.5 Mile Creek`, and `#5 Mine` open no
 * block and print as written.
 */
export function blockStartText(value: string): string {
  return inlineText(value)
    .replace(LEADING_SPACES, '')
    .replace(LEADING_MARKER, '\\')
    .replace(LEADING_ORDINAL, '$1\\$2')
    .replace(CLOSING_HASHES, '\\$&');
}

/**
 * The `enrichmentTrailer` render for a `notice`: a block-quote line. The framework trailer
 * prints values verbatim and `structuredContent` keeps the text as sent, so a notice that
 * carries caller or GeoNames text is escaped here.
 */
export const renderNotice = (value: unknown): string => `> ${blockStartText(String(value))}`;

/** {@link inlineText} plus `|` escaped, for a markdown table cell, whose content is inline. */
export function tableCell(value: string): string {
  return inlineText(value).replace(/\|/g, '\\|');
}

/**
 * Renders a URL as plain text, never as a markdown link. A scheme-less value
 * (GeoNames' `wikipediaURL`) gets `https://`; an `http`/`https` URL prints with unsafe
 * characters, `*`, `~`, and underscores that could pair into emphasis percent-encoded, so
 * it renders as written and still names the same resource; any other scheme prints as
 * escaped text. The result starts with a scheme's first letter, so it takes no
 * line-start escape at the start of a list item.
 */
export function plainUrl(value: string): string {
  const trimmed = value.trim();
  const scheme = SCHEME.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== 'http' && scheme !== 'https') {
    return tableCell(trimmed);
  }
  const url = scheme === undefined ? `https://${trimmed}` : trimmed;
  return encodeEmphasisUnderscores(
    url
      .replace(URL_UNSAFE, (char) => encodeURIComponent(char))
      .replace(URL_DELIMITERS, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`),
  );
}
