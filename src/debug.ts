import { format, type Term } from "./etf.ts";

const LIMIT = 500;

/** True when the ERLNODE_DEBUG environment variable is set. */
export function debugEnabled(): boolean {
  return Boolean(globalThis.process?.env?.ERLNODE_DEBUG);
}

/** Writes a debug line to stderr. */
export function debug(line: string): void {
  console.error(`erlnode: ${line}`);
}

/** A term in Erlang notation, cut to a readable length. */
export function brief(t: Term): string {
  const s = format(t);
  return s.length > LIMIT ? `${s.slice(0, LIMIT)}… (${s.length} chars)` : s;
}
