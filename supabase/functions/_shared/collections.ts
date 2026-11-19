import type { Collection } from "./collection.ts";
import { dailyReadiness } from "./daily-readiness.ts";
import { dailySleep } from "./daily-sleep.ts";
import { dailySpo2 } from "./daily-spo2.ts";
import { sleep } from "./sleep.ts";

export const collections: readonly Collection[] = [
  dailySleep,
  dailySpo2,
  dailyReadiness,
  sleep,
];
