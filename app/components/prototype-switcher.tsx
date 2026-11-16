// Throwaway review controls, never rendered in production.
import { useEffect } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "~/components/ui/button";

export const notificationVariants = [
  { key: "A", name: "Bell popover" },
  { key: "B", name: "Side drawer" },
  { key: "C", name: "Full-page feed" },
] as const;
export type NotificationVariant = (typeof notificationVariants)[number]["key"];

export function PrototypeSwitcher({
  variant,
  onChange,
}: {
  variant: NotificationVariant;
  onChange: (variant: NotificationVariant) => void;
}) {
  const index = notificationVariants.findIndex((item) => item.key === variant);
  const cycle = (direction: number) =>
    onChange(
      notificationVariants[
        (index + direction + notificationVariants.length) %
          notificationVariants.length
      ].key
    );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.closest("input, textarea, select, [contenteditable]") ||
        event.altKey ||
        event.metaKey ||
        event.ctrlKey
      )
        return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        cycle(event.key === "ArrowLeft" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (!import.meta.env.DEV) return null;
  return (
    <nav
      aria-label="Prototype variants"
      className="fixed bottom-4 left-1/2 z-[80] flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/20 bg-slate-950 px-2 py-2 text-white shadow-xl"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Previous variant"
        onClick={() => cycle(-1)}
      >
        <ArrowLeft />
      </Button>
      <span className="min-w-40 text-center text-xs font-medium">
        {variant} · {notificationVariants[index].name}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Next variant"
        onClick={() => cycle(1)}
      >
        <ArrowRight />
      </Button>
    </nav>
  );
}
