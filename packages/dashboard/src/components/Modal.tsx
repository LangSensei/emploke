import { type ReactNode, useEffect, useRef } from "react";
import { CloseIcon } from "./Icons";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * Modal title. Used as the default header content (rendered as an
   * `<h3 class="modal__title">`) and as the dialog's accessible name
   * via `aria-label` unless {@link ariaLabelledBy} is provided.
   */
  title: string;
  /**
   * Optional id of an element whose text should become the dialog's
   * accessible name. Reach for this when the modal's header includes
   * programmatic content beyond a plain title (e.g. kind icon + fqn +
   * status pill) that screen-reader users should hear. When set,
   * `aria-labelledby` wins and `aria-label` is omitted — the two
   * attributes conflict (`aria-labelledby` takes precedence per spec),
   * so we defensively drop the redundant one.
   */
  ariaLabelledBy?: string;
  /**
   * Optional rich header content. When provided, renders in place of
   * the default `<h3>{title}</h3>` and lets callers compose hero
   * blocks (kind icon, fqn, status pill, etc.) without breaking the
   * modal frame. The close button is always appended after.
   */
  header?: ReactNode;
  children: ReactNode;
  size?: "default" | "large";
}

/**
 * Thin wrapper around the native <dialog> element. Gives us focus trap,
 * ESC-to-close, and backdrop styling without importing any UI library.
 */
export function Modal({
  open,
  onClose,
  title,
  ariaLabelledBy,
  header,
  children,
  size = "default",
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    if (!open && dlg.open) dlg.close();
  }, [open]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop-click only; ESC handled by native <dialog> onCancel
    <dialog
      ref={ref}
      className={`modal modal--${size}`}
      aria-label={ariaLabelledBy === undefined ? title : undefined}
      aria-labelledby={ariaLabelledBy}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal__inner">
        <div className={`modal__header${header ? " modal__header--rich" : ""}`}>
          {header ?? <h3 className="modal__title">{title}</h3>}
          <button
            type="button"
            className="btn btn--ghost btn--icon modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
