import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, MessageSquareText, Moon, Sun } from "lucide-react";
import { api } from "../../api";
import type { LifeArea } from "../../types";

/**
 * Everything that is per group chat: each group the assistant has been added
 * to, and the scheduled check-ins it gets. Who may talk to the assistant in a
 * group lives beside this in the same section, but is saved with the SMS
 * schedule because it is a notification preference; these switches save at
 * once, like the view toggles elsewhere.
 */
export function GroupChatSettings({ notify, imessage }: { notify: (message: string) => void; imessage: boolean }) {
  const queryClient = useQueryClient();
  const { data: areas = [] } = useQuery({ queryKey: ["life-areas"], queryFn: api.lifeAreas });
  const groups = areas.filter(area => area.is_group);
  const checkin = useMutation({
    mutationFn: (input: {
      id: string; morning_checkin_time?: string | null; evening_checkin_time?: string | null; checkin_copy_to_owner?: boolean;
    }) => api.updateLifeArea(input.id, {
      morning_checkin_time: input.morning_checkin_time,
      evening_checkin_time: input.evening_checkin_time,
      checkin_copy_to_owner: input.checkin_copy_to_owner,
    }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["life-areas"] }),
    onError: (error: Error) => notify(error.message),
  });
  if (!groups.length) {
    return <div className="empty-state compact">
      {imessage
        ? "No group chats yet. Add the assistant's iMessage line to a group you are in; its first message there creates the group here."
        : "Group chats need iMessage. Switch the message provider to Sendblue to use them."}
    </div>;
  }
  return <div className="group-chat-list">
    {groups.map(group => <div className="group-chat-setting" key={group.id}>
      <div className="group-chat-setting-head">
        <i style={{ background: group.color }}/>
        <div><strong>{group.name}</strong><small>Records from this chat are filed under this area; rename or remove it under Classifications.</small></div>
        <MessageSquareText size={15}/>
      </div>
      <div className="life-area-checkins">
        <CheckinControl
          icon={Sun}
          label="Morning check-in"
          hint="Texts the group what is in progress or due soon and asks what to wrap up"
          area={group}
          value={group.morning_checkin_time ?? null}
          fallback="08:30"
          onChange={time => checkin.mutate({ id: group.id, morning_checkin_time: time })}
        />
        <CheckinControl
          icon={Moon}
          label="Evening check-in"
          hint="Asks the group how the day went; everyone's answers become one shared journal entry"
          area={group}
          value={group.evening_checkin_time ?? null}
          fallback="20:30"
          onChange={time => checkin.mutate({ id: group.id, evening_checkin_time: time })}
        />
        <label className={`life-area-checkin ${group.checkin_copy_to_owner ? "on" : ""}`} title="A copy of each check-in also comes to your own number">
          <input
            type="checkbox"
            checked={Boolean(group.checkin_copy_to_owner)}
            aria-label={`Also text me a copy for ${group.name}`}
            onChange={event => checkin.mutate({ id: group.id, checkin_copy_to_owner: event.target.checked })}
          />
          <Copy size={12} aria-hidden="true"/>
          <span>Also text me a copy</span>
        </label>
      </div>
    </div>)}
  </div>;
}

/**
 * One scheduled check-in for a group: a switch and, while it is on, the local
 * time it goes out. The time is kept while the switch is off so turning it back
 * on brings back the hour that was chosen rather than the default.
 */
function CheckinControl({ icon: Icon, label, hint, area, value, fallback, onChange }: {
  icon: typeof Sun;
  label: string;
  hint: string;
  area: LifeArea;
  value: string | null;
  fallback: string;
  onChange: (time: string | null) => void;
}) {
  const [remembered, setRemembered] = useState(value ?? fallback);
  const on = value !== null;
  return <label className={`life-area-checkin ${on ? "on" : ""}`} title={hint}>
    <input
      type="checkbox"
      checked={on}
      aria-label={`${label} for ${area.name}`}
      onChange={event => onChange(event.target.checked ? remembered : null)}
    />
    <Icon size={12} aria-hidden="true"/>
    <span>{label}</span>
    <input
      className="input"
      type="time"
      value={on ? value : remembered}
      disabled={!on}
      aria-label={`${label} time for ${area.name}`}
      onChange={event => {
        setRemembered(event.target.value);
        if (event.target.value) onChange(event.target.value);
      }}
    />
  </label>;
}
