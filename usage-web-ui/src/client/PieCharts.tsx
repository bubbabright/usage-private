import React, { useMemo, useState } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Sector } from 'recharts';

// Palette — extended Okabe-Ito, colorblind-safe, matches the rest
// of the UI. Neutral grey is used for the "remaining" slice.
const SLICE_COLORS = [
  '#F0E442', '#56B4E9', '#009E73', '#E69F00', '#CC79A7',
  '#D55E00', '#0072B2', '#8B5CF6', '#EC4899', '#14B8A6',
  '#F97316', '#06B6D4',
];
const REMAINING_COLOR = '#374151';
const STATUS_COLORS = { ok: '#10b981', auth_expired: '#f59e0b', error: '#ef4444', rate_limited: '#f97316' };

interface PieSlice {
  name: string;
  value: number;
  color: string;
  pct: number;
  used?: number | null;
  cap?: number | null;
  unit?: string | null;
  resets_at?: string | null;
}

interface ProviderPieProps {
  provider: string;
  windows: any[];
  size?: number;
  showLabels?: boolean;
}

// Custom active sector shape — expands slightly on hover for tactile feedback.
const renderActiveShape = (props: any) => {
  const { cx, cy, innerRadius, outerRadius, startAngle, endAngle, fill, payload, percent } = props;
  const label = payload.name;
  const pctStr = `${(percent * 100).toFixed(1)}%`;
  return (
    <g>
      <Sector
        cx={cx} cy={cy} innerRadius={innerRadius} outerRadius={outerRadius + 4}
        startAngle={startAngle} endAngle={endAngle} fill={fill}
      />
      <Sector
        cx={cx} cy={cy} innerRadius={outerRadius + 6} outerRadius={outerRadius + 8}
        startAngle={startAngle} endAngle={endAngle} fill={fill} opacity={0.4}
      />
      <text x={cx} y={cy - 6} dy={0} textAnchor="middle" fill="#e5e7eb" fontSize={13} fontWeight={600}>
        {label}
      </text>
      <text x={cx} y={cy + 12} textAnchor="middle" fill="#9ca3af" fontSize={11}>
        {pctStr}
      </text>
    </g>
  );
};

