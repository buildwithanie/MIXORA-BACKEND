import { workerBindings } from "./worker-bindings";

export type QueryResult<T> = { rows: T[]; changes: number };
export type CatalogDatabase = {
  query<T extends object>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
  end(): Promise<void>;
};

const globalDatabase = globalThis as typeof globalThis & { mixoraD1Database?: CatalogDatabase };

function bind(sql: string, values: unknown[]): { sql: string; params: string[] } {
  const params: string[] = [];
  const statement = sql.replace(/\$(\d+)/g, (_, index: string) => {
    const position = Number(index) - 1;
    if (position < 0 || position >= values.length) throw new Error("Missing SQL parameter");
    const value = values[position];
    if (value === null || value === undefined) return "NULL";
    params.push(value instanceof Date ? value.toISOString() : typeof value === "boolean" ? (value ? "1" : "0") : String(value));
    return "?";
  });
  return { sql: statement, params };
}

export class CloudflareD1Database implements CatalogDatabase {
  constructor(
    private readonly accountId: string,
    private readonly databaseId: string,
    private readonly token: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async query<T extends object>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
    const body = bind(sql, values);
    const response = await this.request(
      `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/d1/database/${this.databaseId}/query`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      },
    );
    const data = await response.json() as {
      success?: boolean;
      errors?: { code?: number }[];
      result?: { success?: boolean; results?: T[]; meta?: { changes?: number } }[];
    };
    if (response.status >= 500) throw new Error(`Cloudflare D1 unavailable (${response.status})`);
    if (!response.ok || !data.success || !data.result?.every((item) => item.success)) {
      const code = data.errors?.[0]?.code;
      throw new Error(`Cloudflare D1 query failed${code ? ` (${code})` : ""}`);
    }
    return { rows: data.result.at(-1)?.results ?? [],
      changes: data.result.reduce((sum, item) => sum + (item.meta?.changes ?? 0), 0) };
  }

  async end(): Promise<void> {}
}

type WorkerD1 = {
  prepare(sql: string): { bind(...values: string[]): { all<T>(): Promise<{
    success: boolean; results: T[]; meta?: { changes?: number };
  }> } };
};

export class BoundD1Database implements CatalogDatabase {
  constructor(private readonly binding: WorkerD1) {}

  async query<T extends object>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
    const statement = bind(sql, values);
    const result = await this.binding.prepare(statement.sql).bind(...statement.params).all<T>();
    if (!result.success) throw new Error("Cloudflare D1 binding query failed");
    return { rows: result.results ?? [], changes: result.meta?.changes ?? 0 };
  }

  async end(): Promise<void> {}
}

export function db(): CatalogDatabase {
  if (globalDatabase.mixoraD1Database) return globalDatabase.mixoraD1Database;
  if (process.env.MIXORA_WORKER === "1") {
    // A deployed Worker uses its D1 binding, never an account-wide API token.
    return new BoundD1Database(workerBindings().MIXORA_DB);
  }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const database = process.env.CLOUDFLARE_D1_DATABASE_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !database || !token) throw new Error("Cloudflare D1 is not configured");
  return (globalDatabase.mixoraD1Database = new CloudflareD1Database(account, database, token));
}
