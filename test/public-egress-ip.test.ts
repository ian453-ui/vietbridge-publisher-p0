import test from "node:test";
import assert from "node:assert/strict";
import { isPublicIpv4, resolvePublicEgressIpv4 } from "../src/public-egress-ip.ts";

test("public egress allowlist accepts global IPv4 and rejects local or special-use addresses", () => {
  assert.equal(isPublicIpv4("1.52.215.46"), true);
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.2", "169.254.1.2", "100.64.0.1", "192.0.2.1", "224.0.0.1", "::1", "not-an-ip"]) {
    assert.equal(isPublicIpv4(ip), false, ip);
  }
});

test("egress resolver validates responses and falls back to its second provider", async () => {
  const calls: string[] = [];
  const fetcher = async (input: string | URL): Promise<Response> => {
    calls.push(String(input));
    return new Response(calls.length === 1 ? "192.168.1.5" : "1.52.215.46\n", { status: 200 });
  };
  assert.equal(await resolvePublicEgressIpv4(fetcher), "1.52.215.46");
  assert.deepEqual(calls, ["https://api.ipify.org", "https://checkip.amazonaws.com"]);
});

test("egress resolver fails closed when providers do not return a public IPv4", async () => {
  await assert.rejects(resolvePublicEgressIpv4(async () => new Response("::1", { status: 200 })), /PUBLIC_EGRESS_IPV4_UNAVAILABLE/);
});
