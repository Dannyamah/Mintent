import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpBackend, MockBackend, verifySettlement, withServiceFee, type CheckoutStatus } from "../src/index.ts";

const req = { originAsset: "mock:btc", destinationAsset: "dest", amountOut: "50000000", recipient: "treasury", refundTo: "user" };
const expected = { recipient: "treasury", destinationAsset: "dest", minAmountOut: 50_000_000n };

test("service fee rounds up", () => {
  assert.equal(withServiceFee(50_000_000n, 100), 50_500_000n);
  assert.equal(withServiceFee(1n, 100), 2n);
  assert.equal(withServiceFee(100n, 0), 100n);
});

test("mock walks to SUCCESS after a deposit, and settlement verifies", async () => {
  const b = new MockBackend();
  const q = await b.quote(req);
  assert.equal((await b.status(q.depositAddress)).status, "PENDING_DEPOSIT");
  await b.submitDeposit("tx", q.depositAddress);
  const seen = [];
  for (let i = 0; i < 3; i++) seen.push((await b.status(q.depositAddress)).status);
  assert.deepEqual(seen, ["KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"]);
  assert.deepEqual(await verifySettlement(b, await b.status(q.depositAddress), expected), { ok: true, amountOut: 50_000_000n });
});

const success = (over: Partial<Record<string, any>> = {}, amountOut = "50000000"): CheckoutStatus => ({
  status: "SUCCESS",
  swapDetails: { amountOut },
  quoteResponse: { quote: {}, quoteRequest: { recipient: "treasury", destinationAsset: "dest", recipientType: "DESTINATION_CHAIN", ...over } },
});

test("settlement rejects what a SUCCESS string alone would hide", async () => {
  const b = new MockBackend();
  assert.match((await verifySettlement(b, success({ recipient: "attacker" }), expected)).reason!, /recipient/);
  assert.match((await verifySettlement(b, success({ destinationAsset: "other" }), expected)).reason!, /destination asset/);
  assert.match((await verifySettlement(b, success({ recipientType: "INTENTS" }), expected)).reason!, /recipient type/);
  assert.match((await verifySettlement(b, success({}, "49999999"), expected)).reason!, /settled/);
  assert.match((await verifySettlement(b, { ...success(), status: "REFUNDED" }, expected)).reason!, /REFUNDED/);
  assert.match((await verifySettlement(b, { ...success(), quoteResponse: {} }, expected)).reason!, /no quote request/);
});

test("a partner JWT is never sent to a host other than 1Click", async () => {
  const headers: Record<string, string>[] = [];
  const fake = (async (_url: string, init: any) => {
    headers.push(init.headers);
    return new Response("[]", { status: 200 });
  }) as unknown as typeof fetch;
  await new HttpBackend("https://www.usetidepool.tech", "secret-jwt", fake).tokens();
  assert.equal(headers[0].authorization, undefined);
  await new HttpBackend("https://1click.chaindefuser.com", "secret-jwt", fake).tokens();
  assert.equal(headers[1].authorization, "Bearer secret-jwt");
});

test("BTC quotes pass despite the SDK's false negative; other assets must verify", async () => {
  const fake = (async () => new Response(JSON.stringify({ quote: { depositAddress: "d", amountIn: "1", amountOut: "1" }, quoteRequest: {}, signature: "ed25519:bad", timestamp: "t" }), { status: 200 })) as unknown as typeof fetch;
  const b = new HttpBackend("https://1click.chaindefuser.com", undefined, fake);
  assert.equal((await b.quote({ ...req, originAsset: "nep141:btc.omft.near" })).depositAddress, "d");
  await assert.rejects(b.quote({ ...req, originAsset: "nep141:sol.omft.near" }), /signature is invalid/);
});

test("simulate is sent to a sandbox but never to mainnet 1Click", async () => {
  const bodies: any[] = [];
  const fake = (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ quote: { depositAddress: "d", amountIn: "1", amountOut: "1" } }), { status: 200 });
  }) as unknown as typeof fetch;
  await new HttpBackend("https://www.usetidepool.tech", undefined, fake).quote({ ...req, simulate: "FAILED" });
  assert.equal(bodies[0].simulate, "FAILED");
  assert.equal(bodies[0].swapType, "EXACT_OUTPUT");
  assert.equal(bodies[0].recipientType, "DESTINATION_CHAIN");
});

test("HTTP errors surface with their status", async () => {
  const fake = (async () => new Response("bad deadline", { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(new HttpBackend("https://www.usetidepool.tech", undefined, fake).quote(req), /400: bad deadline/);
});
