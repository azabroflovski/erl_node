import type { Subprocess } from "bun";

export const COOKIE = "secret";

// Processes every test node starts with:
// - `:echo` replies `{:echo, msg}` to `from` for every `{from, msg}` it gets;
// - `Counter` is a GenServer, `:inc` bumps the counter and returns the new value;
// - `Funs.adder/1` returns a closure, to pass funs back and forth;
// - `Helpers` spawns processes for link and monitor tests.
const SCRIPT = `
defmodule Counter do
  use GenServer
  def init(n), do: {:ok, n}
  def handle_call(:inc, _from, n), do: {:reply, n + 1, n + 1}
  def handle_call(:get, _from, n), do: {:reply, n, n}
  def handle_call(:stop, _from, n), do: {:stop, :bye, n}
end

defmodule Funs do
  def adder(x), do: fn y -> x + y end
end

defmodule Helpers do
  # A process that sleeps until killed.
  def sleeper, do: spawn(fn -> Process.sleep(:infinity) end)

  # Monitors pid and sends {:down, reason} to report_to when it goes away.
  def watch(pid, report_to) do
    spawn(fn ->
      ref = Process.monitor(pid)
      receive do
        {:DOWN, ^ref, :process, _, reason} -> send(report_to, {:down, reason})
      end
    end)
  end

  # Sends {tag, binary of size bytes} to pid from one process per tag, all at once.
  def blast(pid, tags, size) do
    senders =
      for tag <- tags do
        bin = :binary.copy(<<tag>>, size)
        spawn(fn ->
          receive do
            :go -> send(pid, {tag, bin})
          end
        end)
      end
    Enum.each(senders, &send(&1, :go))
  end

  # Asks node to spawn a process and returns its spawn_reply.
  def spawn_on(node) do
    ref = :erlang.spawn_request(node, :erlang, :node, [])
    receive do
      {:spawn_reply, ^ref, status, result} -> {status, result}
    after
      2000 -> :timeout
    end
  end

  # Links to pid, unlinks on :unlink, never exits on its own.
  def linker(pid) do
    spawn(fn ->
      Process.link(pid)
      receive do
        :unlink -> Process.unlink(pid)
      end
      Process.sleep(:infinity)
    end)
  end
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
