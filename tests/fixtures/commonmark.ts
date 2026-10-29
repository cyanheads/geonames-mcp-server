/**
 * @fileoverview Reads Markdown back through a real CommonMark parser (markdown-it), so a
 * test asserts what a `content[]` client renders rather than which bytes were written.
 * @module tests/fixtures/commonmark
 */

import MarkdownIt, { type Token } from 'markdown-it';

const parsers = {
  commonmark: new MarkdownIt('commonmark'),
  /** GFM tables and strikethrough, plus linkify standing in for GFM's bare-URL autolinks. */
  gfm: new MarkdownIt('default', { linkify: true }),
};

/** One line's parse: the block it opened, its inline text, and any live inline node. */
export interface ParsedLine {
  /** Block tokens other than paragraphs, in order (`heading_open`, `bullet_list_open`, …). */
  blocks: string[];
  /** Each link in the line: its visible text and its target. */
  links: { href: string | null; text: string }[];
  /** Inline node types other than text (`strong_open`, `code_inline`, `html_inline`, …). */
  live: string[];
  /** The plain text the inline content reads as. */
  text: string;
}

/** Parses `markdown` and reads its inline content as plain text, naming every live node. */
export function readLine(
  markdown: string,
  preset: keyof typeof parsers = 'commonmark',
): ParsedLine {
  const blocks: string[] = [];
  const live: string[] = [];
  const links: ParsedLine['links'] = [];
  let text = '';
  let link: ParsedLine['links'][number] | undefined;
  for (const token of parsers[preset].parse(markdown, {})) {
    if (token.type !== 'inline') {
      if (!token.type.startsWith('paragraph_')) blocks.push(token.type);
      continue;
    }
    for (const child of token.children ?? ([] as Token[])) {
      if (child.type === 'text' || child.type === 'text_special') {
        text += child.content;
        if (link) link.text += child.content;
      } else if (child.type === 'softbreak' || child.type === 'hardbreak') {
        text += '\n';
      } else if (child.type === 'link_open') {
        const href = child.attrGet('href');
        const opened = { href: href === null ? null : String(href), text: '' };
        links.push(opened);
        link = opened;
        live.push(child.type);
      } else if (child.type === 'link_close') {
        link = undefined;
      } else {
        live.push(child.type);
        text += child.content;
      }
    }
  }
  return { blocks, links, live, text };
}
