export default function TrendChart({ data }: { data: Array<{ at: string; count: number }> }) {
  const values = data.length ? data : Array.from({ length: 6 }, (_, index) => ({ at: new Date(Date.now() - (5 - index) * 604_800_000).toISOString(), count: 0 }));
  const max = Math.max(5, ...values.map((point) => point.count));
  const points = values.map((point, index) => ({ x: 36 + index * (484 / Math.max(values.length - 1, 1)), y: 210 - (point.count / max) * 160, ...point }));
  const line = points.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ');
  const area = `${line} L${points.at(-1)?.x || 520},220 L36,220 Z`;
  return <div className="trend-chart"><svg viewBox="0 0 560 260" role="img" aria-label="Findings trend over six weeks">
    {[50, 90, 130, 170, 210].map((y) => <line key={y} x1="36" y1={y} x2="530" y2={y} className="trend-grid" />)}
    <path d={area} className="trend-area" /><path d={line} className="trend-line" />
    {points.map((point) => <g key={point.at}><circle cx={point.x} cy={point.y} r="4.5" /><text x={point.x} y="246" textAnchor="middle">{new Date(point.at).toLocaleDateString('en', { month: 'short', day: 'numeric' })}</text></g>)}
  </svg><span><i /> Total findings</span></div>;
}
