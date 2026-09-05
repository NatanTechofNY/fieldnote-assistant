import type { CSSProperties } from "react";
import { NavLink } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import type { MoodPoint } from "../../types";
import { Empty } from "../../components/ui";
import { defaultMoodLabel, moodEmoji } from "../../lib/mood";
import { useTimezone } from "../../lib/timezone";

/**
 * The last two weeks of journal moods as a row of bars, one per entry. Each bar
 * opens the entry it stands for, so the chart is a way back into the day rather
 * than a summary of it, and the words the mood was saved in sit under the chart
 * for the most recent one.
 */
export function MoodTrend({ points }: { points: MoodPoint[] }) {
  const timezone = useTimezone();
  const day = (value: string) => new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, month: "short", day: "numeric",
  }).format(new Date(value));
  const latest = points[points.length - 1];
  const average = points.length
    ? points.reduce((sum, point) => sum + point.score, 0) / points.length
    : 0;
  return <article className="card card-pad">
    <div className="card-title">
      <h3>How the days have felt</h3>
      <NavLink to="/memories" className="card-link">Open journal<ArrowRight size={13}/></NavLink>
    </div>
    {points.length
      ? <>
        <div className="mood-chart">
          {points.map(point => {
            const words = point.label || defaultMoodLabel(point.score);
            return <NavLink
              key={point.id}
              to={`/memories?open=${encodeURIComponent(point.id)}`}
              className="mood-col"
              style={{ "--h": point.score / 5 } as CSSProperties}
              title={`${day(point.at)} · ${words}`}
              aria-label={`${day(point.at)}: ${words}, ${point.score} of 5`}
            >
              <span className="mood-face" aria-hidden="true">{moodEmoji(point.score)}</span>
              <span className="mood-bar"/>
              <span className="mood-day">{day(point.at)}</span>
            </NavLink>;
          })}
        </div>
        <p className="mood-latest">
          {/* The latest entry in its own words; the average is context, not the point. */}
          Latest: <strong>{latest.label || defaultMoodLabel(latest.score)}</strong> on {day(latest.at)}
          {points.length > 1 && <> · averaging {average.toFixed(1)} across {points.length} entries</>}
        </p>
      </>
      : <Empty label="Journal entries with a mood will chart here." />}
  </article>;
}
