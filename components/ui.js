import { ev } from '@/lib/format';

export function Tier({ t }) {
  return <span className={`badge tier tier-${t || 'D'}`}>{t || 'D'}</span>;
}

export function Signals({ list }) {
  if (!list || !list.length) return <span className="muted">—</span>;
  return list.map((s) => <span key={s} className="chip">{ev(s)}</span>);
}

export function Flash({ sp }) {
  if (sp?.error) return <div className="alert err">{sp.error}</div>;
  if (sp?.ok) return <div className="alert ok">{sp.ok}</div>;
  return null;
}

export function Select({ name, options, value, blank, labels }) {
  return (
    <select name={name} defaultValue={value ?? ''}>
      {blank !== undefined && <option value="">{blank}</option>}
      {options.map((o) => (
        <option key={o} value={o}>{labels ? labels(o) : o.replace(/_/g, ' ')}</option>
      ))}
    </select>
  );
}
