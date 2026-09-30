import { useEffect, useState } from "react";

export interface PendingDeletion {
  label: string;
  undo: () => Promise<void>;
}

/**
 * Deletion safety net UI: by the time this renders, the delete has already
 * happened server-side as a SOFT delete with a 24h grace period (see
 * services/queryService.ts's purgeExpiredDeletions/computePurgeAt) — this
 * toast is just the immediate "oops" affordance. Letting it time out does
 * NOT finalize the delete; the item stays recoverable in the 24h trash
 * window either way, so there's no risk in the toast disappearing before
 * someone reacts to it.
 */
export function UndoToast({
  pending,
  onDismiss,
  seconds = 8,
}: {
  pending: PendingDeletion | null;
  onDismiss: () => void;
  seconds?: number;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!pending) return;
    setVisible(true);
    const timer = setTimeout(() => {
      setVisible(false);
      onDismiss();
    }, seconds * 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  if (!pending || !visible) return null;

  return (
    <div
      role="status"
      style={{
        position: "fixed",
        bottom: 24,
        left: "50%",
        transform: "translateX(-50%)",
        background: "#1c2438",
        border: "1px solid #2a3350",
        borderRadius: 10,
        padding: "12px 18px",
        display: "flex",
        alignItems: "center",
        gap: 16,
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        zIndex: 1000,
      }}
    >
      <span style={{ fontSize: 13, color: "#e5e9f5" }}>{pending.label} — recoverable for 24h.</span>
      <button
        type="button"
        onClick={async () => {
          setVisible(false);
          onDismiss();
          await pending.undo();
        }}
        style={{ background: "transparent", border: "none", color: "#60a5fa", fontWeight: 700, fontSize: 13, cursor: "pointer" }}
      >
        UNDO
      </button>
    </div>
  );
}
