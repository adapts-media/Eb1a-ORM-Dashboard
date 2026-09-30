import { useState } from "react";
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  BarChart,
  Bar,
} from "recharts";
import type { Overview, SentimentByKeywordRow, SentimentByPlatformRow, SentimentOverTimeRow } from "../../api/types";

const COLORS = { POSITIVE: "#33c17a", NEGATIVE: "#ef5164", NEUTRAL: "#8b93ab" };

export function DistributionPieChart({ overview }: { overview: Overview }) {
  const data = [
    { name: "Positive", key: "POSITIVE", value: overview.positive },
    { name: "Negative", key: "NEGATIVE", value: overview.negative },
    { name: "Neutral", key: "NEUTRAL", value: overview.neutral },
  ];
  const hasData = data.some((d) => d.value > 0);
  if (!hasData) return <EmptyChart />;
  return (
    <ResponsiveContainer width="100%" height={240}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2}>
          {data.map((d) => (
            <Cell key={d.key} fill={COLORS[d.key as keyof typeof COLORS]} />
          ))}
        </Pie>
        <Legend />
        <Tooltip contentStyle={tooltipStyle} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function SentimentOverTimeChart({ data }: { data: SentimentOverTimeRow[] }) {
  if (data.length === 0) return <EmptyChart />;
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2a3350" />
        <XAxis dataKey="date" stroke="#9aa4bf" fontSize={11} />
        <YAxis stroke="#9aa4bf" fontSize={11} allowDecimals={false} />
        <Tooltip contentStyle={tooltipStyle} />
        <Legend />
        <Line type="monotone" dataKey="POSITIVE" stroke={COLORS.POSITIVE} strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="NEGATIVE" stroke={COLORS.NEGATIVE} strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="NEUTRAL" stroke={COLORS.NEUTRAL} strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function SentimentByKeywordChart({ data }: { data: SentimentByKeywordRow[] }) {
  if (data.length === 0) return <EmptyChart />;
  return (
    <ResponsiveContainer width="100%" height={Math.max(240, data.length * 40)}>
      <BarChart data={data} layout="vertical" margin={{ left: 20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#2a3350" />
        <XAxis type="number" stroke="#9aa4bf" fontSize={11} />
        <YAxis type="category" dataKey="keyword" stroke="#9aa4bf" fontSize={11} width={120} />
        <Tooltip contentStyle={tooltipStyle} />
        <Legend />
        <Bar dataKey="positive" stackId="a" fill={COLORS.POSITIVE} name="Positive" />
        <Bar dataKey="neutral" stackId="a" fill={COLORS.NEUTRAL} name="Neutral" />
        <Bar dataKey="negative" stackId="a" fill={COLORS.NEGATIVE} name="Negative" />
      </BarChart>
    </ResponsiveContainer>
  );
}

function SentimentBarsInner({ positivePct, neutralPct, negativePct }: { positivePct: number; neutralPct: number; negativePct: number }) {
  const bars = [
    { label: "Positive", pct: positivePct, color: COLORS.POSITIVE },
    { label: "Neutral", pct: neutralPct, color: COLORS.NEUTRAL },
    { label: "Negative", pct: negativePct, color: COLORS.NEGATIVE },
  ];
  return (
    <>
      {bars.map((b) => (
        <div key={b.label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, fontSize: 12 }}>
          <span style={{ width: 56, color: "var(--text-dim)" }}>{b.label}</span>
          <div style={{ flex: 1, background: "var(--bg-panel)", borderRadius: 4, height: 10, overflow: "hidden" }}>
            <div style={{ width: `${b.pct}%`, background: b.color, height: "100%" }} />
          </div>
          <span style={{ width: 40, textAlign: "right", fontWeight: 600 }}>{b.pct}%</span>
        </div>
      ))}
    </>
  );
}

/**
 * Feature: "merge duplicate brand trackers into one". When `row.isGroup` is
 * set (a merged KeywordGroup — see services/queryService.ts
 * getSentimentByKeyword), the combined numbers show by default with a
 * "N variants" expand toggle revealing the original per-variant rows
 * underneath, instead of the brand being split across N separate cards.
 */
export function KeywordSentimentBars({
  row,
  onDelete,
}: {
  row: SentimentByKeywordRow;
  onDelete?: (keyword: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isGroup = Boolean(row.isGroup && row.variants && row.variants.length > 1);

  return (
    <div style={{ background: "var(--bg-panel-alt)", padding: "14px 16px", borderRadius: 8, border: "1px solid var(--border)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: "var(--text)" }}>{row.keyword}</div>
          {isGroup && (
            <span
              title={`Merged from ${row.variants!.length} spelling variants`}
              style={{ fontSize: 10, fontWeight: 700, color: "var(--text-dim)", border: "1px solid var(--border)", borderRadius: 999, padding: "1px 7px" }}
            >
              MERGED
            </span>
          )}
        </div>
        {/* Deleting "the group" is ambiguous — variants are managed via the seed list, not deleted individually here. */}
        {onDelete && !isGroup && (
          <button
            type="button"
            title="Delete keyword"
            onClick={() => onDelete(row.keyword)}
            style={{
              background: "transparent",
              border: "none",
              color: "#f87171",
              fontSize: 12,
              cursor: "pointer",
              padding: "2px 6px",
              opacity: 0.8,
            }}
          >
            🗑
          </button>
        )}
      </div>

      <SentimentBarsInner positivePct={row.positivePct} neutralPct={row.neutralPct} negativePct={row.negativePct} />

      {isGroup && (
        <>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={{ background: "transparent", border: "none", color: "#60a5fa", fontSize: 11, fontWeight: 600, cursor: "pointer", padding: "6px 0 0" }}
          >
            {expanded ? "Hide variants ▲" : `Show ${row.variants!.length} variants ▼`}
          </button>
          {expanded && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed var(--border)", display: "grid", gap: 10 }}>
              {row.variants!.map((v) => (
                <div key={v.keyword}>
                  <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>
                    {v.keyword} <span style={{ opacity: 0.7 }}>({v.totalMentions} mentions)</span>
                  </div>
                  <SentimentBarsInner positivePct={v.positivePct} neutralPct={v.neutralPct} negativePct={v.negativePct} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function PlatformSentimentBars({ row }: { row: SentimentByPlatformRow }) {
  const bars = [
    { label: "Positive", pct: row.positivePct, color: COLORS.POSITIVE },
    { label: "Neutral", pct: row.neutralPct, color: COLORS.NEUTRAL },
    { label: "Negative", pct: row.negativePct, color: COLORS.NEGATIVE },
  ];
  return (
    <div style={{ background: "var(--bg-panel-alt)", padding: "14px 16px", borderRadius: 8, border: "1px solid var(--border)" }}>
      <div style={{ fontWeight: 600, marginBottom: 8, textTransform: "uppercase", fontSize: 13, letterSpacing: 0.5, color: "var(--text)" }}>
        {row.platform} <span style={{ fontSize: 11, fontWeight: 400, color: "var(--text-dim)", textTransform: "none" }}>({row.totalMentions} items)</span>
      </div>
      {bars.map((b) => (
        <div key={b.label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, fontSize: 12 }}>
          <span style={{ width: 56, color: "var(--text-dim)" }}>{b.label}</span>
          <div style={{ flex: 1, background: "var(--bg-panel)", borderRadius: 4, height: 10, overflow: "hidden" }}>
            <div style={{ width: `${b.pct}%`, background: b.color, height: "100%" }} />
          </div>
          <span style={{ width: 40, textAlign: "right", fontWeight: 600 }}>{b.pct}%</span>
        </div>
      ))}
    </div>
  );
}

function EmptyChart() {
  return <div className="empty-state" style={{ padding: 30 }}>Not enough analyzed data yet.</div>;
}

const tooltipStyle = { background: "#1c2438", border: "1px solid #2a3350", borderRadius: 8, fontSize: 12 };
