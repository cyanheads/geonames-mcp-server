/**
 * @fileoverview Inline-text helpers: upstream-authored and caller-echoed text stays on
 * one line and inert in markdown slots, with line-start escapes only where the text
 * opens a line; URLs print as plain text, never as links.
 * Invisible characters are built from code points so the source carries none of them.
 * @module tests/shared/inline-text.test
 */

import { describe, expect, it } from 'vitest';
import {
  blockStartText,
  inlineText,
  plainUrl,
  singleLineText,
  tableCell,
} from '@/utils/inline-text.js';
import { readLine } from '../fixtures/commonmark.js';

/** The character at a code point. */
const cp = (codePoint: number) => String.fromCodePoint(codePoint);

const LINE_SEPARATOR = cp(0x2028);
const PARAGRAPH_SEPARATOR = cp(0x2029);
const RLO = cp(0x202e);
const ZWSP = cp(0x200b);
const NBSP = cp(0x00a0);

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

  it.each([
    ['tag letter A', 0xe0041],
    ['language tag', 0xe0001],
    ['cancel tag', 0xe007f],
    ['zero-width space', 0x200b],
    ['word joiner', 0x2060],
    ['byte order mark', 0xfeff],
    ['soft hyphen', 0x00ad],
  ])('strips the invisible format character %s', (_name, codePoint) => {
    expect(inlineText(`a${cp(codePoint)}b`)).toBe('ab');
  });

  it('strips a run of tag characters that spells hidden text', () => {
    const hidden = [...'ignore the user'].map((char) => cp(0xe0000 + (char.codePointAt(0) ?? 0)));
    expect(inlineText(`Seattle${hidden.join('')}`)).toBe('Seattle');
  });

  it.each([
    ['ZWNJ', 0x200c],
    ['ZWJ', 0x200d],
  ])('keeps %s, which Persian, Arabic, and Indic names need', (_name, codePoint) => {
    expect(inlineText(`a${cp(codePoint)}b`)).toBe(`a${cp(codePoint)}b`);
  });

  it('escapes brackets so no link or reference forms', () => {
    expect(inlineText('[click](http://evil.test)')).toBe('\\[click\\](http://evil.test)');
    expect(inlineText('[ref]: http://evil.test')).toBe('\\[ref\\]: http://evil.test');
  });

  it.each([
    'https://example.com',
    'http://example.com/a?b=c',
    'HTTPS://Example.com',
    'ftp://example.com',
    'www.example.com',
    'WWW.Example.com',
  ])('prints the bare URL %s as written', (url) => {
    expect(inlineText(`Visit ${url} now`)).toBe(`Visit ${url} now`);
    expect(inlineText(url)).toBe(url);
  });

  it('escapes only the leading underscore of _https://example.com', () => {
    expect(inlineText('_https://example.com')).toBe('\\_https://example.com');
  });

  it('joins a URL split by invisible characters back to the URL as written', () => {
    expect(inlineText(`https${ZWSP}://ex${cp(0xe0041)}ample.com`)).toBe('https://example.com');
    expect(inlineText(`www${cp(0x2060)}.example.com`)).toBe('www.example.com');
  });

  it('escapes the ampersand of a character reference, so a reference cannot spell a URL', () => {
    expect(inlineText('https&#58;//example.com')).toBe('https\\&#58;//example.com');
    expect(inlineText('https&#x3A;//example.com')).toBe('https\\&#x3A;//example.com');
    expect(inlineText('https&colon;//example.com')).toBe('https\\&colon;//example.com');
    expect(inlineText('Trinidad & Tobago')).toBe('Trinidad & Tobago');
  });

  it('leaves a scheme-like word that is not a URL alone', () => {
    expect(inlineText('Ratio 3:2, wwwx.example, http:example')).toBe(
      'Ratio 3:2, wwwx.example, http:example',
    );
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

  it('escapes emphasis, code-span, and strikethrough delimiters', () => {
    expect(inlineText('**North** _Fork_ `Creek` ~~Old~~')).toBe(
      '\\*\\*North\\*\\* \\_Fork\\_ \\`Creek\\` \\~\\~Old\\~\\~',
    );
    expect(inlineText('Binyamina-Giv`at `Ada')).toBe('Binyamina-Giv\\`at \\`Ada');
    expect(inlineText('a*b')).toBe('a\\*b');
    expect(inlineText('a~b')).toBe('a\\~b');
  });

  it.each([
    ['an identifier', 'W14_01'],
    ['a timezone id', 'America/Los_Angeles'],
    ['digits', '12_34'],
    ['a run of underscores', 'a__b__c'],
    ['letters outside ASCII', 'Ñandú_Ñu'],
    ['a combining mark', `e${cp(0x301)}_x`],
    ['a letter outside the BMP', `${cp(0x20000)}_${cp(0x20001)}`],
  ])('keeps an underscore between two letters, digits, or marks in %s', (_name, text) => {
    expect(inlineText(text)).toBe(text);
  });

  it.each([
    ['Ipanema _Nh_', 'Ipanema \\_Nh\\_'],
    ['_lead', '\\_lead'],
    ['trail_', 'trail\\_'],
    ['a __b', 'a \\_\\_b'],
    ['(_x_)', '(\\_x\\_)'],
    ['a_-b', 'a\\_-b'],
    [`a_${cp(0x20000)} _`, `a_${cp(0x20000)} \\_`],
    [`${cp(0x20000)}_ x`, `${cp(0x20000)}\\_ x`],
  ])('escapes the word-boundary underscores of %s', (text, expected) => {
    expect(inlineText(text)).toBe(expected);
  });

  it('escapes the backslash first, so an author-written backslash cannot cancel a delimiter escape', () => {
    expect(inlineText('\\*x')).toBe('\\\\\\*x');
    expect(inlineText('\\`x')).toBe('\\\\\\`x');
    expect(inlineText('\\~x')).toBe('\\\\\\~x');
    expect(inlineText('a\\_b')).toBe('a\\\\\\_b');
  });

  it.each([
    '4. Wiener Gemeindebezirk',
    '1) Erste',
    '#####',
    '####',
    '### ##',
    'AZ ####',
    '@@ ##',
    '# Hash',
    '- Dash',
    '---',
    '+ Plus',
    'Lot #',
    '#',
    '    four-space indent',
  ])('prints the line-start marker of %j as written: no block opens inside a line', (text) => {
    expect(inlineText(text)).toBe(text);
  });

  it('flattens a leading tab to a space and leaves the marker after it alone', () => {
    expect(inlineText('\t- Tab')).toBe(' - Tab');
  });

  it('still escapes a leading star and turns a leading > into an entity', () => {
    expect(inlineText('* Star')).toBe('\\* Star');
    expect(inlineText('> Quote')).toBe('&gt; Quote');
  });
});

