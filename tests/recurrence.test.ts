import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { localParts, zonedToInstant } from "../server/local-time.ts";
import {
  anchorRecurrence, completionStreak, materializeRecurrence, nextOccurrence, occursOn,
  planRecurrenceWrite, previousOccurrence, type RecurrenceRule,
} from "../server/recurrence.ts";

const NY = "America/New_York";

const daily = (time = "08:00", extra: Partial<RecurrenceRule> = {}): RecurrenceRule =>
  ({ freq: "daily", interval: 1, weekdays: [], time, lead_minutes: null, ...extra });

describe("zonedToInstant", () => {
  it("inverts localParts on both sides of a DST change", () => {
    for (const [date, time] of [["2026-03-07", "08:00"], ["2026-03-08", "08:00"], ["2026-11-01", "08:00"], ["2026-07-04", "23:30"]]) {
      const instant = zonedToInstant(date, time, NY);
      assert.deepEqual(localParts(instant, NY), { date, time });
    }
  });

  it("reads UTC as UTC", () => {
    assert.equal(zonedToInstant("2026-01-15", "08:00", "UTC").toISOString(), "2026-01-15T08:00:00.000Z");
  });

  it("lands a time inside the spring-forward gap on the hour the zone actually has", () => {
    // 02:30 does not exist on 2026-03-08 in New York; the result is a real instant that morning.
    const instant = zonedToInstant("2026-03-08", "02:30", NY);
    assert.equal(localParts(instant, NY).date, "2026-03-08");
    assert.ok(["01:30", "03:30"].includes(localParts(instant, NY).time));
  });
});

describe("nextOccurrence", () => {
  it("picks today when the time is still ahead and tomorrow once it has passed", () => {
    const rule = daily("08:00");
    const before = zonedToInstant("2026-01-15", "07:59", NY);
    const after = zonedToInstant("2026-01-15", "08:00", NY);
    assert.equal(nextOccurrence(rule, before, NY).toISOString(), zonedToInstant("2026-01-15", "08:00", NY).toISOString());
    assert.equal(nextOccurrence(rule, after, NY).toISOString(), zonedToInstant("2026-01-16", "08:00", NY).toISOString());
  });

  it("keeps the wall-clock time across the DST change", () => {
    const rule = daily("08:00");
    const saturday = zonedToInstant("2026-03-07", "09:00", NY);
    const sunday = nextOccurrence(rule, saturday, NY);
    assert.deepEqual(localParts(sunday, NY), { date: "2026-03-08", time: "08:00" });
    // 23 hours apart rather than 24, because the clocks went forward in between.
    assert.equal(sunday.getTime() - zonedToInstant("2026-03-07", "08:00", NY).getTime(), 23 * 3_600_000);
  });

  it("counts every N days from the anchor", () => {
    const rule = daily("08:00", { interval: 3, anchor_date: "2026-01-10" });
    assert.ok(occursOn(rule, "2026-01-10"));
    assert.ok(!occursOn(rule, "2026-01-11"));
    assert.ok(occursOn(rule, "2026-01-13"));
    const from = zonedToInstant("2026-01-11", "12:00", "UTC");
    assert.equal(nextOccurrence(rule, from, "UTC").toISOString(), "2026-01-13T08:00:00.000Z");
  });

  it("walks the chosen weekdays and wraps the week", () => {
    // Mon/Wed/Fri at 21:00. 2026-01-16 is a Friday.
    const rule: RecurrenceRule = { freq: "weekly", interval: 1, weekdays: [1, 3, 5], time: "21:00", lead_minutes: null };
    const fridayNight = zonedToInstant("2026-01-16", "22:00", "UTC");
    assert.equal(nextOccurrence(rule, fridayNight, "UTC").toISOString(), "2026-01-19T21:00:00.000Z", "Monday follows Friday");
    const mondayMorning = zonedToInstant("2026-01-19", "08:00", "UTC");
    assert.equal(nextOccurrence(rule, mondayMorning, "UTC").toISOString(), "2026-01-19T21:00:00.000Z");
  });

  it("skips the off weeks of an every-other-week rule", () => {
    // Saturdays, every other week, phased from Saturday 2026-01-10.
    const rule: RecurrenceRule = { freq: "weekly", interval: 2, weekdays: [6], time: "10:00", lead_minutes: null, anchor_date: "2026-01-10" };
    assert.ok(occursOn(rule, "2026-01-10"));
    assert.ok(!occursOn(rule, "2026-01-17"));
    assert.ok(occursOn(rule, "2026-01-24"));
    const from = zonedToInstant("2026-01-11", "00:00", "UTC");
    assert.equal(nextOccurrence(rule, from, "UTC").toISOString(), "2026-01-24T10:00:00.000Z");
  });
});

