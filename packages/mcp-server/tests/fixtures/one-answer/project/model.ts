// TypeScript-only syntax on purpose. Under the JavaScript grammar the
// interface below error-recovers into a `query(...)` call, so an answer
// that depends on which grammar loaded first shows up as a difference
// between the two doors.
export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export function userKey(id: number, tenant: string): string {
  return `${tenant}:${id}`;
}
