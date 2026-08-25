import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test, { after } from "node:test";
import express, { type Request, type Response } from "express";
import { closeScadaUserStreams, registerScadaSessionStream } from "../lib/scada-session-streams.ts";
import authRouter from "./auth.ts";

const principal = {
  id: "scada-session-test-user",
  email: "scada-session-test@example.com",
  firstName: "SCADA",
  lastName: "Test",
  profileImageUrl: null,
};

const app = express();
app.use((req, _res, next) => {
  const session = req.get("x-test-session");
  const genericAuthenticated = session === "platform" || session === "scada";
  const scadaAuthenticated = session === "scada";
  const testRequest = req as Request & {
    user?: typeof principal;
    scadaUser?: typeof principal;
    isAuthenticated(): boolean;
    isScadaAuthenticated(): boolean;
  };
  testRequest.isAuthenticated = (() => genericAuthenticated) as Request["isAuthenticated"];
  testRequest.isScadaAuthenticated = (() => scadaAuthenticated) as Request["isScadaAuthenticated"];
  testRequest.cookies = Object.fromEntries((req.get("cookie") ?? "").split(";").filter(Boolean).map((entry) => {
    const [key, value = ""] = entry.trim().split("=");
    return [key, value];
  }));
  if (genericAuthenticated) testRequest.user = principal;
  if (scadaAuthenticated) testRequest.scadaUser = principal;
  next();
});
app.use("/api", authRouter);

const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const baseUrl = `http://127.0.0.1:${port}`;

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("the SCADA session endpoint ignores a valid generic Platform Admin identity", async () => {
  const response = await fetch(`${baseUrl}/api/scada-auth/user`, {
    headers: { "x-test-session": "platform" },
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { user: unknown; canUpdatePlantLocations: boolean };
  assert.equal(body.user, null);
  assert.equal(body.canUpdatePlantLocations, false);
});

test("the SCADA session endpoint recognizes only the SCADA session principal", async () => {
  const response = await fetch(`${baseUrl}/api/scada-auth/user`, {
    headers: { "x-test-session": "scada" },
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { user: { id: string } | null };
  assert.equal(body.user?.id, principal.id);
});

test("SCADA logout immediately terminates any active stream for that session", async () => {
  const sid = "scada-stream-logout-test";
  const frames: string[] = [];
  let ended = false;
  const stream = {
    writableEnded: false,
    write(frame: string) { frames.push(frame); return true; },
    end() { ended = true; },
  } as unknown as Response;
  registerScadaSessionStream(sid, principal.id, stream);

  const response = await fetch(`${baseUrl}/api/scada-auth/logout`, {
    method: "POST",
    headers: { cookie: `scada_sid=${sid}` },
  });
  assert.equal(response.status, 204);
  assert.equal(ended, true);
  assert.deepEqual(frames, ["event: auth-expired\ndata: {\"message\":\"SCADA session expired.\"}\n\n"]);
});

test("administrative user revocation closes every active SCADA stream for that user", () => {
  const userId = "revoked-stream-user";
  const ended: string[] = [];
  for (const sid of ["revoked-stream-one", "revoked-stream-two"]) {
    const stream = {
      writableEnded: false,
      write() { return true; },
      end() { ended.push(sid); },
    } as unknown as Response;
    registerScadaSessionStream(sid, userId, stream);
  }
  closeScadaUserStreams(userId);
  assert.deepEqual(ended.sort(), ["revoked-stream-one", "revoked-stream-two"]);
});