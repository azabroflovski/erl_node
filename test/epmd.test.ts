import { afterAll, beforeAll, expect, test } from "bun:test";
import { portPlease } from "../src/epmd.ts";
import { startNode, type TestNode } from "./support/node.ts";

let node: TestNode;

beforeAll(async () => {
  node = await startNode("epmd_test");
});

afterAll(() => node.stop());

test("port matches epmd -names", async () => {
  const info = await portPlease("localhost", "epmd_test");
  const names = await new Response(Bun.spawn(["epmd", "-names"]).stdout).text();
  const line = names.split("\n").find((l) => l.startsWith("name epmd_test "));
  expect(line).toBe(`name epmd_test at port ${info.port}`);
  expect(info.name).toBe("epmd_test");
  expect(info.nodeType).toBe(77);
  expect(info.lowestVersion).toBeLessThanOrEqual(6);
  expect(info.highestVersion).toBeGreaterThanOrEqual(6);
});

test("unknown node", async () => {
  await expect(portPlease("localhost", "no_such_node")).rejects.toThrow("not registered");
});
