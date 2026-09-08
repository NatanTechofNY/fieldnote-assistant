import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { localParts, zonedToInstant } from "../server/local-time.ts";
import {
  anchorRecurrence, completionStreak, firstOccurrenceOnOrAfter, materializeRecurrence, maxLeadMinutes,
  nextOccurrence, occursOn, parseRecurrence, planRecurrenceWrite, previousOccurrence, type RecurrenceRule,
} from "../server/recurrence.ts";
import { recurrence } from "../server/schemas.ts";

const NY = "America/New_York";
const SANTIAGO = "America/Santiago";

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

  it("resolves a time inside the spring-forward gap forward, never on to the day before", () => {
    // 02:30 does not exist on 2026-03-08 in New York; the clocks went straight to 03:00.
    assert.deepEqual(localParts(zonedToInstant("2026-03-08", "02:30", NY), NY), { date: "2026-03-08", time: "03:30" });
    // Chile's clocks jump at midnight, so 00:00 itself is missing on 2026-09-06.
    // Resolving it backwards would put "the start of today" on yesterday.
    const midnight = zonedToInstant("2026-09-06", "00:00", SANTIAGO);
    assert.deepEqual(localParts(midnight, SANTIAGO), { date: "2026-09-06", time: "01:00" });
    // The fall-back overlap still resolves to one instant that reads as asked.
    assert.deepEqual(localParts(zonedToInstant("2026-11-01", "01:30", NY), NY), { date: "2026-11-01", time: "01:30" });
  });
});

