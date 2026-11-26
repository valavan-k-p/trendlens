import { useEffect, useRef, useState } from 'react';
import type { AnalysisReport } from '@core/analysis/types';
import type { ChartReviewRequest, ChartReviewResult } from '../../../shared/api';
import { Markdown } from '../lib/Markdown';
import { reportContext } from '../lib/report';

const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
const MAX_BYTES = 5 * 1024 * 1024;

interface Img {
  dataUrl: string;
  base64: string;
  mediaType: ChartReviewRequest['mediaType'];
  name: string;
}

function readFile(file: File): Promise<Img> {
  return new Promise((resolve, reject) => {
    if (!TYPES.includes(file.type as (typeof TYPES)[number])) return reject(new Error('Use a PNG, JPEG, WebP or GIF image.'));
    if (file.size > MAX_BYTES) return reject(new Error('Images must be 5 MB or smaller.'));
    const r = new FileReader();
    r.onload = () => {
      const dataUrl = String(r.result);
      resolve({ dataUrl, base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: file.type as Img['mediaType'], name: file.name || 'pasted-image' });
    };
    r.onerror = () => reject(new Error('Could not read the image.'));
    r.readAsDataURL(file);
  });
}

export function UploadView({ hasApiKey, currentReport, onOpenSettings, notify }: { hasApiKey: boolean; currentReport: AnalysisReport | null; onOpenSettings: () => void; notify: (msg: string, error?: boolean) => void }) {
  const [img, setImg] = useState<Img | null>(null);
  const [prompt, setPrompt] = useState('');
  const [useContext, setUseContext] = useState(true);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ChartReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const accept = async (file?: File | null) => {
    if (!file) return;
    try {
      setImg(await readFile(file));
      setResult(null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
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

  const review = async () => {
    if (!img) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await window.trendlens.reviewChart({
        imageBase64: img.base64,
        mediaType: img.mediaType,
        prompt,
        context: useContext && currentReport ? reportContext(currentReport) : undefined,
      });
      setResult(res);
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!result) return;
    const p = await window.trendlens.saveText(`chart-review-${new Date().toISOString().slice(0, 10)}.md`, `# AI chart review — ${img?.name ?? ''}\n\n${result.text}\n`);
    if (p) notify(`Saved to ${p}`);
  };

  return (
    <div className="page">
      <h2>AI chart review</h2>
      <p className="sub">Upload, paste (Ctrl+V) or drop a chart screenshot and get a structured educational review. Uses your own API key for Claude, OpenAI, Gemini, OpenRouter, Groq or any OpenAI-compatible server; the image is sent only to the provider you choose.</p>
      {!hasApiKey && (
        <div className="card" style={{ marginBottom: 14, borderColor: 'var(--warn)' }}>
          <b className="tone-warn">API key needed.</b> AI review calls the AI provider you pick in Settings (Claude, OpenAI, Gemini, OpenRouter, Groq or a local server) with your key, stored encrypted on this PC.{' '}
          <button className="btn btn-sm" onClick={onOpenSettings}>
            Open settings
          </button>
          <div style={{ color: 'var(--muted)', marginTop: 6 }}>Everything else in TrendLens works without a key — the Analyzer runs entirely on your machine.</div>
        </div>
      )}
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div
            className={`drop ${over ? 'over' : ''}`}
            onClick={() => fileInput.current?.click()}
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
            {img ? <img src={img.dataUrl} alt="Uploaded chart" /> : <div style={{ padding: 40 }}>Drop a chart image here, click to choose, or paste with Ctrl+V</div>}
          </div>
          <input ref={fileInput} type="file" accept={TYPES.join(',')} hidden onChange={(e) => void accept(e.target.files?.[0])} />
          <textarea rows={3} placeholder="Optional note: symbol, timeframe, or what you want reviewed…" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <label style={{ color: 'var(--muted)', display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={useContext} onChange={(e) => setUseContext(e.target.checked)} disabled={!currentReport} />
            Include the Analyzer's current report{currentReport ? ` (${currentReport.symbol})` : ' (none yet)'} as context
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" disabled={!img || busy || !hasApiKey} onClick={() => void review()}>
              {busy ? (
                <>
                  <span className="spinner" /> Reviewing…
                </>
              ) : (
                'Review chart'
              )}
            </button>
            {img && (
              <button className="btn" onClick={() => setImg(null)} disabled={busy}>
                Clear
              </button>
            )}
          </div>
          {error && <div className="tone-bear">{error}</div>}
        </div>
        <div className="card" style={{ minHeight: 300 }}>
          <h4>
            <span>Review {result ? `· ${result.provider} · ${result.model}` : ''}</span>
            {result && (
              <button className="btn btn-sm" onClick={() => void save()}>
                Save as Markdown
              </button>
            )}
          </h4>
          {result?.note && (
            <div className="tone-warn" style={{ fontSize: 12, marginBottom: 8 }}>
              {result.note}
            </div>
          )}
          {result ? <Markdown text={result.text} /> : <div style={{ color: 'var(--muted)' }}>The structured review appears here.</div>}
        </div>
      </div>
    </div>
  );
}
