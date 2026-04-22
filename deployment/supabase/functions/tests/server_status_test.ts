import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.197.0/testing/asserts.ts";

import { api, apiGet } from "./helpers.ts";
import { startServerInProcess } from "./harness.ts";

Deno.test({
  name: "server_status — start server",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await startServerInProcess();
  },
});

Deno.test({
  name: "server_status — GET returns public online status",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    Deno.env.set("MAINTENANCE_MODE", "0");
    Deno.env.delete("MAINTENANCE_MESSAGE");

    const result = await apiGet("server_status");

    assertEquals(result.status, 200);
    assert(result.body.success);
    assertEquals((result.body as Record<string, unknown>).status, "online");
    assertEquals((result.body as Record<string, unknown>).can_login, true);
    assertEquals(
      (result.body as Record<string, unknown>).message,
      "Gradient Bang login services are available.",
    );
  },
});

Deno.test({
  name: "server_status — maintenance mode returns explicit public status",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    Deno.env.set("MAINTENANCE_MODE", "1");
    Deno.env.set("MAINTENANCE_MESSAGE", "Scheduled maintenance window");

    const result = await api("server_status", {});

    assertEquals(result.status, 200);
    assert(result.body.success);
    assertEquals((result.body as Record<string, unknown>).status, "maintenance");
    assertEquals((result.body as Record<string, unknown>).can_login, false);
    assertEquals(
      (result.body as Record<string, unknown>).message,
      "Scheduled maintenance window",
    );

    Deno.env.set("MAINTENANCE_MODE", "0");
    Deno.env.delete("MAINTENANCE_MESSAGE");
  },
});
