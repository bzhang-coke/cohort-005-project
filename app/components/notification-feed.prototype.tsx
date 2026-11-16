// THROWAWAY: three Notification Feed variants on the existing /dashboard?variant=A|B|C.
// All Notification content, destinations, and preference changes are in-memory samples.
import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { Dialog, Popover } from "radix-ui";
import {
  ArrowLeft,
  ArrowUpRight,
  Bell,
  Check,
  CheckCheck,
  ChevronRight,
  CircleAlert,
  LockKeyhole,
  MessageSquare,
  Receipt,
  Settings2,
  UsersRound,
  X,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import {
  PrototypeSwitcher,
  type NotificationVariant,
} from "~/components/prototype-switcher";

type Category = "discussion" | "seats" | "refunds";
type Availability =
  "available" | "deleted" | "access-lost" | "country-restricted";
type Scene = "populated" | "loading" | "empty" | "error";
type Person = { id: number; name: string; role: string };
type SampleNotification = {
  id: number;
  category: Category;
  title: string;
  context: string;
  time: string;
  detail: string;
  availability: Availability;
  unread: boolean;
  seen: boolean;
};

const categoryNames: Record<Category, string> = {
  discussion: "Discussion activity",
  seats: "Seat claims",
  refunds: "Refund Requests",
};
const categoryIcons = {
  discussion: MessageSquare,
  seats: UsersRound,
  refunds: Receipt,
};

function sampleNotifications(
  person: Person,
  isTeamAdmin: boolean
): SampleNotification[] {
  const actor = person.name === "Sarah Chen" ? "Emma Wilson" : "Sarah Chen";
  const items: Omit<SampleNotification, "id" | "unread" | "seen">[] = [
    {
      category: "discussion",
      title: `${actor} replied in Understanding async functions`,
      context: "TypeScript Essentials · Lesson discussion",
      time: "2 min ago",
      detail:
        "Could you explain why awaiting these requests in sequence takes longer?",
      availability: "available",
    },
    {
      category: "refunds",
      title: "Your Refund Request was approved",
      context: "Advanced React · Your Purchase",
      time: "25 min ago",
      detail:
        "Your Refund Request for Advanced React was approved. This decision does not confirm that the money has been returned.",
      availability: "available",
    },
    {
      category: "discussion",
      title: `${actor} replied in Making state predictable`,
      context: "Advanced React · Lesson discussion",
      time: "Yesterday",
      detail:
        "This sample discussion was deleted after the Notification arrived.",
      availability: "deleted",
    },
    {
      category: "discussion",
      title: `${actor} replied in Designing a component API`,
      context: "React Patterns · Lesson discussion",
      time: "2 days ago",
      detail: "Your Enrollment ended after this Notification arrived.",
      availability: "access-lost",
    },
    {
      category: "refunds",
      title: "Your Refund Request was declined",
      context: "TypeScript Essentials · Your Purchase",
      time: "3 days ago",
      detail:
        "Your Refund Request for TypeScript Essentials was declined. The decision and reason would be highlighted in your Refund Request history.",
      availability: "available",
    },
    {
      category: "discussion",
      title: `${actor} replied in Testing a custom hook`,
      context: "React Patterns · Lesson discussion",
      time: "4 days ago",
      detail: "This lesson is unavailable in your current country.",
      availability: "country-restricted",
    },
    {
      category: "discussion",
      title: `${actor} replied in Working with generics`,
      context: "TypeScript Essentials · Lesson discussion",
      time: "5 days ago",
      detail:
        "The constraint makes sure the function receives a value with a length property.",
      availability: "available",
    },
    {
      category: "discussion",
      title: `${actor} replied in Choosing a union type`,
      context: "TypeScript Essentials · Lesson discussion",
      time: "6 days ago",
      detail:
        "This is an older sample entry, retained in the same chronological feed.",
      availability: "available",
    },
  ];
  if (person.role === "instructor")
    items.unshift({
      category: "discussion",
      title: `${actor} posted a Discussion Question`,
      context: "Your course · Understanding async functions",
      time: "Just now",
      detail:
        "When should I use Promise.all instead of awaiting each operation?",
      availability: "available",
    });
  if (person.role === "admin")
    items.unshift({
      category: "refunds",
      title: `${actor} opened a Refund Request`,
      context: "Advanced React · Individual Purchase",
      time: "Just now",
      detail:
        "This request is waiting for a Platform Admin's decision. The destination highlights this exact Refund Request in the review queue.",
      availability: "available",
    });
  if (isTeamAdmin)
    items.unshift({
      category: "seats",
      title: `${actor} claimed a Seat`,
      context: "Your Team · TypeScript Essentials",
      time: "Just now",
      detail:
        "This Seat is now claimed. The destination highlights the person and course in your Team's Seats.",
      availability: "available",
    });
  return items.map((item, index) => ({
    ...item,
    id: index + 1,
    unread: index < 4,
    seen: index > 1,
  }));
}

type VariantProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  feed: ReactNode;
  context: ReactNode;
};

