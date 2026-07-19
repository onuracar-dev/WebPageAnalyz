import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts'

export default function ScoreCard({ title, score, icon }) {
  const safeScore = Math.max(0, Math.min(100, Number(score) || 0))
  const color = safeScore < 50 ? '#ff7b72' : safeScore < 90 ? '#d29922' : '#2ea043'
  const data = [{ value: safeScore }, { value: 100 - safeScore }]

  return (
    <article className="score-card">
      <div className="score-heading">{icon}<h3>{title}</h3></div>
      <div className="score-chart" aria-label={`${title} skoru: ${safeScore}`}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} innerRadius={45} outerRadius={60} startAngle={90} endAngle={-270} dataKey="value" stroke="none" isAnimationActive={false}>
              <Cell fill={color} />
              <Cell fill="rgba(139, 148, 158, 0.2)" />
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <strong style={{ color }}>{safeScore}</strong>
      </div>
    </article>
  )
}
