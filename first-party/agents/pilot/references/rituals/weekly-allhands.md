# Weekly all-hands

A status report you write to `.pilot/reports/<YYYY-MM-DD>-weekly.md` on a roughly-weekly cadence. Goal: give the user a digestible summary of what the company did this week, without them having to read the full mission logs.

## When

Cadence is your judgment — every 7 days is the default, but adjust to mission tempo. Fast-moving missions might want every 3-4 days; slow-burn missions every 14.

Trigger by checking on each tick: "is it been ≥ 7 days since `.pilot/reports/*-weekly.md` was last written?"

## Format

```markdown
# Weekly all-hands — <YYYY-MM-DD>

## Mission status
<One sentence per active mission: where it stands, what's next.>

## This week's wins
- <bullet per significant accomplishment>
- ...

## Issues encountered
- <bullet per non-trivial setback, with how it was handled>
- ...

## Org changes
- <hires / fires / role changes this week, with one-line reason each>

## Lessons added
- <one-line lessons added to lessons.md this week>

## Looking ahead
- <what you plan to dispatch / focus on in the coming week>

## Asks for the user
- <anything you need from the user to be unblocked>
- (if none, say "No asks this week.")
```

## Drafting process

1. Skim each `.pilot/active-missions/<id>/progress.md` — read the entries from the past week.
2. Skim `.pilot/decisions.log` — entries from the past week, filter for HIRE / RETIRE / SPLIT / MERGE / POSTMORTEM / LESSON.
3. Skim `.pilot/lessons.md` — what was added under the current month?
4. Compose the report following the template.
5. Save to `.pilot/reports/<date>-weekly.md`.
6. Surface to the user in the session terminal: a one-liner ("This week's report: see .pilot/reports/<date>-weekly.md") + the "Asks for the user" section verbatim.

## Quality bar

- Each mission gets exactly one sentence in the status section. If you can't summarize in one sentence, the report is too noisy.
- "Wins" should be observable outcomes, not effort ("delivered the X analysis", not "worked hard on X").
- "Issues" should always pair with how they were handled (or escalation if not yet).
- "Asks for the user" is the most-read section. Make it short and specific.

## Don't

- Don't reproduce the full progress.md of every mission. The reports/ directory is a digest layer; the mission progress.md is the source.
- Don't write a report if literally nothing happened that week. Write "Quiet week — see [open mission status]." in the terminal instead, and skip the file.
- Don't bury bad news. If a mission is failing, lead with that.