export function VariantA({
  open,
  onOpenChange,
  trigger,
  feed,
  context,
}: VariantProps) {
  return (
    <>
      <header className="flex h-16 items-center justify-between border-b px-5">
        <span className="text-sm font-medium">Your learning space</span>
        <Popover.Root open={open} onOpenChange={onOpenChange}>
          <Popover.Trigger asChild>{trigger}</Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="end"
              sideOffset={12}
              aria-label="Notification Feed"
              className="z-40 max-h-[70vh] w-[440px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border bg-popover text-popover-foreground shadow-2xl"
            >
              {feed}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </header>
      {context}
    </>
  );
}

export function VariantB({
  open,
  onOpenChange,
  trigger,
  feed,
  context,
}: VariantProps) {
  return (
    <>
      <header className="flex h-16 items-center justify-between border-b px-5">
        <span className="text-sm font-medium">Your learning space</span>
        <Dialog.Root open={open} onOpenChange={onOpenChange} modal={false}>
          <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Content
              aria-describedby={undefined}
              onInteractOutside={(event) => event.preventDefault()}
              className="fixed inset-y-0 right-0 z-40 w-[520px] max-w-full overflow-y-auto border-l bg-background pb-24 shadow-2xl"
            >
              <Dialog.Title className="sr-only">Notification Feed</Dialog.Title>
              {feed}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </header>
      {context}
    </>
  );
}

export function VariantC({
  feed,
  detail,
  unread,
  selected,
}: {
  feed: ReactNode;
  detail: ReactNode;
  unread: number;
  selected: boolean;
}) {
  return (
    <section className="mx-auto max-w-7xl px-4 py-6 pb-28 lg:px-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-1 text-xs uppercase tracking-widest text-muted-foreground">
            Your activity
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            Notification Feed
          </h1>
        </div>
        <span className="rounded-full bg-primary px-3 py-1 text-sm text-primary-foreground">
          {unread} unread
        </span>
      </div>
      <div className="grid overflow-hidden rounded-xl border bg-card xl:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
        <div
          className={cn("min-w-0 xl:border-r", selected && "hidden xl:block")}
        >
          {feed}
        </div>
        <div
          className={cn("min-w-0 bg-muted/30", !selected && "hidden xl:block")}
        >
          {detail}
        </div>
      </div>
    </section>
  );
}

