import type { ReactNode } from 'react';

/** Minimal, safe Markdown renderer (headings, lists, bold, italics, code) — no raw HTML. */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|_[^_]+_|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${keyBase}-${i++}`;
    if (t.startsWith('**')) out.push(<b key={k}>{t.slice(2, -2)}</b>);
    else if (t.startsWith('`')) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else out.push(<i key={k}>{t.slice(1, -1)}</i>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flush = (k: number) => {
    if (para.length) {
      blocks.push(<p key={`p${k}`}>{inline(para.join(' '), `p${k}`)}</p>);
      para = [];
    }
    if (list.length) {
      blocks.push(
        <ul key={`u${k}`}>
          {list.map((li, j) => (
            <li key={j}>{inline(li, `u${k}-${j}`)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  text.split(/\r?\n/).forEach((raw, k) => {
    const line = raw.trimEnd();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
    if (h) {
      flush(k);
      const level = h[1].length;
      blocks.push(level <= 2 ? <h2 key={`h${k}`}>{inline(h[2], `h${k}`)}</h2> : <h3 key={`h${k}`}>{inline(h[2], `h${k}`)}</h3>);
    } else if (li) {
      if (para.length) flush(k);
      list.push(li[1]);
    } else if (!line.trim()) {
      flush(k);
    } else {
      if (list.length) flush(k);
      para.push(line.trim());
    }
  });
  flush(-1);
  return <div className="md">{blocks}</div>;
}
