import postgres from "npm:postgres@3.4.9";

export type SqlTransaction = postgres.TransactionSql;

let client: postgres.Sql | undefined;

export function sql(): postgres.Sql {
  client ??= postgres(requiredEnv("SUPABASE_DB_URL"), {
    prepare: false,
    max: 3,
    idle_timeout: 20,
    connect_timeout: 5,
  });
  return client;
}

export function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}