describe('blockStartText', () => {
  it('applies every inline rule', () => {
    const text = `**North** _Fork_ \`Creek\` [x](https://e.test) <b> W14_01${RLO}\n&#58;`;
    expect(blockStartText(text)).toBe(inlineText(text));
    expect(blockStartText('Seattle, Washington')).toBe('Seattle, Washington');
  });

  it.each([
    ['4. Wiener Gemeindebezirk', '4\\. Wiener Gemeindebezirk'],
    ['1) Erste', '1\\) Erste'],
    ['123456789. Nine digits', '123456789\\. Nine digits'],
    ['7.', '7\\.'],
    ['- Dash', '\\- Dash'],
    ['-', '\\-'],
    ['---', '\\---'],
    ['-- -', '\\-- -'],
    ['+ Plus', '\\+ Plus'],
    ['# Hash', '\\# Hash'],
    ['###### Six', '\\###### Six'],
    ['#', '\\#'],
    ['#####', '\\#####'],
    ['  3. Indented', '3\\. Indented'],
    ['\t- Tab', '\\- Tab'],
    [`${ZWSP}- Hidden`, '\\- Hidden'],
    [`  ${ZWSP}  + Hidden`, '\\+ Hidden'],
    ['* Star', '\\* Star'],
    ['> Quote', '&gt; Quote'],
  ])('escapes the leading block marker of %j', (text, expected) => {
    expect(blockStartText(text)).toBe(expected);
  });

  it.each([
    ['    four-space indent', 'four-space indent'],
    ['        eight spaces', 'eight spaces'],
    ['\t\tTwo tabs', 'Two tabs'],
    [`  ${ZWSP}   Hidden`, 'Hidden'],
    [' One', 'One'],
    ['   ', ''],
  ])(
    'drops the leading spaces of %j, so four or more cannot open an indented code block',
    (text, expected) => {
      expect(blockStartText(text)).toBe(expected);
    },
  );

  it('keeps leading no-break spaces, which never indent, and inner spaces', () => {
    expect(blockStartText(`${NBSP.repeat(4)}x`)).toBe(`${NBSP.repeat(4)}x`);
    expect(blockStartText('a    b')).toBe('a    b');
  });

  it.each([
    'Route 4. North',
    '4.5 Mile Creek',
    '1234567890. Ten digits',
    '#5 Mine',
    '####### Seven',
    '-5 Below',
    '--x',
    '+1',
    '2)x',
  ])('leaves %j alone: no block starts there', (text) => {
    expect(blockStartText(text)).toBe(text);
  });

  it.each([
    ['Lot #', 'Lot \\#'],
    ['Lot ##  ', 'Lot \\##  '],
    ['# #', '\\# \\#'],
    ['##', '\\##'],
    ['#######', '\\#######'],
    ['####### #', '####### \\#'],
  ])(
    'escapes the closing hashes of %j, which a heading drops as its closing sequence',
    (text, expected) => {
      expect(blockStartText(text)).toBe(expected);
    },
  );

  it.each(['Lot#', 'Lot # 5', 'C# Street'])('leaves the hashes of %j alone', (text) => {
    expect(blockStartText(text)).toBe(text);
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

  it('applies the delimiter escapes, prints line-start markers as written, then escapes pipes', () => {
    expect(tableCell('4. `a`|*b* _c_|W14_01')).toBe('4. \\`a\\`\\|\\*b\\* \\_c\\_\\|W14_01');
    expect(tableCell('#####')).toBe('#####');
    expect(tableCell('### ##')).toBe('### ##');
    expect(tableCell('@# #@@|@## #@@')).toBe('@# #@@\\|@## #@@');
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

  it('percent-encodes line breaks, controls, and invisible format characters', () => {
    expect(plainUrl('https://example.test/a\nb')).toBe('https://example.test/a%0Ab');
    expect(plainUrl('https://example.test/a\rb')).toBe('https://example.test/a%0Db');
    expect(plainUrl(`https://example.test/a${cp(0)}b`)).toBe('https://example.test/a%00b');
    expect(plainUrl(`https://example.test/a${RLO}b`)).toBe('https://example.test/a%E2%80%AEb');
    expect(plainUrl(`https://example.test/a${ZWSP}b`)).toBe('https://example.test/a%E2%80%8Bb');
    expect(plainUrl(`https://example.test/a${cp(0xad)}b`)).toBe('https://example.test/a%C2%ADb');
  });

  it('percent-encodes every * and ~, which emphasis and strikethrough read even inside a URL', () => {
    expect(plainUrl('https://x.test/a*b*c')).toBe('https://x.test/a%2Ab%2Ac');
    expect(plainUrl('https://x.test/~a/~~b~~')).toBe('https://x.test/%7Ea/%7E%7Eb%7E%7E');
    expect(plainUrl('x.test/*')).toBe('https://x.test/%2A');
  });

  it('judges an underscore by the encoded text beside it', () => {
    expect(plainUrl('https://x.test/(*_b_')).toBe('https://x.test/(%2A_b_');
    expect(plainUrl('https://x.test/(<_b_')).toBe('https://x.test/(%3C_b_');
  });

  it.each([
    ['https://x.test/__init__', 'https://x.test/%5F%5Finit%5F%5F'],
    ['https://x.test/A,_B_(c)', 'https://x.test/A,%5FB%5F(c)'],
    ['https://x.test/_a_', 'https://x.test/%5Fa%5F'],
    ['https://x.test/(_a_)/b_c', 'https://x.test/(%5Fa%5F)/b_c'],
  ])(
    'percent-encodes the underscores of %s, where one can open emphasis and a later one close it',
    (url, expected) => {
      expect(plainUrl(url)).toBe(expected);
    },
  );

  it.each([
    'https://en.wikipedia.org/wiki/New_York_City',
    'https://en.wikipedia.org/wiki/Springfield,_Illinois',
    'https://en.wikipedia.org/wiki/Paris_(Texas)',
    'https://en.wikipedia.org/wiki/Charleston,_West_Virginia',
    'https://x.test/a_',
    'https://x.test/_a',
    'https://x.test/b_(c)_d',
  ])('keeps the underscores of %s, which cannot pair into emphasis', (url) => {
    expect(plainUrl(url)).toBe(url);
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

describe('singleLineText', () => {
  it('flattens line breaks, drops invisible characters, and escapes nothing', () => {
    expect(singleLineText(`bad\r\nvalue [x](http://evil.test) <b>${RLO}`)).toBe(
      'bad  value [x](http://evil.test) <b>',
    );
    expect(singleLineText(`a${LINE_SEPARATOR}b\t*c*_d_${ZWSP}&#58;`)).toBe('a b *c*_d_&#58;');
    expect(singleLineText(`a${cp(0x200c)}b`)).toBe(`a${cp(0x200c)}b`);
  });
});

/** Strings whose rendered slots must read back as written: URLs, link syntax, delimiters, line-start markers. */
const ROUND_TRIP_CORPUS = [
  'https://example.com',
  'http://example.com/a?b=c',
  'HTTPS://Example.com',
  'ftp://example.com',
  'Visit https://example.com now',
  'http://evil.test/a*b*c',
  'https://en.wikipedia.org/wiki/Springfield,_Illinois',
  'https://en.wikipedia.org/wiki/Paris_(Texas)',
  '_https://example.com',
  'www.example.com',
  'WWW.Example.com',
  'Visit www.example.com now',
  'www.foo_bar_.com',
  '[click](http://evil.test)',
  '[ref]: http://evil.test',
  '<https://evil.test>',
  'https&#58;//example.com',
  'mail foo@example.com',
  '**North** _Fork_ `Creek` ~~Old~~',
  'Binyamina-Giv`at `Ada',
  '4. Wiener Gemeindebezirk',
  'Route 4. North',
  'W14_01',
  'America/Los_Angeles',
  'Ipanema _Nh_',
  '\\*x',
  '#####',
  '#5 Mine',
  'abc #',
  '[Paris] <b>',
  'AT&T',
  'Trinidad & Tobago',
  'a | b',
  '東京都',
  'Ḩaḑramawt',
  '- dash lead',
  '> quote lead',
];

describe('CommonMark round trip', () => {
  it.each(ROUND_TRIP_CORPUS)('reads %j back as written after a bold label', (text) => {
    expect(readLine(`**L:** ${inlineText(text)}`)).toMatchObject({
      blocks: [],
      live: ['strong_open', 'strong_close'],
      text: `L: ${text}`,
    });
  });

  it.each(
    ROUND_TRIP_CORPUS.flatMap((text) =>
      [
        ['heading', '## ', 'heading_open'],
        ['list item', '- ', 'bullet_list_open'],
        ['block quote', '> ', 'blockquote_open'],
      ].map(([slot, prefix, block]) => [slot, text, prefix, block] as const),
    ),
  )('reads back a %s holding %j as written', (_slot, text, prefix, block) => {
    const parsed = readLine(`${prefix}${blockStartText(text)}`);
    expect(parsed.blocks[0]).toBe(block);
    expect(parsed.live).toEqual([]);
    expect(parsed.text).toBe(text);
  });

  it.each(['[click](http://evil.test)', '<https://evil.test>', 'https&#58;//example.com'])(
    'opens no link for %j under CommonMark, and none to another target under linkify',
    (text) => {
      expect(readLine(`**L:** ${inlineText(text)}`).links).toEqual([]);
      for (const { href, text: shown } of readLine(`**L:** ${inlineText(text)}`, 'gfm').links) {
        expect(href).toBe(shown);
      }
    },
  );

  it('links a bare URL under linkify only to the URL it prints', () => {
    const { links } = readLine(
      `**L:** ${inlineText('Visit https://example.com and www.example.com')}`,
      'gfm',
    );
    expect(links).toContainEqual({ href: 'https://example.com', text: 'https://example.com' });
    for (const { href, text } of links) expect([text, `http://${text}`]).toContain(href);
  });
});

/** Repeats `unit` to exactly `length` characters. */
const fill = (unit: string, length: number) =>
  unit.repeat(Math.ceil(length / unit.length)).slice(0, length);

/** A named input shape, built at a given length. */
type Shape = [name: string, build: (length: number) => string];

const UNDERSCORE_AND_DELIMITER_SHAPES: Shape[] = [
  ['an underscore run between letters', (n) => `a${'_'.repeat(n)}b`],
  ['alternating letters and underscores', (n) => fill('a_', n)],
  ['underscores between spaces', (n) => fill('_ ', n)],
  ['underscore openers and closers', (n) => fill(',_a_(', n)],
  ['delimiter runs', (n) => fill('*`~', n)],
  ['line breaks interleaved', (n) => `${fill('§1 x', n)}\ny`],
  ['spaces before CRLF line breaks', (n) => fill('  \r\n', n)],
  ['repeated URL schemes', (n) => fill('https://', n)],
  ['repeated www prefixes', (n) => fill('www.', n)],
];

const LINE_START_SHAPES: Shape[] = [
  ['spaces before a list marker', (n) => `${' '.repeat(n)}- x`],
  ['spaces before an ordered-list marker', (n) => `${' '.repeat(n)}4. x`],
  ['dashes before a letter', (n) => `${'-'.repeat(n)}x`],
  ['a dash-and-space line', (n) => `-${fill(' -', n)}`],
  ['spaced hashes', (n) => fill(' #', n)],
  ['a hash run before a letter', (n) => ` ${'#'.repeat(n)}x`],
  ['a leading hash run before a letter', (n) => `${'#'.repeat(n)}x`],
  ['a hash before trailing spaces and a letter', (n) => ` #${' '.repeat(n)}x`],
];

/** blockStartText runs inlineText first, so its suite bounds both. */
describe.each<[string, (text: string) => string, Shape[]]>([
  ['blockStartText', blockStartText, [...UNDERSCORE_AND_DELIMITER_SHAPES, ...LINE_START_SHAPES]],
  ['singleLineText', singleLineText, UNDERSCORE_AND_DELIMITER_SHAPES],
  ['plainUrl', (text) => plainUrl(`https://x.test/${text}`), UNDERSCORE_AND_DELIMITER_SHAPES],
])('%s cost', (_name, render, shapes) => {
  /** Shortest input, in characters, of each scaled shape. */
  const START = 1_250;
  /** Size doublings past START: six of them span 64×. */
  const DOUBLINGS = 6;
  /** Per-call CPU ceiling at every size, in milliseconds of this thread's time. */
  const CEILING_MS = 250;
  /** A trial repeats a short input until it has rendered this many characters, so its time reads above the clock's resolution. */
  const TRIAL_CHARS = 320_000;

  /** The best of three trials of this thread's CPU time per `render(text)` call, in milliseconds. */
  function cpuMsPerCall(text: string): number {
    const calls = Math.max(1, Math.ceil(TRIAL_CHARS / text.length));
    let best = Number.POSITIVE_INFINITY;
    for (let trial = 0; trial < 3; trial++) {
      const start = process.threadCpuUsage();
      for (let call = 0; call < calls; call++) render(text);
      const used = process.threadCpuUsage(start);
      best = Math.min(best, (used.user + used.system) / 1000 / calls);
    }
    return best;
  }

  /** Doubles the input from `start` characters `DOUBLINGS` times, holding each size under the ceiling; returns the largest-to-smallest time ratio. */
  function spanRatio(shape: (length: number) => string, start: number): number {
    cpuMsPerCall(shape(start));
    const times: number[] = [];
    for (let doubling = 0, length = start; doubling <= DOUBLINGS; doubling++, length *= 2) {
      const ms = cpuMsPerCall(shape(length));
      expect(ms, `${length} characters`).toBeLessThan(CEILING_MS);
      times.push(ms);
    }
    return (times.at(-1) ?? 0) / Math.max(times[0] ?? 0, 0.001);
  }

  it.each(shapes)('renders %s in time linear in its length across 64×', (_shape, build) => {
    expect(spanRatio(build, START)).toBeLessThan(256);
  });

  it('renders a long digit run in time linear in its length from 5,000 to 320,000 characters', () => {
    expect(spanRatio((n) => `${'1'.repeat(n)}. x`, 5_000)).toBeLessThan(256);
  });
});
