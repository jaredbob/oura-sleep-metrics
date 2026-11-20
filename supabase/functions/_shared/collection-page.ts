import { type Collection, collectionPath, isDay } from "./collection.ts";
import { ouraUserFetch } from "./oura-auth.ts";

export type PageCursor = {
  next_token: string | null;
  page_tokens: string[];
};

export class InvalidCursor extends Error {}

export async function readCollectionPage(
  ownerId: string,
  collection: Collection,
  startDay: string,
  endDay: string,
  cursor: PageCursor,
) {
  const params = new URLSearchParams({
    start_date: startDay,
    end_date: endDay,
  });
  if (cursor.next_token) params.set("next_token", cursor.next_token);
  const response = await ouraUserFetch(
    ownerId,
    collectionPath(collection, undefined, params),
    collection.scope,
  );
  if (!response.ok) {
    await response.body?.cancel();
    if (
      cursor.next_token && (response.status === 400 || response.status === 422)
    ) {
      throw new InvalidCursor();
    }
    throw new Error("Oura collection request failed.");
  }

  const page = await response.json();
  const nextToken = page?.next_token as unknown;
  if (
    !Array.isArray(page?.data) ||
    (nextToken !== null && (typeof nextToken !== "string" || !nextToken))
  ) {
    throw new Error("Invalid Oura collection page.");
  }
  if (
    nextToken !== null &&
    (nextToken === cursor.next_token || cursor.page_tokens.includes(nextToken))
  ) {
    throw new InvalidCursor();
  }

  const records = (page.data as unknown[]).flatMap((document) => {
    const record = collection.parseListed
      ? collection.parseListed(document)
      : collection.parse(document);
    if (!record) return [];
    if (!isDay(record.day)) throw new Error("Invalid Oura document day.");
    return [record];
  });
  return {
    records,
    nextToken,
    pageTokens: nextToken === null ? [] : [...cursor.page_tokens, nextToken],
  };
}
