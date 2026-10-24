import type { Subprocess } from "bun";

export const COOKIE = "secret";

// Processes every test node starts with:
// - `:echo` replies `{:echo, msg}` to `from` for every `{from, msg}` it gets;
// - `Counter` is a GenServer, `:inc` bumps the counter and returns the new value.
const SCRIPT = `
defmodule Counter do
  use GenServer
  def init(n), do: {:ok, n}
  def handle_call(:inc, _from, n), do: {:reply, n + 1, n + 1}
  def handle_call(:get, _from, n), do: {:reply, n, n}
end

defmodule Echo do
  def loop do
    receive do
      {from, msg} when is_pid(from) -> send(from, {:echo, msg})
      _ -> :ok
    end
    loop()
  end
end

{:ok, _} = GenServer.start_link(Counter, 0, name: Counter)
Process.register(spawn_link(&Echo.loop/0), :echo)
IO.puts("READY")
Process.sleep(:infinity)
`;

export interface TestNode {
  /** Full node name, e.g. `app@localhost`. */
  name: string;
  stop(): Promise<void>;
}

/** Starts an Elixir node `<sname>@localhost` and waits until it is ready. */
export async function startNode(sname: string, opts: { cookie?: string; erl?: string } = {}): Promise<TestNode> {
  const name = `${sname}@localhost`;
  const args = ["--sname", name, "--cookie", opts.cookie ?? COOKIE];
  if (opts.erl) args.push("--erl", opts.erl);
  const proc = Bun.spawn(["elixir", ...args, "-e", SCRIPT], {
    stdout: "pipe",
    stderr: "inherit",
  });
  await waitForLine(proc, "READY", 15_000);
  return {
    name,
    async stop() {
      proc.kill();
      await proc.exited;
    },
  };
}

async function waitForLine(proc: Subprocess<"ignore", "pipe", "inherit">, line: string, timeout: number) {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let out = "";
  const timer = setTimeout(() => proc.kill(), timeout);
  try {
    while (!out.split("\n").includes(line)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`node exited before printing ${line}:\n${out}`);
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

/** Runs Elixir code in a throwaway VM and returns its stdout. */
export async function runElixir(code: string, args: string[] = []): Promise<string> {
  const proc = Bun.spawn(["elixir", ...args, "-e", code], { stdout: "pipe", stderr: "pipe" });
  const [out, err, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (status !== 0) throw new Error(`elixir exited with ${status}:\n${err}`);
  return out;
}
