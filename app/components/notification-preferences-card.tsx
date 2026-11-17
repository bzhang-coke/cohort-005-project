import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader } from "./ui/card";
import { Button } from "./ui/button";
import {
  createNotificationPreferencesClient,
  type NotificationPreferencesClient,
} from "~/lib/notification-preferences-client";
import {
  notificationLabels,
  type NotificationCategory,
  type NotificationSettings,
} from "~/lib/notifications";

const defaultClient = createNotificationPreferencesClient();
type PendingChanges = Partial<
  Record<NotificationCategory, { enabled: boolean; sequence: number }>
>;

export function NotificationPreferencesCard({
  personId,
  client = defaultClient,
}: {
  personId: number;
  client?: NotificationPreferencesClient;
}) {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [pending, setPending] = useState<PendingChanges>({});
  const [feedback, setFeedback] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const changes = useRef<PendingChanges>({});
  const sequence = useRef(0);
  const queue = useRef(Promise.resolve());
  const lifecycle = useRef(0);

  useEffect(() => {
    const current = ++lifecycle.current;
    setLoadFailed(false);
    void client
      .load()
      .then((result) => {
        if (lifecycle.current === current && result.personId === personId)
          setSettings(result);
        else if (lifecycle.current === current) setLoadFailed(true);
      })
      .catch(() => {
        if (lifecycle.current === current) setLoadFailed(true);
      });
    return () => {
      lifecycle.current += 1;
    };
  }, [client, personId, retry]);

  function flip(category: NotificationCategory) {
    if (!settings || settings.status !== "ready") return;
    const enabled = !(
      changes.current[category]?.enabled ??
      settings.preferences?.[category]?.channels.feed ??
      category !== "enrollments"
    );
    const change = { category, channel: "feed" as const, enabled };
    const id = ++sequence.current;
    const current = lifecycle.current;
    changes.current[category] = { enabled, sequence: id };
    setPending({ ...changes.current });
    setFeedback("Saving...");
    // Preserve same-category intent order, including rapid on/off/on flips.
    // Pending leaves remain optimistic while older snapshots reconcile.
    queue.current = queue.current.then(async () => {
      if (lifecycle.current !== current) return;
      try {
        const saved = await client.save(change);
        if (lifecycle.current !== current) return;
        if (saved.personId !== personId || saved.status !== "ready")
          throw new Error("Notification preferences are unavailable.");
        setSettings(saved);
        setFeedback("Saved");
        toast.success("Notification preference saved.");
      } catch {
        if (lifecycle.current !== current) return;
        let reconciled = false;
        try {
          const saved = await client.load();
          if (lifecycle.current !== current) return;
          if (saved.personId === personId) {
            setSettings(saved);
            reconciled = saved.status === "ready";
          }
        } catch {
          // Keep the last confirmed snapshot if the reconciliation also fails.
        }
        if (lifecycle.current !== current) return;
        setFeedback(
          reconciled
            ? "Could not save. Saved preferences restored."
            : "Could not save. Showing the last confirmed preferences."
        );
        toast.error(
          "Notification preference could not be saved. Please try again."
        );
      } finally {
        if (
          lifecycle.current === current &&
          changes.current[category]?.sequence === id
        ) {
          delete changes.current[category];
          setPending({ ...changes.current });
        }
      }
    });
  }

  const saving = Object.keys(pending).length > 0;
  return (
    <Card id="notifications" className="mt-8 max-w-md">
      <CardHeader>
        <h2 className="text-lg font-semibold">Notifications</h2>
        <p className="text-sm text-muted-foreground">
          Choose what appears in your Notification Feed.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadFailed ? (
          <div role="alert" className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Notification preferences could not be loaded.
            </p>
            <Button
              variant="outline"
              onClick={() => setRetry((value) => value + 1)}
            >
              Try again
            </Button>
          </div>
        ) : !settings ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading Notification preferences...
          </p>
        ) : (
          <>
            {settings.status !== "ready" && (
              <p className="text-sm text-muted-foreground">
                Notification preferences are currently unavailable. Please try
                again later.
              </p>
            )}
            {settings.categories.map((category) => {
              const checked =
                pending[category]?.enabled ??
                settings.preferences?.[category]?.channels.feed ??
                category !== "enrollments";
              return (
                <div
                  key={category}
                  className="flex items-center justify-between gap-4"
                >
                  <label
                    id={`notification-label-${category}`}
                    htmlFor={`notification-${category}`}
                    className="text-sm font-medium"
                  >
                    {notificationLabels[category]}
                  </label>
                  <button
                    id={`notification-${category}`}
                    type="button"
                    role="switch"
                    aria-labelledby={`notification-label-${category}`}
                    aria-checked={checked}
                    disabled={settings.status !== "ready"}
                    onClick={() => flip(category)}
                    className={`inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-transparent transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "bg-primary" : "bg-input"}`}
                  >
                    <span
                      className={`pointer-events-none block size-5 rounded-full bg-background shadow-sm transition-transform ${checked ? "translate-x-5" : "translate-x-0"}`}
                    />
                  </button>
                </div>
              );
            })}
          </>
        )}
        <p
          role="status"
          aria-live="polite"
          className="min-h-5 text-xs text-muted-foreground"
        >
          {saving ? "Saving..." : feedback}
        </p>
      </CardContent>
    </Card>
  );
}
