import { useFetcher } from "react-router";
import { LockKeyhole, NotebookPen } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { MAX_NOTE_LENGTH } from "~/lib/notes";
import { formatRelativeTime } from "~/lib/utils";

/** The Student's private editor, beside the lesson's discussion. */
export function LessonNote({
  note,
}: {
  note: { body: string; updatedAt: string } | null | undefined;
}) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const isSaving = fetcher.state !== "idle";
  const error = fetcher.data?.error;

  return (
    <section
      aria-labelledby="lesson-notes-title"
      className="mb-6 rounded-xl border bg-card text-card-foreground shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <NotebookPen aria-hidden="true" className="size-5 text-primary" />
          <h2 id="lesson-notes-title" className="text-xl font-semibold">
            Your notes
          </h2>
        </div>
        <span
          id="lesson-notes-privacy"
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <LockKeyhole aria-hidden="true" className="size-3.5" />
          Only visible to you
        </span>
      </div>
      <fetcher.Form method="post" className="space-y-3 p-6">
        <input type="hidden" name="intent" value="save-note" />
        <p id="lesson-notes-help" className="text-sm text-muted-foreground">
          Capture a takeaway or something to revisit from this lesson.
        </p>
        <Textarea
          name="body"
          aria-labelledby="lesson-notes-title"
          aria-describedby="lesson-notes-privacy lesson-notes-help"
          rows={4}
          maxLength={MAX_NOTE_LENGTH}
          defaultValue={note?.body ?? ""}
          placeholder="What would you like to remember?"
          className="min-h-28 resize-y bg-background leading-relaxed"
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="status" className="text-xs text-muted-foreground">
            {error ? (
              <span className="text-destructive">{error}</span>
            ) : note ? (
              <span suppressHydrationWarning>
                Last edited {formatRelativeTime(note.updatedAt)}
              </span>
            ) : (
              <span>
                Your notes stay private, even when you join the discussion.
              </span>
            )}
          </div>
          <Button type="submit" size="sm" disabled={isSaving}>
            {isSaving ? "Saving..." : "Save notes"}
          </Button>
        </div>
      </fetcher.Form>
    </section>
  );
}
