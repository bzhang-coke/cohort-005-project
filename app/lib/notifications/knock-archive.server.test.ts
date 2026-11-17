import { afterEach, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { knockNotificationTransport } from "./knock.server";

const config = { secretApiKey: "secret-test-key", feedChannelId: "feed-id" };
const questionWorkflow = "cadence-discussion-question-created";
const replyWorkflow = "cadence-discussion-reply-created";
function message(id: string, commentId = 45, workflow = questionWorkflow) {
  return {
    id,
    data: { commentId },
    source: { key: workflow },
    channel: { id: "feed-id" },
  };
}
function page(items: unknown[], after: string | null = null) {
  return Response.json({ items, page_info: { after } });
}
function feed(entries: unknown[], after: string | null = null) {
  return Response.json({ entries, page_info: { after } });
}

afterEach(() => vi.restoreAllMocks());

it("uses a secret-key scalar comment and channel filter through every page, archiving only exact Discussion matches", async () => {
  const requests: Request[] = [];
  let discoveryComplete = false;
  const transport = knockNotificationTransport(config, async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    if (request.method === "PUT") {
      expect(discoveryComplete).toBe(true);
      return Response.json({ id: url.pathname.split("/")[3] });
    }
    if (url.searchParams.get("after") === "older-page") {
      discoveryComplete = true;
      return page([message("second"), message("first")]);
    }
    return page(
      [
        message("first"),
        message("surviving-reply", 46, replyWorkflow),
        message("unrelated-workflow", 45, "cadence-seat-claimed"),
        { ...message("other-channel"), channel: { id: "email-id" } },
        { ...message("wrong-scalar"), data: { commentId: "45" } },
        { ...message("no-data"), data: null },
      ],
      "older-page"
    );
  });

  await transport.archiveComment({ commentId: 45, personIds: [] });

  const lookups = requests.filter((request) => request.method === "GET");
  expect(
    lookups.map((request) => new URL(request.url).searchParams.get("after"))
  ).toEqual([null, "older-page"]);
  for (const request of lookups) {
    const url = new URL(request.url);
    expect(url.origin + url.pathname).toBe("https://api.knock.app/v1/messages");
    expect(url.searchParams.get("trigger_data")).toBe('{"commentId":45}');
    expect(url.searchParams.get("channel_id")).toBe("feed-id");
    expect(request.headers.get("Authorization")).toBe("Bearer secret-test-key");
  }
  expect(
    requests
      .filter((request) => request.method === "PUT")
      .map((request) => new URL(request.url).pathname)
  ).toEqual(["/v1/messages/first/archived", "/v1/messages/second/archived"]);
});

it("also finds retained old items through every person's complete feed, including a former Instructor, before archiving deduplicated IDs", async () => {
  const requests: Request[] = [];
  let formerInstructorExhausted = false;
  const transport = knockNotificationTransport(config, async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);
    if (request.method === "PUT") {
      expect(formerInstructorExhausted).toBe(true);
      return Response.json({});
    }
    if (url.pathname === "/v1/messages") return page([message("recent")]);
    if (url.pathname === "/v1/users/9/feeds/feed-id") {
      if (url.searchParams.get("after") === "oldest-page") {
        formerInstructorExhausted = true;
        return feed([
          { ...message("retained-old"), inserted_at: "2020-01-01T00:00:00Z" },
          message("surviving-reply", 46, replyWorkflow),
          message("wrong-workflow", 45, "cadence-refund-request-opened"),
        ]);
      }
      return feed([message("recent")], "oldest-page");
    }
    return feed([]);
  });

  await transport.archiveComment({ commentId: 45, personIds: [42, 9, 73, 9] });

  const feedRequests = requests.filter((request) =>
    request.url.includes("/feeds/")
  );
  expect(
    feedRequests.map((request) => new URL(request.url).pathname).sort()
  ).toEqual([
    "/v1/users/42/feeds/feed-id",
    "/v1/users/73/feeds/feed-id",
    "/v1/users/9/feeds/feed-id",
    "/v1/users/9/feeds/feed-id",
  ]);
  for (const request of feedRequests) {
    const query = new URL(request.url).searchParams;
    expect(query.get("status")).toBe("all");
    expect(query.get("archived")).toBe("exclude");
    expect(query.get("mode")).toBe("rich");
    // Inspect retained data directly; don't assume an expired trigger-data
    // index or an age cutoff can discover every historical feed entry.
    expect(query.has("trigger_data")).toBe(false);
    expect(query.has("after_date")).toBe(false);
    expect(request.headers.get("Authorization")).toBe("Bearer secret-test-key");
  }
  expect(
    requests
      .filter((request) => request.method === "PUT")
      .map((request) => new URL(request.url).pathname)
  ).toEqual([
    "/v1/messages/recent/archived",
    "/v1/messages/retained-old/archived",
  ]);
});

it("attempts all independently discovered archives despite a later lookup page, another person's feed, and one archive failing", async () => {
  const archived: string[] = [];
  const transport = knockNotificationTransport(config, async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method === "PUT") {
      archived.push(url.pathname);
      return url.pathname.includes("failed-archive")
        ? new Response(null, { status: 503 })
        : Response.json({});
    }
    if (url.pathname === "/v1/messages") {
      return url.searchParams.has("after")
        ? new Response(null, { status: 500 })
        : page(
            [message("failed-archive"), message("recent-success")],
            "broken-page"
          );
    }
    if (url.pathname === "/v1/users/9/feeds/feed-id") {
      return new Response(null, { status: 503 });
    }
    return feed([message("old-success")]);
  });

  await expect(
    transport.archiveComment({ commentId: 45, personIds: [9, 42] })
  ).rejects.toThrow("Notification archival was incomplete");

  expect(archived).toEqual([
    "/v1/messages/failed-archive/archived",
    "/v1/messages/recent-success/archived",
    "/v1/messages/old-success/archived",
  ]);
});

it.each(["messages", "feed"])(
  "stops a repeated %s cursor, retaining discovered matches for independent archival",
  async (source) => {
    let repeatedPageRequests = 0;
    const archived: string[] = [];
    const transport = knockNotificationTransport(
      config,
      async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (request.method === "PUT") {
          archived.push(url.pathname);
          return Response.json({});
        }
        const isMessages = url.pathname === "/v1/messages";
        if ((source === "messages") === isMessages) {
          repeatedPageRequests++;
          // Stop the controlled server too, so a broken client cannot hang Vitest.
          if (repeatedPageRequests > 2)
            return new Response(null, { status: 500 });
          return (isMessages ? page : feed)([message("found")], "same-cursor");
        }
        return (isMessages ? page : feed)([]);
      }
    );

    await expect(
      transport.archiveComment({ commentId: 45, personIds: [42] })
    ).rejects.toThrow("Notification archival was incomplete");
    expect(repeatedPageRequests).toBe(2);
    expect(archived).toEqual(["/v1/messages/found/archived"]);
  }
);

it("bounds concurrent person-feed lookups while discovering every persisted recipient", async () => {
  let active = 0;
  let maximumActive = 0;
  const discovered: string[] = [];
  const transport = knockNotificationTransport(config, async (input, init) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/v1/messages") return page([]);
    active++;
    maximumActive = Math.max(maximumActive, active);
    discovered.push(url.pathname);
    await setImmediate();
    active--;
    return feed([]);
  });

  await transport.archiveComment({
    commentId: 45,
    personIds: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  });
  expect(discovered).toHaveLength(9);
  expect(maximumActive).toBeLessThanOrEqual(4);
});
