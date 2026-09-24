import { Fragment, type ReactNode } from 'react';
import { type RichBlock, type RichInline } from '@readport/shared';

/**
 * A description laid out: the blocks the server made of whatever HTML or
 * Markdown a book's file carried (server/src/library/rich-text.ts), turned
 * into elements one by one. Nothing here reads markup - text is text, and a
 * link is followed only to an http, https or mailto address, checked again
 * here so a page never trusts a payload to have been checked.
 */

const FOLLOWABLE = /^(https?:|mailto:)/i;

function inlines(nodes: RichInline[], key: string): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}.${i}`;
    switch (n.t) {
      case 'text':
        return <Fragment key={k}>{n.v}</Fragment>;
      case 'br':
        return <br key={k} />;
      case 'b':
        return <strong key={k}>{inlines(n.c, k)}</strong>;
      case 'i':
        return <em key={k}>{inlines(n.c, k)}</em>;
      case 'u':
        return <u key={k}>{inlines(n.c, k)}</u>;
      case 's':
        return <s key={k}>{inlines(n.c, k)}</s>;
      case 'code':
        return <code key={k}>{inlines(n.c, k)}</code>;
      case 'sup':
        return <sup key={k}>{inlines(n.c, k)}</sup>;
      case 'sub':
        return <sub key={k}>{inlines(n.c, k)}</sub>;
      case 'a':
        return FOLLOWABLE.test(n.href) ? (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer nofollow">
            {inlines(n.c, k)}
          </a>
        ) : (
          <Fragment key={k}>{inlines(n.c, k)}</Fragment>
        );
      default:
        return null;
    }
  });
}

function block(b: RichBlock, key: string): ReactNode {
  switch (b.t) {
    case 'p':
      return <p key={key}>{inlines(b.c, key)}</p>;
    case 'h':
      return (
        <p key={key} className="rich__h">
          {inlines(b.c, key)}
        </p>
      );
    case 'ul':
    case 'ol': {
      const List = b.t;
      return (
        <List key={key}>
          {b.items.map((item, i) => (
            <li key={i}>
              {/* An item that is one paragraph is its words, without a paragraph's margins. */}
              {item.length === 1 && item[0]!.t === 'p'
                ? inlines(item[0]!.c, `${key}.${i}`)
                : item.map((x, j) => block(x, `${key}.${i}.${j}`))}
            </li>
          ))}
        </List>
      );
    }
    case 'quote':
      return <blockquote key={key}>{b.c.map((x, j) => block(x, `${key}.${j}`))}</blockquote>;
    case 'hr':
      return <hr key={key} />;
    default:
      return null;
  }
}

export function RichText({ blocks, className }: { blocks: RichBlock[]; className?: string }) {
  return (
    <div className={`rich${className ? ` ${className}` : ''}`}>
      {blocks.map((b, i) => block(b, String(i)))}
    </div>
  );
}