function DestinationPreview({
  item,
  onBack,
}: {
  item: SampleNotification | undefined;
  onBack: () => void;
}) {
  if (!item)
    return (
      <div className="flex min-h-64 flex-col items-center justify-center p-8 text-center text-muted-foreground">
        <ArrowUpRight className="mb-4 size-7" />
        <h3 className="font-medium text-foreground">Pick a Notification</h3>
        <p className="mt-2 max-w-64 text-sm">
          See the discussion, Refund Request, or Seat it takes you to.
        </p>
      </div>
    );
  const unavailable = item.availability !== "available";
  const heading =
    item.availability === "deleted"
      ? "This discussion is no longer available"
      : item.availability === "access-lost"
        ? "You no longer have access to this lesson"
        : item.availability === "country-restricted"
          ? "This lesson is unavailable in your country"
          : item.category === "discussion"
            ? "Lesson discussion"
            : item.category === "refunds"
              ? "Refund Request details"
              : "Team Seats";
  return (
    <section aria-label="Sample destination" className="p-5 sm:p-6">
      <Button variant="ghost" size="sm" onClick={onBack} className="mb-5 -ml-2">
        <ArrowLeft /> Back to feed
      </Button>
      <p className="mb-4 text-xs font-medium uppercase tracking-widest text-muted-foreground">
        Sample destination
      </p>
      {unavailable && (
        <LockKeyhole className="mb-3 size-7 text-muted-foreground" />
      )}
      <h3 className="text-xl font-semibold leading-snug">{heading}</h3>
      <p className="mt-2 text-sm text-muted-foreground">{item.context}</p>
      <div
        className={cn(
          "mt-6 rounded-lg border p-4 text-sm leading-relaxed",
          !unavailable &&
            "border-blue-300 bg-blue-50 text-blue-950 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100"
        )}
      >
        {unavailable
          ? "The Notification stays in your history. You can return to the feed and continue with your other updates."
          : item.detail}
      </div>
      {!unavailable && (
        <p className="mt-4 text-xs text-muted-foreground">
          The matching{" "}
          {item.category === "discussion"
            ? "Discussion Question or Discussion Reply"
            : item.category === "refunds"
              ? "Refund Request"
              : "Seat claim"}{" "}
          is highlighted here.
        </p>
      )}
    </section>
  );
}

