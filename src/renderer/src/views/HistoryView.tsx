import { useEffect, useState } from 'react';
import { timeframeLabel } from '@core/types';
import type { HistoryEntry } from '../../../shared/api';
import { ReportView } from '../components/ReportView';
import { conditionTone, reportToMarkdown, toneClass } from '../lib/report';

export function HistoryView({ onOpenSymbol, notify }: { onOpenSymbol: (e: HistoryEntry) => void; notify: (msg: string, error?: boolean) => void }) {
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    void window.trendlens.listHistory().then((h) => {
      setItems(h);
      setSel(h[0]?.id ?? null);
    });
  }, []);

  const shown = items.filter((e) => !filter.trim() || `${e.report.symbol} ${e.report.name ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  const current = items.find((e) => e.id === sel);

  const remove = async (id: string) => {
    const next = await window.trendlens.deleteHistory(id);
    setItems(next);
    if (sel === id) setSel(next[0]?.id ?? null);
  };

  const exportMd = async (e: HistoryEntry) => {
    const p = await window.trendlens.saveText(`${e.report.symbol.replace(/[^A-Za-z0-9.-]/g, '')}-${e.report.timeframe}-${new Date(e.savedAt).toISOString().slice(0, 10)}.md`, reportToMarkdown(e.report));
    if (p) notify(`Saved to ${p}`);
  };

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column' }}>
      <h2>Analysis history</h2>
      <p className="sub">Saved reports, stored locally. Revisit past observations and compare them with how price developed.</p>
      {items.length === 0 ? (
        <div className="empty">
          <h3>No saved reports yet</h3>
          Run an analysis and press <b>Save</b> to keep it here.
        </div>
      ) : (
        <div className="hist" style={{ flex: 1, minHeight: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
            <input className="input" placeholder="Filter by symbol…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div className="hist-list">
              {shown.map((e) => (
                <div key={e.id} className={`hist-item ${e.id === sel ? 'sel' : ''}`} onClick={() => setSel(e.id)}>
                  <b>
                    {e.report.symbol} · {timeframeLabel(e.report.timeframe)}
                  </b>
                  <span className={toneClass(conditionTone(e.report.condition))}>{e.report.condition}</span>
                  <small>
                    {new Date(e.savedAt).toLocaleString()} · conf {e.report.confidence}% · risk {e.report.risk.level}
                  </small>
                </div>
              ))}
            </div>
          </div>
          <div style={{ overflowY: 'auto', minHeight: 0 }}>
            {current && (
              <>
                <div style={{ display: 'flex', gap: 8, padding: '0 14px' }}>
                  <button className="btn btn-sm" onClick={() => onOpenSymbol(current)}>
                    Open chart now
                  </button>
                  <button className="btn btn-sm" onClick={() => void exportMd(current)}>
                    Export Markdown
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => void remove(current.id)}>
                    Delete
                  </button>
                </div>
                <ReportView report={current.report} />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
