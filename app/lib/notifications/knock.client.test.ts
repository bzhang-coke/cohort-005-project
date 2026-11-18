import { afterEach, expect, it, vi } from "vitest";
import { knockNotificationFeedClient } from "./knock.client";
const identity = {
  mode: "live" as const,
  personId: 7,
  publicApiKey: "public",
  feedChannelId: "00000000-0000-4000-8000-000000000037",
  userToken: `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: "7", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`,
  expiresAt: Date.now() + 3600000,
};
afterEach(() => vi.unstubAllGlobals());

it("keeps bursts of feed reads below Knock's five-per-second limit without retrying", async () => {
  vi.useFakeTimers();
  const starts: number[] = [];
  vi.stubGlobal("fetch", async () => {
    const now = Date.now();
    const recent = starts.filter((time) => now - time < 1000);
    starts.push(now);
    if (recent.length >= 5)
      return Response.json({ error: "Rate limited" }, { status: 429 });
    return Response.json({
      entries: [],
      meta: { total_count: 0, unread_count: 0, unseen_count: 0 },
      page_info: { after: null },
    });
  });
  const client = await knockNotificationFeedClient(
    identity,
    async () => identity
  );
  try {
    const reads = Promise.allSettled(
      Array.from({ length: 8 }, () => client.list())
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect((await reads).every((result) => result.status === "fulfilled")).toBe(
      true
    );
    expect(starts).toHaveLength(8);
    for (const start of starts)
      expect(
        starts.filter((time) => time >= start && time - start < 1000).length
      ).toBeLessThanOrEqual(5);
  } finally {
    client.dispose();
    vi.useRealTimers();
  }
});

it("does not send a paced feed read after its client is disposed", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () =>
    Response.json({
      entries: [],
      meta: { total_count: 0, unread_count: 0, unseen_count: 0 },
      page_info: { after: null },
    })
  );
  vi.stubGlobal("fetch", fetcher);
  const client = await knockNotificationFeedClient(
    identity,
    async () => identity
  );
  try {
    await client.list();
    const queued = Promise.allSettled([client.list()]);
    await vi.advanceTimersByTimeAsync(1);
    client.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await queued)[0]?.status).toBe("rejected");
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    client.dispose();
    vi.useRealTimers();
  }
});
it("uses signed rich feeds and returns Cadence text, actor imagery, cursors and independent counts", async () => {
  const requests: { url: string; headers: Headers }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    requests.push({ url, headers: new Headers(init.headers) });
    return Response.json({
      entries: [
        {
          id: "message",
          inserted_at: "2026-11-17T12:00:00Z",
          read_at: null,
          seen_at: "2026-11-17T12:00:01Z",
          actors: [{ name: "Ada", avatar: "https://example.com/ada.png" }],
          data: {
            category: "refundRequestUpdates",
            title: "Refund Request received",
            context: "Course · $79.00 · Under review",
            destination: null,
          },
        },
      ],
      meta: { total_count: 40, unread_count: 30, unseen_count: 20 },
      page_info: { after: "older" },
    });
  });
  const client = await knockNotificationFeedClient(
    identity,
    async () => identity
  );
  try {
    expect(await client.list()).toEqual({
      items: [
        {
          id: "message",
          createdAt: "2026-11-17T12:00:00Z",
          read: false,
          seen: true,
          actor: { name: "Ada", avatarUrl: "https://example.com/ada.png" },
          category: "refundRequestUpdates",
          title: "Refund Request received",
          context: "Course · $79.00 · Under review",
          destination: null,
        },
      ],
      total: 40,
      unread: 30,
      unseen: 20,
      nextCursor: "older",
    });
    const request = requests[0];
    if (!request) throw new Error("Missing feed request.");
    expect(request.url).toContain(
      "/v1/users/7/feeds/00000000-0000-4000-8000-000000000037"
    );
    expect(request.url).toContain("mode=rich");
    expect(request.headers.get("X-Knock-User-Token")).toBe(identity.userToken);
    expect(request.headers.get("Authorization")).toBe("Bearer public");
  } finally {
    client.dispose();
  }
});

it("marks the whole signed-in channel seen without a loaded-ID list, and confirms completion separately from enqueue", async () => {
  const requests: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    requests.push({
      url,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json(
      init.method === "POST"
        ? { id: "operation", status: "queued" }
        : {
            entries: [],
            meta: { total_count: 100, unread_count: 100, unseen_count: 0 },
            page_info: { after: null },
          }
    );
  });
  const client = await knockNotificationFeedClient(
    identity,
    async () => identity
  );
  try {
    await client.markAllSeen();
    expect(requests[0]).toEqual({
      url: "https://api.knock.app/v1/channels/00000000-0000-4000-8000-000000000037/messages/bulk/seen",
      method: "POST",
      body: { recipient_ids: ["7"], archived: "exclude" },
    });
    expect(requests[1]?.url).toContain(
      "/v1/users/7/feeds/00000000-0000-4000-8000-000000000037"
    );
    expect(requests).toHaveLength(2);
  } finally {
    client.dispose();
  }
});

it.each(["list", "markRead", "markAllSeen", "markAllRead"] as const)(
  "surfaces %s HTTP failures without optimistic success or repeated writes",
  async (operation) => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return Response.json({ error: "Unavailable" }, { status: 503 });
    });
    const client = await knockNotificationFeedClient(
      identity,
      async () => identity
    );
    try {
      await expect(
        operation === "markRead"
          ? client.markRead("message")
          : client[operation]()
      ).rejects.toThrow("request failed");
      expect(calls).toBe(1);
    } finally {
      client.dispose();
    }
  }
);

it("keeps a queued bulk operation distinct from confirmation and bounds its follow-up reads", async () => {
  vi.useFakeTimers();
  let writes = 0;
  let reads = 0;
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    if (init.method === "POST") {
      writes++;
      return Response.json({
        id: "operation",
        status: "queued",
        progress_path: "https://untrusted.example/",
      });
    }
    reads++;
    return Response.json({
      entries: [],
      meta: { total_count: 100, unread_count: 100, unseen_count: 100 },
      page_info: { after: null },
    });
  });
  const client = await knockNotificationFeedClient(
    identity,
    async () => identity
  );
  try {
    const pending = expect(client.markAllSeen()).rejects.toThrow(
      "still processing"
    );
    await vi.advanceTimersByTimeAsync(4000);
    await pending;
    expect(writes).toBe(1);
    expect(reads).toBe(5);
  } finally {
    client.dispose();
    vi.useRealTimers();
  }
});

it("accepts a genuinely empty last page with an omitted cursor", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json({
      entries: [],
      meta: { total_count: 0, unread_count: 0, unseen_count: 0 },
      page_info: {},
    })
  );
  const client = await knockNotificationFeedClient(
    identity,
    async () => identity
  );
  try {
    expect(await client.list()).toEqual({
      items: [],
      total: 0,
      unread: 0,
      unseen: 0,
      nextCursor: null,
    });
  } finally {
    client.dispose();
  }
});