// Donut with provider name in center. Each window with a pct is a slice;
// the remainder (100 - sum) is a neutral grey slice.
export function ProviderPie({ provider, windows, size = 160, showLabels = true }: ProviderPieProps) {
  const [activeIndex, setActiveIndex] = useState<number | undefined>(undefined);

  const { data, totalPct, mainLabel } = useMemo(() => {
    const slices: PieSlice[] = [];
    let used = 0;
    windows.forEach((w, i) => {
      const pct = typeof w?.pct === 'number' ? w.pct : null;
      if (pct === null || pct <= 0) return;
      slices.push({
        name: w.label || w.id || `Window ${i + 1}`,
        value: Math.max(0, Math.min(100 - used, pct)),
        color: SLICE_COLORS[i % SLICE_COLORS.length],
        pct,
        used: w.used ?? null,
        cap: w.cap ?? null,
        unit: w.unit ?? null,
        resets_at: w.resets_at ?? null,
      });
      used += pct;
    });
    const remaining = Math.max(0, 100 - used);
    if (remaining > 0.01) {
      slices.push({
        name: 'Remaining',
        value: remaining,
        color: REMAINING_COLOR,
        pct: remaining,
      });
    }
    return {
      data: slices,
      totalPct: used,
      mainLabel: provider.charAt(0).toUpperCase() + provider.slice(1),
    };
  }, [provider, windows]);

  if (!data.length) {
    return (
      <div className="flex items-center justify-center" style={{ width: size, height: size }}>
        <span className="text-xs text-neutral-500 text-center">no data</span>
      </div>
    );
  }

  const activeIdx = activeIndex ?? 0;

  return (
    <div className="inline-flex flex-col items-center gap-1">
      <div style={{ width: size, height: size }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip content={<PieTooltip />} cursor={{ fill: 'transparent' }} />
            <Pie
              activeIndex={activeIdx}
              activeShape={renderActiveShape}
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius={size * 0.35}
              outerRadius={size * 0.46}
              onMouseEnter={(_, idx) => setActiveIndex(idx)}
              onMouseLeave={() => setActiveIndex(undefined)}
              stroke="none"
            >
              {data.map((entry, index) => (
                <Cell key={entry.name} fill={entry.color} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
      </div>
      {showLabels && (
        <div className="text-center mt-1">
          <span className="text-sm font-semibold text-neutral-100">{mainLabel}</span>
          <span className="text-[10px] text-neutral-500 block">{data.length} window{data.length !== 1 ? 's' : ''}</span>
        </div>
      )}
    </div>
  );
}

// Compact donut for grid/tile layouts — just the chart, no labels.
export function ProviderPieMini({ provider, windows, size = 100 }: ProviderPieProps) {
  const { data } = useMemo(() => {
    const slices: PieSlice[] = [];
    let used = 0;
    windows.forEach((w, i) => {
      const pct = typeof w?.pct === 'number' ? w.pct : null;
      if (pct === null || pct <= 0) return;
      slices.push({
        name: w.label || w.id || `W${i + 1}`,
        value: Math.max(0, Math.min(100 - used, pct)),
        color: SLICE_COLORS[i % SLICE_COLORS.length],
        pct,
      });
      used += pct;
    });
    const remaining = Math.max(0, 100 - used);
    if (remaining > 0.01) {
      slices.push({ name: 'Remaining', value: remaining, color: REMAINING_COLOR, pct: remaining });
    }
    return { data: slices };
  }, [provider, windows]);

  if (!data.length) {
    return (
      <div className="flex items-center justify-center" style={{ width: size, height: size }}>
        <span className="text-[10px] text-neutral-500">—</span>
      </div>
    );
  }

  return (
    <div style={{ width: size, height: size }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius={size * 0.32}
            outerRadius={size * 0.44}
            stroke="none"
          >
            {data.map((entry) => (
              <Cell key={entry.name} fill={entry.color} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

// Legend below a pie — maps each slice to its label and value.
export function PieLegend({ windows }: { windows: any[] }) {
  const items = useMemo(() => {
    const out: { name: string; pct: number; used?: number | null; cap?: number | null; unit?: string | null; color: string }[] = [];
    let used = 0;
    windows.forEach((w, i) => {
      const pct = typeof w?.pct === 'number' ? w.pct : null;
      if (pct === null || pct <= 0) return;
      out.push({
        name: w.label || w.id,
        pct,
        used: w.used ?? null,
        cap: w.cap ?? null,
        unit: w.unit ?? null,
        color: SLICE_COLORS[i % SLICE_COLORS.length],
      });
      used += pct;
    });
    const remaining = Math.max(0, 100 - used);
    if (remaining > 0.01) {
      out.push({ name: 'Remaining', pct: remaining, color: REMAINING_COLOR });
    }
    return out;
  }, [windows]);

  if (!items.length) return null;

  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-neutral-400">
      {items.map((item) => (
        <span key={item.name} className="flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: item.color }} />
          <span className="text-neutral-300">{item.name}</span>
          <span className="tabular-nums">{item.pct.toFixed(1)}%</span>
          {item.used !== null && item.used !== undefined && item.unit && (
            <span className="text-neutral-600">
              {item.unit.toLowerCase() === 'usd' ? `$${item.used.toLocaleString()}` : item.used.toLocaleString()} {item.unit}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

// Tooltip wrapper — Recharts Tooltip renders a default white box; this
// one matches the dark theme.
export function PieTooltip({ active, payload }: any) {
  if (active && payload && payload.length) {
    const entry = payload[0].payload;
    return (
      <div className="bg-neutral-900 border border-neutral-700 rounded-lg p-2 text-xs shadow-lg">
        <span className="text-neutral-100 font-medium">{entry.name}</span>
        <div className="text-neutral-400 mt-0.5">{entry.pct.toFixed(1)}%</div>
        {entry.used !== null && entry.used !== undefined && entry.unit && (
          <div className="text-neutral-500">
            {entry.unit.toLowerCase() === 'usd' ? `$${entry.used.toLocaleString()}` : `${entry.used.toLocaleString()} ${entry.unit}`}
          </div>
        )}
      </div>
    );
  }
  return null;
}
