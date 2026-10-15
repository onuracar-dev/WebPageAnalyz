import { Fragment } from 'react';

const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

/** Renders engine text, turning Markdown links (Lighthouse and axe use them) into real links. */
export function InlineText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(LINK)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push(<Fragment key={`t${cursor}`}>{text.slice(cursor, index)}</Fragment>);
    parts.push(
      <a key={`a${index}`} href={match[2]} target="_blank" rel="noreferrer noopener">
        {match[1]}
      </a>,
    );
    cursor = index + match[0].length;
  }
  if (cursor < text.length) parts.push(<Fragment key={`t${cursor}`}>{text.slice(cursor)}</Fragment>);
  return <>{parts}</>;
}
