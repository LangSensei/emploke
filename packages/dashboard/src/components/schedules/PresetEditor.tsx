import type { ChangeEvent } from "react";
import { HOUR_DIVISORS, MINUTE_DIVISORS, type Preset, type PresetKind } from "./cronPresets";
import { PRESET_OPTIONS, WEEKDAY_LABELS } from "./scheduleFormShared";

export interface PresetEditorProps {
  preset: Preset;
  onChange: (p: Preset) => void;
  disabled: boolean;
  /**
   * Prefix for input/label ids and data-testids. Defaults to
   * `"create-schedule"` so the original `CreateScheduleModal` tests
   * keep passing without changes. `EditScheduleModal` passes
   * `"edit-schedule"` to avoid id collisions if both modals are
   * mounted (only one is open at a time in practice, but unique
   * testids keep tests independent).
   */
  idPrefix?: string;
}

/**
 * Inline editor for the per-preset parameters (hour, minute, days,
 * dayOfMonth, n, raw expr). Switching the preset kind via the top
 * select reseeds the parameters with sensible defaults so the user
 * never sees an empty input on first switch.
 *
 * Extracted from `CreateScheduleModal` so `EditScheduleModal` can
 * reuse it without copying ~200 LOC of preset-row rendering.
 */
export function PresetEditor({
  preset,
  onChange,
  disabled,
  idPrefix = "create-schedule",
}: PresetEditorProps) {
  const setKind = (kind: PresetKind) => {
    switch (kind) {
      case "daily":
        onChange({ kind, hour: 9, minute: 0 });
        return;
      case "weekdays":
        onChange({ kind, hour: 9, minute: 0 });
        return;
      case "weekly":
        onChange({ kind, days: [1, 2, 3, 4, 5], hour: 9, minute: 0 });
        return;
      case "monthly":
        onChange({ kind, dayOfMonth: 1, hour: 9, minute: 0 });
        return;
      case "every-n-hours":
        onChange({ kind, n: 6 });
        return;
      case "every-n-minutes":
        onChange({ kind, n: 15 });
        return;
      case "advanced":
        onChange({ kind, expr: "" });
        return;
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <label htmlFor={`${idPrefix}-preset-kind`}>
        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
          Schedule
        </div>
        <select
          id={`${idPrefix}-preset-kind`}
          value={preset.kind}
          onChange={(e) => setKind(e.target.value as PresetKind)}
          disabled={disabled}
          className="select select--full"
          data-testid={`${idPrefix}-preset`}
        >
          {PRESET_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      {(preset.kind === "daily" ||
        preset.kind === "weekdays" ||
        preset.kind === "weekly" ||
        preset.kind === "monthly") && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {preset.kind === "monthly" && (
            <label htmlFor={`${idPrefix}-dom`}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                Day
              </div>
              <input
                id={`${idPrefix}-dom`}
                type="number"
                min={1}
                max={31}
                value={preset.dayOfMonth}
                onChange={(e) =>
                  onChange({ ...preset, dayOfMonth: clampInt(e, 1, 31, preset.dayOfMonth) })
                }
                disabled={disabled}
                className="input"
                style={{ width: 80 }}
                data-testid={`${idPrefix}-dom`}
              />
            </label>
          )}
          {preset.kind === "weekly" && (
            <fieldset
              style={{ border: "none", padding: 0, margin: 0, display: "flex", gap: 4 }}
              data-testid={`${idPrefix}-weekday-group`}
            >
              <legend className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                Days
              </legend>
              {WEEKDAY_LABELS.map(({ value, label }) => {
                const checked = preset.days.includes(value);
                return (
                  <label
                    key={value}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      fontSize: 12,
                    }}
                  >
                    <span>{label}</span>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...preset.days, value]
                          : preset.days.filter((d) => d !== value);
                        onChange({ ...preset, days: next });
                      }}
                      data-testid={`${idPrefix}-weekday-${value}`}
                    />
                  </label>
                );
              })}
            </fieldset>
          )}
          <label htmlFor={`${idPrefix}-hour`}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Hour (0–23)
            </div>
            <input
              id={`${idPrefix}-hour`}
              type="number"
              min={0}
              max={23}
              value={preset.hour}
              onChange={(e) => onChange({ ...preset, hour: clampInt(e, 0, 23, preset.hour) })}
              disabled={disabled}
              className="input"
              style={{ width: 80 }}
              data-testid={`${idPrefix}-hour`}
            />
          </label>
          <label htmlFor={`${idPrefix}-minute`}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
              Minute (0–59)
            </div>
            <input
              id={`${idPrefix}-minute`}
              type="number"
              min={0}
              max={59}
              value={preset.minute}
              onChange={(e) => onChange({ ...preset, minute: clampInt(e, 0, 59, preset.minute) })}
              disabled={disabled}
              className="input"
              style={{ width: 80 }}
              data-testid={`${idPrefix}-minute`}
            />
          </label>
        </div>
      )}

      {preset.kind === "every-n-hours" && (
        <label htmlFor={`${idPrefix}-every-h`}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            Every N hours (divisors of 24)
          </div>
          <select
            id={`${idPrefix}-every-h`}
            value={String(preset.n)}
            onChange={(e) =>
              onChange({ kind: "every-n-hours", n: Number.parseInt(e.target.value, 10) })
            }
            disabled={disabled}
            className="select"
            data-testid={`${idPrefix}-every-h`}
          >
            {HOUR_DIVISORS.map((n) => (
              <option key={n} value={String(n)}>
                {n}
              </option>
            ))}
          </select>
        </label>
      )}

      {preset.kind === "every-n-minutes" && (
        <label htmlFor={`${idPrefix}-every-m`}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            Every N minutes (divisors of 60)
          </div>
          <select
            id={`${idPrefix}-every-m`}
            value={String(preset.n)}
            onChange={(e) =>
              onChange({ kind: "every-n-minutes", n: Number.parseInt(e.target.value, 10) })
            }
            disabled={disabled}
            className="select"
            data-testid={`${idPrefix}-every-m`}
          >
            {MINUTE_DIVISORS.map((n) => (
              <option key={n} value={String(n)}>
                {n}
              </option>
            ))}
          </select>
        </label>
      )}

      {preset.kind === "advanced" && (
        <label htmlFor={`${idPrefix}-advanced`}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            Raw cron expression (5 fields: minute hour dayOfMonth month dayOfWeek)
          </div>
          <input
            id={`${idPrefix}-advanced`}
            type="text"
            value={preset.expr}
            onChange={(e) => onChange({ kind: "advanced", expr: e.target.value })}
            disabled={disabled}
            placeholder="*/5 9-17 * * 1-5"
            className="input"
            style={{ width: "100%", fontFamily: "monospace" }}
            data-testid={`${idPrefix}-advanced`}
          />
        </label>
      )}
    </div>
  );
}

function clampInt(
  e: ChangeEvent<HTMLInputElement>,
  min: number,
  max: number,
  fallback: number,
): number {
  const raw = e.target.value;
  if (raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
