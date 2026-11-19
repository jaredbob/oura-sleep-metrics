import type { Collection } from "./collection.ts";
import { dailySleep } from "./daily-sleep.ts";
import { sleep } from "./sleep.ts";

export const collections: readonly Collection[] = [
  dailySleep,
  sleep,
];
