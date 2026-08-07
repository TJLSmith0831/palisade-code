import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Props = {
  onClose: () => void;
  label: string;
  className?: string;
  testId?: string;
  children: ReactNode;
};

/** Shared `role="dialog"` wrapper for every overlay/commandbar in the app — focuses
 * the first control on open and traps Tab within the dialog while it's up. */
export default function Modal({ onClose, label, className, testId, children }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    // A child's own `autoFocus` (e.g. the branch-name input) wins if it already claimed focus.
    if (!box.contains(document.activeElement)) box.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    box.addEventListener("keydown", onKeyDown);
    return () => box.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="overlay" onClick={onClose}>
      <div
        ref={boxRef}
        className={`commandbar ${className ?? ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-testid={testId}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
