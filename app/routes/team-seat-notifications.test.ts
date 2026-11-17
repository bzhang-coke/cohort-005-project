import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToString } from "react-dom/server";
import {
  createMemoryRouter,
  RouterContextProvider,
  RouterProvider,
} from "react-router";
import { createTestDb, seedBaseData } from "~/test/setup";
import {
  coupons,
  purchases,
  teamMembers,
  TeamMemberRole,
  teams,
} from "~/db/schema";
import { setCurrentUserId } from "~/lib/session";
import Team, { loader } from "./team";

vi.mock("~/db", () => ({
  get db() {
    return db;
  },
}));

let db: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
});
afterEach(() => {
  db.$client.close();
});

function seatForBuyer(buyerId: number, code: string) {
  const team = db.insert(teams).values({}).returning().get();
  db.insert(teamMembers)
    .values({ teamId: team.id, userId: buyerId, role: TeamMemberRole.Admin })
    .run();
  const purchase = db
    .insert(purchases)
    .values({ userId: buyerId, courseId: base.course.id, amountPaid: 7999 })
    .returning()
    .get();
  const seat = db
    .insert(coupons)
    .values({
      teamId: team.id,
      purchaseId: purchase.id,
      courseId: base.course.id,
      code,
      redeemedByUserId: base.user.id,
      redeemedAt: "2026-11-17T12:00:00.000Z",
    })
    .returning()
    .get();
  return { purchase, seat };
}

async function loadTeam(personId: number | null, hash: string) {
  const url = new URL(`http://localhost/team${hash}`);
  const cookie =
    personId === null ? "" : await setCurrentUserId(new Request(url), personId);
  return loader({
    request: new Request(url, { headers: { Cookie: cookie } }),
    params: {},
    context: new RouterContextProvider(),
    url,
    pattern: "/team",
  });
}

it("renders the exact claimed Seat anchor only within the buyer's authorized Team", async () => {
  const { seat } = seatForBuyer(base.instructor.id, "BUYER-SEAT");
  const unrelated = seatForBuyer(base.user.id, "OTHER-TEAM-SEAT");
  const destination = `/team#seat-${seat.id}`;
  const loaderData = await loadTeam(base.instructor.id, `#seat-${seat.id}`);
  const router = createMemoryRouter(
    [
      {
        path: "/team",
        element: createElement(Team, { loaderData } as ComponentProps<
          typeof Team
        >),
      },
    ],
    { initialEntries: [destination] }
  );
  try {
    const html = renderToString(createElement(RouterProvider, { router }));
    expect(html).toContain(`id="seat-${seat.id}"`);
    expect(html.replace(/<!--.*?-->/g, "")).toContain(
      "Claimed by test@example.com"
    );
    expect(html).not.toContain(`id="seat-${unrelated.seat.id}"`);
    expect(html).not.toContain("OTHER-TEAM-SEAT");
  } finally {
    router.dispose();
  }
});

it.each([null, "claimant"])(
  "does not grant Team access through a Seat destination to %s",
  async (person) => {
    const { seat } = seatForBuyer(base.instructor.id, "BUYER-SEAT");
    await expect(
      loadTeam(person === null ? null : base.user.id, `#seat-${seat.id}`)
    ).rejects.toMatchObject({
      init: { status: person === null ? 401 : 403 },
    });
  }
);

it("keeps a different Team Admin's Seat destination scoped to their own Team", async () => {
  const { seat } = seatForBuyer(base.instructor.id, "BUYER-SEAT");
  const unrelated = seatForBuyer(base.user.id, "OTHER-TEAM-SEAT");
  const result = await loadTeam(base.user.id, `#seat-${seat.id}`);
  expect(result.couponRows.map((row) => row.id)).toEqual([unrelated.seat.id]);
  expect(result.teamLicences.map((licence) => licence.purchaseId)).toEqual([
    unrelated.purchase.id,
  ]);
});
