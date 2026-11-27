/**
 * The option chain table: calls left, strike centre, puts right. Rows are keyed by strike, so a
 * refresh updates cells in place and keeps the scroll position and the selected strike.
 */
import { useEffect, useRef } from 'react';
import { inLots, type QuoteField, type Side, type SortKey } from '@core/options/option-chain';
import type { OptionChain, OptionQuote, StrikeRow } from '@core/options/types';
import { num, signed, strike as fmtStrike, toneOf } from '../../lib/optionsFormat';

interface Col {
  f: QuoteField;
  label: string;
  /** Counts that follow the Lots/Units toggle. */
  counted?: boolean;
  decimals?: number;
  signed?: boolean;
}

const COLS: Col[] = [
  { f: 'oi', label: 'OI', counted: true },
  { f: 'oiChange', label: 'Chg OI', counted: true, signed: true },
  { f: 'volume', label: 'Volume', counted: true },
  { f: 'iv', label: 'IV', decimals: 2 },
  { f: 'ltp', label: 'LTP', decimals: 2 },
  { f: 'change', label: 'Chg', decimals: 2, signed: true },
  { f: 'bidQty', label: 'Bid Qty' },
  { f: 'bidPrice', label: 'Bid', decimals: 2 },
  { f: 'askPrice', label: 'Ask', decimals: 2 },
  { f: 'askQty', label: 'Ask Qty' },
];
const CALL_COLS = COLS;
const PUT_COLS = [...COLS].reverse();

export interface ChainTableProps {
  chain: OptionChain;
  rows: StrikeRow[];
  price?: number;
  atm?: number;
  show: 'both' | 'calls' | 'puts';
  units: 'lots' | 'units';
  maxima: { callOi?: number; putOi?: number; callChg?: number; putChg?: number };
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onSort: (key: SortKey) => void;
  selected?: number;
  onSelect: (strike: number) => void;
  /** Changes when a different underlying/expiry is loaded, to re-centre on ATM once. */
  scrollKey: string;
}

export function ChainTable(p: ChainTableProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const centred = useRef('');
  const lotsOk = p.units === 'lots' && p.chain.oiUnit === 'units' && !!p.chain.lotSize;

  // Centre the ATM strike once per underlying/expiry; later refreshes keep the user's scroll.
  useEffect(() => {
    if (centred.current === p.scrollKey || p.atm === undefined || !wrap.current) return;
    const tr = wrap.current.querySelector<HTMLTableRowElement>(`tr[data-strike="${p.atm}"]`);
    if (!tr) return;
    centred.current = p.scrollKey;
    wrap.current.scrollTop = tr.offsetTop - wrap.current.clientHeight / 2 + tr.offsetHeight / 2;
  }, [p.scrollKey, p.atm, p.rows.length]);

  const value = (q: OptionQuote | undefined, c: Col) => {
    const v = q?.[c.f];
    return c.counted && lotsOk ? inLots(v, p.chain) : v;
  };
  const cell = (side: Side, row: StrikeRow, c: Col) => {
    const q = row[side];
    const v = value(q, c);
    const itm = p.price !== undefined && (side === 'call' ? row.strike < p.price : row.strike > p.price);
    const cls = [c.f === 'change' || c.f === 'oiChange' ? toneOf(v) : '', itm ? 'itm' : ''];
    if (c.f === 'oi' && q?.oi !== undefined && q.oi > 0 && q.oi === (side === 'call' ? p.maxima.callOi : p.maxima.putOi)) cls.push('max-oi');
    if (c.f === 'oiChange' && q?.oiChange !== undefined && q.oiChange > 0 && q.oiChange === (side === 'call' ? p.maxima.callChg : p.maxima.putChg)) cls.push('max-chg');
    const dec = c.counted && lotsOk ? (Number.isInteger(v) ? 0 : 1) : (c.decimals ?? 0);
    return (
      <td key={`${side}-${c.f}`} className={cls.join(' ')}>
        {v === undefined ? '' : c.signed ? signed(v, dec) : num(v, dec)}
      </td>
    );
  };
  const head = (side: Side, c: Col) => {
    const key = `${side}.${c.f}` as SortKey;
    const on = p.sort.key === key;
    return (
      <th key={key} onClick={() => p.onSort(key)} className={on ? 'sorted' : ''} title={`Sort by ${side} ${c.label}`}>
        {c.label}
        {c.counted && lotsOk ? <small> lots</small> : null}
        {on ? (p.sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
      </th>
    );
  };
  const showCalls = p.show !== 'puts';
  const showPuts = p.show !== 'calls';
  const has = (f: QuoteField) => p.rows.some((r) => r.call?.[f] !== undefined || r.put?.[f] !== undefined);
  const present = new Set(COLS.filter((c) => c.f === 'ltp' || has(c.f)).map((c) => c.f));
  const callCols = CALL_COLS.filter((c) => present.has(c.f));
  const putCols = PUT_COLS.filter((c) => present.has(c.f));

  return (
    <div className="oc-table-wrap" ref={wrap}>
      <table className="oc-table">
        <thead>
          <tr className="oc-sides">
            {showCalls && <th colSpan={callCols.length}>CALLS</th>}
            <th className="oc-strike-h" />
            {showPuts && <th colSpan={putCols.length}>PUTS</th>}
          </tr>
          <tr>
            {showCalls && callCols.map((c) => head('call', c))}
            <th className={`oc-strike-h ${p.sort.key === 'strike' ? 'sorted' : ''}`} onClick={() => p.onSort('strike')}>
              Strike{p.sort.key === 'strike' ? (p.sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
            </th>
            {showPuts && putCols.map((c) => head('put', c))}
          </tr>
        </thead>
        <tbody>
          {p.rows.map((r) => (
            <tr key={r.strike} data-strike={r.strike} className={[r.strike === p.atm ? 'atm' : '', r.strike === p.selected ? 'sel' : ''].join(' ')} onClick={() => p.onSelect(r.strike)}>
              {showCalls && callCols.map((c) => cell('call', r, c))}
              <td className="oc-strike">
                {fmtStrike(r.strike)}
                {r.strike === p.atm && <span className="oc-atm-tag">ATM</span>}
              </td>
              {showPuts && putCols.map((c) => cell('put', r, c))}
            </tr>
          ))}
          {!p.rows.length && (
            <tr>
              <td colSpan={21} className="oc-none">
                No strikes match the current filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
