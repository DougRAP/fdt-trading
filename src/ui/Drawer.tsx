import { useEffect, useRef, type ReactNode } from "react";

export function Drawer({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="cp-dialog" aria-label={title} onClose={onClose} onCancel={onClose}>
      <div className="cp-dialog-head">
        <h2>{title}</h2>
        <button type="button" onClick={onClose} aria-label={`Close ${title}`}>Close</button>
      </div>
      {open && <div className="cp-body">{children}</div>}
    </dialog>
  );
}
