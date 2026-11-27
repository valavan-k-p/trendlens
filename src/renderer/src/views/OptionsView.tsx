/**
 * Option Chain page: market selection, live chain with auto-refresh, analytics dashboard,
 * OI analysis, Greeks and IV, Max Pain, and locally captured history. All data comes through the
 * main process; nothing here talks to the network or the disk directly.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { analyzeGreeks, ivRankPercentile } from '@core/options/iv-analysis';
import { summarizeChain } from '@core/options/option-analytics';
import { filterRows, sortRows, strikeWindow, type SortKey } from '@core/options/option-chain';
import { chainFreshness, expiryMoment, marketSession } from '@core/options/option-contracts';
import { fromSnapshot, toSnapshot } from '@core/options/option-snapshots';
import type { ParsedOptionCsv } from '@core/options/providers/csv';
import { IST_OFFSET, type OptionChain, type OptionExchange, type UnderlyingKind } from '@core/options/types';
import type { Mt4OptionCatalog, OptionCatalog, OptionSnapshotMeta, Settings } from '../../../shared/api';
import { AnalyticsCards } from '../components/options/AnalyticsCards';
import { ChainTable } from '../components/options/ChainTable';
import { GreeksPanel } from '../components/options/GreeksPanel';
import { HistoryPanel } from '../components/options/HistoryPanel';
import { MaxPainPanel } from '../components/options/MaxPainPanel';
import { OiAnalysis } from '../components/options/OiAnalysis';
import { age, expiryLabel, istTime, num, strike } from '../lib/optionsFormat';

type Tab = 'chain' | 'oi' | 'greeks' | 'maxpain' | 'history';
const TABS: [Tab, string][] = [
  ['chain', 'Option Chain'],
  ['oi', 'OI Analysis'],
  ['greeks', 'Greeks & IV'],
  ['maxpain', 'Max Pain'],
  ['history', 'History'],
];
const KIND_LABEL: Record<UnderlyingKind, string> = { index: 'Index', stock: 'Stock', commodity: 'Commodity' };
const PROVIDER_LABEL = { upstox: 'Upstox', dhan: 'Dhan' } as const;
const PREFS = 'trendlens.options.v1';

type Source = 'api' | 'mt4';

interface Prefs {
  source: Source;
  mt4Key: string;
  mt4Expiry: string;
  exchange: OptionExchange;
  kind: UnderlyingKind;
  underlyingId: string;
  expiry: string;
  range: number | 'all';
  units: 'lots' | 'units';
  refreshSec: number;
  show: 'both' | 'calls' | 'puts';
}
const DEFAULT_PREFS: Prefs = { source: 'api', mt4Key: 'NIFTY:W', mt4Expiry: '', exchange: 'NSE', kind: 'index', underlyingId: 'NSE:NIFTY', expiry: '', range: 15, units: 'lots', refreshSec: 30, show: 'both' };
function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREFS) ?? '{}') as Partial<Prefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

const cleanError = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const istDay = (t: number) => new Date((t + IST_OFFSET) * 1000).toISOString().slice(0, 10);

/** The ATM IV of the nearest expiry captured on each IST day, for IV rank/percentile. */
function dailyAtmIv(metas: OptionSnapshotMeta[]): { t: number; atmIv?: number }[] {
  const byDay = new Map<string, OptionSnapshotMeta>();
  for (const m of metas) {
    const d = istDay(m.t);
    const cur = byDay.get(d);
    if (!cur || m.expiry < cur.expiry || (m.expiry === cur.expiry && m.t > cur.t)) byDay.set(d, m);
  }
  return [...byDay.values()].map((m) => ({ t: m.t, atmIv: m.summary.atmIv }));
}

