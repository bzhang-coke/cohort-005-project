import { useEffect, useState, useSyncExternalStore } from "react";
import { Link, useNavigate } from "react-router";
import { Popover } from "radix-ui";
import {
  Bell,
  Check,
  GraduationCap,
  MessageSquare,
  Receipt,
  Settings,
  UsersRound,
} from "lucide-react";
import { UserAvatar } from "~/components/user-avatar";
import { cn } from "~/lib/utils";
import {
  createNotificationFeedController,
  fetchNotificationIdentity,
  notificationBadge,
  type NotificationRow,
} from "~/lib/notification-feed-client";
import type { NotificationCategory } from "~/lib/notifications";

const icons: Record<NotificationCategory, typeof Receipt> = {
  refundRequestUpdates: Receipt,
  openRefundRequests: Receipt,
  discussionQuestions: MessageSquare,
  discussionReplies: MessageSquare,
  enrollments: GraduationCap,
  seatClaims: UsersRound,
};
function elapsed(iso: string) {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(iso)) / 1000)
  );
  if (seconds < 60) return "Just now";
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (seconds < 3600)
    return formatter.format(-Math.floor(seconds / 60), "minute");
  if (seconds < 86400)
    return formatter.format(-Math.floor(seconds / 3600), "hour");
  return formatter.format(-Math.floor(seconds / 86400), "day");
}
function Sender({ row }: { row: NotificationRow }) {
  const Icon = icons[row.category];
  return (
    <span className={cn("relative shrink-0", row.read && "opacity-45")}>
      {row.actor ? (
        <UserAvatar
          name={row.actor.name}
          avatarUrl={row.actor.avatarUrl}
          className="size-10"
        />
      ) : (
        <span
          aria-label="Cadence"
          className="flex size-10 items-center justify-center rounded-full bg-primary font-bold text-primary-foreground"
        >
          C
        </span>
      )}
      <span className="absolute -bottom-1 -right-1 rounded-full border-2 border-popover bg-muted p-0.5">
        <Icon aria-hidden="true" className="size-3" />
      </span>
    </span>
  );
}

export function NotificationFeed({ personId }: { personId: number }) {
  const navigate = useNavigate();
  const [controller] = useState(() =>
    createNotificationFeedController({
      credentials: fetchNotificationIdentity,
      connect: async (identity, renew) => {
        const { knockNotificationFeedClient } =
          await import("~/lib/notifications/knock.client");
        return knockNotificationFeedClient(identity, renew);
      },
    })
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  useEffect(() => {
    void controller.setPerson(personId);
    return () => controller.dispose();
  }, [controller, personId]);
  const badge = notificationBadge(state.unseen);
  async function activate(id: string) {
    const destination = await controller.activate(id);
    if (destination) await navigate(destination);
  }
  async function retry() {
    if (state.status === "error") await controller.setPerson(personId);
    await controller.setOpen(true);
  }
  return (
    <Popover.Root
      open={state.open}
      onOpenChange={(open) => {
        void controller.setOpen(open);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={
            state.unseen
              ? `Notifications, ${state.unseen} unseen`
              : "Notifications"
          }
          className="relative ml-auto rounded-md p-2 hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Bell className="size-5" aria-hidden="true" />
          {badge && (
            <span
              aria-hidden="true"
              className="absolute -right-1 -top-1 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] font-semibold leading-4 text-white"
            >
              {badge}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="start"
          sideOffset={12}
          collisionPadding={8}
          aria-labelledby="notification-feed-title"
          className="z-50 flex max-h-[min(36rem,calc(100dvh-1rem))] w-[min(24rem,calc(100vw-1rem))] flex-col rounded-xl border bg-popover text-popover-foreground shadow-lg outline-none"
        >
          <div className="flex shrink-0 items-center justify-between border-b px-4 py-3">
            <h2 id="notification-feed-title" className="font-semibold">
              Notifications
            </h2>
            <Link
              to="/settings#notifications"
              aria-label="Notification settings"
              onClick={() => {
                void controller.setOpen(false);
              }}
              className="rounded p-1 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            >
              <Settings className="size-4" />
            </Link>
          </div>
          <div
            className="overflow-y-auto overscroll-contain"
            aria-busy={state.status === "loading" || state.busy}
          >
            {state.status === "loading" && (
              <p role="status" className="p-6 text-sm text-muted-foreground">
                Loading Notifications…
              </p>
            )}
            {state.error && (
              <div role="alert" className="p-4 text-sm">
                <p>{state.error}</p>
                <button
                  type="button"
                  onClick={() => {
                    void retry();
                  }}
                  className="mt-2 rounded underline focus-visible:outline-2"
                >
                  Try again
                </button>
              </div>
            )}
            {state.statusError && (
              <div role="alert" className="border-b p-4 text-sm">
                {state.statusError}
              </div>
            )}
            {state.status === "ready" && state.items.length === 0 && (
              <p className="p-8 text-center text-sm text-muted-foreground">
                You're all caught up.
              </p>
            )}
            <ul className="divide-y" aria-label="Notifications">
              {state.items.map((row) => (
                <li
                  key={row.id}
                  className="flex items-start gap-1 p-3 hover:bg-accent/40"
                >
                  <button
                    type="button"
                    disabled={state.busy}
                    onClick={() => {
                      void activate(row.id);
                    }}
                    className="flex min-w-0 flex-1 gap-3 rounded p-1 text-left focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <Sender row={row} />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block text-sm",
                          row.read ? "font-normal" : "font-bold"
                        )}
                      >
                        {row.title}
                      </span>
                      <span
                        title={row.context}
                        className="mt-0.5 block truncate text-xs text-muted-foreground"
                      >
                        {row.context}
                      </span>
                      <time
                        dateTime={row.createdAt}
                        title={new Date(row.createdAt).toLocaleString()}
                        className="mt-1 block text-xs text-muted-foreground"
                      >
                        {elapsed(row.createdAt)}
                      </time>
                    </span>
                  </button>
                  {!row.read && (
                    <button
                      type="button"
                      disabled={state.busy}
                      aria-label={`Mark ${row.title} as read`}
                      onClick={() => {
                        void controller.markRead(row.id);
                      }}
                      className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <Check className="size-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
