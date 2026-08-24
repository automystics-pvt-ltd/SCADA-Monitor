import { Router, type IRouter, type Response } from "express";
import { and, asc, desc, eq, gt, gte, lt, lte, or, sql } from "drizzle-orm";
import mqtt, { type MqttClient } from "mqtt";
import {
  db,
  mqttCommunicationEventsTable,
  mqttConsumerLeasesTable,
  mqttDeliverySequencesTable,
  mqttInverterEnergyHistoryTable,
  mqttSnapshotsTable,
  plantLocationsTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { canUpdatePlantLocation } from "../middlewares/plantLocationAuthorization";
import { deviceCommunicationState, heartbeatWindows, medianCadenceMs, recoveryNeedsResync, retainValidSourceTimestamp, sourceTimestampIso, sourceTimestampMilliseconds, telemetryParameterFromRawPayload } from "../lib/telemetry-reliability";
import { inverterEnergyObservationFromParameter } from "../lib/inverter-energy";

const router: IRouter = Router();
const brokerUrl = process.env.MQTT_BROKER_URL ?? "mqtt://76.13.4.214";
const subscriptionTopic = process.env.MQTT_TOPIC ?? "trn246/modbus";
const mqttInstanceIdentity = process.env.MQTT_CLIENT_INSTANCE_ID ?? process.env.HOSTNAME ?? `pid-${process.pid}`;
const mqttClientId = process.env.MQTT_CLIENT_ID
  ?? `scada-${Buffer.from(subscriptionTopic).toString("hex").slice(0, 8)}-${Buffer.from(mqttInstanceIdentity).toString("hex").slice(0, 10)}`;
const mqttLeaseOwnerId = `lease-${Buffer.from(mqttInstanceIdentity).toString("hex").slice(0, 16)}-${process.pid}`;
const username = process.env.MQTT_USERNAME;
const password = process.env.MQTT_PASSWORD;
const listeners = new Map<Response, {
  pending: string[];
  deferredMessages: Array<{ event: string; data: unknown; eventId: number }>;
  paused: boolean;
  backpressured: boolean;
  flushing: boolean;
}>();
const SNAPSHOT_INTERVAL_MS = 15_000;
const PERSISTENCE_INTERVAL_MINUTES = 15;
const PERSISTENCE_START_MINUTE = 6 * 60;
const PERSISTENCE_END_MINUTE = 18 * 60;
const DEFAULT_PLANT_TIMEZONE = "Asia/Kolkata";
const configuredTimezone = process.env.MQTT_PLANT_TIMEZONE ?? process.env.PLANT_TIMEZONE ?? DEFAULT_PLANT_TIMEZONE;
const configuredMqttPlantSite = process.env.MQTT_PLANT_SITE?.trim() || subscriptionTopic;

type StoredMessage = { topic: string; payload: string; receivedAt: string; sequence: number; sourceTimestamp?: string };
type CommunicationState = "live" | "stale" | "interrupted" | "awaiting-first-data";
type DeliveryGap = {
  detectedAt: string;
  reason: string;
  startSequence?: number;
  endSequence?: number;
  source: "sse" | "persistence";
};
type CommunicationEventDraft = {
  eventType: string;
  topic: string;
  deliverySequence?: number;
  rawPayload?: string;
  sourceTimestamp?: string;
  receivedAt: Date;
  startedAt?: Date;
  endedAt?: Date;
  durationMs?: number;
  reason?: string;
  metadata?: Record<string, unknown>;
};
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
  parameters: Record<string, unknown>[];
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
const COMMUNICATION_PERSISTENCE_QUEUE_LIMIT = 1000;
const SSE_PENDING_FRAME_LIMIT = 250;
let deliverySequenceInitialization: Promise<void> | undefined;
let inboundMessageChain: Promise<void> = Promise.resolve();
let consumerLeaseHeld = false;
let subscriptionState: "idle" | "pending" | "active" | "failed" = "idle";
let consumerLeaseTimer: NodeJS.Timeout | undefined;
const MQTT_CONSUMER_LEASE_MS = 45_000;
const MQTT_CONSUMER_LEASE_RENEWAL_MS = 15_000;
let communicationPersistenceQueue: CommunicationEventDraft[] = [];
let communicationPersistenceRunning = false;
let communicationPersistenceRetryTimer: NodeJS.Timeout | undefined;
let communicationPersistenceError: string | undefined;
let receivedMessageCount = 0;
let lastTelemetryReceivedAtMs: number | undefined;
let lastTelemetrySourceTimestampMs: number | undefined;
let lastTelemetrySequence: number | undefined;
let observedIntervalsMs: number[] = [];
let previousCommunicationState: CommunicationState = "awaiting-first-data";
let activeInterruption: {
  startedAt: string;
  reason: string;
  lastSequence?: number;
} | undefined;
let lastInterruption: {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  reason: string;
  startSequence?: number;
  endSequence?: number;
} | undefined;
let confirmedDeliveryGap: DeliveryGap | undefined;
let communicationTimer: NodeJS.Timeout | undefined;
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

function initializeDeliverySequence() {
  if (!deliverySequenceInitialization) {
    deliverySequenceInitialization = (async () => {
      const [latest] = await db.select({
        latestSequence: sql<number | null>`max(${mqttCommunicationEventsTable.deliverySequence})`,
      }).from(mqttCommunicationEventsTable).where(eq(mqttCommunicationEventsTable.topic, subscriptionTopic));
      await db.insert(mqttDeliverySequencesTable).values({
        topic: subscriptionTopic,
        nextSequence: Number(latest?.latestSequence ?? 0),
      }).onConflictDoNothing();
    })().catch((error) => {
      deliverySequenceInitialization = undefined;
      throw error;
    });
  }
  return deliverySequenceInitialization;
}

async function allocateDeliverySequence() {
  await initializeDeliverySequence();
  const [allocated] = await db.insert(mqttDeliverySequencesTable)
    .values({ topic: subscriptionTopic, nextSequence: 1 })
    .onConflictDoUpdate({
      target: mqttDeliverySequencesTable.topic,
      set: {
        nextSequence: sql`${mqttDeliverySequencesTable.nextSequence} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning({ sequence: mqttDeliverySequencesTable.nextSequence });
  if (!allocated) throw new Error("Unable to allocate an MQTT delivery sequence.");
  return allocated.sequence;
}

async function deliveryHighWater() {
  const [event] = await db.select({
    sequence: sql<number | null>`max(${mqttCommunicationEventsTable.deliverySequence})`,
  })
    .from(mqttCommunicationEventsTable)
    .where(and(
      eq(mqttCommunicationEventsTable.topic, subscriptionTopic),
      eq(mqttCommunicationEventsTable.eventType, "telemetry"),
    ));
  return event?.sequence ?? undefined;
}

function parseDeliverySequence(value: unknown) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) ? sequence : undefined;
}

function frame(event: string, data: unknown, eventId?: number) {
  return `${eventId === undefined ? "" : `id: ${eventId}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function enqueueFrame(state: { pending: string[] }, event: string, data: unknown, eventId?: number) {
  state.pending.push(frame(event, data, eventId));
}

function enqueueReplayFrame(res: Response, state: {
  pending: string[];
  deferredMessages: unknown[];
  paused: boolean;
  backpressured: boolean;
  flushing: boolean;
}, event: string, data: unknown, eventId?: number) {
  if (state.pending.length + state.deferredMessages.length >= SSE_PENDING_FRAME_LIMIT) {
    noteDeliveryGap({
      detectedAt: new Date().toISOString(),
      reason: "SSE replay exceeded the bounded client recovery buffer.",
      endSequence: eventId,
      source: "sse",
    });
    listeners.delete(res);
    res.end();
    return false;
  }
  enqueueFrame(state, event, data, eventId);
  flushListener(res, state);
  return true;
}

function flushListener(res: Response, state: { pending: string[]; paused: boolean; backpressured: boolean; flushing: boolean }) {
  if (state.backpressured || state.flushing || res.writableEnded || res.destroyed) return;
  state.flushing = true;
  try {
    while (state.pending.length && !res.writableEnded && !res.destroyed) {
      const nextFrame = state.pending.shift();
      if (!nextFrame) break;
      if (!res.write(nextFrame)) {
        state.backpressured = true;
        res.once("drain", () => {
          state.backpressured = false;
          flushListener(res, state);
        });
        break;
      }
    }
  } catch {
    listeners.delete(res);
  } finally {
    state.flushing = false;
  }
}

function send(res: Response, event: string, data: unknown, eventId?: number) {
  const state = listeners.get(res);
  if (!state) {
    if (!res.writableEnded && !res.destroyed) res.write(frame(event, data, eventId));
    return;
  }
  if (state.pending.length + state.deferredMessages.length >= SSE_PENDING_FRAME_LIMIT) {
    const firstPending = state.pending[0];
    const droppedSequence = firstPending
      ? firstPending.match(/^id: (\d+)/)?.[1]
      : state.deferredMessages[0]?.eventId?.toString();
    noteDeliveryGap({
      detectedAt: new Date().toISOString(),
      reason: "SSE listener backpressure exceeded the bounded recovery buffer.",
      startSequence: parseDeliverySequence(droppedSequence),
      endSequence: eventId,
      source: "sse",
    });
    listeners.delete(res);
    res.end();
    return;
  }
  if (state.paused && event === "message" && eventId !== undefined) {
    state.deferredMessages.push({ event, data, eventId });
    return;
  }
  enqueueFrame(state, event, data, eventId);
  flushListener(res, state);
}

function broadcast(event: string, data: unknown, eventId?: number) {
  for (const listener of listeners.keys()) send(listener, event, data, eventId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function enqueueCommunicationEvent(event: CommunicationEventDraft) {
  if (communicationPersistenceQueue.length >= COMMUNICATION_PERSISTENCE_QUEUE_LIMIT) {
    const dropped = communicationPersistenceQueue.shift();
    confirmedDeliveryGap = {
      detectedAt: new Date().toISOString(),
      reason: "Communication-event persistence backlog exceeded the bounded queue.",
      startSequence: dropped?.deliverySequence,
      endSequence: event.deliverySequence,
      source: "persistence",
    };
    communicationPersistenceError = confirmedDeliveryGap.reason;
  }
  communicationPersistenceQueue.push(event);
  void drainCommunicationEventQueue();
}

function noteDeliveryGap(gap: DeliveryGap) {
  confirmedDeliveryGap = gap;
  enqueueCommunicationEvent({
    eventType: "delivery-gap",
    topic: subscriptionTopic,
    receivedAt: new Date(gap.detectedAt),
    reason: gap.reason,
    metadata: {
      source: gap.source,
      startSequence: gap.startSequence,
      endSequence: gap.endSequence,
    },
  });
}

async function drainCommunicationEventQueue() {
  if (communicationPersistenceRunning) return;
  communicationPersistenceRunning = true;
  try {
    while (communicationPersistenceQueue.length) {
      const event = communicationPersistenceQueue[0];
      if (!event) break;
      try {
        await db.insert(mqttCommunicationEventsTable).values({
          deliverySequence: event.deliverySequence,
          topic: event.topic,
          eventType: event.eventType,
          rawPayload: event.rawPayload,
          sourceTimestamp: event.sourceTimestamp,
          receivedAt: event.receivedAt,
          startedAt: event.startedAt,
          endedAt: event.endedAt,
          durationMs: event.durationMs,
          reason: event.reason,
          metadata: event.metadata ?? {},
        });
        communicationPersistenceQueue.shift();
        communicationPersistenceError = undefined;
      } catch (error) {
        communicationPersistenceError = error instanceof Error ? error.message : "Communication event persistence failed";
        logger.error({ err: error, eventType: event.eventType }, "MQTT communication event persistence failed");
        if (!communicationPersistenceRetryTimer) {
          communicationPersistenceRetryTimer = setTimeout(() => {
            communicationPersistenceRetryTimer = undefined;
            void drainCommunicationEventQueue();
          }, 5_000);
        }
        break;
      }
    }
  } finally {
    communicationPersistenceRunning = false;
  }
}

function recordCommunicationEvent(event: CommunicationEventDraft) {
  enqueueCommunicationEvent(event);
}

function parameterFromPayload(rawPayload: string): Record<string, unknown> | undefined {
  return telemetryParameterFromRawPayload(rawPayload);
}

function sourceTimestampFromPayload(rawPayload: string) {
  const parameter = parameterFromPayload(rawPayload);
  return parameter ? parameterObservationTime(parameter) : undefined;
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
  return sourceTimestampIso(value);
}

function parameterObservationMilliseconds(parameter: Record<string, unknown>) {
  const value = parameter.date_iso_8601 ?? parameter.timestamp ?? parameter.date;
  return sourceTimestampMilliseconds(value) ?? 0;
}

function observedCadenceMs() {
  return medianCadenceMs(observedIntervalsMs);
}

function heartbeatThresholds() {
  const cadenceMs = observedCadenceMs();
  const { staleAfterMs, interruptedAfterMs } = heartbeatWindows(cadenceMs);
  return {
    cadenceMs,
    staleAfterMs,
    interruptedAfterMs,
  };
}

function communicationStateAt(nowMs = Date.now()) {
  const { cadenceMs, staleAfterMs, interruptedAfterMs } = heartbeatThresholds();
  const heartbeat = deviceCommunicationState(lastTelemetryReceivedAtMs, nowMs, cadenceMs);
  const deviceCommunication: CommunicationState = heartbeat.state;
  const freshnessAgeMs = heartbeat.freshnessAgeMs;
  return { deviceCommunication, freshnessAgeMs, cadenceMs, staleAfterMs, interruptedAfterMs };
}

function refreshCommunicationHealth(nowMs = Date.now()) {
  const health = communicationStateAt(nowMs);
  const previous = previousCommunicationState;
  if (health.deviceCommunication !== previous) {
    if ((health.deviceCommunication === "stale" || health.deviceCommunication === "interrupted")
      && (previous === "live" || previous === "awaiting-first-data")
      && lastTelemetryReceivedAtMs !== undefined) {
      const startedAt = new Date(lastTelemetryReceivedAtMs + health.staleAfterMs).toISOString();
      activeInterruption = {
        startedAt,
        reason: "No telemetry arrived within the observed heartbeat cadence.",
        lastSequence: lastTelemetrySequence,
      };
      recordCommunicationEvent({
        eventType: "communication-interruption",
        topic: subscriptionTopic,
        receivedAt: new Date(nowMs),
        startedAt: new Date(startedAt),
        reason: activeInterruption.reason,
        metadata: {
          state: health.deviceCommunication,
          staleAfterMs: health.staleAfterMs,
          interruptedAfterMs: health.interruptedAfterMs,
          lastSequence: lastTelemetrySequence,
        },
      });
    }
    if (health.deviceCommunication === "live" && activeInterruption) {
      const endedAt = new Date(nowMs).toISOString();
      const startedAtMs = new Date(activeInterruption.startedAt).getTime();
      lastInterruption = {
        startedAt: activeInterruption.startedAt,
        endedAt,
        durationMs: Math.max(0, nowMs - startedAtMs),
        reason: activeInterruption.reason,
        startSequence: activeInterruption.lastSequence,
        endSequence: lastTelemetrySequence,
      };
      recordCommunicationEvent({
        eventType: "communication-recovery",
        topic: subscriptionTopic,
        deliverySequence: lastTelemetrySequence,
        receivedAt: new Date(nowMs),
        startedAt: new Date(lastInterruption.startedAt),
        endedAt: new Date(lastInterruption.endedAt),
        durationMs: lastInterruption.durationMs,
        reason: "Telemetry resumed after an observed communication interruption.",
        metadata: {
          priorReason: lastInterruption.reason,
          startSequence: lastInterruption.startSequence,
          endSequence: lastInterruption.endSequence,
        },
      });
      activeInterruption = undefined;
    }
    previousCommunicationState = health.deviceCommunication;
  }
  return health;
}

function recordTelemetryHeartbeat(message: StoredMessage) {
  const receivedAtMs = new Date(message.receivedAt).getTime();
  if (Number.isFinite(receivedAtMs)) {
    if (lastTelemetryReceivedAtMs !== undefined) {
      const intervalMs = receivedAtMs - lastTelemetryReceivedAtMs;
      // A Modbus sample often arrives as a burst of register messages. Those
      // sub-quarter-second gaps are part of one observation, not the device
      // heartbeat cadence operators need to judge communication health.
      if (intervalMs >= 250 && intervalMs <= 60 * 60 * 1000) {
        observedIntervalsMs.push(intervalMs);
        if (observedIntervalsMs.length > 30) observedIntervalsMs.shift();
      }
    }
    lastTelemetryReceivedAtMs = receivedAtMs;
  }
  lastTelemetrySequence = message.sequence;
  receivedMessageCount += 1;
  refreshCommunicationHealth(receivedAtMs);
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
    // Preserve the exact scheduled-window parameter evidence alongside the
    // legacy raw KPI hints. Clients calculate engineering KPIs from this
    // immutable evidence only when source scaling, unit, and semantics agree.
    parameters,
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

function startCommunicationTimer() {
  if (communicationTimer) return;
  communicationTimer = setInterval(() => {
    refreshCommunicationHealth();
    broadcast("status", status());
  }, 5_000);
}

function stopClientForLeaseLoss() {
  const activeClient = client;
  client = undefined;
  connected = false;
  subscriptionState = "idle";
  activeClient?.end(true);
}

async function renewConsumerLease() {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + MQTT_CONSUMER_LEASE_MS);
  try {
    const [lease] = await db.insert(mqttConsumerLeasesTable)
      .values({ topic: subscriptionTopic, ownerId: mqttLeaseOwnerId, expiresAt, updatedAt: now })
      .onConflictDoUpdate({
        target: mqttConsumerLeasesTable.topic,
        set: { ownerId: mqttLeaseOwnerId, expiresAt, updatedAt: now },
        where: or(
          lt(mqttConsumerLeasesTable.expiresAt, now),
          eq(mqttConsumerLeasesTable.ownerId, mqttLeaseOwnerId),
        ),
      })
      .returning({ ownerId: mqttConsumerLeasesTable.ownerId });
    const acquired = lease?.ownerId === mqttLeaseOwnerId;
    if (!acquired && consumerLeaseHeld) {
      consumerLeaseHeld = false;
      lastError = "This API instance is in standby; another instance owns the MQTT consumer lease.";
      stopClientForLeaseLoss();
      broadcast("status", status());
    } else if (acquired && !consumerLeaseHeld) {
      consumerLeaseHeld = true;
      lastError = undefined;
      startClient();
      broadcast("status", status());
    }
  } catch (error) {
    if (consumerLeaseHeld) {
      consumerLeaseHeld = false;
      lastError = "MQTT consumer lease could not be renewed; delivery is paused until ownership is verified.";
      stopClientForLeaseLoss();
      broadcast("resync", {
        state: "resync-required",
        reason: "MQTT consumer ownership could not be verified against the durable ledger.",
      });
      broadcast("status", status());
    }
    logger.warn({ err: error }, "MQTT consumer lease renewal failed");
  }
}

function requestMqttConsumer() {
  startSnapshotTimer();
  startCommunicationTimer();
  void renewConsumerLease();
  if (!consumerLeaseTimer) {
    consumerLeaseTimer = setInterval(() => void renewConsumerLease(), MQTT_CONSUMER_LEASE_RENEWAL_MS);
  }
}

function status() {
  const schedule = persistenceSchedule(new Date());
  const communication = refreshCommunicationHealth();
  return {
    connected: connected && subscriptionState === "active" && consumerLeaseHeld,
    brokerUrl,
    topic: subscriptionTopic,
    error: lastError,
    communication: {
      brokerTransport: consumerLeaseHeld
        ? subscriptionState === "active"
          ? "subscribed"
          : connected
            ? "connected"
            : "disconnected"
        : "standby",
      subscriptionState,
      deviceCommunication: communication.deviceCommunication,
      lastReceivedAt: lastTelemetryReceivedAtMs === undefined ? undefined : new Date(lastTelemetryReceivedAtMs).toISOString(),
      lastSourceTimestamp: lastTelemetrySourceTimestampMs === undefined ? undefined : new Date(lastTelemetrySourceTimestampMs).toISOString(),
      sourceAgeMs: lastTelemetrySourceTimestampMs === undefined ? undefined : Math.max(0, Date.now() - lastTelemetrySourceTimestampMs),
      dataFrequencySeconds: communication.cadenceMs === undefined ? undefined : Number((communication.cadenceMs / 1_000).toFixed(2)),
      freshnessAgeMs: communication.freshnessAgeMs,
      staleAfterMs: communication.staleAfterMs,
      interruptedAfterMs: communication.interruptedAfterMs,
      receivedMessageCount,
      lastReceivedSequence: lastTelemetrySequence,
      confirmedDeliveryGap,
      activeInterruption,
      lastInterruption,
      persistenceBacklog: communicationPersistenceQueue.length,
      persistenceError: communicationPersistenceError,
      consumerOwnership: consumerLeaseHeld ? "active" : "standby",
      replayWindow: {
        oldestSequence: messageHistory[0]?.sequence,
        newestSequence: messageHistory.at(-1)?.sequence,
        capacity: MESSAGE_HISTORY_LIMIT,
      },
    },
    persistence: {
      intervalMinutes: PERSISTENCE_INTERVAL_MINUTES,
      scheduleStart: "06:00",
      scheduleEnd: "18:00",
      timezone: plantTimezone,
      inverterEnergySite: configuredMqttPlantSite,
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
  if (!consumerLeaseHeld || client) return;

  const mqttClient = mqtt.connect(brokerUrl, {
    clientId: mqttClientId,
    username,
    password,
    protocolVersion: 4,
    reconnectPeriod: 5_000,
    connectTimeout: 30_000,
    keepalive: 30,
    clean: false,
    resubscribe: true,
  });
  client = mqttClient;

  mqttClient.on("connect", () => {
    if (client !== mqttClient || !consumerLeaseHeld) return;
    connected = true;
    subscriptionState = "pending";
    lastError = undefined;
    logger.info({ brokerUrl, subscriptionTopic }, "MQTT broker connected");
    recordCommunicationEvent({
      eventType: "broker-connected",
      topic: subscriptionTopic,
      receivedAt: new Date(),
      metadata: {
        protocolVersion: 4,
        cleanSession: false,
        sessionIdentity: process.env.MQTT_CLIENT_ID ? "operator-configured" : "instance-bound",
      },
    });
    broadcast("status", status());
    mqttClient.subscribe(subscriptionTopic, { qos: 1 }, (error) => {
      if (client !== mqttClient || !consumerLeaseHeld) return;
      if (error) {
        subscriptionState = "failed";
        lastError = `Subscription failed: ${error.message}`;
        recordCommunicationEvent({
          eventType: "subscription-failed",
          topic: subscriptionTopic,
          receivedAt: new Date(),
          reason: error.message,
        });
        logger.error({ err: error, subscriptionTopic }, "MQTT subscription failed");
        broadcast("status", status());
        return;
      }
      subscriptionState = "active";
      recordCommunicationEvent({
        eventType: "subscription-confirmed",
        topic: subscriptionTopic,
        receivedAt: new Date(),
        metadata: { qos: 1 },
      });
      logger.info({ subscriptionTopic }, "MQTT topic subscription confirmed");
      broadcast("status", status());
    });
  });

  mqttClient.on("reconnect", () => {
    if (client !== mqttClient || !consumerLeaseHeld) return;
    connected = false;
    subscriptionState = "idle";
    recordCommunicationEvent({
      eventType: "broker-reconnecting",
      topic: subscriptionTopic,
      receivedAt: new Date(),
      reason: "MQTT client requested broker reconnection.",
    });
    broadcast("status", status());
  });

  mqttClient.on("close", () => {
    if (client !== mqttClient || !consumerLeaseHeld) return;
    connected = false;
    subscriptionState = "idle";
    recordCommunicationEvent({
      eventType: "broker-closed",
      topic: subscriptionTopic,
      receivedAt: new Date(),
      reason: "MQTT broker transport closed.",
    });
    broadcast("status", status());
  });

  mqttClient.on("error", (error) => {
    if (client !== mqttClient || !consumerLeaseHeld) return;
    connected = false;
    subscriptionState = "idle";
    lastError = error.message;
    recordCommunicationEvent({
      eventType: "broker-error",
      topic: subscriptionTopic,
      receivedAt: new Date(),
      reason: error.message,
    });
    logger.warn({ err: error }, "MQTT client error");
    broadcast("status", status());
    if (error.message === "connack timeout") {
      client = undefined;
      mqttClient.end(true);
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          requestMqttConsumer();
        }, 5_000);
      }
    }
  });

  mqttClient.on("message", (topic, payload) => {
    if (client !== mqttClient || !consumerLeaseHeld || subscriptionState !== "active") return;
    const payloadCopy = Buffer.from(payload);
    inboundMessageChain = inboundMessageChain.then(async () => {
      await captureMqttMessage(topic, payloadCopy);
    }).catch((error) => {
      lastError = "Telemetry delivery could not be durably sequenced; a resync is required when the ledger recovers.";
      confirmedDeliveryGap = {
        detectedAt: new Date().toISOString(),
        reason: lastError,
        source: "persistence",
      };
      broadcast("resync", {
        state: "resync-required",
        reason: lastError,
      });
      broadcast("status", status());
      logger.error({ err: error, topic }, "Unable to capture MQTT telemetry delivery");
    });
  });
}

async function captureMqttMessage(topic: string, payload: Buffer) {
  const rawPayload = payload.toString("utf8");
  const parameter = parameterFromPayload(rawPayload);
  const receivedAt = new Date().toISOString();
  const message: StoredMessage = {
    topic,
    payload: rawPayload,
    receivedAt,
    sequence: await allocateDeliverySequence(),
    sourceTimestamp: parameter ? parameterObservationTime(parameter) : undefined,
  };
  latestMessage = message;
  lastTelemetrySourceTimestampMs = retainValidSourceTimestamp(lastTelemetrySourceTimestampMs, parameter);

  // The live screen is an operational path. Sequence reservation is the only
  // durable coordination it waits for; archival writes run independently so a
  // slow history database never holds back the original MQTT payload.
  recordCommunicationEvent({
    eventType: "telemetry",
    topic,
    deliverySequence: message.sequence,
    rawPayload,
    sourceTimestamp: message.sourceTimestamp,
    receivedAt: new Date(receivedAt),
    metadata: { qos: 1, preservedRawPayload: true, delivery: "immediate" },
  });
  recordTelemetryHeartbeat(message);
  queueSnapshotMessage(message);
  requestSnapshotScheduleRun();
  messageHistory.push(message);
  if (messageHistory.length > MESSAGE_HISTORY_LIMIT) messageHistory.splice(0, messageHistory.length - MESSAGE_HISTORY_LIMIT);
  broadcast("message", message, message.sequence);
  broadcast("status", status());

  const energy = parameter ? inverterEnergyObservationFromParameter(parameter, configuredMqttPlantSite) : undefined;
  if (energy) {
    void db.insert(mqttInverterEnergyHistoryTable).values({
        topic,
        siteName: energy.siteName,
        inverterId: energy.inverterId,
        inverterName: energy.inverterName,
        parameter: energy.parameter,
        value: energy.value,
        rawValue: energy.rawValue,
        unit: energy.unit,
        address: energy.address,
        sourceName: energy.sourceName,
        observedAt: new Date(energy.observedAt),
        receivedAt: new Date(receivedAt),
        scalingStatus: energy.scalingStatus,
        sourcePayload: rawPayload,
        metadata: energy.metadata,
      }).onConflictDoNothing({
        target: [
          mqttInverterEnergyHistoryTable.siteName,
          mqttInverterEnergyHistoryTable.topic,
          mqttInverterEnergyHistoryTable.inverterId,
          mqttInverterEnergyHistoryTable.parameter,
          mqttInverterEnergyHistoryTable.address,
          mqttInverterEnergyHistoryTable.observedAt,
        ],
      }).catch((error) => {
        logger.error({ err: error, sequence: message.sequence }, "MQTT inverter-energy archive write failed after live delivery");
      });
  }
}

router.get("/mqtt/status", (_req, res) => {
  requestMqttConsumer();
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

type EnergyHistoryPeriod = "Day" | "Week" | "Month" | "Year";

function energyHistoryPeriod(value: unknown): EnergyHistoryPeriod | undefined {
  return value === "Day" || value === "Week" || value === "Month" || value === "Year" ? value : undefined;
}

function parseCalendarDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  const test = new Date(Date.UTC(year, month - 1, day));
  return test.getUTCFullYear() === year && test.getUTCMonth() === month - 1 && test.getUTCDate() === day ? { year, month, day } : undefined;
}

function shiftCalendarDate(parts: { year: number; month: number; day: number }, period: EnergyHistoryPeriod) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (period === "Day") date.setUTCDate(date.getUTCDate() + 1);
  if (period === "Week") date.setUTCDate(date.getUTCDate() + 7);
  if (period === "Month") date.setUTCMonth(date.getUTCMonth() + 1);
  if (period === "Year") date.setUTCFullYear(date.getUTCFullYear() + 1);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function energyHistoryRange(period: EnergyHistoryPeriod, anchor: { year: number; month: number; day: number }) {
  const start = { ...anchor };
  if (period === "Week") {
    const weekday = new Date(Date.UTC(start.year, start.month - 1, start.day)).getUTCDay();
    const mondayOffset = (weekday + 6) % 7;
    const monday = new Date(Date.UTC(start.year, start.month - 1, start.day - mondayOffset));
    start.year = monday.getUTCFullYear();
    start.month = monday.getUTCMonth() + 1;
    start.day = monday.getUTCDate();
  }
  if (period === "Month") start.day = 1;
  if (period === "Year") {
    start.month = 1;
    start.day = 1;
  }
  const next = shiftCalendarDate(start, period);
  const rangeStart = localDateTimeToUtc({ ...start, hour: 0, minute: 0, second: 0 }, plantTimezone);
  const rangeEnd = new Date(localDateTimeToUtc({ ...next, hour: 0, minute: 0, second: 0 }, plantTimezone).getTime() - 1);
  return { rangeStart, rangeEnd };
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

router.get("/mqtt/inverter-energy-history", async (req, res): Promise<void> => {
  const siteName = parseSiteName(req.query.siteName);
  const inverterId = typeof req.query.inverterId === "string" ? req.query.inverterId.trim() : "";
  const period = energyHistoryPeriod(req.query.period);
  const anchor = parseCalendarDate(req.query.anchor);
  if (!siteName || siteName.length > 160 || !inverterId || inverterId.length > 160) {
    res.status(400).json({ message: "A plant/site and inverter identifier are required." });
    return;
  }
  if (!period || !anchor) {
    res.status(400).json({ message: "Use a Day, Week, Month, or Year period and a valid plant-calendar anchor date." });
    return;
  }

  const { rangeStart, rangeEnd } = energyHistoryRange(period, anchor);
  const samplingInterval = period === "Day" ? "1 minute" : period === "Week" ? "15 minutes" : period === "Month" ? "1 hour" : "1 day";
  const bucket = sql`date_bin(${sql.raw(`interval '${samplingInterval}'`)}, ${mqttInverterEnergyHistoryTable.observedAt}, TIMESTAMPTZ '1970-01-01 00:00:00+00')`;

  try {
    const samples = await db
      .selectDistinctOn([bucket])
      .from(mqttInverterEnergyHistoryTable)
      .where(and(
        eq(mqttInverterEnergyHistoryTable.topic, subscriptionTopic),
        eq(mqttInverterEnergyHistoryTable.siteName, siteName),
        eq(mqttInverterEnergyHistoryTable.inverterId, inverterId),
        gte(mqttInverterEnergyHistoryTable.observedAt, rangeStart),
        lte(mqttInverterEnergyHistoryTable.observedAt, rangeEnd),
      ))
      .orderBy(bucket, desc(mqttInverterEnergyHistoryTable.observedAt));
    samples.sort((first, second) => first.observedAt.getTime() - second.observedAt.getTime());

    res.set("Cache-Control", "no-store").json({
      range: { from: rangeStart.toISOString(), to: rangeEnd.toISOString() },
      siteName,
      inverterId,
      period,
      timezone: plantTimezone,
      sampling: { interval: samplingInterval, method: "latest exact source observation in each interval" },
      samples: samples.map((sample) => ({
        id: sample.id,
        siteName: sample.siteName,
        siteScope: "configured-source-site",
        inverterId: sample.inverterId,
        inverterName: sample.inverterName,
        parameter: sample.parameter,
        value: sample.value,
        rawValue: sample.rawValue,
        unit: sample.unit,
        address: sample.address,
        sourceName: sample.sourceName,
        observedAt: sample.observedAt.toISOString(),
        receivedAt: sample.receivedAt.toISOString(),
        scalingStatus: sample.scalingStatus === "validated" ? "validated" : "raw",
        sourcePayload: sample.sourcePayload,
        metadata: sample.metadata,
      })),
    });
  } catch (error) {
    logger.error({ err: error, siteName, inverterId }, "Inverter energy history query failed");
    res.status(500).json({ message: "Unable to load per-inverter energy history." });
  }
});

async function replayableMessagesAfter(lastEventId: number, replayHighWater: number) {
  if (replayHighWater <= lastEventId) return [];
  const persisted = await db
    .select()
    .from(mqttCommunicationEventsTable)
    .where(and(
      eq(mqttCommunicationEventsTable.topic, subscriptionTopic),
      eq(mqttCommunicationEventsTable.eventType, "telemetry"),
      gt(mqttCommunicationEventsTable.deliverySequence, lastEventId),
      lte(mqttCommunicationEventsTable.deliverySequence, replayHighWater),
    ))
    .orderBy(asc(mqttCommunicationEventsTable.deliverySequence))
    .limit(MESSAGE_HISTORY_LIMIT);

  const recovered = new Map<number, StoredMessage>();
  for (const event of persisted) {
    if (event.deliverySequence === null || !event.rawPayload) continue;
    recovered.set(event.deliverySequence, {
      topic: event.topic,
      payload: event.rawPayload,
      receivedAt: event.receivedAt.toISOString(),
      sequence: event.deliverySequence,
      sourceTimestamp: event.sourceTimestamp ?? undefined,
    });
  }
  for (const message of messageHistory) {
    if (message.sequence > lastEventId && message.sequence <= replayHighWater) recovered.set(message.sequence, message);
  }
  return [...recovered.values()].sort((left, right) => left.sequence - right.sequence);
}

function inMemoryDeliveryHighWater() {
  return messageHistory.at(-1)?.sequence;
}

router.get("/mqtt/communication-events", async (req, res): Promise<void> => {
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 50;
  try {
    const events = await db
      .select()
      .from(mqttCommunicationEventsTable)
      .where(eq(mqttCommunicationEventsTable.topic, subscriptionTopic))
      .orderBy(desc(mqttCommunicationEventsTable.receivedAt))
      .limit(limit);
    res.set("Cache-Control", "no-store").json({ events });
  } catch (error) {
    req.log.error({ err: error }, "MQTT communication events query failed");
    res.status(500).json({ message: "Unable to load MQTT communication evidence." });
  }
});

router.get("/mqtt/stream", (req, res) => {
  requestMqttConsumer();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const listenerState = {
    pending: [] as string[],
    deferredMessages: [] as Array<{ event: string; data: unknown; eventId: number }>,
    paused: true,
    backpressured: false,
    flushing: false,
  };
  listeners.set(res, listenerState);
  send(res, "status", status());
  void latestSavedSnapshotEvidence()
    .then((snapshot) => {
      if (snapshot && listeners.has(res) && !res.writableEnded) send(res, "snapshot", snapshot);
    })
    .catch((error) => logger.warn({ err: error }, "Latest MQTT snapshot stream hydration failed"));

  const requestedAfter = parseDeliverySequence(req.get("Last-Event-ID"));
  let replayHighWater: number | undefined;
  let deliveredThrough = requestedAfter;
  let recoveryComplete = false;
  let replayVerified = true;
  let pollingLedger = false;
  void (async () => {
    try {
      await initializeDeliverySequence();
      const persistedHighWater = await deliveryHighWater();
      replayHighWater = Math.max(persistedHighWater ?? 0, inMemoryDeliveryHighWater() ?? 0);
      const highWater = replayHighWater;
      if (requestedAfter === undefined) {
        for (const message of messageHistory) {
          if (message.sequence <= highWater) {
            if (!enqueueReplayFrame(res, listenerState, "message", { ...message, replay: true, recovered: false }, message.sequence)) break;
          }
        }
      } else {
        const recovered = await replayableMessagesAfter(requestedAfter, highWater);
        if (recoveryNeedsResync(requestedAfter, highWater, recovered.map((message) => message.sequence))) {
          replayVerified = false;
          send(res, "resync", {
            state: "resync-required",
            reason: "The requested delivery range could not be proven complete from replay evidence.",
            requestedAfter,
            replayHighWater: highWater,
          });
          for (const message of messageHistory) {
            if (message.sequence <= highWater) {
              if (!enqueueReplayFrame(res, listenerState, "message", { ...message, replay: true, recovered: false }, message.sequence)) break;
            }
          }
        } else {
          for (const message of recovered) {
            if (!enqueueReplayFrame(res, listenerState, "message", { ...message, replay: false, recovered: true }, message.sequence)) break;
          }
        }
      }
    } catch (error) {
      replayVerified = false;
      logger.warn({ err: error, requestedAfter }, "MQTT stream recovery query failed");
      send(res, "resync", {
        state: "resync-required",
        reason: "Durable replay could not be verified. The stream will continue with new telemetry.",
        requestedAfter,
      });
    } finally {
      for (const message of listenerState.deferredMessages.sort((left, right) => left.eventId - right.eventId)) {
        if (!enqueueReplayFrame(res, listenerState, message.event, message.data, message.eventId)) break;
      }
      listenerState.deferredMessages.length = 0;
      listenerState.paused = false;
      flushListener(res, listenerState);
      deliveredThrough = replayVerified ? replayHighWater : requestedAfter;
      recoveryComplete = true;
    }
  })();

  const ledgerFanout = setInterval(async () => {
    if (consumerLeaseHeld || !recoveryComplete || pollingLedger || deliveredThrough === undefined || !listeners.has(res)) return;
    pollingLedger = true;
    try {
      const highWater = await deliveryHighWater();
      if (highWater === undefined || highWater <= deliveredThrough) return;
      const recovered = await replayableMessagesAfter(deliveredThrough, highWater);
      if (recoveryNeedsResync(deliveredThrough, highWater, recovered.map((message) => message.sequence))) {
        send(res, "resync", {
          state: "resync-required",
          reason: "Standby stream could not verify a complete durable telemetry range.",
          requestedAfter: deliveredThrough,
          replayHighWater: highWater,
        });
        return;
      }
      for (const message of recovered) {
        send(res, "message", { ...message, replay: false, recovered: true }, message.sequence);
      }
      deliveredThrough = highWater;
    } catch (error) {
      logger.warn({ err: error }, "Standby SSE ledger fanout failed");
    } finally {
      pollingLedger = false;
    }
  }, 1_000);

  const heartbeat = setInterval(() => {
    send(res, "heartbeat", { at: new Date().toISOString() });
  }, 20_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(ledgerFanout);
    listeners.delete(res);
    res.end();
  });
});

export default router;