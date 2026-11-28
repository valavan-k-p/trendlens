/**
 * AI Assistant: a chat for market news and questions. With Gemini or Claude it searches current
 * news (and the global drivers of commodities), judges credibility and gives a short directional
 * read with sources. A chart image can be attached (paste, drop or pick) to any question.
 */
import { useEffect, useRef, useState } from 'react';
import type { AnalysisReport } from '@core/analysis/types';
import type { ChatTurn } from '@core/ai/trading';
import type { AiChatResult, NewsMode } from '../../../shared/api';
import { Markdown } from '../lib/Markdown';
import { callUsageText, UsageSummaryBar, useUsage } from '../components/AiUsage';

const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
const MAX_BYTES = 5 * 1024 * 1024;
const STORE = 'trendlens.assistant.v1';
const QUICK = ['NIFTY news impact', 'BANKNIFTY news', 'Natural gas outlook', 'Crude oil news', 'Gold news', 'SENSEX news'];

interface Img {
  dataUrl: string;
  base64: string;
  mediaType: string;
  name: string;
}

interface Msg extends ChatTurn {
  id: number;
  imageUrl?: string;
  meta?: Pick<AiChatResult, 'sources' | 'model' | 'provider' | 'searched' | 'tokens' | 'note' | 'usage'>;
  error?: boolean;
}

function readFile(file: File): Promise<Img> {
  return new Promise((resolve, reject) => {
    if (!TYPES.includes(file.type as (typeof TYPES)[number])) return reject(new Error('Use a PNG, JPEG, WebP or GIF image.'));
    if (file.size > MAX_BYTES) return reject(new Error('Images must be 5 MB or smaller.'));
    const r = new FileReader();
    r.onload = () => {
      const dataUrl = String(r.result);
      resolve({ dataUrl, base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: file.type, name: file.name || 'pasted-image' });
    };
    r.onerror = () => reject(new Error('Could not read the image.'));
    r.readAsDataURL(file);
  });
}

const cleanError = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function load(): Msg[] {
  try {
    return (JSON.parse(localStorage.getItem(STORE) ?? '[]') as Msg[]).slice(-40);
  } catch {
    return [];
  }
}

