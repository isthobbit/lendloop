import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Data minimization: expire security bookkeeping and old operational records.
crons.hourly("purge expired nonces", { minuteUTC: 7 }, internal.maintenance.purgeNonces, {});
crons.daily("retention sweep", { hourUTC: 2, minuteUTC: 17 }, internal.maintenance.retentionSweep, {});
crons.daily("purge reminder tickets", { hourUTC: 2, minuteUTC: 27 }, internal.maintenance.purgeReminderTickets, {});

export default crons;