function CsvImportDialog({
  file,
  catalog,
  onCancel,
  onLoad,
}: {
  file: { fileName: string; parsed: ParsedOptionCsv };
  catalog: OptionCatalog | null;
  onCancel: () => void;
  onLoad: (chain: OptionChain, save: boolean) => void;
}) {
  const p = file.parsed;
  const match = catalog?.underlyings.find((u) => u.symbol === p.symbol);
  const [exchange, setExchange] = useState<OptionExchange>(match?.exchange ?? catalog?.exchange ?? 'NSE');
  const [symbol, setSymbol] = useState(p.symbol ?? '');
  const [expiry, setExpiry] = useState(p.expiry ?? '');
  const [spot, setSpot] = useState('');
  const [oiUnit, setOiUnit] = useState<'lots' | 'units'>(p.oiUnitHint ?? 'units');
  const [lot, setLot] = useState(match?.lotSize ? String(match.lotSize) : '');
  const [futures, setFutures] = useState(exchange === 'MCX');
  const [dataTime, setDataTime] = useState('');
  const [save, setSave] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = () => {
    try {
      if (!symbol.trim()) throw new Error('Enter the underlying symbol.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw new Error('Enter the expiry date.');
      const t = dataTime ? Date.parse(`${dataTime}:00+05:30`) / 1000 : Date.now() / 1000;
      if (!Number.isFinite(t)) throw new Error('The data time is not valid.');
      const spotN = spot.trim() ? Number(spot.replace(/,/g, '')) : undefined;
      if (spotN !== undefined && !(spotN > 0)) throw new Error('The underlying price must be a positive number.');
      const lotN = lot.trim() ? Number(lot) : undefined;
      const sym = symbol.trim().toUpperCase();
      const chain: OptionChain = {
        provider: 'csv',
        exchange,
        symbol: sym,
        underlyingId: `${exchange}:${sym}`,
        expiry,
        expiryTime: expiryMoment(expiry, exchange),
        underlyingPrice: spotN,
        underlyingIsFutures: futures,
        lotSize: lotN && lotN > 0 ? lotN : undefined,
        oiUnit,
        fetchedAt: t,
        rows: p.rows,
        notes: [`Imported from ${file.fileName}${dataTime ? '' : '; the data time is the import time because the file does not state it'}.`],
      };
      onLoad(chain, save);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <h2>Import option chain CSV</h2>
        <p className="oc-note" style={{ marginTop: 0 }}>
          {file.fileName}: {p.rows.length} strikes, {p.layout === 'nse' ? 'NSE website layout (OI in contracts)' : 'generic layout'}. Fill in what the file does not say.
        </p>
        <div className="field">
          <label>Exchange</label>
          <select className="input" value={exchange} onChange={(e) => setExchange(e.target.value as OptionExchange)}>
            <option>NSE</option>
            <option>BSE</option>
            <option>MCX</option>
          </select>
        </div>
        <div className="field">
          <label>Underlying symbol</label>
          <input className="input" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="NIFTY" />
        </div>
        <div className="field">
          <label>Expiry</label>
          <input className="input" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </div>
        <div className="field">
          <label>Underlying price</label>
          <input className="input" value={spot} onChange={(e) => setSpot(e.target.value)} placeholder="optional; otherwise derived from put-call parity" />
        </div>
        <div className="field">
          <label>OI counted in</label>
          <select className="input" value={oiUnit} onChange={(e) => setOiUnit(e.target.value as 'lots' | 'units')}>
            <option value="lots">Contracts / lots</option>
            <option value="units">Units (quantity)</option>
          </select>
        </div>
        <div className="field">
          <label>Lot size</label>
          <input className="input" value={lot} onChange={(e) => setLot(e.target.value)} placeholder="units per lot, e.g. 65 for NIFTY" />
        </div>
        <div className="field">
          <label>Data time (IST)</label>
          <input className="input" type="datetime-local" value={dataTime} onChange={(e) => setDataTime(e.target.value)} />
        </div>
        <div className="field">
          <label>Options on futures</label>
          <label style={{ color: 'var(--text)' }}>
            <input type="checkbox" checked={futures} onChange={(e) => setFutures(e.target.checked)} /> the underlying price is a futures price (Black-76)
          </label>
        </div>
        <div className="field">
          <label>History</label>
          <label style={{ color: 'var(--text)' }}>
            <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> save as a snapshot
          </label>
        </div>
        {err && <div className="tone-bear">{err}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={load}>
            Load chain
          </button>
        </div>
      </div>
    </div>
  );
}

export function OptionsView({ settings, active, notify, onOpenSettings }: { settings: Settings; active: boolean; notify: (m: string, e?: boolean) => void; onOpenSettings: () => void }) {
  const init = useMemo(loadPrefs, []);
  const [source, setSource] = useState<Source>(init.source);
  const [mt4Key, setMt4Key] = useState(init.mt4Key);
  const [mt4Expiry, setMt4Expiry] = useState(init.mt4Expiry);
  const [mt4Cat, setMt4Cat] = useState<Mt4OptionCatalog | null>(null);
  const [exchange, setExchange] = useState<OptionExchange>(init.exchange);
  const [kind, setKind] = useState<UnderlyingKind>(init.kind);
  const [underlyingId, setUnderlyingId] = useState(init.underlyingId);
  const [expiry, setExpiry] = useState(init.expiry);
  const [range, setRange] = useState<number | 'all'>(init.range);
  const [units, setUnits] = useState<'lots' | 'units'>(init.units);
  const [refreshSec, setRefreshSec] = useState(init.refreshSec);
  const [show, setShow] = useState(init.show);
  const [catalog, setCatalog] = useState<OptionCatalog | null>(null);
  const [catLoading, setCatLoading] = useState(false);
  const [live, setLive] = useState<OptionChain | null>(null);
  const [offline, setOffline] = useState<{ chain: OptionChain; label: string } | null>(null);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastOk, setLastOk] = useState<number | undefined>();
  const [selected, setSelected] = useState<number | undefined>();
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'strike', dir: 'asc' });
  const [search, setSearch] = useState('');
  const [money, setMoney] = useState<'all' | 'call-itm' | 'put-itm'>('all');
  const [hideEmpty, setHideEmpty] = useState(false);
  const [tab, setTab] = useState<Tab>('chain');
  const [metas, setMetas] = useState<OptionSnapshotMeta[]>([]);
  const [csv, setCsv] = useState<{ fileName: string; parsed: ParsedOptionCsv } | null>(null);
  const [now, setNow] = useState(Date.now() / 1000);
  const prevLive = useRef<OptionChain | null>(null);
  const inflight = useRef(false);
  const keyRef = useRef('');

  useEffect(() => {
    localStorage.setItem(PREFS, JSON.stringify({ source, mt4Key, mt4Expiry, exchange, kind, underlyingId, expiry, range, units, refreshSec, show } satisfies Prefs));
  }, [source, mt4Key, mt4Expiry, exchange, kind, underlyingId, expiry, range, units, refreshSec, show]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 5000);
    return () => clearInterval(id);
  }, []);

  // ---- instrument catalog (public instrument lists, cached by the main process)
  const loadCatalog = useCallback(
    async (refresh = false) => {
      setCatLoading(true);
      try {
        setCatalog(await window.trendlens.optionCatalog(exchange, refresh));
      } catch (e) {
        setCatalog({ exchange, source: 'upstox', underlyings: [], chainProvider: 'upstox', configured: false, error: cleanError(e) });
      } finally {
        setCatLoading(false);
      }
    },
    [exchange],
  );
  useEffect(() => {
    if (active && source === 'api') void loadCatalog();
    // Settings changes (provider, credentials) re-evaluate what is configured.
  }, [active, source, loadCatalog, settings.optionProvider, settings.optionKeys.upstox, settings.optionKeys.dhan]);

  // ---- MetaTrader 4 option series (prices only, from the TrendLensFeed EA)
  const loadMt4 = useCallback(async () => {
    try {
      setMt4Cat(await window.trendlens.mt4OptionCatalog());
    } catch (e) {
      setMt4Cat({ series: [], exportFound: false, error: cleanError(e) });
    }
  }, []);
  useEffect(() => {
    if (!active || source !== 'mt4') return;
    void loadMt4();
    const id = setInterval(() => void loadMt4(), 30_000);
    return () => clearInterval(id);
  }, [active, source, loadMt4]);
  const mt4Series = mt4Cat?.series.find((s) => s.key === mt4Key);
  useEffect(() => {
    if (!mt4Cat?.series.length) return;
    if (!mt4Series) setMt4Key((mt4Cat.series.find((s) => s.key === 'NIFTY:W') ?? mt4Cat.series[0]).key);
  }, [mt4Cat, mt4Series]);
  useEffect(() => {
    if (mt4Series && mt4Series.expiries.length && !mt4Series.expiries.includes(mt4Expiry)) setMt4Expiry(mt4Series.defaultExpiry ?? mt4Series.expiries[0]);
  }, [mt4Series, mt4Expiry]);
  const mt4Ready = !!mt4Series && /^\d{4}-\d{2}-\d{2}$/.test(mt4Expiry);

  const kinds = useMemo(() => [...new Set((catalog?.underlyings ?? []).map((u) => u.kind))], [catalog]);
  const list = useMemo(() => (catalog?.underlyings ?? []).filter((u) => u.kind === kind), [catalog, kind]);
  const underlying = catalog?.underlyings.find((u) => u.id === underlyingId);
  const [undText, setUndText] = useState('');
  useEffect(() => setUndText(underlying?.symbol ?? ''), [underlying?.symbol]);

  // Keep selections valid when the catalog or exchange changes.
  useEffect(() => {
    if (!catalog || catalog.exchange !== exchange || !catalog.underlyings.length) return;
    if (!kinds.includes(kind)) return setKind(kinds[0]);
    if (!list.some((u) => u.id === underlyingId)) {
      const pref = ['NIFTY', 'SENSEX', 'CRUDEOIL', 'BANKNIFTY'];
      setUnderlyingId((list.find((u) => pref.includes(u.symbol)) ?? list[0])?.id ?? '');
    }
  }, [catalog, exchange, kinds, kind, list, underlyingId]);
  useEffect(() => {
    if (underlying && !underlying.expiries.includes(expiry)) setExpiry(underlying.expiries[0]);
  }, [underlying, expiry]);

  const chainKey = source === 'mt4' ? `mt4|${mt4Key}|${mt4Expiry}` : `${exchange}|${underlyingId}|${expiry}`;
  useEffect(() => {
    keyRef.current = chainKey;
    setLive(null);
    prevLive.current = null;
    setError(null);
    setLastOk(undefined);
    setSelected(undefined);
  }, [chainKey]);

  // ---- snapshots for this underlying
  const symbol = offline?.chain.symbol ?? (source === 'mt4' ? mt4Series?.underlying : underlying?.symbol);
  const symbolExchange = offline?.chain.exchange ?? (source === 'mt4' ? mt4Series?.exchange : undefined) ?? exchange;
  const loadMetas = useCallback(async () => {
    const ex = symbolExchange;
    if (!symbol) return setMetas([]);
    try {
      setMetas(await window.trendlens.optionSnapshots(ex, symbol));
    } catch {
      setMetas([]);
    }
  }, [symbolExchange, symbol]);
  useEffect(() => {
    if (active) void loadMetas();
  }, [active, loadMetas]);

  // ---- live fetch + auto refresh
  const fetchNow = useCallback(async () => {
    if (inflight.current) return;
    if (source === 'mt4' ? !mt4Ready : !catalog?.configured || !underlying || !expiry || !underlying.expiries.includes(expiry)) return;
    inflight.current = true;
    setFetching(true);
    const key = chainKey;
    try {
      const r = source === 'mt4' ? await window.trendlens.mt4OptionChain({ key: mt4Key, expiry: mt4Expiry }) : await window.trendlens.optionChain({ exchange, underlyingId, expiry });
      if (keyRef.current !== key) return;
      setLive((prev) => {
        if (prev && prev.fetchedAt !== r.chain.fetchedAt) prevLive.current = prev;
        return r.chain;
      });
      setLastOk(r.chain.fetchedAt);
      setError(null);
      if (r.saved) void loadMetas();
    } catch (e) {
      if (keyRef.current === key) setError(cleanError(e));
    } finally {
      inflight.current = false;
      setFetching(false);
    }
  }, [source, mt4Ready, mt4Key, mt4Expiry, catalog, underlying, expiry, exchange, underlyingId, chainKey, loadMetas]);

  const canFetch = source === 'mt4' ? mt4Ready : !!catalog?.configured;
  useEffect(() => {
    if (!active || offline || !canFetch) return;
    void fetchNow();
    if (refreshSec <= 0) return;
    const id = setInterval(() => void fetchNow(), refreshSec * 1000);
    return () => clearInterval(id);
    // fetchNow changes with the selection; the interval restarts with it.
  }, [active, offline, canFetch, refreshSec, fetchNow]);

  // ---- derived data
  const chain = offline?.chain ?? live;
  const r = settings.optionRiskFreeRate / 100;
  const qFallback = settings.optionDividendYield / 100;
  const greeks = useMemo(() => (chain ? analyzeGreeks(chain, { r, qFallback, now: chain.fetchedAt }) : null), [chain, r, qFallback]);
  const price = chain?.underlyingPrice ?? greeks?.underlying;
  const summary = useMemo(() => (chain ? summarizeChain(chain, price) : null), [chain, price]);
  const windowRows = useMemo(() => (chain && summary ? strikeWindow(chain.rows, summary.atm, range) : []), [chain, summary, range]);
  const shownRows = useMemo(() => sortRows(filterRows(windowRows, { search, moneyness: money, hideEmpty }, price), sort.key, sort.dir), [windowRows, search, money, hideEmpty, price, sort]);
  const windowStrikes = useMemo(() => new Set(windowRows.map((x) => x.strike)), [windowRows]);
  // Where the source gives no IV (MT4, some CSVs), the table shows the calculated IV instead.
  const tableRows = useMemo(() => {
    if (!greeks) return shownRows;
    const byStrike = new Map(greeks.rows.map((g) => [g.strike, g]));
    const fill = (q: OptionChain['rows'][number]['call'], iv: number | undefined) => (q && q.iv === undefined && iv !== undefined ? { ...q, iv } : q);
    return shownRows.map((r) => {
      const g = byStrike.get(r.strike);
      return { strike: r.strike, call: fill(r.call, g?.call?.ivCalculated), put: fill(r.put, g?.put?.ivCalculated) };
    });
  }, [shownRows, greeks]);
  const hasOi = !!chain?.rows.some((x) => x.call?.oi !== undefined || x.put?.oi !== undefined);
  const prevGreeks = useMemo(() => (prevLive.current && !offline ? analyzeGreeks(prevLive.current, { r, qFallback, now: prevLive.current.fetchedAt }) : null), [live, offline, r, qFallback]);

  const ivChange = useMemo(() => {
    if (!chain || !greeks?.atmIv) return undefined;
    const out: { vsPrev?: number; prevLabel?: string; vsDay?: number; dayLabel?: string } = {};
    if (prevGreeks?.atmIv !== undefined && prevLive.current) {
      out.vsPrev = greeks.atmIv - prevGreeks.atmIv;
      out.prevLabel = `refresh at ${istTime(prevLive.current.fetchedAt, false).slice(0, 8)}`;
    }
    const today = istDay(chain.fetchedAt);
    const earlier = metas.filter((m) => m.expiry === chain.expiry && istDay(m.t) < today && m.summary.atmIv !== undefined);
    const last = earlier[earlier.length - 1];
    if (last) {
      out.vsDay = greeks.atmIv - last.summary.atmIv!;
      out.dayLabel = `last capture ${istTime(last.t).slice(0, 11)}`;
    }
    return out;
  }, [chain, greeks, prevGreeks, metas]);
  const ivStats = useMemo(() => ivRankPercentile(dailyAtmIv(metas), greeks?.atmIv), [metas, greeks]);

  const onSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'strike' ? 'asc' : 'desc' }));
  const pick = (k: number) => {
    setSelected(k);
    setTab('chain');
  };

  const importCsv = async () => {
    try {
      const f = await window.trendlens.importOptionCsv();
      if (f) setCsv(f);
    } catch (e) {
      notify(cleanError(e), true);
    }
  };
  const loadCsvChain = async (c: OptionChain, save: boolean) => {
    setCsv(null);
    setOffline({ chain: c, label: `Imported CSV · ${c.symbol} ${c.expiry}` });
    if (save) {
      try {
        const g = analyzeGreeks(c, { r, qFallback, now: c.fetchedAt });
        const s = summarizeChain(c, c.underlyingPrice ?? g.underlying);
        await window.trendlens.saveOptionSnapshot(
          toSnapshot(c, { spot: c.underlyingPrice, pcrOi: s.pcr.oi, pcrVolume: s.pcr.volume, maxPain: s.maxPain?.strike, atm: s.atm, atmIv: g.atmIv, callOi: s.totalCallOi, putOi: s.totalPutOi }),
        );
        notify('Imported chain saved as a snapshot.');
        void loadMetas();
      } catch (e) {
        notify(cleanError(e), true);
      }
    }
  };
  const viewSnapshot = async (m: OptionSnapshotMeta) => {
    const ex = chain?.exchange ?? exchange;
    const sym = chain?.symbol ?? symbol;
    if (!sym) return;
    const s = await window.trendlens.loadOptionSnapshot(ex, sym, m.expiry, m.t);
    if (!s) return notify('That snapshot could not be read.', true);
    setOffline({ chain: fromSnapshot(s), label: `Snapshot · ${sym} ${m.expiry} · captured ${istTime(m.t)}` });
    setTab('chain');
  };

  // ---- status line
  const session = marketSession(chain?.exchange ?? exchange, now);
  const freshness = chain ? chainFreshness(chain.fetchedAt, now, chain.exchange, refreshSec || 60) : 'stale';
  const provider = catalog?.chainProvider;
  const sel = chain?.rows.find((x) => x.strike === selected);
  const selG = greeks?.rows.find((x) => x.strike === selected);

  return (
    <div className="page oc-page">
      <div className="oc-controls">
        <label>
          Source
          <select value={source} onChange={(e) => setSource(e.target.value as Source)}>
            <option value="api">Broker API (OI, IV)</option>
            <option value="mt4">MetaTrader 4 (prices)</option>
          </select>
        </label>
        {source === 'mt4' ? (
          <>
            <label>
              MT4 series
              <select value={mt4Key} onChange={(e) => setMt4Key(e.target.value)} disabled={!mt4Cat?.series.length}>
                {(mt4Cat?.series ?? []).map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.underlying} · {s.weekly ? 'weekly' : 'monthly'} ({s.exchange}, {s.strikes} strikes)
                  </option>
                ))}
                {!mt4Cat?.series.length && <option value={mt4Key}>{mt4Cat ? 'none found' : 'loading…'}</option>}
              </select>
            </label>
            <label>
              Expiry {mt4Series && mt4Expiry === mt4Series.defaultExpiry ? '(assumed)' : ''}
              {mt4Series?.expiries.length ? (
                <select value={mt4Expiry} onChange={(e) => setMt4Expiry(e.target.value)}>
                  {mt4Series.expiries.map((x) => (
                    <option key={x} value={x}>
                      {expiryLabel(x)}
                      {x === mt4Series.defaultExpiry ? ' · assumed' : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <input type="date" value={mt4Expiry} onChange={(e) => setMt4Expiry(e.target.value)} />
              )}
            </label>
          </>
        ) : (
          <>
        <label>
          Exchange
          <select value={exchange} onChange={(e) => setExchange(e.target.value as OptionExchange)}>
            <option>NSE</option>
            <option>BSE</option>
            <option>MCX</option>
          </select>
        </label>
        <label>
          Instrument
          <select value={kind} onChange={(e) => setKind(e.target.value as UnderlyingKind)} disabled={!kinds.length}>
            {(kinds.length ? kinds : [kind]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Underlying
          <input
            list="oc-underlyings"
            className="oc-und"
            value={undText}
            onChange={(e) => {
              setUndText(e.target.value);
              const v = e.target.value.trim().toUpperCase();
              const u = list.find((x) => x.symbol === v);
              if (u) setUnderlyingId(u.id);
            }}
            onBlur={() => setUndText(underlying?.symbol ?? '')}
            onFocus={(e) => e.target.select()}
            placeholder={catLoading ? 'Loading…' : 'Symbol'}
          />
          <datalist id="oc-underlyings">
            {list.map((u) => (
              <option key={u.id} value={u.symbol}>
                {u.name}
                {u.lotSize ? ` · lot ${u.lotSize}` : ''}
              </option>
            ))}
          </datalist>
        </label>
        <label>
          Expiry
          <select value={expiry} onChange={(e) => setExpiry(e.target.value)} disabled={!underlying}>
            {(underlying?.expiries ?? []).map((x) => (
              <option key={x} value={x}>
                {expiryLabel(x)}
              </option>
            ))}
          </select>
        </label>
          </>
        )}
        <label>
          Show
          <select value={show} onChange={(e) => setShow(e.target.value as Prefs['show'])}>
            <option value="both">Calls & Puts</option>
            <option value="calls">Calls</option>
            <option value="puts">Puts</option>
          </select>
        </label>
        <label>
          Strikes
          <select value={String(range)} onChange={(e) => setRange(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            {[5, 10, 15, 20, 30, 50].map((n) => (
              <option key={n} value={n}>
                ATM ± {n}
              </option>
            ))}
            <option value="all">All</option>
          </select>
        </label>
        {source !== 'mt4' && (
        <label>
          OI in
          <select value={units} onChange={(e) => setUnits(e.target.value as 'lots' | 'units')}>
            <option value="lots">Lots</option>
            <option value="units">Quantity</option>
          </select>
        </label>
        )}
        <label>
          Auto-refresh
          <select value={refreshSec} onChange={(e) => setRefreshSec(Number(e.target.value))}>
            <option value={0}>Off</option>
            {[5, 10, 15, 30, 60, 120].map((n) => (
              <option key={n} value={n}>
                {n < 60 ? `${n} s` : `${n / 60} min`}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-sm" onClick={() => void fetchNow()} disabled={fetching || !canFetch || !!offline} title="Refresh now">
          {fetching ? <span className="spinner" /> : '⟳ Refresh'}
        </button>
        <button className="btn btn-sm" onClick={() => void importCsv()} title="Load an option-chain CSV (e.g. downloaded from the NSE website)">
          Import CSV
        </button>
      </div>

      <div className="oc-status">
        {offline ? (
          <>
            <span className="tone-warn">● {offline.label}</span>
            <span>{offline.chain.notes?.join(' ')}</span>
            <button className="btn btn-sm" onClick={() => setOffline(null)}>
              Back to live
            </button>
          </>
        ) : source === 'mt4' ? (
          <>
            <span className="oc-prov">MT4</span>
            {mt4Cat?.missing || mt4Cat?.error ? (
              <span className="tone-warn">{mt4Cat.error ?? mt4Cat.missing}</span>
            ) : error ? (
              <span className="tone-bear">● {error}</span>
            ) : live ? (
              <span className={freshness === 'fresh' ? 'live-ok' : freshness === 'delayed' ? 'tone-warn' : 'tone-bear'}>
                {freshness === 'fresh' && session === 'open' && <span className="live-dot" />}
                {session === 'closed' ? 'Market closed · last prices' : freshness === 'fresh' ? 'Live prices' : freshness === 'delayed' ? 'Delayed' : 'Stale prices'} · written by TrendLensFeed {istTime(live.fetchedAt, false)} ({age(now - live.fetchedAt)})
              </span>
            ) : (
              <span>{mt4Cat ? 'Loading prices…' : 'Reading MT4…'}</span>
            )}
            {mt4Series && (
              <span className="oc-faint">
                {mt4Series.underlyingSymbol ? `underlying ${mt4Series.underlyingSymbol}` : 'no underlying quote'}
                {mt4Series.lotSize ? ` · lot ${mt4Series.lotSize}` : ''} · prices only: no OI, volume or provider IV
              </span>
            )}
          </>
        ) : (
          <>
            <span className="oc-prov">{provider ? `${PROVIDER_LABEL[provider]}` : '—'}</span>
            {catalog && !catalog.configured ? (
              <span className="tone-warn">
                Not connected. {catalog.missing}{' '}
                <button className="btn btn-sm" onClick={onOpenSettings}>
                  Open Settings
                </button>
              </span>
            ) : error ? (
              <span className="tone-bear">
                ● {error}
                {lastOk ? ` · last successful update ${istTime(lastOk, false)} (${age(now - lastOk)})` : ''}
              </span>
            ) : live ? (
              <span className={freshness === 'fresh' ? 'live-ok' : freshness === 'delayed' ? 'tone-warn' : 'tone-bear'}>
                {freshness === 'fresh' && session === 'open' && <span className="live-dot" />}
                {session === 'closed' ? 'Market closed · last data' : freshness === 'fresh' ? 'Live' : freshness === 'delayed' ? 'Delayed' : 'Stale data'} · updated {istTime(live.fetchedAt, false)} ({age(now - live.fetchedAt)})
              </span>
            ) : catalog?.configured ? (
              <span>{fetching ? 'Loading chain…' : 'Waiting for data…'}</span>
            ) : null}
            {catalog?.error && <span className="tone-bear">Instrument list: {catalog.error}</span>}
            {underlying && (
              <span className="oc-faint">
                {underlying.name}
                {underlying.lotSize ? ` · lot ${underlying.lotSize}` : ''} · {underlying.expiries.length} expiries
                {catalog?.updatedAt ? ` · instrument list ${age(now - catalog.updatedAt)}` : ''}
              </span>
            )}
            {exchange === 'MCX' && <span className="oc-faint">MCX options are on futures; Greeks use Black-76.</span>}
          </>
        )}
      </div>

      {!chain ? (
        <div className="empty">
          {source === 'mt4' && !offline ? (
            mt4Cat?.missing || mt4Cat?.error ? (
              <>
                <h3>MetaTrader 4 option prices</h3>
                <p style={{ maxWidth: 680, margin: '0 auto 12px' }}>{mt4Cat.error ?? mt4Cat.missing}</p>
                <button className="btn" onClick={() => void loadMt4()}>
                  Check again
                </button>
              </>
            ) : error ? (
              <p className="tone-bear">{error}</p>
            ) : (
              <p>
                <span className="spinner" /> Reading MetaTrader 4 option prices…
              </p>
            )
          ) : catLoading ? (
            <p>
              <span className="spinner" /> Loading the {exchange} instrument list…
            </p>
          ) : catalog && !catalog.configured ? (
            <>
              <h3>Connect an option data source</h3>
              <p style={{ maxWidth: 640, margin: '0 auto 12px' }}>{catalog.missing}</p>
              <p className="oc-note" style={{ maxWidth: 640, margin: '0 auto 14px' }}>
                TrendLens only uses documented provider APIs with your own credentials; it does not scrape exchange websites. You can still import an option-chain CSV, such as the file the NSE website lets you download.
              </p>
              <button className="btn btn-primary" onClick={onOpenSettings}>
                Open Settings
              </button>{' '}
              <button className="btn" onClick={() => void importCsv()}>
                Import CSV
              </button>
            </>
          ) : error ? (
            <>
              <h3>No chain loaded</h3>
              <p className="tone-bear">{error}</p>
              <button className="btn" onClick={() => void importCsv()}>
                Import CSV instead
              </button>
            </>
          ) : (
            <p>
              <span className="spinner" /> Loading option chain…
            </p>
          )}
        </div>
      ) : (
        summary &&
        greeks && (
          <>
            <AnalyticsCards chain={chain} s={summary} units={units} freshness={freshness} now={now} session={session} />
            <div className="oc-tabs">
              {TABS.map(([id, label]) => (
                <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
              <span className="spacer" />
              {tab === 'chain' && (
                <>
                  <input className="oc-search" placeholder="Strike or range, e.g. 25000-25500" value={search} onChange={(e) => setSearch(e.target.value)} />
                  <select value={money} onChange={(e) => setMoney(e.target.value as typeof money)}>
                    <option value="all">All strikes</option>
                    <option value="call-itm">ITM calls</option>
                    <option value="put-itm">ITM puts</option>
                  </select>
                  <button className={`toggle ${hideEmpty ? 'on' : ''}`} onClick={() => setHideEmpty(!hideEmpty)}>
                    Hide zero OI
                  </button>
                </>
              )}
            </div>
            {tab === 'chain' && (
              <>
                {sel && (
                  <div className="oc-selected">
                    <b>Strike {strike(sel.strike)}</b>
                    <span>
                      Call LTP {num(sel.call?.ltp, 2)} · IV {selG?.call?.iv ? `${selG.call.iv.value.toFixed(2)}%` : '—'} · Δ {selG?.call?.delta?.value.toFixed(3) ?? '—'} · Θ {selG?.call?.theta?.value.toFixed(2) ?? '—'}
                    </span>
                    <span>
                      Put LTP {num(sel.put?.ltp, 2)} · IV {selG?.put?.iv ? `${selG.put.iv.value.toFixed(2)}%` : '—'} · Δ {selG?.put?.delta?.value.toFixed(3) ?? '—'} · Θ {selG?.put?.theta?.value.toFixed(2) ?? '—'}
                    </span>
                    <button className="btn btn-sm" onClick={() => setSelected(undefined)}>
                      Clear
                    </button>
                  </div>
                )}
                <ChainTable
                  chain={chain}
                  rows={tableRows}
                  price={price}
                  atm={summary.atm}
                  show={show}
                  units={units}
                  maxima={{ callOi: summary.maxCallOi?.value, putOi: summary.maxPutOi?.value, callChg: summary.maxCallOiAdd?.value, putChg: summary.maxPutOiAdd?.value }}
                  sort={sort}
                  onSort={onSort}
                  selected={selected}
                  onSelect={(k) => setSelected(k === selected ? undefined : k)}
                  scrollKey={`${chain.provider}|${chain.symbol}|${chain.expiry}|${offline?.label ?? ''}`}
                />
                <p className="oc-note">
                  {!hasOi && 'Shaded cells are in the money. IV is calculated from the prices (Greeks & IV tab shows the model). Chg is against the previous daily close in the source. Click a header to sort, a row to select a strike.'}
                  {hasOi && <>Shaded cells are in the money. Highest OI and highest OI addition on each side are outlined. Chg and Chg OI are against the previous trading day as reported by the source. Click a header to sort, a
                  row to select a strike.</>}
                </p>
              </>
            )}
            {(tab === 'oi' || tab === 'maxpain') && !hasOi && (
              <div className="card oc-note" style={{ fontSize: 13 }}>
                {tab === 'oi' ? 'OI analysis' : 'Max Pain'} needs open interest, and {chain.provider === 'mt4' ? 'MetaTrader 4 provides option prices only' : 'this chain has no open interest'}. Use a broker API source
                (Settings → Option chain data) for OI, PCR and Max Pain. The Option Chain and Greeks & IV tabs work from prices.
              </div>
            )}
            {tab === 'oi' && hasOi && <OiAnalysis chain={chain} rows={windowRows} s={summary} units={units} pcrHistory={metas.filter((m) => m.expiry === chain.expiry)} onPick={pick} />}
            {tab === 'greeks' && <GreeksPanel chain={chain} g={greeks} strikes={windowStrikes} ivChange={ivChange} ivStats={ivStats} onPick={pick} />}
            {tab === 'maxpain' && hasOi && <MaxPainPanel chain={chain} s={summary} strikes={windowStrikes} />}
            {tab === 'history' && <HistoryPanel chain={chain} metas={metas} expiry={chain.expiry} strikes={windowStrikes} units={units} snapshotSeconds={settings.optionSnapshotSeconds} onView={(m) => void viewSnapshot(m)} />}
            <p className="disclaimer">Option data and interpretations are for education only, not investment advice. Build-up and writing labels describe price and OI changes, not who traded.</p>
          </>
        )
      )}

      {csv && <CsvImportDialog file={csv} catalog={catalog} onCancel={() => setCsv(null)} onLoad={(c, save) => void loadCsvChain(c, save)} />}
    </div>
  );
}