export function UploadView({ hasApiKey, currentReport, onOpenSettings }: { hasApiKey: boolean; currentReport: AnalysisReport | null; onOpenSettings: () => void; notify: (msg: string, error?: boolean) => void }) {
  const [msgs, setMsgs] = useState<Msg[]>(load);
  const [text, setText] = useState('');
  const [img, setImg] = useState<Img | null>(null);
  const [newsMode, setNewsMode] = useState<NewsMode>(() => (localStorage.getItem('trendlens.assistant.news') as NewsMode) || 'rss');
  useEffect(() => localStorage.setItem('trendlens.assistant.news', newsMode), [newsMode]);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const usage = useUsage(msgs.length);

  // Persist the conversation without images (they are large and only sent once).
  useEffect(() => {
    localStorage.setItem(STORE, JSON.stringify(msgs.slice(-40).map(({ imageBase64: _a, imageUrl: _b, ...m }) => m)));
    end.current?.scrollIntoView({ block: 'end' });
  }, [msgs]);

  const accept = async (file?: File | null) => {
    if (!file) return;
    try {
      setImg(await readFile(file));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = Array.from(e.clipboardData?.files ?? []).find((x) => x.type.startsWith('image/'));
      if (f) void accept(f);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  const send = async (q = text) => {
    const question = q.trim() || (img ? 'Review this chart: trend, key levels, and whether a CE or PE entry is valid now.' : '');
    if (!question || busy) return;
    const user: Msg = { id: Date.now(), role: 'user', text: question, imageBase64: img?.base64, mediaType: img?.mediaType, imageUrl: img?.dataUrl };
    const next = [...msgs, user];
    setMsgs(next);
    setText('');
    setImg(null);
    setBusy(true);
    setErr(null);
    try {
      // A one-line hint about the instrument on screen helps short questions ("news?").
      const hint = currentReport ? `\n[On screen: ${currentReport.symbol} ${currentReport.timeframe} last ${currentReport.lastPrice}, engine ${currentReport.condition}]` : '';
      const turns: ChatTurn[] = next.filter((m) => !m.error).map((m, i, all) => ({ role: m.role, text: i === all.length - 1 ? m.text + hint : m.text, imageBase64: m.imageBase64, mediaType: m.mediaType }));
      const r = await window.trendlens.aiChat({ turns, newsMode, symbol: currentReport?.symbol });
      setMsgs((m) => [...m, { id: Date.now(), role: 'assistant', text: r.text, meta: { sources: r.sources, model: r.model, provider: r.provider, searched: r.searched, tokens: r.tokens, note: r.note, usage: r.usage } }]);
    } catch (e) {
      setMsgs((m) => [...m, { id: Date.now(), role: 'assistant', text: cleanError(e), error: true }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`page chat-page ${over ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void accept(e.dataTransfer.files[0]);
      }}
    >
      <div className="chat-head">
        <h2>AI Assistant</h2>
        <span className="sub">Ask about news and what may move NIFTY, BANKNIFTY, SENSEX, crude, natural gas, gold… Drop or paste a chart to ask about it.</span>
        <span className="spacer" />
        <UsageSummaryBar summary={usage} />
        <label className="chat-toggle" title="Free headlines: TrendLens reads Google News RSS, Economic Times, Mint, Business Standard and RBI feeds and sends the relevant ones (works on a free Gemini key). Google Search: also lets the AI search the web (paid Gemini key or Claude; billed per search).">
          News
          <select value={newsMode} onChange={(e) => setNewsMode(e.target.value as NewsMode)}>
            <option value="rss">Free headlines</option>
            <option value="search">Free headlines + Google Search</option>
            <option value="off">Off</option>
          </select>
        </label>
        {msgs.length > 0 && (
          <button className="btn btn-sm" onClick={() => setMsgs([])} disabled={busy}>
            New chat
          </button>
        )}
      </div>

      {!hasApiKey && (
        <div className="card" style={{ borderColor: 'var(--warn)' }}>
          <b className="tone-warn">AI key needed.</b> Add a Gemini or Claude key in Settings for live news search.{' '}
          <button className="btn btn-sm" onClick={onOpenSettings}>
            Open settings
          </button>
        </div>
      )}

      <div className="chat-log">
        {!msgs.length && (
          <div className="chat-empty">
            <p>Try one of these, or type your own question:</p>
            <div className="chat-quick">
              {QUICK.map((q) => (
                <button key={q} className="toggle" onClick={() => void send(q)} disabled={busy || !hasApiKey}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={`chat-msg ${m.role} ${m.error ? 'error' : ''}`}>
            {m.imageUrl && <img src={m.imageUrl} alt="attached chart" />}
            {m.role === 'assistant' && !m.error ? <Markdown text={m.text} /> : <div className="chat-text">{m.text}</div>}
            {m.meta && (
              <div className="chat-meta">
                {m.meta.sources.length > 0 && (
                  <div className="chat-sources">
                    {m.meta.sources.map((s, i) => (
                      <a key={s.url} href="#" title={s.url} onClick={(e) => (e.preventDefault(), void window.trendlens.openExternal(s.url))}>
                        [{i + 1}] {s.title || new URL(s.url).hostname}
                      </a>
                    ))}
                  </div>
                )}
                <span>
                  {m.meta.provider} · {m.meta.model}
                  {m.meta.searched ? ' · searched the web' : ''} · {callUsageText(m.meta.usage, m.meta.tokens)}
                  {m.meta.note ? ` · ${m.meta.note}` : ''}
                </span>
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="chat-msg assistant">
            <span className="spinner" /> {newsMode !== 'off' ? 'Reading the latest headlines and analysing…' : 'Thinking…'}
          </div>
        )}
        <div ref={end} />
      </div>

      {err && <div className="tone-bear">{err}</div>}
      <div className="chat-input">
        {img && (
          <div className="chat-attach">
            <img src={img.dataUrl} alt="" />
            <span>{img.name}</span>
            <button className="btn btn-sm" onClick={() => setImg(null)}>
              ✕
            </button>
          </div>
        )}
        <button className="btn" title="Attach a chart image" onClick={() => fileInput.current?.click()} disabled={busy}>
          📎
        </button>
        <input ref={fileInput} type="file" accept={TYPES.join(',')} hidden onChange={(e) => void accept(e.target.files?.[0])} />
        <textarea
          rows={2}
          placeholder="e.g. Natural gas news — will it go up this week?"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn btn-primary" onClick={() => void send()} disabled={busy || !hasApiKey || (!text.trim() && !img)}>
          Send
        </button>
      </div>
      <p className="disclaimer">AI answers can be wrong or out of date; check the sources. Not financial advice.</p>
    </div>
  );
}