describe("previousOccurrence", () => {
  it("is the mirror of nextOccurrence", () => {
    const rule: RecurrenceRule = { freq: "weekly", interval: 1, weekdays: [1, 3, 5], time: "21:00", lead_minutes: null };
    const monday = zonedToInstant("2026-01-19", "21:00", "UTC");
    assert.equal(previousOccurrence(rule, monday, "UTC").toISOString(), "2026-01-16T21:00:00.000Z");
    assert.equal(previousOccurrence(daily("08:00"), zonedToInstant("2026-01-15", "08:00", "UTC"), "UTC").toISOString(), "2026-01-14T08:00:00.000Z");
  });
});

describe("anchorRecurrence and materializeRecurrence", () => {
  it("phases a new series from its first occurrence", () => {
    const early = zonedToInstant("2026-01-15", "07:00", "UTC");
    const late = zonedToInstant("2026-01-15", "09:00", "UTC");
    assert.equal(anchorRecurrence(daily("08:00", { interval: 2 }), null, "UTC", early).anchor_date, "2026-01-15");
    assert.equal(anchorRecurrence(daily("08:00", { interval: 2 }), null, "UTC", late).anchor_date, "2026-01-16");
  });

  it("keeps the phase when only the time changes and restarts it when the cadence does", () => {
    const previous = daily("08:00", { interval: 2, anchor_date: "2026-01-01" });
    assert.equal(anchorRecurrence(daily("09:00", { interval: 2 }), previous, "UTC").anchor_date, "2026-01-01");
    assert.notEqual(anchorRecurrence(daily("09:00", { interval: 3 }), previous, "UTC").anchor_date, "2026-01-01");
  });

  it("derives the reminder from the lead and leaves it out when there is none", () => {
    const from = zonedToInstant("2026-01-15", "07:00", "UTC");
    assert.deepEqual(materializeRecurrence(daily("08:00", { lead_minutes: 10 }), "UTC", from), {
      due_at: "2026-01-15T08:00:00.000Z",
      reminder_at: "2026-01-15T07:50:00.000Z",
    });
    assert.deepEqual(materializeRecurrence(daily("08:00", { lead_minutes: 0 }), "UTC", from), {
      due_at: "2026-01-15T08:00:00.000Z",
      reminder_at: "2026-01-15T08:00:00.000Z",
    });
    assert.equal(materializeRecurrence(daily("08:00"), "UTC", from).reminder_at, null);
  });
});

describe("planRecurrenceWrite", () => {
  const current = {
    recurrence_json: JSON.stringify(daily("08:00", { anchor_date: "2026-01-01" })),
    due_at: "2026-01-15T08:00:00.000Z",
    reminder_at: null,
    extra_reminders_json: '["2026-01-15T07:00:00.000Z"]',
  };

  it("locks the schedule of a repeating row when the request says nothing about the rule", () => {
    const plan = planRecurrenceWrite(undefined, current, "UTC");
    assert.equal(plan.recurrence_json, current.recurrence_json);
    assert.deepEqual(plan.derived, {
      due_at: current.due_at,
      reminder_at: null,
      extra_reminders_json: current.extra_reminders_json,
    });
  });

  it("leaves a one-off row alone", () => {
    const plan = planRecurrenceWrite(
      undefined, { recurrence_json: null, due_at: "x", reminder_at: null, extra_reminders_json: "[]" }, "UTC",
    );
    assert.deepEqual(plan, { recurrence_json: null, derived: null });
  });

  it("clears the rule and keeps the current occurrence as a one-off", () => {
    assert.deepEqual(planRecurrenceWrite(null, current, "UTC"), { recurrence_json: null, derived: null });
  });

  it("computes the next occurrence for a new rule", () => {
    const from = zonedToInstant("2026-01-15", "09:00", "UTC");
    const plan = planRecurrenceWrite(daily("08:00", { lead_minutes: 15 }), undefined, "UTC", from);
    assert.deepEqual(plan.derived, {
      due_at: "2026-01-16T08:00:00.000Z",
      reminder_at: "2026-01-16T07:45:00.000Z",
      extra_reminders_json: "[]",
    });
    assert.equal(JSON.parse(plan.recurrence_json as string).anchor_date, "2026-01-16");
  });
});

describe("completionStreak", () => {
  const rule = daily("08:00", { anchor_date: "2026-01-01" });
  const day = (date: string) => `${date}T08:00:00.000Z`;

  it("counts consecutive completed occurrences back from the current one", () => {
    const completed = [day("2026-01-13"), day("2026-01-14"), day("2026-01-15")];
    assert.equal(completionStreak(rule, completed, day("2026-01-15"), "UTC"), 3);
  });

  it("steps over an open current occurrence without breaking the run", () => {
    const completed = [day("2026-01-13"), day("2026-01-14")];
    assert.equal(completionStreak(rule, completed, day("2026-01-15"), "UTC"), 2);
  });

  it("stops at a miss", () => {
    assert.equal(completionStreak(rule, [day("2026-01-12"), day("2026-01-14")], day("2026-01-14"), "UTC"), 1);
    assert.equal(completionStreak(rule, [day("2026-01-12"), day("2026-01-13")], day("2026-01-15"), "UTC"), 0);
    assert.equal(completionStreak(rule, [], day("2026-01-01"), "UTC"), 0);
  });
});
