import type {
  LifeArea,
} from "../../types";
import { hasGroupAreas, MY_ITEMS } from "../../lib/area-filter";

export function LifeAreaFilter({
  areas,
  value,
  onChange,
}: {
  areas: LifeArea[];
  value: string;
  onChange: (value: string) => void;
}) {
  // "My items" only means something once a group chat has an area of its own;
  // before that it is "All areas" under another name, and a puzzle.
  const groups = hasGroupAreas(areas);
  return <div className="area-filter" aria-label="Life area filter">
    {groups && <button className={value === MY_ITEMS ? "active" : ""} aria-pressed={value === MY_ITEMS} onClick={() => onChange(MY_ITEMS)}>My items</button>}
    <button className={!value ? "active" : ""} aria-pressed={!value} onClick={() => onChange("")}>All areas</button>
    {areas.map(area => <button
      key={area.id}
      className={value === area.id ? "active" : ""}
      aria-pressed={value === area.id}
      onClick={() => onChange(area.id)}
    >{area.name}</button>)}
  </div>;
}
