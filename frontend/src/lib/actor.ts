const ACTOR_STORAGE_KEY = "orm_dashboard_actor_name";

/**
 * Best-effort "who did this" for the DeletionLog audit trail. This app has
 * no login/session system, so there is no real user identity to attach —
 * this asks for a free-text name once per browser (remembered in
 * localStorage) rather than fabricating precision the app doesn't have.
 */
export function getActorName(): string | undefined {
  try {
    const stored = localStorage.getItem(ACTOR_STORAGE_KEY);
    if (stored && stored.trim()) return stored.trim();

    const entered = window.prompt("Deleting as (your name, kept for the deletion log):") || "";
    if (entered.trim()) {
      localStorage.setItem(ACTOR_STORAGE_KEY, entered.trim());
      return entered.trim();
    }
    return undefined;
  } catch {
    return undefined;
  }
}