describe("parseRecurrence", () => {
  it("reads a stored rule back and treats a malformed one as no rule", () => {
    const stored = JSON.stringify(daily("08:00", { interval: 2, anchor_date: "2026-01-01", lead_minutes: 10 }));
    assert.deepEqual(parseRecurrence(stored), daily("08:00", { interval: 2, anchor_date: "2026-01-01", lead_minutes: 10 }));
    assert.equal(parseRecurrence(null), null);
    assert.equal(parseRecurrence("not json"), null);
    assert.equal(parseRecurrence(JSON.stringify({ freq: "monthly", time: "08:00" })), null);
    assert.equal(parseRecurrence(JSON.stringify({ freq: "daily", time: "8am" })), null);
    assert.equal(parseRecurrence(JSON.stringify({ freq: "weekly", weekdays: [], time: "08:00" })), null, "weekly with no days cannot be walked");
    assert.deepEqual(
      parseRecurrence(JSON.stringify({ freq: "weekly", weekdays: [5, 1, 9, 1], time: "08:00" }))?.weekdays,
      [1, 5],
      "stray and repeated days are dropped rather than thrown on",
    );
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

  it("reaches the next occurrence of the widest rule the schema admits", () => {
    // Every 365 weeks on a Monday, phased from Monday 2026-01-05: the next one is nearly seven years out.
    const rule: RecurrenceRule = { freq: "weekly", interval: 365, weekdays: [1], time: "09:00", lead_minutes: null, anchor_date: "2026-01-05" };
    const next = nextOccurrence(rule, zonedToInstant("2026-01-06", "00:00", "UTC"), "UTC");
    assert.equal(next.toISOString(), new Date(Date.UTC(2026, 0, 5, 9) + 365 * 7 * 86_400_000).toISOString());
    assert.equal(previousOccurrence(rule, next, "UTC").toISOString(), "2026-01-05T09:00:00.000Z");
    assert.equal(
      nextOccurrence(daily("09:00", { interval: 365, anchor_date: "2026-01-05" }), zonedToInstant("2026-01-06", "00:00", "UTC"), "UTC").toISOString(),
      "2027-01-05T09:00:00.000Z",
    );
  });
});

describe("firstOccurrenceOnOrAfter", () => {
  it("is decided on the local date, so a midnight DST jump cannot pull it on to yesterday", () => {
    // 2026-09-06 has no 00:00 in Santiago. A late rule must still land on the 6th, not the 5th.
    const rule = daily("23:30");
    const first = firstOccurrenceOnOrAfter(rule, "2026-09-06", SANTIAGO);
    assert.deepEqual(localParts(first, SANTIAGO), { date: "2026-09-06", time: "23:30" });
    assert.deepEqual(materializeRecurrence(rule, SANTIAGO, { date: "2026-09-06" }).due_at, first.toISOString());
    // An ordinary day answers the same as searching from just before its midnight.
    assert.equal(
      firstOccurrenceOnOrAfter(daily("08:00"), "2026-01-15", NY).toISOString(),
      nextOccurrence(daily("08:00"), new Date(zonedToInstant("2026-01-15", "00:00", NY).getTime() - 1), NY).toISOString(),
    );
  });
});

describe("maxLeadMinutes", () => {
  it("lets a text reach back only to the midnight after the previous occurrence", () => {
    assert.equal(maxLeadMinutes(daily("09:00")), 540, "every day at 9 can be texted at most nine hours ahead");
    assert.equal(maxLeadMinutes(daily("09:00", { interval: 2 })), 1440 + 540);
    const monFri: RecurrenceRule = { freq: "weekly", interval: 1, weekdays: [1, 5], time: "21:00", lead_minutes: null };
    assert.equal(maxLeadMinutes(monFri), 2 * 1440 + 21 * 60, "Friday to Monday is three days, Monday to Friday four");
    const alternateSaturdays: RecurrenceRule = { freq: "weekly", interval: 2, weekdays: [6], time: "10:00", lead_minutes: null };
    assert.equal(maxLeadMinutes(alternateSaturdays), 13 * 1440 + 600);
    const wrap: RecurrenceRule = { freq: "weekly", interval: 1, weekdays: [0, 6], time: "10:00", lead_minutes: null };
    assert.equal(maxLeadMinutes(wrap), 600, "Saturday and Sunday are a day apart across the week boundary");
  });

  it("is enforced by the schema, which also refuses coerced numbers", () => {
    assert.ok(recurrence.safeParse({ freq: "daily", time: "09:00", lead_minutes: 540 }).success);
    const tooFar = recurrence.safeParse({ freq: "daily", time: "09:00", lead_minutes: 1440 });
    assert.ok(!tooFar.success);
    assert.match(tooFar.error!.issues[0].message, /at most 540 minutes/);
    assert.ok(recurrence.safeParse({ freq: "weekly", weekdays: [1, 5], time: "21:00", lead_minutes: 1440 }).success);
    assert.ok(!recurrence.safeParse({ freq: "weekly", weekdays: [null], time: "21:00" }).success, "null is not Sunday");
    assert.ok(!recurrence.safeParse({ freq: "daily", time: "09:00", lead_minutes: "" }).success, "an empty string is not 'at the time'");
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

  const kept = {
    recurrence_json: current.recurrence_json,
    derived: { due_at: current.due_at, reminder_at: null, extra_reminders_json: current.extra_reminders_json },
    occurrenceMoved: false,
  };

  it("locks the schedule of a repeating row when the request says nothing about the rule", () => {
    assert.deepEqual(planRecurrenceWrite(undefined, current, "UTC"), kept);
  });

  it("treats the same rule sent back as saying nothing, so a rename does not move the occurrence", () => {
    // The editor sends the whole form on every save. The occurrence it holds
    // (08:00 today, already past) and the extra reminder on it both stay.
    const later = zonedToInstant("2026-01-15", "10:00", "UTC");
    assert.deepEqual(planRecurrenceWrite(daily("08:00"), current, "UTC", later), kept);
    // The order the days are listed in is not a change either.
    const weekly = {
      ...current,
      recurrence_json: JSON.stringify({ freq: "weekly", interval: 1, weekdays: [1, 5], time: "08:00", lead_minutes: 0, anchor_date: "2026-01-01" }),
    };
    const resent = planRecurrenceWrite({ freq: "weekly", interval: 1, weekdays: [5, 1], time: "08:00", lead_minutes: 0 }, weekly, "UTC", later);
    assert.equal(resent.recurrence_json, weekly.recurrence_json);
    assert.equal(resent.occurrenceMoved, false);
  });

  it("moves the occurrence when the rule really changes, and says so", () => {
    const later = zonedToInstant("2026-01-15", "10:00", "UTC");
    const plan = planRecurrenceWrite(daily("09:00"), current, "UTC", later);
    assert.equal(plan.occurrenceMoved, true);
    assert.deepEqual(plan.derived, { due_at: "2026-01-16T09:00:00.000Z", reminder_at: null, extra_reminders_json: "[]" });
    assert.equal(JSON.parse(plan.recurrence_json as string).anchor_date, "2026-01-01", "a time change keeps the phase");
  });

  it("leaves a one-off row alone", () => {
    const plan = planRecurrenceWrite(
      undefined, { recurrence_json: null, due_at: "x", reminder_at: null, extra_reminders_json: "[]" }, "UTC",
    );
    assert.deepEqual(plan, { recurrence_json: null, derived: null, occurrenceMoved: false });
  });

  it("clears the rule and keeps the current occurrence as a one-off", () => {
    assert.deepEqual(planRecurrenceWrite(null, current, "UTC"), { recurrence_json: null, derived: null, occurrenceMoved: false });
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
    assert.equal(plan.occurrenceMoved, false, "a new row has no occurrence to move from");
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

  it("survives the time of the rule changing, because days are matched rather than instants", () => {
    // Two mornings done at 08:00, then the rule moved to 09:00 and the row rolled on to the 15th at 09:00.
    const moved = daily("09:00", { anchor_date: "2026-01-01" });
    const completed = [day("2026-01-13"), day("2026-01-14")];
    assert.equal(completionStreak(moved, completed, "2026-01-15T09:00:00.000Z", "UTC"), 2);
    // The same log read from a different timezone still lines up by local day.
    assert.equal(completionStreak(moved, completed, "2026-01-15T09:00:00.000Z", NY), 2);
  });
});
