import { type CSSProperties, useState } from "react";
import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { api } from "../../api";
import type { MoodPoint, MoodTrendScope } from "../../types";
import { Empty } from "../../components/ui";
import { hasGroupAreas } from "../../lib/area-filter";
import { defaultMoodLabel, describeMoods, moodEmoji, moodOwnerName } from "../../lib/mood";
import { useTimezone } from "../../lib/timezone";

/** Which view the card was left on; the owner's own is the default. */
const SCOPE_KEY = "fieldnote.mood-trend.scope";

function storedScope(): MoodTrendScope {
  try {
    return window.localStorage.getItem(SCOPE_KEY) === "shared" ? "shared" : "mine";
  } catch {
    return "mine";
  }
}

/**
 * The last two weeks of journal moods as a row of bars, one per entry. Each bar
 * opens the entry it stands for, so the chart is a way back into the day rather
 * than a summary of it, and the words the mood was saved in sit under the chart
 * for the most recent one.
 *
 * Two views once a group chat exists. "Mine" is the owner's own entries and
 * nothing filed under a group — a household's evening is not the owner's day.
 * "Shared" is the group entries: the bar is the combined score, and each
 * person's own score is marked on it, so a 2 and a 4 do not simply read as a 3.
 */
export function MoodTrend({ points }: { points: MoodPoint[] }) {
  const timezone = useTimezone();
  const { data: areas = [] } = useQuery({ queryKey: ["life-areas"], queryFn: api.lifeAreas });
  const groups = hasGroupAreas(areas);
  const [scope, setScope] = useState<MoodTrendScope>(storedScope);
  const view: MoodTrendScope = groups ? scope : "mine";
  const shared = useQuery({ queryKey: ["mood-trend", "shared"], queryFn: () => api.moodTrend("shared"), enabled: view === "shared" });
  const shown = view === "shared" ? shared.data ?? [] : points;
  const choose = (next: MoodTrendScope) => {
    setScope(next);
    try { window.localStorage.setItem(SCOPE_KEY, next); } catch { /* private mode */ }
  };
  const day = (value: string) => new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, month: "short", day: "numeric",
  }).format(new Date(value));
  const latest = shown[shown.length - 1];
  const average = shown.length
    ? shown.reduce((sum, point) => sum + point.score, 0) / shown.length
    : 0;
  const severalGroups = new Set(shown.map(point => point.life_area_id)).size > 1;
  return <article className="card card-pad">
    <div className="card-title">
      <h3>How the days have felt</h3>
      {groups && <div className="area-filter mood-scope" role="group" aria-label="Whose moods">
        <button type="button" className={view === "mine" ? "active" : ""} aria-pressed={view === "mine"} onClick={() => choose("mine")}>Mine</button>
        <button type="button" className={view === "shared" ? "active" : ""} aria-pressed={view === "shared"} onClick={() => choose("shared")}>Shared</button>
      </div>}
      <NavLink to="/memories" className="card-link">Open journal<ArrowRight size={13}/></NavLink>
    </div>
    {shown.length
      ? <>
        <div className="mood-chart">
          {shown.map(point => {
            const words = point.moods?.length ? describeMoods(point.moods) : (point.label || defaultMoodLabel(point.score));
            const where = view === "shared" && point.life_area_name ? `${point.life_area_name} · ` : "";
            return <NavLink
              key={point.id}
              to={`/memories?open=${encodeURIComponent(point.id)}`}
              className="mood-col"
              style={{ "--h": point.score / 5 } as CSSProperties}
              title={`${day(point.at)} · ${where}${words}`}
              aria-label={`${day(point.at)}: ${where}${words}, ${point.score} of 5`}
            >
              <span className="mood-face" aria-hidden="true">{moodEmoji(point.score)}</span>
              <span className="mood-bar">
                {/* Each person's own score, sitting on the combined bar at its own height. */}
                {view === "shared" && point.moods?.map(mood => (
                  <i
                    key={mood.name}
                    className="mood-mark"
                    style={{ "--m": mood.score / 5 } as CSSProperties}
                    title={`${moodOwnerName(mood.name)}: ${mood.label}, ${mood.score} of 5`}
                    aria-hidden="true"
                  />
                ))}
              </span>
              <span className="mood-day">{day(point.at)}</span>
            </NavLink>;
          })}
        </div>
        <p className="mood-latest">
          {/* The latest entry in its own words; the average is context, not the point. */}
          Latest: <strong>{latest.moods?.length ? describeMoods(latest.moods) : (latest.label || defaultMoodLabel(latest.score))}</strong>
          {view === "shared" && severalGroups && latest.life_area_name ? <> in {latest.life_area_name}</> : null} on {day(latest.at)}
          {shown.length > 1 && <> · averaging {average.toFixed(1)} across {shown.length} entries</>}
        </p>
      </>
      : <Empty label={view === "shared"
        ? (shared.isLoading ? "Loading the shared entries…" : "A group's evening check-in answers will chart here.")
        : "Journal entries with a mood will chart here."} />}
  </article>;
}
