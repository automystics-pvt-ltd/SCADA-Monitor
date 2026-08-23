import { Router, type IRouter, type Response } from "express";
import mqtt, { type MqttClient } from "mqtt";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const brokerUrl = process.env.MQTT_BROKER_URL ?? "mqtt://76.13.4.214";
const subscriptionTopic = process.env.MQTT_TOPIC ?? "trn246/modbus";
const username = process.env.MQTT_USERNAME;
const password = process.env.MQTT_PASSWORD;
const listeners = new Set<Response>();

let client: MqttClient | undefined;
let connected = false;
let latestMessage: { topic: string; payload: string; receivedAt: string } | undefined;

function send(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event: string, data: unknown) {
  for (const listener of listeners) send(listener, event, data);
}

function status() {
  return { connected, brokerUrl, topic: subscriptionTopic };
}

function startClient() {
  if (client) return;

  client = mqtt.connect(brokerUrl, {
    username,
    password,
    reconnectPeriod: 5_000,
    connectTimeout: 10_000,
    clean: true,
  });

  client.on("connect", () => {
    connected = true;
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
    logger.warn({ err: error }, "MQTT client error");
    broadcast("status", status());
  });

  client.on("message", (topic, payload) => {
    latestMessage = { topic, payload: payload.toString("utf8"), receivedAt: new Date().toISOString() };
    broadcast("message", latestMessage);
  });
}

router.get("/mqtt/status", (_req, res) => {
  startClient();
  res.json(status());
});

router.get("/mqtt/stream", (req, res) => {
  startClient();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  listeners.add(res);
  send(res, "status", status());
  if (latestMessage) send(res, "message", latestMessage);

  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    listeners.delete(res);
    res.end();
  });
});

export default router;