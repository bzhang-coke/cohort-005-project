import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LessonNote } from "~/modules/lesson-notes";

const state = vi.hoisted(() => ({
  value: "idle",
  data: undefined as { ok: boolean; error?: string } | undefined,
}));
vi.mock("react-router", () => ({
  useFetcher: () => ({
    state: state.value,
    data: state.data,
    Form: (props: ComponentProps<"form">) => <form {...props} />,
  }),
}));

beforeEach(() => {
  state.value = "idle";
  state.data = undefined;
});

describe("LessonNote", () => {
  it.each([undefined, null])(
    "offers a labeled private editor for an absent note (%s)",
    (note) => {
      const html = renderToStaticMarkup(<LessonNote note={note} />);
      expect(html).toContain('method="post"');
      expect(html).toContain('name="intent" value="save-note"');
      expect(html).toContain('name="body"');
      expect(html).toContain('aria-labelledby="lesson-notes-title"');
      expect(html).toContain('maxLength="2000"');
      expect(html).toMatch(/<textarea[^>]*><\/textarea>/);
      expect(html).toContain("Only visible to you");
      expect(html).toContain(
        "Your notes stay private, even when you join the discussion."
      );
      expect(html).toContain("Save notes");
      expect(html).not.toContain('disabled=""');
      expect(html).not.toContain("Last edited");
    }
  );

  it("renders saved notes as plain text and shows their edit time", () => {
    const html = renderToStaticMarkup(
      <LessonNote
        note={{
          body: '<script>alert("hi")</script>',
          updatedAt: new Date().toISOString(),
        }}
      />
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Last edited");
    expect(html).not.toContain(
      "Your notes stay private, even when you join the discussion."
    );
  });

  it.each(["submitting", "loading"])(
    "prevents duplicate saves while %s",
    (value) => {
      state.value = value;
      const html = renderToStaticMarkup(<LessonNote note={undefined} />);
      expect(html).toContain('disabled=""');
      expect(html).toContain("Saving...");
      expect(html).not.toContain("Save notes");
    }
  );

  it("announces a save error instead of displaying a stale edit time", () => {
    state.data = { ok: false, error: "Unable to save your note" };
    const html = renderToStaticMarkup(
      <LessonNote
        note={{ body: "Keep this draft", updatedAt: new Date().toISOString() }}
      />
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Unable to save your note");
    expect(html).toContain("Keep this draft");
    expect(html).not.toContain("Last edited");
  });
});
