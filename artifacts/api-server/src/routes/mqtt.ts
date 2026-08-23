import { Router, type IRouter, type Response } from "express";
import { desc } from "drizzle-orm";
import mqtt, { type MqttClient } from "mqtt";
import { db, mqttSnapshotsTable } from "@workspace/db";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const brokerUrl = process.env.MQTT_BROKER_URL ?? "mqtt://76.13.4.214";
const subscriptionTopic = process.env.MQTT_TOPIC ?? "trn246/modbus";
const username = process.env.MQTT_USERNAME;
const password = process.env.MQTT_PASSWORD;
const listeners = new Set<Response>();
const SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;

type StoredMessage = { topic: string; payload: string; receivedAt: string };
type SnapshotBuffer = {
  startedAt: Date;
  messages: StoredMessage[];
  latestParameters: Record<string, Record<string, unknown>>;
};

let client: MqttClient | undefined;
let connected = false;
let reconnectTimer: NodeJS.Timeout | undefined;
let lastError: string | undefined;
let latestMessage: StoredMessage | undefined;
const messageHistory: StoredMessage[] = [];
const MESSAGE_HISTORY_LIMIT = 5000;
let snapshotTimer: NodeJS.Timeout | undefined;
let snapshotBuffer: SnapshotBuffer = { startedAt: new Date(), messages: [], latestParameters: {} };
let lastSnapshotAt: string | undefined;
let snapshotError: string | undefined;

function send(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event: string, data: unknown) {
  for (const listener of listeners) send(listener, event, data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parameterFromPayload(rawPayload: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(rawPayload);
    if (!isRecord(parsed)) return undefined;
    const parameter = isRecord(parsed.Automystics) ? parsed.Automystics : parsed;
    return parameter.name !== undefined || parameter.data !== undefined ? parameter : undefined;
  } catch {
    return undefined;
  }
}

function snapshotParameterKey(parameter: Record<string, unknown>) {
  return `${String(parameter.server_name ?? "")}|${String(parameter.name ?? "")}|${String(parameter.addr ?? "")}`;
}

function queueSnapshotMessage(message: StoredMessage) {
  const parameter = parameterFromPayload(message.payload);
  snapshotBuffer.messages.push(message);
  if (parameter) snapshotBuffer.latestParameters[snapshotParameterKey(parameter)] = parameter;
}

async function flushSnapshot() {
  const buffer = snapshotBuffer;
  const windowEndedAt = new Date();
  snapshotBuffer = { startedAt: windowEndedAt, messages: [], latestParameters: {} };
  if (!buffer.messages.length) return;

  try {
    await db.insert(mqttSnapshotsTable).values({
      windowStartedAt: buffer.startedAt,
      windowEndedAt,
      topic: subscriptionTopic,
      messageCount: buffer.messages.length,
      parameterCount: Object.keys(buffer.latestParameters).length,
      data: {
        messages: buffer.messages,
        latestParameters: Object.values(buffer.latestParameters),
      },
    });
    lastSnapshotAt = windowEndedAt.toISOString();
    snapshotError = undefined;
    broadcast("status", status());
    logger.info({ messageCount: buffer.messages.length, parameterCount: Object.keys(buffer.latestParameters).length }, "MQTT snapshot stored");
  } catch (error) {
    snapshotBuffer = {
      startedAt: buffer.startedAt,
      messages: [...buffer.messages, ...snapshotBuffer.messages],
      latestParameters: { ...buffer.latestParameters, ...snapshotBuffer.latestParameters },
    };
    snapshotError = error instanceof Error ? error.message : "Snapshot write failed";
    logger.error({ err: error }, "MQTT snapshot write failed");
    broadcast("status", status());
  }
}

function startSnapshotTimer() {
  if (snapshotTimer) return;
  snapshotTimer = setInterval(() => void flushSnapshot(), SNAPSHOT_INTERVAL_MS);
}

function status() {
  return {
    connected,
    brokerUrl,
    topic: subscriptionTopic,
    error: lastError,
    persistence: {
      intervalMinutes: 15,
      pendingMessages: snapshotBuffer.messages.length,
      lastSnapshotAt,
      error: snapshotError,
    },
  };
}

function startClient() {
  if (client) return;
  startSnapshotTimer();

  client = mqtt.connect(brokerUrl, {
    username,
    password,
    protocolVersion: 4,
    reconnectPeriod: 5_000,
    connectTimeout: 30_000,
    keepalive: 30,
    clean: true,
  });

  client.on("connect", () => {
    connected = true;
    lastError = undefined;
    logger.info({ brokerUrl, subscriptionTopic }, "MQTT broker connected");
    broadcast("status", status());
    client?.subscribe(subscriptionTopic, { qos: 0 }, (error) => {
      if (error) logger.error({ err: error, subscriptionTopic }, "MQTT subscription failed");
    });
  });

  client.on("reconnect", () => {
    connected = false;
    broadcast("status", status());
  });

  client.on("close", () => {
    connected = false;
    broadcast("status", status());
  });

  client.on("error", (error) => {
    connected = false;
    lastError = error.message;
    logger.warn({ err: error }, "MQTT client error");
    broadcast("status", status());
    if (error.message === "connack timeout") {
      const failedClient = client;
      client = undefined;
      failedClient?.end(true);
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          startClient();
        }, 5_000);
      }
    }
  });

  client.on("message", (topic, payload) => {
    latestMessage = { topic, payload: payload.toString("utf8"), receivedAt: new Date().toISOString() };
    queueSnapshotMessage(latestMessage);
    messageHistory.push(latestMessage);
    if (messageHistory.length > MESSAGE_HISTORY_LIMIT) messageHistory.splice(0, messageHistory.length - MESSAGE_HISTORY_LIMIT);
    broadcast("message", latestMessage);
  });
}

router.get("/mqtt/status", (_req, res) => {
  startClient();
  res.json(status());
});

router.get("/mqtt/snapshots", async (_req, res) => {
  try {
    const snapshots = await db
      .select()
      .from(mqttSnapshotsTable)
      .orderBy(desc(mqttSnapshotsTable.capturedAt))
      .limit(20);
    res.json({ snapshots });
  } catch (error) {
    logger.error({ err: error }, "MQTT snapshots query failed");
    res.status(500).json({ message: "Unable to load stored MQTT snapshots" });
  }
});

router.get("/mqtt/stream", (req, res) => {
  startClient();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  listeners.add(res);
  send(res, "status", status());
  for (const message of messageHistory) send(res, "message", message);

  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    listeners.delete(res);
    res.end();
  });
});

export default router;