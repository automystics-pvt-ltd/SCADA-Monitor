import { Router, type IRouter, type Response } from "express";
import { and, asc, desc, gt, lt, sql } from "drizzle-orm";
import mqtt, { type MqttClient } from "mqtt";
import { db, mqttSnapshotsTable } from "@workspace/db";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const brokerUrl = process.env.MQTT_BROKER_URL ?? "mqtt://76.13.4.214";
const subscriptionTopic = process.env.MQTT_TOPIC ?? "trn246/modbus";
const username = process.env.MQTT_USERNAME;
const password = process.env.MQTT_PASSWORD;
const listeners = new Set<Response>();
const SNAPSHOT_INTERVAL_MS = 15_000;
const PERSISTENCE_INTERVAL_MINUTES = 10;
const PERSISTENCE_START_MINUTE = 6 * 60;
const PERSISTENCE_END_MINUTE = 18 * 60;
const DEFAULT_PLANT_TIMEZONE = "Asia/Kolkata";
const HISTORY_PAGE_SIZE = 250;
const MAX_HISTORY_SNAPSHOTS = 5000;
const configuredTimezone = process.env.MQTT_PLANT_TIMEZONE ?? process.env.PLANT_TIMEZONE ?? DEFAULT_PLANT_TIMEZONE;

type StoredMessage = { topic: string; payload: string; receivedAt: string };
type SnapshotBuffer = {
  startedAt: Date;
  slotKey: string;
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
let snapshotBuffer: SnapshotBuffer | undefined;
let lastSnapshotAt: string | undefined;
let lastSnapshotScheduledFor: string | undefined;
let lastSnapshotStatus: "saved" | "missing" | undefined;
let snapshotError: string | undefined;
let initializedScheduleDate: string | undefined;
let scheduleRun: Promise<void> | undefined;
const failedSnapshotQueue: Array<{ buffer: SnapshotBuffer; scheduledFor: Date }> = [];

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

function validTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    return DEFAULT_PLANT_TIMEZONE;
  }
}

let plantTimezone = validTimezone(configuredTimezone);

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function zonedParts(date: Date, timezone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function localDateTimeToUtc(parts: Omit<ZonedParts, "second"> & { second?: number }, timezone: string) {
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second ?? 0);
  let guess = localAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = zonedParts(new Date(guess), timezone);
    const observedAsUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
    const candidate = localAsUtc - (observedAsUtc - guess);
    if (candidate === guess) break;
    guess = candidate;
  }
  return new Date(guess);
}

