import type {
  LifeArea,
} from "../../types";
import { MY_ITEMS } from "../../lib/area-filter";

export function LifeAreaFilter({
  areas,
  value,
  onChange,
}: {
  areas: LifeArea[];
  value: string;
  onChange: (value: string) => void;
}) {
  return <div className="area-filter" aria-label="Life area filter">
    <button className={value === MY_ITEMS ? "active" : ""} onClick={() => onChange(MY_ITEMS)}>My items</button>
    <button className={!value ? "active" : ""} onClick={() => onChange("")}>All areas</button>
    {areas.map(area => <button
      key={area.id}
      className={value === area.id ? "active" : ""}
      onClick={() => onChange(area.id)}
    >{area.name}</button>)}
  </div>;
}
