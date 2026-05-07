import { type ReactNode, useEffect, useRef } from "react";
import { CloseIcon } from "./Icons";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  size?: "default" | "large";
}

/**
 * Thin wrapper around the native <dialog> element. Gives us focus trap,
 * ESC-to-close, and backdrop styling without importing any UI library.
 */
export function Modal({ open, onClose, title, children, size = "default" }: ModalProps) {
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
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal__inner">
        <div className="modal__header">
          <h3 className="modal__title">{title}</h3>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
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
