import { Router, type IRouter, type Response } from "express";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import mqtt, { type MqttClient } from "mqtt";
import { db, mqttSnapshotsTable, plantLocationsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { canUpdatePlantLocation } from "../middlewares/plantLocationAuthorization";

const router: IRouter = Router();
const brokerUrl = process.env.MQTT_BROKER_URL ?? "mqtt://76.13.4.214";
const subscriptionTopic = process.env.MQTT_TOPIC ?? "trn246/modbus";
const username = process.env.MQTT_USERNAME;
const password = process.env.MQTT_PASSWORD;
const listeners = new Set<Response>();
const SNAPSHOT_INTERVAL_MS = 15_000;
const PERSISTENCE_INTERVAL_MINUTES = 15;
const PERSISTENCE_START_MINUTE = 6 * 60;
const PERSISTENCE_END_MINUTE = 18 * 60;
const DEFAULT_PLANT_TIMEZONE = "Asia/Kolkata";
const configuredTimezone = process.env.MQTT_PLANT_TIMEZONE ?? process.env.PLANT_TIMEZONE ?? DEFAULT_PLANT_TIMEZONE;

type StoredMessage = { topic: string; payload: string; receivedAt: string };
type SnapshotBuffer = {
  startedAt: Date;
  slotKey: string;
  messages: StoredMessage[];
  latestParameters: Record<string, Record<string, unknown>>;
};
type SnapshotSaveStatus = "saved" | "missing" | "incomplete";
type SavedKpiMetric = {
  parameter: string;
  value: number;
  rawData: string;
  address: string;
  sourceTimestamp?: string;
};
type SavedSnapshotEvidence = {
  id: number;
  topic: string;
  windowStartedAt: string;
  windowEndedAt: string;
  scheduledFor: string;
  capturedAt: string;
  timezone?: string;
  saveStatus: SnapshotSaveStatus;
  missingReason?: string;
  messageCount: number;
  parameterCount: number;
  metrics: {
    activePower: SavedKpiMetric | null;
    dailyEnergy: SavedKpiMetric | null;
    totalEnergy: SavedKpiMetric | null;
    specificYield: SavedKpiMetric | null;
  };
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
let lastSnapshotStatus: SnapshotSaveStatus | undefined;
let snapshotError: string | undefined;
let reconciledScheduleDate: string | undefined;
let scheduleRun: Promise<void> | undefined;
const failedSnapshotQueue: Array<{ buffer: SnapshotBuffer; scheduledFor: Date }> = [];

function parseCoordinate(value: unknown, min: number, max: number) {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(numeric) && numeric >= min && numeric <= max ? numeric : undefined;
}

function parseSiteName(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

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

function numericParameterValue(parameter: Record<string, unknown>) {
  const value = typeof parameter.data === "number" ? parameter.data : typeof parameter.data === "string" ? Number(parameter.data) : NaN;
  return Number.isFinite(value) ? value : null;
}

function parameterObservationTime(parameter: Record<string, unknown>) {
  const value = parameter.date_iso_8601 ?? parameter.timestamp ?? parameter.date;
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value < 1_000_000_000_000 ? value * 1_000 : value).toISOString();
  return undefined;
}

function parameterObservationMilliseconds(parameter: Record<string, unknown>) {
  const value = parameter.date_iso_8601 ?? parameter.timestamp ?? parameter.date;
  if (typeof value === "number" && Number.isFinite(value)) return value < 1_000_000_000_000 ? value * 1_000 : value;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function latestSavedMetric(parameters: Record<string, unknown>[], names: string[]): SavedKpiMetric | null {
  const requestedNames = new Set(names.map((name) => name.toLowerCase()));
  const matching = parameters
    .filter((parameter) => requestedNames.has(String(parameter.name ?? "").trim().toLowerCase()))
    .map((parameter) => ({ parameter, value: numericParameterValue(parameter) }))
    .filter((candidate): candidate is { parameter: Record<string, unknown>; value: number } => candidate.value !== null);

  if (!matching.length) return null;
  const latest = matching.reduce((current, candidate) => parameterObservationMilliseconds(candidate.parameter) > parameterObservationMilliseconds(current.parameter) ? candidate : current);
  return {
    parameter: String(latest.parameter.name ?? "register"),
    value: latest.value,
    rawData: String(latest.parameter.raw_data ?? latest.parameter.data ?? ""),
    address: String(latest.parameter.full_addr ?? latest.parameter.addr ?? "—"),
    sourceTimestamp: parameterObservationTime(latest.parameter),
  };
}

function snapshotSaveStatus(data: unknown, messageCount: number, parameterCount: number): SnapshotSaveStatus {
  if (isRecord(data) && data.saveStatus === "missing") return "missing";
  if (isRecord(data) && data.saveStatus === "incomplete") return "incomplete";
  if (!messageCount) return "missing";
  return parameterCount ? "saved" : "incomplete";
}

function snapshotEvidence(snapshot: {
  id: number;
  topic: string;
  windowStartedAt: Date;
  windowEndedAt: Date;
  capturedAt: Date;
  messageCount: number;
  parameterCount: number;
  data: unknown;
}): SavedSnapshotEvidence {
  const data = isRecord(snapshot.data) ? snapshot.data : {};
  const parameters = Array.isArray(data.latestParameters)
    ? data.latestParameters.filter(isRecord)
    : [];
  const saveStatus = snapshotSaveStatus(data, snapshot.messageCount, snapshot.parameterCount);
  const scheduledFor = typeof data.scheduledFor === "string" ? data.scheduledFor : snapshot.windowEndedAt.toISOString();

  return {
    id: snapshot.id,
    topic: snapshot.topic,
    windowStartedAt: snapshot.windowStartedAt.toISOString(),
    windowEndedAt: snapshot.windowEndedAt.toISOString(),
    scheduledFor,
    capturedAt: snapshot.capturedAt.toISOString(),
    timezone: typeof data.timezone === "string" ? data.timezone : undefined,
    saveStatus,
    missingReason: typeof data.missingReason === "string" ? data.missingReason : undefined,
    messageCount: snapshot.messageCount,
    parameterCount: snapshot.parameterCount,
    metrics: {
      activePower: latestSavedMetric(parameters, ["actpow"]),
      dailyEnergy: latestSavedMetric(parameters, ["dailyeneregykwh"]),
      totalEnergy: latestSavedMetric(parameters, ["totalenergy"]),
      specificYield: latestSavedMetric(parameters, ["todayyield"]),
    },
  };
}

function setLastSnapshot(evidence: SavedSnapshotEvidence) {
  lastSnapshotAt = evidence.capturedAt;
  lastSnapshotScheduledFor = evidence.scheduledFor;
  lastSnapshotStatus = evidence.saveStatus;
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

function localBoundary(parts: ZonedParts, minuteOfDay: number) {
  return localDateTimeToUtc({
    ...parts,
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
    second: 0,
  }, plantTimezone);
}

function completedWindowBoundaries(now: Date) {
  const schedule = persistenceSchedule(now);
  const lastCompletedBoundary = schedule.minutes < PERSISTENCE_START_MINUTE
    ? null
    : schedule.minutes >= PERSISTENCE_END_MINUTE
      ? localBoundary(schedule.local, PERSISTENCE_END_MINUTE)
      : schedule.currentSlotStart;
  if (!lastCompletedBoundary) return { schedule, boundaries: [] as Date[] };

  const boundaries: Date[] = [];
  for (let minute = PERSISTENCE_START_MINUTE; minute <= PERSISTENCE_END_MINUTE; minute += PERSISTENCE_INTERVAL_MINUTES) {
    const boundary = localBoundary(schedule.local, minute);
    if (boundary <= lastCompletedBoundary) boundaries.push(boundary);
  }
  return { schedule, boundaries };
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

function snapshotOutcome(buffer: SnapshotBuffer) {
  if (!buffer.messages.length) {
    return {
      saveStatus: "missing" as const,
      missingReason: "No MQTT telemetry was available in this completed scheduled window.",
    };
  }
  if (!Object.keys(buffer.latestParameters).length) {
    return {
      saveStatus: "incomplete" as const,
      missingReason: "MQTT messages arrived, but none contained a valid telemetry parameter.",
    };
  }
  return { saveStatus: "saved" as const, missingReason: undefined };
}

async function persistSnapshot(buffer: SnapshotBuffer, scheduledFor: Date, savedAt = new Date()) {
  const scheduledForIso = scheduledFor.toISOString();
  try {
    const outcome = snapshotOutcome(buffer);
    const [inserted] = await db.insert(mqttSnapshotsTable).values({
      windowStartedAt: buffer.startedAt,
      windowEndedAt: scheduledFor,
      capturedAt: savedAt,
      topic: subscriptionTopic,
      messageCount: buffer.messages.length,
      parameterCount: Object.keys(buffer.latestParameters).length,
      data: {
        schemaVersion: 3,
        recordType: "scheduled-telemetry-snapshot",
        saveStatus: outcome.saveStatus,
        missingReason: outcome.missingReason,
        scheduledFor: scheduledForIso,
        capturedAt: savedAt.toISOString(),
        timezone: plantTimezone,
        messages: buffer.messages,
        latestParameters: Object.values(buffer.latestParameters),
      },
    }).onConflictDoNothing({
      target: [mqttSnapshotsTable.topic, mqttSnapshotsTable.windowEndedAt],
      where: sql`(${mqttSnapshotsTable.data} ->> 'schemaVersion') = '3'`,
    }).returning();

    if (!inserted) {
      const existingCandidates = await db
        .select()
        .from(mqttSnapshotsTable)
        .where(and(eq(mqttSnapshotsTable.topic, subscriptionTopic), eq(mqttSnapshotsTable.windowEndedAt, scheduledFor)))
        .limit(10);
      const existing = existingCandidates.find((candidate) => isRecord(candidate.data) && candidate.data.schemaVersion === 3);
      if (existing) {
        const evidence = snapshotEvidence(existing);
        setLastSnapshot(evidence);
        broadcast("snapshot", evidence);
        broadcast("status", status());
      }
      return true;
    }

    const evidence = snapshotEvidence(inserted);
    setLastSnapshot(evidence);
    snapshotError = undefined;
    broadcast("snapshot", evidence);
    broadcast("status", status());
    logger.info({ scheduledFor: scheduledForIso, saveStatus: outcome.saveStatus, messageCount: buffer.messages.length, parameterCount: Object.keys(buffer.latestParameters).length }, "MQTT snapshot stored");
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

async function latestSavedSnapshotEvidence() {
  const snapshots = await db
    .select()
    .from(mqttSnapshotsTable)
    .where(eq(mqttSnapshotsTable.topic, subscriptionTopic))
    .orderBy(desc(mqttSnapshotsTable.windowEndedAt), desc(mqttSnapshotsTable.capturedAt))
    .limit(96);
  const snapshot = snapshots.find((candidate) => isRecord(candidate.data) && candidate.data.schemaVersion === 3 && snapshotSaveStatus(candidate.data, candidate.messageCount, candidate.parameterCount) === "saved");
  return snapshot ? snapshotEvidence(snapshot) : null;
}

async function reconcileCompletedWindows(now = new Date()) {
  const { schedule, boundaries } = completedWindowBoundaries(now);
  if (reconciledScheduleDate === schedule.localDate) return;

  for (const boundary of boundaries) {
    const windowStartedAt = new Date(boundary.getTime() - PERSISTENCE_INTERVAL_MINUTES * 60_000);
    const saved = await persistSnapshot(emptySnapshotBuffer(windowStartedAt, slotKey(zonedParts(windowStartedAt, plantTimezone))), boundary, now);
    if (!saved) return;
  }
  reconciledScheduleDate = schedule.localDate;
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
  await reconcileCompletedWindows(now);
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

router.get("/mqtt/snapshots/latest", async (req, res): Promise<void> => {
  try {
    const snapshot = await latestSavedSnapshotEvidence();
    res.set("Cache-Control", "no-store").json({ snapshot });
  } catch (error) {
    req.log.error({ err: error }, "Latest MQTT snapshot query failed");
    res.status(500).json({ message: "Unable to load the latest saved MQTT snapshot." });
  }
});

router.get("/mqtt/site-locations", async (_req, res) => {
  try {
    const locations = await db
      .select()
      .from(plantLocationsTable)
      .orderBy(asc(plantLocationsTable.siteName));
    res.set("Cache-Control", "no-store").json({ locations });
  } catch (error) {
    logger.error({ err: error }, "Plant locations query failed");
    res.status(500).json({ message: "Unable to load saved plant locations" });
  }
});

router.put("/mqtt/site-locations/:siteName", async (req, res): Promise<void> => {
  const siteName = parseSiteName(req.params.siteName);
  const latitude = parseCoordinate(req.body?.latitude, -90, 90);
  const longitude = parseCoordinate(req.body?.longitude, -180, 180);
  if (!siteName || siteName.length > 160 || latitude === undefined || longitude === undefined) {
    res.status(400).json({ message: "Site name, latitude (-90 to 90), and longitude (-180 to 180) are required." });
    return;
  }
  if (!req.isAuthenticated()) {
    res.status(401).json({ message: "Operator sign-in is required to update plant locations." });
    return;
  }
  if (!canUpdatePlantLocation(req.user, siteName)) {
    res.status(403).json({ message: "Your operator account is not authorized to update this plant location." });
    return;
  }

  try {
    const [location] = await db
      .insert(plantLocationsTable)
      .values({ siteName, latitude, longitude })
      .onConflictDoUpdate({
        target: plantLocationsTable.siteName,
        set: { latitude, longitude, updatedAt: new Date() },
      })
      .returning();
    res.json({ location });
  } catch (error) {
    logger.error({ err: error, siteName }, "Plant location save failed");
    res.status(500).json({ message: "Unable to save the plant location" });
  }
});

function parseRangeBoundary(value: unknown, boundary: "start" | "end") {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  if (boundary === "end") parsed.setMilliseconds(999);
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
  if (rangeStart > rangeEnd) {
    res.status(400).json({ message: "The history start must be before the end." });
    return;
  }
  if (rangeEnd.getTime() - rangeStart.getTime() > 31 * 24 * 60 * 60 * 1000) {
    res.status(400).json({ message: "Choose a history range of 31 days or less." });
    return;
  }

  try {
    const snapshots = await db
      .select()
      .from(mqttSnapshotsTable)
      .where(and(gte(mqttSnapshotsTable.windowEndedAt, rangeStart), lte(mqttSnapshotsTable.windowStartedAt, rangeEnd)))
      .orderBy(asc(mqttSnapshotsTable.windowEndedAt))
      .limit(500);

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
        if (Number.isNaN(receivedTime.getTime()) || receivedTime < rangeStart || receivedTime > rangeEnd) continue;
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
      snapshotCount: snapshots.length,
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
  void latestSavedSnapshotEvidence()
    .then((snapshot) => {
      if (snapshot && listeners.has(res) && !res.writableEnded) send(res, "snapshot", snapshot);
    })
    .catch((error) => logger.warn({ err: error }, "Latest MQTT snapshot stream hydration failed"));
  for (const message of messageHistory) send(res, "message", { ...message, replay: true });

  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    listeners.delete(res);
    res.end();
  });
});

export default router;