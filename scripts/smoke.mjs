// Runs the built package (dist/) against a live Elixir node, outside Bun.
// Usage: node scripts/smoke.mjs [path to index.mjs]   (also: deno run -A ...)
import { spawn } from "node:child_process";

const entry = process.argv[2] ?? new URL("../dist/index.mjs", import.meta.url).href;
const { atom, defineGenServer, start, tuple } = await import(entry.startsWith("/") ? `file://${entry}` : entry);

const APP = "smoke_app@localhost";
const SCRIPT = `
defmodule Counter do
  use GenServer
  def init(n), do: {:ok, n}
  def handle_call(:inc, _from, n), do: {:reply, n + 1, n + 1}
end
{:ok, _} = GenServer.start_link(Counter, 0, name: Counter)
IO.puts("READY")
Process.sleep(:infinity)
`;

const elixir = spawn("elixir", ["--sname", APP, "--cookie", "secret", "-e", SCRIPT], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve, reject) => {
  let out = "";
  elixir.stdout.on("data", (d) => {
    out += d;
    if (out.includes("READY")) resolve();
  });
  elixir.on("exit", () => reject(new Error("elixir exited")));
});

const checks = [];
const check = (name, ok) => {
  checks.push([name, ok]);
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
};

const node = start({ name: "smoke_js@localhost", cookie: "secret" });
try {
  await node.listen({ host: "127.0.0.1" });
  await node.connect(APP);
  check("connect", node.list().includes(APP));
  check("GenServer.call", (await node.call(["Counter", APP], atom("inc"))) === 1);
  check("erpc", (await node.erpc(APP, "erlang", "node")) === atom(APP));
  const lists = node.module(APP, "lists");
  check("module", JSON.stringify(await lists.seq(1, 3)) === "[1,2,3]");

  const Local = defineGenServer({
    init: () => 0,
    handleCall: (req, n) => (req === atom("inc") ? { reply: n + 1, state: n + 1 } : undefined),
  });
  await Local.start(node, { name: "LocalCounter" });
  check("defineGenServer, called from Elixir", (await node.rpc(APP, "Elixir.GenServer", "call", [tuple(atom("Elixir.LocalCounter"), node.name), atom("inc")])) === 1);

  const got = new Promise((resolve) => {
    node.spawn(async (self) => {
      self.register("inbox");
      for await (const msg of self) return resolve(msg);
    });
  });
  await node.rpc(APP, "erlang", "send", [tuple(atom("inbox"), node.name), atom("hi")]);
  check("receive a message from Elixir", (await got) === atom("hi"));
} catch (err) {
  check(`no exception (${err?.message ?? err})`, false);
} finally {
  await node.close();
  elixir.kill();
}
const failed = checks.filter(([, ok]) => !ok).length;
console.log(failed ? `${failed} failed` : `all ${checks.length} passed`);
process.exit(failed ? 1 : 0);