export function NotificationFeedPrototype({
  currentUser,
  isTeamAdmin,
  children,
}: {
  currentUser: Person | null;
  isTeamAdmin: boolean;
  children: ReactNode;
}) {
  const [params, setParams] = useSearchParams();
  const requestedVariant = params.get("variant");
  const variant: NotificationVariant =
    requestedVariant === "B" || requestedVariant === "C"
      ? requestedVariant
      : "A";
  const [open, setOpen] = useState(true);
  const [scene, setScene] = useState<Scene>("populated");
  const [entries, setEntries] = useState(() =>
    currentUser ? sampleNotifications(currentUser, isTeamAdmin) : []
  );
  const [preferences, setPreferences] = useState({
    discussion: true,
    seats: true,
  });
  const [tab, setTab] = useState<"all" | "unread" | "preferences">("all");
  const [limit, setLimit] = useState(6);
  const [selectedId, setSelectedId] = useState<number>();
  const [sampleCategory, setSampleCategory] = useState<Category>("discussion");
  const [notice, setNotice] = useState("");
  const [nextId, setNextId] = useState(100);
  const visibleEntries = entries
    .filter((item) => tab !== "unread" || item.unread)
    .slice(0, limit);
  const unread = entries.filter((item) => item.unread).length;
  const selected = entries.find((item) => item.id === selectedId);
  const expanded = variant === "C" || open;

  useEffect(() => {
    if (
      !expanded ||
      scene !== "populated" ||
      tab === "preferences" ||
      (selectedId !== undefined && variant !== "C")
    )
      return;
    const ids = new Set(visibleEntries.map((item) => item.id));
    setEntries((previous) =>
      previous.some((item) => ids.has(item.id) && !item.seen)
        ? previous.map((item) =>
            ids.has(item.id) ? { ...item, seen: true } : item
          )
        : previous
    );
  }, [expanded, scene, tab, limit, selectedId, variant, entries]);

  const state = {
    variant,
    person: currentUser,
    isTeamAdmin,
    open: expanded,
    scene,
    tab,
    limit,
    selectedId: selectedId ?? null,
    unread,
    preferences,
    entries,
  };
  useEffect(() => {
    console.info("Notification Feed prototype variant", state);
  }, [variant]);

  function changeVariant(next: NotificationVariant) {
    setParams(
      (previous) => {
        const nextParams = new URLSearchParams(previous);
        nextParams.set("variant", next);
        return nextParams;
      },
      { replace: true, preventScrollReset: true }
    );
    setOpen(true);
    setSelectedId(undefined);
  }
  function changeScene(next: Scene) {
    setScene(next);
    setSelectedId(undefined);
    setOpen(true);
    setNotice("");
    if (next === "empty") setEntries([]);
    if (next === "populated" && currentUser)
      setEntries(sampleNotifications(currentUser, isTeamAdmin));
  }
  function reset() {
    setPreferences({ discussion: true, seats: true });
    setTab("all");
    setLimit(6);
    changeScene("populated");
  }
  function openEntry(item: SampleNotification) {
    setSelectedId(item.id);
    setEntries((previous) =>
      previous.map((entry) =>
        entry.id === item.id ? { ...entry, unread: false, seen: true } : entry
      )
    );
  }
  function addSample() {
    if (!currentUser) return;
    if (sampleCategory !== "refunds" && !preferences[sampleCategory]) {
      setNotice(
        `${categoryNames[sampleCategory]} is muted. The new sample event added no Notification. Unmuting will not replay it.`
      );
      return;
    }
    const samples = sampleNotifications(currentUser, isTeamAdmin);
    const sample = samples.find((item) => item.category === sampleCategory);
    if (!sample) return;
    setEntries((previous) => [
      { ...sample, id: nextId, unread: true, seen: false, time: "Just now" },
      ...previous,
    ]);
    setNextId((previous) => previous + 1);
    setScene("populated");
    setNotice(`A new ${categoryNames[sampleCategory]} Notification arrived.`);
  }

  const preferencesPanel = (
    <section aria-label="Notification preferences" className="space-y-5 p-5">
      <div>
        <h3 className="font-semibold">Choose what reaches your feed</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Your choices apply across all your courses, Teams, and roles.
        </p>
      </div>
      {(["discussion", "seats"] as const).map((category) => (
        <label
          key={category}
          className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border p-4"
        >
          <span>
            <span className="block text-sm font-medium">
              {categoryNames[category]}
            </span>
            <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
              {category === "discussion"
                ? "New Discussion Questions and Discussion Replies together."
                : "New claims in Teams you administer."}
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label={categoryNames[category]}
            checked={preferences[category]}
            onChange={(event) =>
              setPreferences((previous) => ({
                ...previous,
                [category]: event.target.checked,
              }))
            }
            className="mt-1 size-5 accent-blue-600"
          />
        </label>
      ))}
      <div className="rounded-lg bg-muted p-4">
        <div className="flex items-center justify-between gap-3 text-sm font-medium">
          <span>Refund Requests</span>
          <span className="flex items-center gap-1 text-xs">
            <LockKeyhole className="size-3" /> Always on
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Decisions on your Purchases, and new requests if you are a Platform
          Admin.
        </p>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Muting stops new Notifications. Existing entries stay as they are.
        Unmuting does not bring back missed activity.
      </p>
    </section>
  );

  const feedHeader = (
    <div className="border-b bg-background p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            {variant === "C" ? "Recent Notifications" : "Notification Feed"}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {unread} unread · {currentUser?.name}
          </p>
        </div>
        <div className="flex gap-1">
          <Button
            aria-label="Notification preferences"
            title="Notification preferences"
            variant={tab === "preferences" ? "secondary" : "ghost"}
            size="icon-sm"
            onClick={() => {
              setTab(tab === "preferences" ? "all" : "preferences");
              setSelectedId(undefined);
            }}
          >
            <Settings2 />
          </Button>
          {variant !== "C" && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close Notification Feed"
              onClick={() => setOpen(false)}
            >
              <X />
            </Button>
          )}
        </div>
      </div>
      {tab !== "preferences" && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <div
            className="flex rounded-md bg-muted p-1"
            aria-label="Filter Notifications"
          >
            {(["all", "unread"] as const).map((value) => (
              <button
                key={value}
                aria-pressed={tab === value}
                onClick={() => {
                  setTab(value);
                  setSelectedId(undefined);
                }}
                className={cn(
                  "rounded px-3 py-1 text-xs font-medium",
                  tab === value && "bg-background shadow-sm"
                )}
              >
                {value === "all" ? "All" : "Unread"}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="xs"
            disabled={!unread || scene !== "populated"}
            onClick={() =>
              setEntries((previous) =>
                previous.map((item) => ({ ...item, unread: false }))
              )
            }
          >
            <CheckCheck /> Mark all read
          </Button>
        </div>
      )}
    </div>
  );

  const list =
    scene === "loading" ? (
      <div
        role="status"
        aria-label="Loading Notifications"
        className="space-y-6 p-5"
      >
        <span className="text-sm text-muted-foreground">
          Loading your Notifications…
        </span>
        {[1, 2, 3].map((number) => (
          <div key={number} className="flex animate-pulse gap-3">
            <div className="size-9 rounded-full bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-4/5 rounded bg-muted" />
              <div className="h-3 w-2/3 rounded bg-muted" />
            </div>
          </div>
        ))}
      </div>
    ) : scene === "error" ? (
      <div role="alert" className="p-8 text-center">
        <CircleAlert className="mx-auto mb-3 size-7 text-muted-foreground" />
        <h3 className="font-medium">Couldn't load your Notifications</h3>
        <p className="my-3 text-sm text-muted-foreground">
          Your other work is still available.
        </p>
        <Button
          variant="outline"
          onClick={() => {
            setScene("populated");
            setNotice("Simulated connection restored.");
          }}
        >
          Try again
        </Button>
      </div>
    ) : visibleEntries.length === 0 ? (
      <div className="p-10 text-center">
        <CheckCheck className="mx-auto mb-3 size-8 text-muted-foreground" />
        <h3 className="font-medium">
          {tab === "unread" ? "You're all caught up" : "No Notifications yet"}
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          {tab === "unread"
            ? "Your read Notifications are still in All."
            : "Discussion activity, Refund Requests, and relevant Seat claims will appear here."}
        </p>
      </div>
    ) : (
      <>
        <ul aria-label="Notifications" className="divide-y">
          {visibleEntries.map((item) => {
            const Icon = categoryIcons[item.category];
            return (
              <li
                key={item.id}
                data-notification-id={item.id}
                data-unread={item.unread}
                className={cn(
                  "group flex items-start gap-1 px-3 py-2",
                  item.unread && "bg-blue-50/60 dark:bg-blue-950/25",
                  selectedId === item.id && "ring-1 ring-inset ring-blue-400"
                )}
              >
                <button
                  onClick={() => openEntry(item)}
                  className="flex min-w-0 flex-1 gap-3 rounded-lg p-2 text-left hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-blue-600"
                >
                  <span
                    className={cn(
                      "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full",
                      item.category === "discussion"
                        ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                        : item.category === "refunds"
                          ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                          : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block text-sm leading-snug",
                        item.unread ? "font-semibold" : "font-medium"
                      )}
                    >
                      {item.title}
                    </span>
                    <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                      {item.context}
                    </span>
                    <span className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                      {item.unread && (
                        <span className="size-1.5 rounded-full bg-blue-600" />
                      )}
                      {item.time}
                      {item.unread && (
                        <span className="sr-only"> · Unread</span>
                      )}
                    </span>
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="mt-2 shrink-0"
                  title={item.unread ? "Mark as read" : "Mark as unread"}
                  aria-label={`${item.unread ? "Mark as read" : "Mark as unread"}: ${item.title}`}
                  onClick={() =>
                    setEntries((previous) =>
                      previous.map((entry) =>
                        entry.id === item.id
                          ? { ...entry, unread: !entry.unread }
                          : entry
                      )
                    )
                  }
                >
                  {item.unread ? (
                    <Check />
                  ) : (
                    <span className="size-2 rounded-full border border-current" />
                  )}
                </Button>
              </li>
            );
          })}
        </ul>
        <footer className="border-t p-4 text-center">
          {entries.filter((item) => tab !== "unread" || item.unread).length >
          limit ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLimit((previous) => previous + 6)}
            >
              Load older Notifications <ChevronRight />
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              You're at the beginning of your feed.
            </p>
          )}
        </footer>
      </>
    );

  const destination = (
    <DestinationPreview
      item={selected}
      onBack={() => setSelectedId(undefined)}
    />
  );
  const feed = (
    <>
      {feedHeader}
      {tab === "preferences"
        ? preferencesPanel
        : selected && variant !== "C"
          ? destination
          : list}
    </>
  );
  const trigger = (
    <Button
      variant="outline"
      aria-label={`Open Notification Feed, ${unread} unread`}
    >
      <Bell className="size-4" />
      <span className="hidden sm:inline">Notifications</span>
      {unread > 0 && (
        <span
          data-testid="unread-badge"
          className="min-w-5 rounded-full bg-blue-600 px-1.5 py-0.5 text-center text-xs text-white"
        >
          {unread}
        </span>
      )}
    </Button>
  );

  return (
    <div className="min-h-full pb-20">
      <aside
        aria-label="Prototype review controls"
        className="border-b border-dashed border-amber-300 bg-amber-50 px-4 py-3 text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
      >
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-xs">
          <div>
            <p className="font-semibold">Notification Feed · UI prototype</p>
            <p className="mt-1 opacity-75">
              Sample Notifications ·{" "}
              {currentUser
                ? `${currentUser.role === "admin" ? "Platform Admin" : currentUser.role === "instructor" ? "Instructor" : "Student"}${isTeamAdmin ? " + Team Admin" : ""}`
                : "Choose a person in DevUI"}
            </p>
          </div>
          <label className="flex items-center gap-2">
            Scene{" "}
            <select
              aria-label="Prototype scene"
              value={scene}
              onChange={(event) => changeScene(event.target.value as Scene)}
              className="rounded border bg-background px-2 py-1.5 text-foreground"
            >
              {(["populated", "loading", "empty", "error"] as const).map(
                (value) => (
                  <option key={value} value={value}>
                    {value[0].toUpperCase() + value.slice(1)}
                  </option>
                )
              )}
            </select>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Sample event category"
              value={sampleCategory}
              onChange={(event) =>
                setSampleCategory(event.target.value as Category)
              }
              className="rounded border bg-background px-2 py-1.5 text-foreground"
            >
              <option value="discussion">Discussion activity</option>
              {isTeamAdmin && <option value="seats">Seat claims</option>}
              <option value="refunds">Refund Request</option>
            </select>
            <Button
              variant="outline"
              size="xs"
              onClick={addSample}
              disabled={!currentUser}
              className="text-foreground"
            >
              Add sample event
            </Button>
            <Button variant="ghost" size="xs" onClick={reset}>
              Reset demo
            </Button>
          </div>
        </div>
        {notice && (
          <p role="status" className="mt-2 max-w-3xl text-xs">
            {notice}
          </p>
        )}
        <details className="mt-2 text-xs">
          <summary className="w-fit cursor-pointer">
            Review notes & current state
          </summary>
          <div className="mt-3 max-w-3xl space-y-2">
            <p>
              Compare A: compact bell popover, B: persistent side drawer, C:
              full-page feed with destination preview. Use the bottom arrows or
              your keyboard's left/right arrows.
            </p>
            <p>
              Proposed behavior: seeing an entry leaves it unread; opening it
              marks it read. Mark-all affects the entire feed. Each event stays
              separate. Older entries remain available through Load older; the
              retention duration is still an integration decision.
            </p>
            <p>
              Destinations are illustrative: no real navigation, refunds,
              discussion posts, or Seat changes happen here. Reloading or
              switching people resets sample state. Vendor delivery,
              persistence, security, and exact destination anchors are not
              tested by this demo.
            </p>
            <pre className="max-h-64 overflow-auto rounded bg-slate-950 p-3 text-[10px] text-slate-100">
              {JSON.stringify(state, null, 2)}
            </pre>
          </div>
        </details>
      </aside>
      {!currentUser ? (
        <div className="p-10">
          <h1 className="text-2xl font-semibold">Choose someone to preview</h1>
          <p className="mt-3 text-muted-foreground">
            Use Switch user in the DevUI panel. Try a Student, Instructor,
            Platform Admin, or Team Admin.
          </p>
        </div>
      ) : variant === "A" ? (
        <VariantA
          open={open}
          onOpenChange={setOpen}
          trigger={trigger}
          feed={feed}
          context={children}
        />
      ) : variant === "B" ? (
        <VariantB
          open={open}
          onOpenChange={setOpen}
          trigger={trigger}
          feed={feed}
          context={children}
        />
      ) : (
        <VariantC
          feed={feed}
          detail={destination}
          unread={unread}
          selected={!!selected}
        />
      )}
      <PrototypeSwitcher variant={variant} onChange={changeVariant} />
    </div>
  );
}
