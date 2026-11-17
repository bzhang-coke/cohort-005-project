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
  const [narrow, setNarrow] = useState(false);
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const [pageSentinel, setPageSentinel] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    void controller.setPerson(personId);
    return () => controller.dispose();
  }, [controller, personId]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 639px)");
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (
      !state.open ||
      state.status !== "ready" ||
      !state.nextCursor ||
      state.pageLoading ||
      state.pageError ||
      state.busy ||
      !scrollRoot ||
      !pageSentinel
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          void controller.loadMore();
      },
      { root: scrollRoot, rootMargin: "0px 0px 120px 0px" }
    );
    observer.observe(pageSentinel);
    return () => observer.disconnect();
  }, [
    controller,
    scrollRoot,
    pageSentinel,
    state.open,
    state.status,
    state.nextCursor,
    state.pageLoading,
    state.pageError,
    state.busy,
    state.items,
  ]);
  const badge = notificationBadge(state.unseen);
  async function activate(id: string) {
    const destination = await controller.activate(id);
    if (destination) await navigate(destination);
  }
  async function retry() {
    if (state.items.length) await controller.refresh();
    else if (state.status === "error") await controller.setPerson(personId);
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
          side={narrow ? "bottom" : "right"}
          align="start"
          sideOffset={narrow ? 8 : 12}
          collisionPadding={8}
          aria-labelledby="notification-feed-title"
          className="z-50 flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-[min(24rem,calc(100vw-1rem))] flex-col rounded-xl border bg-popover text-popover-foreground shadow-lg outline-none"
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
            <h2 id="notification-feed-title" className="font-semibold">
              Notifications
            </h2>
            <button
              type="button"
              disabled={
                state.busy || state.status !== "ready" || state.unread === 0
              }
              onClick={() => {
                void controller.markAllRead();
              }}
              className="ml-auto rounded px-1 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
            >
              Mark all as read
            </button>
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
            ref={setScrollRoot}
            tabIndex={0}
            role="region"
            aria-label="Notification history"
            className="min-h-0 overflow-y-auto overscroll-contain rounded-b-xl focus-visible:outline-2 focus-visible:outline-ring"
            aria-busy={
              state.status === "loading" || state.busy || state.pageLoading
            }
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
            {state.pageLoading && (
              <p
                role="status"
                className="p-4 text-center text-sm text-muted-foreground"
              >
                Loading older Notifications…
              </p>
            )}
            {state.pageError && (
              <div role="alert" className="border-t p-4 text-sm">
                <p>{state.pageError}</p>
                <button
                  type="button"
                  onClick={() => {
                    void controller.loadMore();
                  }}
                  className="mt-2 rounded underline focus-visible:outline-2"
                >
                  Try again
                </button>
              </div>
            )}
            <div ref={setPageSentinel} aria-hidden="true" className="h-px" />
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
