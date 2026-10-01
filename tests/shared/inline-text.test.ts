/**
 * @fileoverview Inline-text helpers: upstream-authored and caller-echoed text stays on
 * one line and inert in markdown slots; URLs print as plain text, never as links.
 * Invisible characters are built from code points so the source carries none of them.
 * @module tests/shared/inline-text.test
 */

import { describe, expect, it } from 'vitest';
import { inlineText, plainUrl, tableCell } from '@/utils/inline-text.js';

/** The character at a code point. */
const cp = (codePoint: number) => String.fromCodePoint(codePoint);

const LINE_SEPARATOR = cp(0x2028);
const PARAGRAPH_SEPARATOR = cp(0x2029);
const RLO = cp(0x202e);

describe('inlineText', () => {
  it('returns plain text unchanged', () => {
    expect(inlineText('Seattle, Washington')).toBe('Seattle, Washington');
    expect(inlineText('')).toBe('');
  });

  it.each([
    ['LF', '\n'],
    ['CR', '\r'],
    ['tab', '\t'],
    ['line separator', LINE_SEPARATOR],
    ['paragraph separator', PARAGRAPH_SEPARATOR],
  ])('flattens %s to a space', (_name, char) => {
    expect(inlineText(`a${char}b`)).toBe('a b');
  });

  it('turns a CRLF into two spaces, one per character', () => {
    expect(inlineText('a\r\nb')).toBe('a  b');
  });

  it('keeps an injected heading, list marker, or fence on the same line', () => {
    const out = inlineText('Seattle\n\n## Injected\n- item\n```\ncode');
    expect(out).not.toContain('\n');
    expect(out.startsWith('Seattle')).toBe(true);
  });

  it.each([
    ['NUL', 0x0000],
    ['ESC', 0x001b],
    ['DEL', 0x007f],
    ['NEL (C1)', 0x0085],
    ['C1 end', 0x009f],
    ['LRM', 0x200e],
    ['RLM', 0x200f],
    ['LRE', 0x202a],
    ['RLO', 0x202e],
    ['LRI', 0x2066],
    ['PDI', 0x2069],
    ['ALM', 0x061c],
  ])('strips %s', (_name, codePoint) => {
    expect(inlineText(`a${cp(codePoint)}b`)).toBe('ab');
  });

  it('escapes brackets so no link or reference forms', () => {
    expect(inlineText('[click](http://evil.test)')).toBe('\\[click\\](http://evil.test)');
    expect(inlineText('[ref]: http://evil.test')).toBe('\\[ref\\]: http://evil.test');
  });

  it('escapes a backslash before the brackets, so an author-written escape cannot undo it', () => {
    expect(inlineText('\\[x\\]')).toBe('\\\\\\[x\\\\\\]');
    expect(inlineText('a\\b')).toBe('a\\\\b');
  });

  it('turns angle brackets into entities', () => {
    expect(inlineText('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(inlineText('<https://evil.test>')).toBe('&lt;https://evil.test&gt;');
  });

  it('handles every rule together', () => {
    expect(inlineText(`x\r\n[a]${RLO} <b>`)).toBe('x  \\[a\\] &lt;b&gt;');
  });
});

describe('tableCell', () => {
  it('escapes pipes on top of inlineText', () => {
    expect(tableCell('a | b')).toBe('a \\| b');
  });

  it('keeps a row on one line when the text carries a newline and a pipe', () => {
    const cell = tableCell('Evil\n| fake | row |');
    expect(cell).not.toContain('\n');
    expect(cell.replace(/\\\|/g, '')).not.toContain('|');
  });

  it('escapes a pipe after a backslash without leaving it unescaped', () => {
    expect(tableCell('a\\|b')).toBe('a\\\\\\|b');
  });

  it('applies the inline rules', () => {
    expect(tableCell('[x] <y>')).toBe('\\[x\\] &lt;y&gt;');
  });
});

describe('plainUrl', () => {
  it('adds https:// to a scheme-less URL', () => {
    expect(plainUrl('en.wikipedia.org/wiki/Seattle')).toBe('https://en.wikipedia.org/wiki/Seattle');
  });

  it.each([
    'https://en.wikipedia.org/wiki/Seattle',
    'http://example.test/a?b=c#d',
    'HTTPS://Example.test/X',
  ])('prints the http or https URL %s as it is', (url) => {
    expect(plainUrl(url)).toBe(url);
  });

  it('trims surrounding whitespace', () => {
    expect(plainUrl('  https://example.test/a  ')).toBe('https://example.test/a');
  });

  it('percent-encodes the characters that could break out of a slot', () => {
    expect(plainUrl('https://example.test/a b')).toBe('https://example.test/a%20b');
    expect(plainUrl('https://example.test/[x]')).toBe('https://example.test/%5Bx%5D');
    expect(plainUrl('https://example.test/<a>')).toBe('https://example.test/%3Ca%3E');
    expect(plainUrl('https://example.test/a|b')).toBe('https://example.test/a%7Cb');
    expect(plainUrl('https://example.test/a`b')).toBe('https://example.test/a%60b');
    expect(plainUrl('https://example.test/a"b')).toBe('https://example.test/a%22b');
    expect(plainUrl('https://example.test/a\\b')).toBe('https://example.test/a%5Cb');
  });

  it('percent-encodes line breaks, controls, and bidi marks', () => {
    expect(plainUrl('https://example.test/a\nb')).toBe('https://example.test/a%0Ab');
    expect(plainUrl('https://example.test/a\rb')).toBe('https://example.test/a%0Db');
    expect(plainUrl(`https://example.test/a${cp(0)}b`)).toBe('https://example.test/a%00b');
    expect(plainUrl(`https://example.test/a${RLO}b`)).toBe('https://example.test/a%E2%80%AEb');
  });

  it('prints a scheme-less URL with injected markup safely', () => {
    expect(plainUrl('example.test/x)\n[evil](http://e.test')).toBe(
      'https://example.test/x)%0A%5Bevil%5D(http://e.test',
    );
  });

  it.each([
    ['javascript:alert(1)', 'javascript:alert(1)'],
    ['JavaScript:alert(1)', 'JavaScript:alert(1)'],
    ['data:text/html,<b>x</b>', 'data:text/html,&lt;b&gt;x&lt;/b&gt;'],
    ['ftp://example.test/a', 'ftp://example.test/a'],
    ['mailto:a@example.test', 'mailto:a@example.test'],
    ['file:///etc/passwd', 'file:///etc/passwd'],
  ])('prints %s as escaped text, never as a URL', (input, expected) => {
    expect(plainUrl(input)).toBe(expected);
    expect(plainUrl(input).startsWith('https://')).toBe(false);
  });

  it('escapes markup and pipes in a non-http scheme', () => {
    expect(plainUrl('x-custom:[a]|b\nc')).toBe('x-custom:\\[a\\]\\|b c');
  });

  it('does not treat a colon later in a path as a scheme', () => {
    expect(plainUrl('en.wikipedia.org/wiki/Category:Seattle')).toBe(
      'https://en.wikipedia.org/wiki/Category:Seattle',
    );
  });
});
