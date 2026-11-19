import type { Collection } from "./collection.ts";
import { dailyReadiness } from "./daily-readiness.ts";
import { dailySleep } from "./daily-sleep.ts";

export const collections: readonly Collection[] = [
  dailySleep,
  dailyReadiness,
];