function dateKey(parts: ZonedParts) {
  return `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

function slotKey(parts: ZonedParts) {
  return `${dateKey(parts)}T${parts.hour.toString().padStart(2, "0")}:${parts.minute.toString().padStart(2, "0")}`;
}

function emptySnapshotBuffer(startedAt: Date, key: string): SnapshotBuffer {
  return { startedAt, slotKey: key, messages: [], latestParameters: {} };
}

function persistenceSchedule(now: Date) {
  const local = zonedParts(now, plantTimezone);
  const minutes = local.hour * 60 + local.minute;
  const collecting = minutes >= PERSISTENCE_START_MINUTE && minutes < PERSISTENCE_END_MINUTE;
  const currentSlotMinute = Math.floor(minutes / PERSISTENCE_INTERVAL_MINUTES) * PERSISTENCE_INTERVAL_MINUTES;
  const currentSlotParts = { ...local, hour: Math.floor(currentSlotMinute / 60), minute: currentSlotMinute % 60, second: 0 };
  const currentSlotStart = localDateTimeToUtc(currentSlotParts, plantTimezone);
  const nextSlotParts = { ...currentSlotParts, minute: currentSlotParts.minute + PERSISTENCE_INTERVAL_MINUTES };
  const nextSlotStart = nextSlotParts.minute >= 60
    ? localDateTimeToUtc({
      ...nextSlotParts,
      hour: nextSlotParts.hour + Math.floor(nextSlotParts.minute / 60),
      minute: nextSlotParts.minute % 60,
    }, plantTimezone)
    : localDateTimeToUtc(nextSlotParts, plantTimezone);
  const nextStart = minutes < PERSISTENCE_START_MINUTE
    ? localDateTimeToUtc({ ...local, hour: 6, minute: 0, second: 0 }, plantTimezone)
    : minutes < PERSISTENCE_END_MINUTE
      ? nextSlotStart
      : localDateTimeToUtc({ ...local, hour: 6, minute: 0, second: 0 }, plantTimezone) > now
        ? localDateTimeToUtc({ ...local, hour: 6, minute: 0, second: 0 }, plantTimezone)
        : localDateTimeToUtc({ ...local, day: local.day + 1, hour: 6, minute: 0, second: 0 }, plantTimezone);
  return {
    local,
    localDate: dateKey(local),
    minutes,
    collecting,
    currentSlotKey: slotKey(currentSlotParts),
    currentSlotStart,
    nextScheduledAt: nextStart,
  };
}

function timezoneFromParameter(parameter: Record<string, unknown>) {
  for (const [key, value] of Object.entries(parameter)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
    if (!["timezone", "sitetimezone", "planttimezone", "sitetz", "planttz", "tz"].includes(normalized)) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
      return value;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function queueSnapshotMessage(message: StoredMessage) {
  const parameter = parameterFromPayload(message.payload);
  const telemetryTimezone = parameter ? timezoneFromParameter(parameter) : undefined;
  if (telemetryTimezone) plantTimezone = telemetryTimezone;
  const now = new Date(message.receivedAt);
  const schedule = persistenceSchedule(now);
  if (!schedule.collecting) return;
  if (!snapshotBuffer) snapshotBuffer = emptySnapshotBuffer(schedule.currentSlotStart, schedule.currentSlotKey);
  if (snapshotBuffer.slotKey !== schedule.currentSlotKey) {
    const previousBuffer = snapshotBuffer;
    snapshotBuffer = emptySnapshotBuffer(schedule.currentSlotStart, schedule.currentSlotKey);
    void persistSnapshot(previousBuffer, schedule.currentSlotStart, now);
  }
  snapshotBuffer.messages.push(message);
  if (parameter) snapshotBuffer.latestParameters[snapshotParameterKey(parameter)] = parameter;
}

async function persistSnapshot(buffer: SnapshotBuffer, scheduledFor: Date, savedAt = new Date()) {
  const scheduledForIso = scheduledFor.toISOString();
  try {
    const [existing] = await db
      .select({ id: mqttSnapshotsTable.id })
      .from(mqttSnapshotsTable)
      .where(sql`${mqttSnapshotsTable.data} ->> 'scheduledFor' = ${scheduledForIso}`)
      .limit(1);
    if (existing) return true;
    const saveStatus = buffer.messages.length ? "saved" : "missing";
    await db.insert(mqttSnapshotsTable).values({
      windowStartedAt: buffer.startedAt,
      windowEndedAt: scheduledFor,
      capturedAt: savedAt,
      topic: subscriptionTopic,
      messageCount: buffer.messages.length,
      parameterCount: Object.keys(buffer.latestParameters).length,
      data: {
        schemaVersion: 2,
        recordType: "scheduled-telemetry-snapshot",
        saveStatus,
        missingReason: buffer.messages.length ? undefined : "No MQTT telemetry was available in this scheduled window.",
        scheduledFor: scheduledForIso,
        capturedAt: savedAt.toISOString(),
        timezone: plantTimezone,
        messages: buffer.messages,
        latestParameters: Object.values(buffer.latestParameters),
      },
    });
    lastSnapshotAt = savedAt.toISOString();
    lastSnapshotScheduledFor = scheduledForIso;
    lastSnapshotStatus = saveStatus;
    snapshotError = undefined;
    broadcast("status", status());
    logger.info({ scheduledFor: scheduledForIso, saveStatus, messageCount: buffer.messages.length, parameterCount: Object.keys(buffer.latestParameters).length }, "MQTT snapshot stored");
    return true;
  } catch (error) {
    const alreadyQueued = failedSnapshotQueue.some((pending) => pending.scheduledFor.getTime() === scheduledFor.getTime());
    if (!alreadyQueued) failedSnapshotQueue.push({ buffer, scheduledFor });
    snapshotError = error instanceof Error ? error.message : "Snapshot write failed";
    logger.error({ err: error }, "MQTT snapshot write failed");
    broadcast("status", status());
    return false;
  }
}

async function retryFailedSnapshots() {
  while (failedSnapshotQueue.length) {
    const pending = failedSnapshotQueue.shift();
    if (!pending) return;
    const stored = await persistSnapshot(pending.buffer, pending.scheduledFor);
    if (!stored) return;
  }
}

async function runSnapshotSchedule(now = new Date()) {
  await retryFailedSnapshots();
  const schedule = persistenceSchedule(now);
  if (schedule.collecting) {
    if (initializedScheduleDate !== schedule.localDate) {
      initializedScheduleDate = schedule.localDate;
      const dayStart = localDateTimeToUtc({ ...schedule.local, hour: 6, minute: 0, second: 0 }, plantTimezone);
      await persistSnapshot(emptySnapshotBuffer(dayStart, `${schedule.localDate}T06:00`), dayStart, now);
    }
    if (!snapshotBuffer) snapshotBuffer = emptySnapshotBuffer(schedule.currentSlotStart, schedule.currentSlotKey);
    else if (snapshotBuffer.slotKey !== schedule.currentSlotKey) {
      const previousBuffer = snapshotBuffer;
      snapshotBuffer = emptySnapshotBuffer(schedule.currentSlotStart, schedule.currentSlotKey);
      await persistSnapshot(previousBuffer, schedule.currentSlotStart, now);
    }
  } else if (schedule.minutes >= PERSISTENCE_END_MINUTE && snapshotBuffer) {
    const lastBoundary = localDateTimeToUtc({ ...schedule.local, hour: 18, minute: 0, second: 0 }, plantTimezone);
    const previousBuffer = snapshotBuffer;
    snapshotBuffer = undefined;
    await persistSnapshot(previousBuffer, lastBoundary, now);
  } else if (schedule.minutes < PERSISTENCE_START_MINUTE) {
    snapshotBuffer = undefined;
  }
  broadcast("status", status());
}

function requestSnapshotScheduleRun() {
  if (scheduleRun) return;
  scheduleRun = runSnapshotSchedule().finally(() => {
    scheduleRun = undefined;
  });
}

function startSnapshotTimer() {
  if (snapshotTimer) return;
  requestSnapshotScheduleRun();
  snapshotTimer = setInterval(requestSnapshotScheduleRun, SNAPSHOT_INTERVAL_MS);
}

function status() {
  const schedule = persistenceSchedule(new Date());
  return {
    connected,
    brokerUrl,
    topic: subscriptionTopic,
    error: lastError,
    persistence: {
      intervalMinutes: PERSISTENCE_INTERVAL_MINUTES,
      scheduleStart: "06:00",
      scheduleEnd: "18:00",
      timezone: plantTimezone,
      savingActive: schedule.collecting,
      currentWindow: snapshotBuffer?.slotKey,
      nextScheduledAt: schedule.nextScheduledAt.toISOString(),
      pendingMessages: (snapshotBuffer?.messages.length ?? 0) + failedSnapshotQueue.reduce((total, pending) => total + pending.buffer.messages.length, 0),
      lastSnapshotAt,
      lastSnapshotScheduledFor,
      lastSnapshotStatus,
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
    requestSnapshotScheduleRun();
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

function parseRangeBoundary(value: unknown, boundary: "start" | "end") {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed;
}

function isElectricalParameter(parameter: Record<string, unknown>) {
  const name = typeof parameter.name === "string" ? parameter.name.toLowerCase() : "";
  return /(voltage|current|amper|activepower|realpower|powerfactor|frequency|hz|(^|[^a-z])pf([^a-z]|$))/.test(name);
}

router.get("/mqtt/electrical-history", async (req, res) => {
  const from = parseRangeBoundary(req.query.from, "start");
  const to = parseRangeBoundary(req.query.to, "end");
  if (from === undefined || to === undefined) {
    res.status(400).json({ message: "Use valid ISO date/time values for the history range." });
    return;
  }

  const rangeEnd = to ?? new Date();
  const rangeStart = from ?? new Date(rangeEnd.getTime() - 24 * 60 * 60 * 1000);
  if (rangeStart >= rangeEnd) {
    res.status(400).json({ message: "The history start must be before the end." });
    return;
  }
  if (rangeEnd.getTime() - rangeStart.getTime() > 31 * 24 * 60 * 60 * 1000) {
    res.status(400).json({ message: "Choose a history range of 31 days or less." });
    return;
  }

  try {
    const snapshots = [];
    let page = 0;
    let truncated = false;
    while (snapshots.length < MAX_HISTORY_SNAPSHOTS) {
      const batch = await db
        .select()
        .from(mqttSnapshotsTable)
        .where(and(gt(mqttSnapshotsTable.windowEndedAt, rangeStart), lt(mqttSnapshotsTable.windowStartedAt, rangeEnd)))
        .orderBy(asc(mqttSnapshotsTable.windowEndedAt))
        .limit(Math.min(HISTORY_PAGE_SIZE, MAX_HISTORY_SNAPSHOTS - snapshots.length))
        .offset(page * HISTORY_PAGE_SIZE);
      snapshots.push(...batch);
      if (batch.length < HISTORY_PAGE_SIZE) break;
      page += 1;
    }
    if (snapshots.length === MAX_HISTORY_SNAPSHOTS) truncated = true;

    const samples: Array<Record<string, unknown>> = [];
    for (const snapshot of snapshots) {
      if (!isRecord(snapshot.data) || !Array.isArray(snapshot.data.messages)) continue;
      const scheduledFor = typeof snapshot.data.scheduledFor === "string" ? snapshot.data.scheduledFor : snapshot.windowEndedAt.toISOString();
      const saveStatus = snapshot.data.saveStatus === "missing" ? "missing" : "saved";
      const timezone = typeof snapshot.data.timezone === "string" ? snapshot.data.timezone : undefined;
      for (const message of snapshot.data.messages) {
        if (!isRecord(message) || typeof message.payload !== "string") continue;
        const parameter = parameterFromPayload(message.payload);
        if (!parameter || !isElectricalParameter(parameter)) continue;
        const receivedAt = typeof message.receivedAt === "string" ? message.receivedAt : snapshot.capturedAt.toISOString();
        const receivedTime = new Date(receivedAt);
        if (Number.isNaN(receivedTime.getTime()) || receivedTime < rangeStart || receivedTime >= rangeEnd) continue;
        samples.push({
          ...parameter,
          timestamp: receivedAt,
          topic: typeof message.topic === "string" ? message.topic : snapshot.topic,
          snapshotCapturedAt: snapshot.capturedAt.toISOString(),
          snapshotScheduledFor: scheduledFor,
          snapshotSaveStatus: saveStatus,
          snapshotTimezone: timezone,
        });
      }
    }

    res.json({
      range: { from: rangeStart.toISOString(), to: rangeEnd.toISOString() },
      semantics: "[from, to)",
      snapshotCount: snapshots.length,
      truncated,
      samples,
    });
  } catch (error) {
    logger.error({ err: error }, "Electrical history query failed");
    res.status(500).json({ message: "Unable to load persisted electrical telemetry." });
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