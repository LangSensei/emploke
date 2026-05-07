import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CloseIcon, PlusIcon } from "./Icons";

interface ChipsInputProps {
  values: string[];
  onChange: (values: string[]) => void;
  options: string[];
  placeholder?: string;
  disabled?: boolean;
  emptyText?: string;
  /** Values to render as "missing" (red) — typically deps that don't exist in the catalog. */
  invalidValues?: readonly string[];
}

interface SuggestRect {
  left: number;
  top: number;
  width: number;
}

/**
 * Multi-select with autocomplete and free-text fallback.
 *
 * The suggestion dropdown is rendered via a portal so it can escape ancestor
 * `overflow: hidden` containers (e.g. a modal body that scrolls). It uses
 * `position: fixed` with viewport coordinates computed from the input's
 * bounding rect, and the portal target is the nearest <dialog> ancestor (if
 * any) so we stay inside the browser's native top-layer when the chips live
 * inside a modal — otherwise document.body covers the dialog visually.
 */
export function ChipsInput({
  values,
  onChange,
  options,
  placeholder,
  disabled,
  emptyText,
  invalidValues,
}: ChipsInputProps) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [rect, setRect] = useState<SuggestRect | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const inputId = useId();
  const containerRef = useRef<HTMLDivElement>(null);

  const add = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    if (values.includes(v)) return;
    onChange([...values, v]);
    setText("");
  };

  const remove = (v: string) => {
    onChange(values.filter((x) => x !== v));
  };

  const suggestions = options
    .filter((o) => !values.includes(o))
    .filter((o) => o.toLowerCase().includes(text.toLowerCase()))
    .slice(0, 8);

  // biome-ignore lint/correctness/useExhaustiveDependencies: rect updates whenever focus / values change
  useLayoutEffect(() => {
    if (!focused) return;
    // Resolve the portal target: the nearest <dialog> ancestor or document.body.
    const target = containerRef.current?.closest("dialog") ?? document.body;
    setPortalTarget(target as HTMLElement);

    const update = () => {
      const r = containerRef.current?.getBoundingClientRect();
      if (!r) return;
      setRect({ left: r.left, top: r.bottom + 4, width: r.width });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [focused, values.length, text]);

  useEffect(() => {
    if (!focused) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFocused(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [focused]);

  const showDropdown = focused && suggestions.length > 0 && rect && portalTarget;

  return (
    <div className="chips" ref={containerRef}>
      <div className="chips__row">
        {values.length === 0 && !text && emptyText && (
          <span className="chips__empty">{emptyText}</span>
        )}
        {values.map((v) => {
          const isInvalid = invalidValues?.includes(v) ?? false;
          return (
            <span
              key={v}
              className={`chips__chip${isInvalid ? " chips__chip--invalid" : ""}`}
              title={isInvalid ? `Missing: not found in catalog` : undefined}
            >
              <span className="chips__chip-text">{v}</span>
              {!disabled && (
                <button
                  type="button"
                  className="chips__chip-remove"
                  onClick={() => remove(v)}
                  aria-label={`Remove ${v}`}
                >
                  <CloseIcon />
                </button>
              )}
            </span>
          );
        })}
        <input
          id={inputId}
          type="text"
          className="chips__input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(text);
            } else if (e.key === "Backspace" && text === "" && values.length > 0) {
              remove(values[values.length - 1]!);
            } else if (e.key === "," && text.trim()) {
              e.preventDefault();
              add(text);
            } else if (e.key === "Escape") {
              setFocused(false);
            }
          }}
          placeholder={values.length === 0 ? placeholder : ""}
          disabled={disabled}
          autoComplete="off"
        />
      </div>
      {showDropdown &&
        createPortal(
          <div
            className="chips__suggest"
            style={{ left: rect.left, top: rect.top, width: rect.width }}
          >
            {suggestions.map((o) => (
              <button
                key={o}
                type="button"
                className="chips__suggest-item"
                onMouseDown={(e) => {
                  e.preventDefault();
                  add(o);
                }}
              >
                <PlusIcon />
                <span>{o}</span>
              </button>
            ))}
          </div>,
          portalTarget,
        )}
    </div>
  );
}
