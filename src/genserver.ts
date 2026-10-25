import { atom, format, type Pid, type Term, Tuple, tuple } from "./etf.ts";
import { type ErlNode, jsErrorReason } from "./node.ts";
import type { Process } from "./process.ts";

/**
 * Callbacks of a GenServer written in JS. Same roles as in Elixir; state is
 * passed in and returned, so the callbacks can be tested as plain functions.
 * State must not be `undefined` (use `null`).
 */
export interface GenServerSpec<S, A> {
  /** Builds the initial state. Messages that arrive meanwhile wait in the mailbox. */
  init: (self: Process, args: A) => S | Promise<S>;
  /**
   * `GenServer.call`: return `{ reply, state }` (a missing `reply` replies
   * `:ok`), or nothing when the request is not handled, which crashes the
   * process like a missing `handle_call` clause.
   */
  handleCall?: (
    request: Term,
    state: S,
    from: Term,
  ) => { reply?: Term; state: S } | void | Promise<{ reply?: Term; state: S } | void>;
  /** `GenServer.cast`: returns the new state. */
  handleCast?: (request: Term, state: S) => S | Promise<S>;
  /** Any other message: returns the new state. Without it, such messages are logged and dropped. */
  handleInfo?: (msg: Term, state: S) => S | Promise<S>;
  /** Runs once when the process ends, for any reason, to clean up. */
  terminate?: (reason: Term, state: S) => unknown;
}

export interface GenServer<A> {
  /**
   * Starts the server and resolves with its pid once `init` has finished,
   * like `GenServer.start_link`. Rejects if `init` throws. With `restart`,
   * a crash runs `init` again in a new process (see `node.spawn`).
   */
  start(node: ErlNode, opts?: { name?: string; args?: A; restart?: boolean | { delay?: number } }): Promise<Pid>;
}

/**
 * Describes a GenServer once; `start` it as many times as needed:
 *
 *     const Counter = defineGenServer({
 *       init: (_self, start: number) => start,
 *       handleCall: (req, n) => (req === atom("inc") ? { reply: n + 1, state: n + 1 } : undefined),
 *     });
 *     await Counter.start(node, { name: "Counter", args: 0 });
 *
 * Elixir talks to it with `GenServer.call({Counter, :"js@host"}, :inc)`.
 */
export function defineGenServer<S, A = undefined>(spec: GenServerSpec<S, A>): GenServer<A> {
  return {
    start(node, opts = {}) {
      return new Promise((resolve, reject) => {
        let started = false;
        node.spawn(
          async (self) => {
            const label = opts.name ?? String(self.pid);
            if (opts.name) self.register(opts.name);
            let state: S;
            try {
              state = await spec.init(self, opts.args as A);
            } catch (err) {
              if (started) throw err; // a restart: crash and let restart try again
              started = true;
              reject(err);
              // {:shutdown, _} so that a failed first start is not restarted.
              self.exit(tuple(atom("shutdown"), tuple(atom("init_failed"), jsErrorReason(err))));
              return;
            }
            if (!started) {
              started = true;
              resolve(self.pid);
            }
            let reason: Term = atom("normal");
            try {
              for await (const msg of self) state = await handle(node, spec, label, msg, state);
            } catch (err) {
              reason = jsErrorReason(err);
              throw err;
            } finally {
              if (spec.terminate) {
                try {
                  await spec.terminate(self.alive ? reason : (self.exitReason ?? reason), state);
                } catch (err) {
                  console.error(`erlnode: ${label} terminate failed:`, err);
                }
              }
            }
          },
          { restart: opts.restart },
        );
      });
    },
  };
}

async function handle<S, A>(node: ErlNode, spec: GenServerSpec<S, A>, label: string, msg: Term, state: S): Promise<S> {
  const [tag, a, b] = msg instanceof Tuple ? msg : [];
  if (tag === atom("$gen_call") && msg instanceof Tuple && msg.length === 3) {
    const result = await spec.handleCall?.(b!, state, a!);
    if (!result) throw new Error(`${label}: no handleCall clause for ${format(b!)}`);
    await node.reply(a!, result.reply === undefined ? atom("ok") : result.reply);
    return result.state;
  }
  if (tag === atom("$gen_cast") && msg instanceof Tuple && msg.length === 2) {
    if (!spec.handleCast) throw new Error(`${label}: got a cast but has no handleCast: ${format(a!)}`);
    return checked(await spec.handleCast(a!, state), label, "handleCast");
  }
  if (!spec.handleInfo) {
    console.error(`erlnode: ${label} has no handleInfo, dropped ${format(msg)}`);
    return state;
  }
  return checked(await spec.handleInfo(msg, state), label, "handleInfo");
}

function checked<S>(state: S, label: string, callback: string): S {
  if (state === undefined) throw new Error(`${label}: ${callback} must return the new state`);
  return state;
}
