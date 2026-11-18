import { db, getSqlite } from "../app/db";
import { backfillNotificationPeople } from "../app/lib/notifications.server";

try {
  const result = await backfillNotificationPeople(db);
  console.log("Notification person backfill:", result);
  // A nonzero exit status makes an incomplete live rollout visible. Completed
  // Cadence records and successful people remain intact; rerunning is safe.
  if (result.failed > 0 || result.disabled > 0) process.exitCode = 1;
} finally {
  getSqlite().close();
}
