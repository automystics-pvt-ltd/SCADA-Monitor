import { Router, type IRouter, type Response } from "express";
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import mqtt, { type MqttClient } from "mqtt";
import {
  db,
  mqttCommunicationEventsTable,
  mqttConsumerLeasesTable,
  mqttDeliverySequencesTable,
  mqttInverterEnergyHistoryTable,
  mqttInverterMeasurementHistoryTable,
  mqttSnapshotsTable,
  platformConfigurationTable,
  plantCalibrationProfilesTable,
  plantLocationsTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { canUpdatePlantLocation } from "../middlewares/plantLocationAuthorization";
import { allowGrantedSite, allowSiteRole, allowUnscopedScadaEvidence, grantedSiteNames, siteAccess } from "../middlewares/platformSiteAccess";
import { deviceCommunicationState, heartbeatWindows, latestBootstrapMessages, medianCadenceMs, recoveryNeedsResync, retainValidSourceTimestamp, sourceTimestampIso, sourceTimestampMilliseconds, telemetryParameterFromRawPayload } from "../lib/telemetry-reliability";
import { inverterActivePowerObservationFromParameter, inverterEnergyObservationFromParameter, inverterMeasurementObservationFromParameter, type InverterActivePowerObservation } from "../lib/inverter-energy";
import { applyTrn246TelemetryCalibration } from "../lib/trn246-telemetry-calibration";
import {
  keepReportRecord,
  reportCategoryForParameter,
  SCADA_REPORT_TYPES,
  sourceExplicitlyValidatesEngineeringValue,
  stableReportRecordId,
  type ReportFilterSet,
  type ReportProvenance,
  type ScadaReportRecord,
  type ScadaReportType,
} from "../lib/scada-reporting";
import { queryBoundedScadaReport } from "../lib/scada-report-query";

const router: IRouter = Router();
const defaultBrokerUrl = process.env.MQTT_BROKER_URL ?? "mqtt://76.13.4.214";
const defaultSubscriptionTopic = process.env.MQTT_TOPIC ?? "trn246/modbus";
const mqttInstanceIdentity = process.env.MQTT_CLIENT_INSTANCE_ID ?? process.env.HOSTNAME ?? `pid-${process.pid}`;
const configuredClientId = process.env.MQTT_CLIENT_ID;
const mqttLeaseOwnerId = `lease-${Buffer.from(mqttInstanceIdentity).toString("hex").slice(0, 16)}-${process.pid}`;
const username = process.env.MQTT_USERNAME;
const password = process.env.MQTT_PASSWORD;
type SseListenerState = {
  siteName?: string;
  pending: string[];
  deferredMessages: Array<{ event: string; data: unknown; eventId: number }>;
  paused: boolean;
  backpressured: boolean;
  flushing: boolean;
};
const listeners = new Map<Response, SseListenerState>();
const SNAPSHOT_INTERVAL_MS = 15_000;
const PERSISTENCE_INTERVAL_MINUTES = 15;
const PERSISTENCE_START_MINUTE = 6 * 60;
const PERSISTENCE_END_MINUTE = 18 * 60;
const DEFAULT_PLANT_TIMEZONE = "Asia/Kolkata";
const defaultTimezone = process.env.MQTT_PLANT_TIMEZONE ?? process.env.PLANT_TIMEZONE ?? DEFAULT_PLANT_TIMEZONE;
const defaultMqttPlantSite = process.env.MQTT_PLANT_SITE?.trim() || defaultSubscriptionTopic;
export type MqttRuntimeConfiguration = { brokerUrl: string; topic: string; plantSite: string; timezone: string };
let runtimeConfiguration: MqttRuntimeConfiguration = {
  brokerUrl: defaultBrokerUrl,
  topic: defaultSubscriptionTopic,
  plantSite: defaultMqttPlantSite,
  timezone: defaultTimezone,
};
let applyState: "idle" | "connecting" | "subscribed" | "rolling-back" | "failed" = "idle";
let lastApplyError: string | undefined;
let lastApplyAt: string | undefined;
let applyWaiters: Array<(success: boolean) => void> = [];
let brokerUrl = runtimeConfiguration.brokerUrl;
let subscriptionTopic = runtimeConfiguration.topic;
let configuredMqttPlantSite = runtimeConfiguration.plantSite;
let plantTimezone = validTimezone(runtimeConfiguration.timezone);

function payloadSiteName(payload: unknown) {
  return isRecord(payload) ? parseSiteName(payload.site_name ?? payload.siteName ?? payload.plant_name ?? payload.plantName) : "";
}

function messageBelongsToSite(message: StoredMessage, siteName?: string) {
  if (!siteName) return true;
  return payloadSiteName(message.parameter) === siteName || payloadSiteName(parameterFromPayload(message.payload)) === siteName;
}

function snapshotBelongsToSite(snapshot: { data: unknown }, siteName?: string) {
  if (!siteName) return true;
  if (!isRecord(snapshot.data)) return false;
  const messages = Array.isArray(snapshot.data.messages) ? snapshot.data.messages : [];
  const parameters = Array.isArray(snapshot.data.parameters) ? snapshot.data.parameters : [];
  return messages.some((message) => isRecord(message) && typeof message.payload === "string"
    && messageBelongsToSite({ ...message, sequence: 0, receivedAt: "", topic: "" } as StoredMessage, siteName))
    || parameters.some((parameter) => payloadSiteName(parameter) === siteName);
}

type StoredMessage = {
  topic: string;
  payload: string;
  parameter?: Record<string, unknown>;
  receivedAt: string;
  sequence: number;
  sourceTimestamp?: string;
  inverterRecords?: InverterActivePowerObservation[];
  delivery: "immediate" | "retained";
};
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
  calibrationProfile?: PublicPlantCalibrationProfile | null;
};

type CalibrationRole = "acPower" | "dailyEnergy" | "totalEnergy";
type CalibrationCounterRole = "instantaneous-power" | "daily-counter" | "cumulative-counter";
type CalibrationEngineeringUnit = "W" | "kW" | "MW" | "Wh" | "kWh" | "MWh";
type CalibrationSource = {
  role: CalibrationRole;
  sourceName: string;
  parameter: string;
  address: string;
  unit: CalibrationEngineeringUnit;
  multiplier: number;
  counterRole: CalibrationCounterRole;
  scalingConfirmed: true;
};
type PublicPlantCalibrationProfile = {
  siteName: string;
  version: string;
  status: "approved";
  installedDcCapacityKwp: number;
  sources: CalibrationSource[];
  approvedBy: string;
  approvedAt: string;
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
const SSE_BOOTSTRAP_MESSAGE_LIMIT = 120;
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

function listenerIsOpen(res: Response) {
  return listeners.has(res) && !res.writableEnded && !res.destroyed;
}

function closeRecoverableSseListener(res: Response, state: SseListenerState, reason: string, eventId?: number) {
  if (!listeners.has(res)) return;
  const firstPending = state.pending[0];
  const deliveredThrough = firstPending
    ? parseDeliverySequence(firstPending.match(/^id: (\d+)/)?.[1])
    : state.deferredMessages[0]?.eventId;
  recordCommunicationEvent({
    eventType: "sse-recovery-required",
    topic: subscriptionTopic,
    receivedAt: new Date(),
    reason,
    metadata: {
      deliveredThrough,
      pendingFrames: state.pending.length,
      deferredFrames: state.deferredMessages.length,
      nextSequence: eventId,
    },
  });
  listeners.delete(res);
  res.end();
}

async function waitForSseReplayCapacity(res: Response, state: SseListenerState) {
  while (listenerIsOpen(res)) {
    if (!state.backpressured && state.pending.length + state.deferredMessages.length < SSE_PENDING_FRAME_LIMIT) return true;
    await new Promise<void>((resolve) => {
      const resume = () => {
        res.off("drain", resume);
        res.off("close", resume);
        resolve();
      };
      res.once("drain", resume);
      res.once("close", resume);
    });
  }
  return false;
}

async function enqueueReplayFrame(res: Response, state: SseListenerState, event: string, data: unknown, eventId?: number) {
  if (!await waitForSseReplayCapacity(res, state)) return false;
  enqueueFrame(state, event, data, eventId);
  flushListener(res, state);
  return listenerIsOpen(res);
}

function flushListener(res: Response, state: SseListenerState) {
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
    // A slow browser has not lost telemetry: its Last-Event-ID lets it resume
    // from the durable ledger. This is a recoverable listener condition, not
    // a plant, broker, or persistence delivery gap.
    closeRecoverableSseListener(res, state, "SSE listener fell behind its bounded recovery buffer; reconnect will resume from the durable delivery sequence.", eventId);
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
  for (const [listener, state] of listeners) {
    if (event === "message" && state.siteName && !messageBelongsToSite(data as StoredMessage, state.siteName)) continue;
    if (event === "snapshot" && state.siteName && !snapshotBelongsToSite({ data: data }, state.siteName)) continue;
    send(listener, event, data, eventId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicCalibrationProfile(record: {
  siteName: string;
  version: string;
  status: string;
  installedDcCapacityKwp: number;
  sources: unknown;
  approvedBy: string;
  approvedAt: Date;
}): PublicPlantCalibrationProfile | null {
  if (record.status !== "approved" || !Array.isArray(record.sources)) return null;
  const sources = parseCalibrationSources(record.sources);
  if (!sources || !Number.isFinite(record.installedDcCapacityKwp) || record.installedDcCapacityKwp <= 0) return null;
  return {
    siteName: record.siteName,
    version: record.version,
    status: "approved",
    installedDcCapacityKwp: record.installedDcCapacityKwp,
    sources,
    approvedBy: record.approvedBy,
    approvedAt: record.approvedAt.toISOString(),
  };
}

function parseCalibrationSources(value: unknown): CalibrationSource[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const allowedRoles = new Set<CalibrationRole>(["acPower", "dailyEnergy", "totalEnergy"]);
  const allowedUnits = new Set<CalibrationEngineeringUnit>(["W", "kW", "MW", "Wh", "kWh", "MWh"]);
  const allowedCounters = new Set<CalibrationCounterRole>(["instantaneous-power", "daily-counter", "cumulative-counter"]);
  const sources: CalibrationSource[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const multiplier = typeof item.multiplier === "number" ? item.multiplier : Number(item.multiplier);
    if (
      !allowedRoles.has(item.role as CalibrationRole)
      || typeof item.sourceName !== "string" || !item.sourceName.trim() || item.sourceName.trim().length > 160
      || typeof item.parameter !== "string" || !item.parameter.trim() || item.parameter.trim().length > 160
      || typeof item.address !== "string" || !item.address.trim() || item.address.trim().length > 160
      || !allowedUnits.has(item.unit as CalibrationEngineeringUnit)
      || !allowedCounters.has(item.counterRole as CalibrationCounterRole)
      || item.scalingConfirmed !== true
      || !Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 1_000_000
    ) return null;
    const role = item.role as CalibrationRole;
    const counterRole = item.counterRole as CalibrationCounterRole;
    if ((role === "acPower" && counterRole !== "instantaneous-power") || (role === "dailyEnergy" && counterRole !== "daily-counter") || (role === "totalEnergy" && counterRole !== "cumulative-counter")) return null;
    const unit = item.unit as CalibrationEngineeringUnit;
    if ((role === "acPower" && !["W", "kW", "MW"].includes(unit)) || (role !== "acPower" && !["Wh", "kWh", "MWh"].includes(unit))) return null;
    sources.push({ role, sourceName: item.sourceName.trim(), parameter: item.parameter.trim(), address: item.address.trim(), unit, multiplier, counterRole, scalingConfirmed: true });
  }
  return sources;
}

async function currentPlantCalibrationProfile(siteName = configuredMqttPlantSite) {
  const [record] = await db
    .select()
    .from(plantCalibrationProfilesTable)
    .where(eq(plantCalibrationProfilesTable.siteName, siteName))
    .limit(1);
  return record ? publicCalibrationProfile(record) : null;
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
  const parameter = telemetryParameterFromRawPayload(rawPayload);
  return parameter ? applyTrn246TelemetryCalibration(parameter) : undefined;
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
    ? data.latestParameters.filter(isRecord).map(applyTrn246TelemetryCalibration)
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
    calibrationProfile: publicCalibrationProfileFromSnapshot(data.calibrationProfile),
  };
}

function publicCalibrationProfileFromSnapshot(value: unknown) {
  if (!isRecord(value) || typeof value.siteName !== "string" || typeof value.version !== "string" || value.status !== "approved" || typeof value.installedDcCapacityKwp !== "number" || typeof value.approvedBy !== "string" || typeof value.approvedAt !== "string") return null;
  const sources = parseCalibrationSources(value.sources);
  if (!sources || !Number.isFinite(value.installedDcCapacityKwp) || value.installedDcCapacityKwp <= 0) return null;
  return {
    siteName: value.siteName,
    version: value.version,
    status: "approved" as const,
    installedDcCapacityKwp: value.installedDcCapacityKwp,
    sources,
    approvedBy: value.approvedBy,
    approvedAt: value.approvedAt,
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
  const parameter = message.parameter ?? parameterFromPayload(message.payload);
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
    const calibrationProfile = await currentPlantCalibrationProfile();
    const [inserted] = await db.insert(mqttSnapshotsTable).values({
      windowStartedAt: buffer.startedAt,
      windowEndedAt: scheduledFor,
      capturedAt: savedAt,
      topic: subscriptionTopic,
      messageCount: buffer.messages.length,
      parameterCount: Object.keys(buffer.latestParameters).length,
      data: {
        schemaVersion: 4,
        recordType: "scheduled-telemetry-snapshot",
        saveStatus: outcome.saveStatus,
        missingReason: outcome.missingReason,
        scheduledFor: scheduledForIso,
        capturedAt: savedAt.toISOString(),
        timezone: plantTimezone,
        messages: buffer.messages,
        latestParameters: Object.values(buffer.latestParameters),
        calibrationProfile,
      },
    }).onConflictDoNothing({
      target: [mqttSnapshotsTable.topic, mqttSnapshotsTable.windowEndedAt],
      where: sql`(${mqttSnapshotsTable.data} ->> 'schemaVersion') = '4'`,
    }).returning();

    if (!inserted) {
      const existingCandidates = await db
        .select()
        .from(mqttSnapshotsTable)
        .where(and(eq(mqttSnapshotsTable.topic, subscriptionTopic), eq(mqttSnapshotsTable.windowEndedAt, scheduledFor)))
        .limit(10);
      const existing = existingCandidates.find((candidate) => isRecord(candidate.data) && candidate.data.schemaVersion === 4);
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

async function latestSavedSnapshotEvidence(siteName?: string) {
  const snapshots = await db
    .select()
    .from(mqttSnapshotsTable)
    .where(eq(mqttSnapshotsTable.topic, subscriptionTopic))
    .orderBy(desc(mqttSnapshotsTable.windowEndedAt), desc(mqttSnapshotsTable.capturedAt))
    .limit(96);
  const snapshot = snapshots.find((candidate) => isRecord(candidate.data) && (candidate.data.schemaVersion === 3 || candidate.data.schemaVersion === 4) && snapshotSaveStatus(candidate.data, candidate.messageCount, candidate.parameterCount) === "saved" && snapshotBelongsToSite(candidate, siteName));
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

function resolveApplyWaiters(success: boolean) {
  const waiters = applyWaiters;
  applyWaiters = [];
  for (const resolve of waiters) resolve(success);
}

async function waitForSubscription(timeoutMs = 20_000) {
  if (subscriptionState === "active" && connected) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      applyWaiters = applyWaiters.filter((waiter) => waiter !== complete);
      resolve(false);
    }, timeoutMs);
    const complete = (success: boolean) => {
      clearTimeout(timer);
      resolve(success);
    };
    applyWaiters.push(complete);
  });
}

export async function applyMqttConfiguration(next: MqttRuntimeConfiguration) {
  if (!consumerLeaseHeld) {
    throw new Error("This API instance is not the active MQTT consumer.");
  }
  if (applyState === "connecting" || applyState === "rolling-back") {
    throw new Error("An MQTT configuration apply is already in progress.");
  }
  const previous = runtimeConfiguration;
  applyState = "connecting";
  lastApplyError = undefined;
  lastApplyAt = new Date().toISOString();
  runtimeConfiguration = next;
  brokerUrl = next.brokerUrl;
  subscriptionTopic = next.topic;
  configuredMqttPlantSite = next.plantSite;
  plantTimezone = validTimezone(next.timezone);
  stopClientForLeaseLoss();
  consumerLeaseHeld = true;
  startClient();
  const connectedToCandidate = await waitForSubscription();
  if (connectedToCandidate) {
    applyState = "subscribed";
    broadcast("status", status());
    return true;
  }

  applyState = "rolling-back";
  lastApplyError = "The staged broker did not confirm its topic subscription.";
  runtimeConfiguration = previous;
  brokerUrl = previous.brokerUrl;
  subscriptionTopic = previous.topic;
  configuredMqttPlantSite = previous.plantSite;
  plantTimezone = validTimezone(previous.timezone);
  stopClientForLeaseLoss();
  consumerLeaseHeld = true;
  startClient();
  await waitForSubscription(20_000);
  applyState = "failed";
  broadcast("status", status());
  return false;
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

let runtimeConfigurationLoaded = false;

async function loadRuntimeConfiguration() {
  if (runtimeConfigurationLoaded) return;
  const [saved] = await db.select().from(platformConfigurationTable)
    .where(eq(platformConfigurationTable.key, "mqtt")).limit(1);
  if (saved && isRecord(saved.value)) {
    const value = saved.value;
    runtimeConfiguration = {
      brokerUrl: typeof value.brokerUrl === "string" ? value.brokerUrl : defaultBrokerUrl,
      topic: typeof value.topic === "string" ? value.topic : defaultSubscriptionTopic,
      plantSite: typeof value.plantSite === "string" ? value.plantSite : defaultMqttPlantSite,
      timezone: typeof value.timezone === "string" ? value.timezone : defaultTimezone,
    };
    brokerUrl = runtimeConfiguration.brokerUrl;
    subscriptionTopic = runtimeConfiguration.topic;
    configuredMqttPlantSite = runtimeConfiguration.plantSite;
    plantTimezone = validTimezone(runtimeConfiguration.timezone);
  }
  runtimeConfigurationLoaded = true;
}

function requestMqttConsumer() {
  void loadRuntimeConfiguration().then(() => {
  startSnapshotTimer();
  startCommunicationTimer();
  void renewConsumerLease();
  if (!consumerLeaseTimer) {
    consumerLeaseTimer = setInterval(() => void renewConsumerLease(), MQTT_CONSUMER_LEASE_RENEWAL_MS);
  }
  });
}

function status() {
  const schedule = persistenceSchedule(new Date());
  const communication = refreshCommunicationHealth();
  return {
    connected: connected && subscriptionState === "active" && consumerLeaseHeld,
    brokerUrl,
    topic: subscriptionTopic,
    plantSite: configuredMqttPlantSite,
    timezone: plantTimezone,
    applyState,
    lastApplyError,
    lastApplyAt,
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

export function getMqttRuntimeStatus() {
  return status();
}

function startClient() {
  if (!consumerLeaseHeld || client) return;

  const mqttClient = mqtt.connect(brokerUrl, {
    clientId: configuredClientId
      ?? `scada-${Buffer.from(subscriptionTopic).toString("hex").slice(0, 8)}-${Buffer.from(mqttInstanceIdentity).toString("hex").slice(0, 10)}`,
    username,
    password,
    protocolVersion: 4,
    reconnectPeriod: 5_000,
    connectTimeout: 30_000,
    keepalive: 30,
    clean: false,
    // Subscribe explicitly after each confirmed transport connection so one
    // reconnect produces one observable subscription acknowledgement.
    resubscribe: false,
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
        resolveApplyWaiters(false);
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
      applyState = applyState === "connecting" ? "subscribed" : applyState;
      resolveApplyWaiters(true);
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

  mqttClient.on("message", (topic, payload, packet) => {
    if (client !== mqttClient || !consumerLeaseHeld || subscriptionState !== "active") return;
    const payloadCopy = Buffer.from(payload);
    inboundMessageChain = inboundMessageChain.then(async () => {
      await captureMqttMessage(topic, payloadCopy, packet.retain === true);
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

async function captureMqttMessage(topic: string, payload: Buffer, retained = false) {
  const rawPayload = payload.toString("utf8");
  const parameter = parameterFromPayload(rawPayload);
  const receivedAt = new Date().toISOString();
  const inverterRecord = parameter
    ? inverterActivePowerObservationFromParameter(parameter, configuredMqttPlantSite)
    : undefined;
  const message: StoredMessage = {
    topic,
    payload: rawPayload,
    parameter,
    receivedAt,
    sequence: await allocateDeliverySequence(),
    sourceTimestamp: parameter ? parameterObservationTime(parameter) : undefined,
    inverterRecords: inverterRecord ? [inverterRecord] : undefined,
    delivery: retained ? "retained" : "immediate",
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
    metadata: { qos: 1, preservedRawPayload: true, delivery: message.delivery },
  });
  if (!retained) {
    recordTelemetryHeartbeat(message);
    queueSnapshotMessage(message);
    requestSnapshotScheduleRun();
  }
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

  const measurement = parameter ? inverterMeasurementObservationFromParameter(parameter, configuredMqttPlantSite) : undefined;
  if (measurement) {
    void db.insert(mqttInverterMeasurementHistoryTable).values({
      topic,
      siteName: measurement.siteName,
      inverterId: measurement.inverterId,
      inverterName: measurement.inverterName,
      parameter: measurement.parameter,
      displayLabel: measurement.displayLabel,
      measurementKind: measurement.measurementKind,
      value: measurement.value,
      rawValue: measurement.rawValue,
      unit: measurement.unit,
      address: measurement.address,
      sourceName: measurement.sourceName,
      observedAt: new Date(measurement.observedAt),
      receivedAt: new Date(receivedAt),
      scalingStatus: measurement.scalingStatus,
      sourcePayload: rawPayload,
      metadata: { ...measurement.metadata, delivery: message.delivery },
    }).onConflictDoNothing({
      target: [
        mqttInverterMeasurementHistoryTable.siteName,
        mqttInverterMeasurementHistoryTable.topic,
        mqttInverterMeasurementHistoryTable.inverterId,
        mqttInverterMeasurementHistoryTable.parameter,
        mqttInverterMeasurementHistoryTable.address,
        mqttInverterMeasurementHistoryTable.observedAt,
        mqttInverterMeasurementHistoryTable.receivedAt,
        mqttInverterMeasurementHistoryTable.value,
      ],
    }).catch((error) => {
      logger.error({ err: error, sequence: message.sequence }, "MQTT inverter-measurement archive write failed after live delivery");
    });
  }
}

router.get("/mqtt/status", (_req, res) => {
  requestMqttConsumer();
  res.json(status());
});

router.get("/mqtt/snapshots", async (req, res) => {
  const siteName = parseSiteName(req.query.siteName);
  if (siteName && !await allowGrantedSite(req, res, siteName)) return;
  try {
    const snapshots = await db
      .select()
      .from(mqttSnapshotsTable)
      .orderBy(desc(mqttSnapshotsTable.capturedAt))
      .limit(100);
    res.json({ snapshots: snapshots.filter((snapshot) => snapshotBelongsToSite(snapshot, siteName || undefined)).slice(0, 20) });
  } catch (error) {
    logger.error({ err: error }, "MQTT snapshots query failed");
    res.status(500).json({ message: "Unable to load stored MQTT snapshots" });
  }
});

router.get("/mqtt/snapshots/latest", async (req, res): Promise<void> => {
  const siteName = parseSiteName(req.query.siteName);
  if (siteName && !await allowGrantedSite(req, res, siteName)) return;
  if (!siteName && !await allowUnscopedScadaEvidence(req, res)) return;
  try {
    const snapshot = await latestSavedSnapshotEvidence(siteName || undefined);
    res.set("Cache-Control", "no-store").json({ snapshot });
  } catch (error) {
    req.log.error({ err: error }, "Latest MQTT snapshot query failed");
    res.status(500).json({ message: "Unable to load the latest saved MQTT snapshot." });
  }
});

router.get("/mqtt/site-locations", async (req, res) => {
  try {
    const granted = await grantedSiteNames(req);
    const locations = await db
      .select()
      .from(plantLocationsTable)
      .orderBy(asc(plantLocationsTable.siteName));
    res.set("Cache-Control", "no-store").json({
      locations: granted ? locations.filter((location) => granted.has(location.siteName)) : locations,
    });
  } catch (error) {
    logger.error({ err: error }, "Plant locations query failed");
    res.status(500).json({ message: "Unable to load saved plant locations" });
  }
});

router.get("/mqtt/site-access", async (req, res) => {
  const access = await siteAccess(req);
  res.set("Cache-Control", "no-store").json({
    sites: [...access.sites].sort(),
    roles: Object.fromEntries(access.roles),
    global: access.global,
    policy: access.global ? "global" : "assigned-sites",
  });
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
  if (!await allowGrantedSite(req, res, siteName)) return;
  if (!await allowSiteRole(req, res, siteName, ["site-admin"])) return;

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

router.get("/mqtt/calibration-profile", async (req, res): Promise<void> => {
  const siteName = parseSiteName(req.query.siteName) || configuredMqttPlantSite;
  if (siteName.length > 160) {
    res.status(400).json({ message: "A valid plant/site name is required." });
    return;
  }
  if (!await allowGrantedSite(req, res, siteName)) return;
  try {
    res.set("Cache-Control", "no-store").json({ profile: await currentPlantCalibrationProfile(siteName) });
  } catch (error) {
    req.log.error({ err: error, siteName }, "Plant calibration profile query failed");
    res.status(500).json({ message: "Unable to load the plant calibration profile." });
  }
});

function calibrationPreviewText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function calibrationPreviewNumber(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function calibrationPreviewRole(value: unknown): CalibrationRole | undefined {
  return value === "acPower" || value === "dailyEnergy" || value === "totalEnergy" ? value : undefined;
}

function calibrationPreviewUnit(value: unknown): CalibrationEngineeringUnit | undefined {
  return value === "W" || value === "kW" || value === "MW" || value === "Wh" || value === "kWh" || value === "MWh" ? value : undefined;
}

function calibrationPreviewCounterRole(value: unknown): CalibrationCounterRole | undefined {
  return value === "instantaneous-power" || value === "daily-counter" || value === "cumulative-counter" ? value : undefined;
}

function previewParameterSource(parameter: Record<string, unknown>) {
  return String(parameter.server_name ?? parameter.source ?? parameter.device ?? parameter.server ?? "").trim();
}

function previewParameterName(parameter: Record<string, unknown>) {
  return String(parameter.name ?? parameter.parameter ?? parameter.tag ?? "").trim();
}

function previewParameterAddress(parameter: Record<string, unknown>) {
  return String(parameter.full_addr ?? parameter.address ?? parameter.register ?? parameter.addr ?? "").replace(/\D/g, "");
}

function previewNormalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function previewRawValue(parameter: Record<string, unknown>) {
  const candidate = parameter.raw_data ?? parameter.rawValue ?? parameter.raw_value ?? parameter.source_raw_value ?? parameter.data ?? parameter.value;
  return calibrationPreviewNumber(candidate);
}

function calibrationPreviewSource(value: unknown): CalibrationSource | null {
  if (!isRecord(value)) return null;
  const role = calibrationPreviewRole(value.role);
  const sourceName = calibrationPreviewText(value.sourceName);
  const parameter = calibrationPreviewText(value.parameter);
  const address = calibrationPreviewText(value.address);
  const unit = calibrationPreviewUnit(value.unit);
  const multiplier = calibrationPreviewNumber(value.multiplier);
  const counterRole = calibrationPreviewCounterRole(value.counterRole);
  const roleCounterRole = role === "acPower" ? "instantaneous-power" : role === "dailyEnergy" ? "daily-counter" : role === "totalEnergy" ? "cumulative-counter" : undefined;
  const expectedPowerUnit = role === "acPower" && unit !== undefined && ["W", "kW", "MW"].includes(unit);
  const expectedEnergyUnit = role !== "acPower" && unit !== undefined && ["Wh", "kWh", "MWh"].includes(unit);
  if (!role || !sourceName || !parameter || !address || !unit || !multiplier || multiplier <= 0 || !counterRole || counterRole !== roleCounterRole || (!expectedPowerUnit && !expectedEnergyUnit)) return null;
  return { role, sourceName, parameter, address, unit, multiplier, counterRole, scalingConfirmed: true };
}

function previewFreshnessWindowMs() {
  return heartbeatWindows(medianCadenceMs(observedIntervalsMs)).staleAfterMs;
}

function previewCurrentMessage(message: StoredMessage, nowMs: number) {
  if (message.delivery !== "immediate") return false;
  const receivedAtMs = Date.parse(message.receivedAt);
  const maximumAgeMs = previewFreshnessWindowMs();
  if (!Number.isFinite(receivedAtMs) || receivedAtMs > nowMs || receivedAtMs < nowMs - maximumAgeMs) return false;
  const sourceAtMs = sourceTimestampMilliseconds(message.sourceTimestamp);
  return sourceAtMs === undefined || (sourceAtMs <= nowMs && sourceAtMs >= nowMs - maximumAgeMs);
}

function previewEvidence(message: StoredMessage) {
  const candidate = message.parameter ?? parameterFromPayload(message.payload);
  const rawValue = candidate ? previewRawValue(candidate) : undefined;
  if (!candidate || rawValue === undefined) return undefined;
  return {
    sourceName: previewParameterSource(candidate),
    parameter: previewParameterName(candidate),
    address: previewParameterAddress(candidate),
    rawValue,
    observedAt: message.sourceTimestamp ?? undefined,
    receivedAt: message.receivedAt,
    sequence: message.sequence,
    delivery: message.delivery,
  };
}

function previewMapping(source: CalibrationSource, index: number, nowMs: number) {
  const matchingMessages = messageHistory
    .filter((message) => {
      const candidate = message.parameter ?? parameterFromPayload(message.payload);
      return candidate !== undefined
        && previewNormalized(previewParameterSource(candidate)) === previewNormalized(source.sourceName)
        && previewNormalized(previewParameterName(candidate)) === previewNormalized(source.parameter)
        && previewParameterAddress(candidate) === source.address.replace(/\D/g, "");
    })
    .sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt));
  const current = matchingMessages.find((message) => previewCurrentMessage(message, nowMs));
  if (current) {
    const evidence = previewEvidence(current);
    if (evidence) return { index, status: "matched" as const, evidence };
    return { index, status: "not-found" as const, reason: "A current matching broker message did not contain a numeric raw register value." };
  }
  const immediate = matchingMessages.find((message) => message.delivery === "immediate");
  if (immediate) return { index, status: "stale" as const, reason: "A matching live delivery exists, but its receipt or source observation is outside the current freshness window." };
  const retained = matchingMessages.find((message) => message.delivery === "retained");
  if (retained) return { index, status: "retained" as const, reason: "The only matching evidence is retained by the broker, not a current live delivery." };
  return { index, status: "not-found" as const, reason: "No broker evidence currently matches this source, parameter, and register address." };
}

router.post("/mqtt/calibration-preview", async (req, res): Promise<void> => {
  const siteName = parseSiteName(req.body?.siteName) || configuredMqttPlantSite;
  const requestedSources = req.body?.sources;
  if (siteName.length > 160 || !Array.isArray(requestedSources) || requestedSources.length > 100) {
    res.status(400).json({ message: "A valid plant/site name and up to 100 draft source mappings are required." });
    return;
  }
  if (!req.isAuthenticated()) {
    res.status(401).json({ message: "Operator sign-in is required to verify calibration mappings against live broker evidence." });
    return;
  }
  if (!canUpdatePlantLocation(req.user, siteName)) {
    res.status(403).json({ message: "Your operator account is not authorized to verify calibration mappings for this plant." });
    return;
  }
  if (!await allowGrantedSite(req, res, siteName)) return;
  if (!await allowSiteRole(req, res, siteName, ["operator", "site-admin"])) return;
  const nowMs = Date.now();
  const mappings = requestedSources.map((value: unknown, index: number) => {
    const source = calibrationPreviewSource(value);
    return source
      ? previewMapping(source, index, nowMs)
      : { index, status: "invalid" as const, reason: "Complete the source, parameter, address, compatible unit, counter role, and positive multiplier before verifying." };
  });

  res.set("Cache-Control", "no-store").json({
    siteName,
    checkedAt: new Date().toISOString(),
    mappings,
    sourceStatus: latestMessage ? "broker evidence available" : "awaiting broker evidence",
  });
});

router.put("/mqtt/calibration-profile/:siteName", async (req, res): Promise<void> => {
  const siteName = parseSiteName(req.params.siteName);
  const installedDcCapacityKwp = typeof req.body?.installedDcCapacityKwp === "number" ? req.body.installedDcCapacityKwp : Number(req.body?.installedDcCapacityKwp);
  const sources = parseCalibrationSources(req.body?.sources);
  if (!siteName || siteName.length > 160 || !Number.isFinite(installedDcCapacityKwp) || installedDcCapacityKwp <= 0 || installedDcCapacityKwp > 10_000_000 || !sources) {
    res.status(400).json({ message: "An installed DC capacity and one or more complete, confirmed source-register mappings are required." });
    return;
  }
  if (!req.isAuthenticated()) {
    res.status(401).json({ message: "Operator sign-in is required to approve a plant calibration profile." });
    return;
  }
  if (!canUpdatePlantLocation(req.user, siteName)) {
    res.status(403).json({ message: "Your operator account is not authorized to approve this plant calibration profile." });
    return;
  }
  if (!await allowGrantedSite(req, res, siteName)) return;
  const verification = sources.map((source, index) => previewMapping(source, index, Date.now()));
  if (verification.some((mapping) => mapping.status !== "matched")) {
    res.status(409).json({
      message: "Approval is held until every source mapping has a current live broker match. Refresh verification and resolve the flagged mapping(s).",
      mappings: verification,
    });
    return;
  }
  const approvedAt = new Date();
  const version = `calibration-${approvedAt.toISOString()}`;
  const approvedBy = req.user.email ? `email:${req.user.email.toLowerCase()}` : `id:${req.user.id}`;
  try {
    const [record] = await db.insert(plantCalibrationProfilesTable).values({
      siteName,
      version,
      status: "approved",
      installedDcCapacityKwp,
      sources,
      approvedBy,
      approvedAt,
    }).onConflictDoUpdate({
      target: plantCalibrationProfilesTable.siteName,
      set: { version, status: "approved", installedDcCapacityKwp, sources, approvedBy, approvedAt, updatedAt: approvedAt },
    }).returning();
    const profile = record ? publicCalibrationProfile(record) : null;
    if (!profile) throw new Error("Saved calibration profile could not be validated.");
    res.json({ profile });
  } catch (error) {
    req.log.error({ err: error, siteName }, "Plant calibration profile save failed");
    res.status(500).json({ message: "Unable to save the plant calibration profile." });
  }
});

function parseRangeBoundary(value: unknown, boundary: "start" | "end") {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  if (boundary === "end" && /^\d{4}-\d{2}-\d{2}$/.test(value)) parsed.setUTCHours(23, 59, 59, 999);
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
  const siteName = parseSiteName(req.query.siteName);
  if (siteName) {
    if (!await allowGrantedSite(req, res, siteName)) return;
  } else if (!await allowUnscopedScadaEvidence(req, res)) return;
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
    for (const snapshot of snapshots.filter((candidate) => snapshotBelongsToSite(candidate, siteName || undefined))) {
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
  if (!await allowGrantedSite(req, res, siteName)) return;

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

router.get("/mqtt/inverter-measurements", async (req, res): Promise<void> => {
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
  if (!await allowGrantedSite(req, res, siteName)) return;

  const { rangeStart, rangeEnd } = energyHistoryRange(period, anchor);
  try {
    const samples = await db
      .select()
      .from(mqttInverterMeasurementHistoryTable)
      .where(and(
        eq(mqttInverterMeasurementHistoryTable.topic, subscriptionTopic),
        eq(mqttInverterMeasurementHistoryTable.siteName, siteName),
        eq(mqttInverterMeasurementHistoryTable.inverterId, inverterId),
        gte(mqttInverterMeasurementHistoryTable.observedAt, rangeStart),
        lte(mqttInverterMeasurementHistoryTable.observedAt, rangeEnd),
      ))
      .orderBy(asc(mqttInverterMeasurementHistoryTable.observedAt), asc(mqttInverterMeasurementHistoryTable.receivedAt))
      .limit(3_000);

    res.set("Cache-Control", "no-store").json({
      range: { from: rangeStart.toISOString(), to: rangeEnd.toISOString() },
      siteName,
      inverterId,
      period,
      timezone: plantTimezone,
      samples: samples.map((sample) => ({
        id: sample.id,
        siteName: sample.siteName,
        siteScope: "configured-source-site",
        inverterId: sample.inverterId,
        inverterName: sample.inverterName,
        parameter: sample.parameter,
        displayLabel: sample.displayLabel,
        measurementKind: sample.measurementKind,
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
    logger.error({ err: error, siteName, inverterId }, "Inverter measurement history query failed");
    res.status(500).json({ message: "Unable to load archived inverter measurements." });
  }
});

function reportList(value: unknown, maximumItems = 50) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return values
    .flatMap((item) => typeof item === "string" ? [item.trim()] : [])
    .filter(Boolean)
    .slice(0, maximumItems);
}

function reportProvenance(value: string): value is ReportProvenance {
  return value === "live" || value === "latest-saved" || value === "historical-saved";
}

function sourceText(parameter: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = parameter[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function reportCategoryForMeasurement(kind: unknown, parameter: string) {
  if (kind === "energy") return "energy" as const;
  if (kind === "electrical" || kind === "active-power" || kind === "dc-power") return "electrical" as const;
  return reportCategoryForParameter(parameter);
}

function reportTitle(type: ScadaReportType) {
  return {
    operations: "Operations overview",
    electrical: "Electrical performance",
    energy: "Energy & yield",
    inverter: "Inverter detail",
    environmental: "Environmental",
    alarms: "Alarms & faults",
    communication: "Communication",
    live: "Live snapshot",
    historical: "Historical review",
    comparison: "Site comparison",
    availability: "Availability",
    "data-quality": "Data quality",
    "plant-monitoring": "Plant / site monitoring",
    "inverter-monitoring": "Inverter monitoring",
    "electrical-parameters": "Electrical parameters",
    "ac-dc-power": "AC / DC power",
    "energy-generation": "Energy generation",
    "mppt-monitoring": "MPPT monitoring",
    "string-monitoring": "String monitoring",
    "temperature-monitoring": "Temperature monitoring",
    "power-factor-frequency": "Power factor & frequency",
    "alarm-fault": "Alarm & fault report",
    "device-communication": "Device communication",
    "mqtt-modbus-telemetry": "MQTT / Modbus telemetry",
    "live-data": "Live data",
    "historical-saved": "Historical saved data",
  }[type];
}

function validatedLiveReportRecord(message: StoredMessage): ScadaReportRecord | undefined {
  const parameter = message.parameter ?? parameterFromPayload(message.payload);
  const measurement = parameter ? inverterMeasurementObservationFromParameter(parameter, configuredMqttPlantSite) : undefined;
  if (measurement?.scalingStatus === "validated") {
    return {
      id: stableReportRecordId({ source: measurement.sourceName, siteName: measurement.siteName, deviceId: measurement.inverterId, parameter: measurement.parameter, address: measurement.address, observedAt: measurement.observedAt, receivedAt: message.receivedAt, value: measurement.value }),
      recordType: "measurement",
      category: reportCategoryForMeasurement(measurement.measurementKind, measurement.parameter),
      siteName: measurement.siteName,
      deviceId: measurement.inverterId,
      deviceName: measurement.inverterName,
      parameter: measurement.parameter,
      displayLabel: measurement.displayLabel,
      measurementKind: measurement.measurementKind,
      value: measurement.value,
      unit: measurement.unit,
      address: measurement.address,
      sourceName: measurement.sourceName,
      observedAt: measurement.observedAt,
      receivedAt: message.receivedAt,
      provenance: "live",
      quality: "validated",
      status: null,
      reason: null,
    };
  }
  if (!parameter || !sourceExplicitlyValidatesEngineeringValue(parameter)) return undefined;

  const value = numericParameterValue(parameter);
  const observedAt = parameterObservationTime(parameter);
  if (value === null || !observedAt) return undefined;
  const parameterName = String(parameter.name ?? parameter.parameter ?? "register");
  const measurementKind = String(parameter.measurement_type ?? parameter.semantic ?? "other").replaceAll("_", "-");
  const sourceName = String(parameter.server_name ?? parameter.source ?? "MQTT source");
  const address = String(parameter.full_addr ?? parameter.address ?? parameter.addr ?? "—");
  const deviceId = sourceText(parameter, ["inverter_id", "inverterId", "device_id", "deviceId"]) ?? null;
  const siteName = sourceText(parameter, ["site_name", "siteName", "plant_name", "plantName"]) ?? configuredMqttPlantSite;
  return {
    id: stableReportRecordId({ source: sourceName, siteName, deviceId, parameter: parameterName, address, observedAt, receivedAt: message.receivedAt, value }),
    recordType: "measurement",
    category: reportCategoryForMeasurement(measurementKind, parameterName),
    siteName,
    deviceId,
    deviceName: sourceText(parameter, ["inverter_name", "inverterName", "device_name", "deviceName"]) ?? null,
    parameter: parameterName,
    displayLabel: sourceText(parameter, ["display_name", "displayName", "label"]) ?? parameterName,
    measurementKind,
    value,
    unit: String(parameter.engineering_unit ?? parameter.unit ?? "source units"),
    address,
    sourceName,
    observedAt,
    receivedAt: message.receivedAt,
    provenance: "live",
    quality: "validated",
    status: null,
    reason: null,
  };
}

router.get("/mqtt/reports", async (req, res): Promise<void> => {
  const requestedType = typeof req.query.reportType === "string" ? req.query.reportType : "operations";
  if (!SCADA_REPORT_TYPES.includes(requestedType as ScadaReportType)) {
    res.status(400).json({ message: "Use a supported report category." });
    return;
  }
  const from = parseRangeBoundary(req.query.from, "start");
  const to = parseRangeBoundary(req.query.to, "end");
  if (from === undefined || to === undefined) {
    res.status(400).json({ message: "Use valid ISO date/time values for the report range." });
    return;
  }
  const rangeEnd = to ?? new Date();
  const rangeStart = from ?? new Date(rangeEnd.getTime() - 30 * 24 * 60 * 60 * 1_000);
  if (rangeStart > rangeEnd || rangeEnd.getTime() - rangeStart.getTime() > 366 * 24 * 60 * 60 * 1_000) {
    res.status(400).json({ message: "Use a report range up to 366 days with an end after the start." });
    return;
  }

  const requestedSite = parseSiteName(req.query.siteName);
  let siteName = requestedSite && requestedSite !== "all" ? requestedSite : "";
  const granted = await grantedSiteNames(req);
  if (granted && !siteName) {
    if (granted.size !== 1) {
      res.status(400).json({ message: "Select one assigned plant/site before requesting a report." });
      return;
    }
    siteName = [...granted][0];
  }
  if (granted && !granted.has(siteName)) {
    res.status(403).json({ message: "Your assigned site access does not include this report scope." });
    return;
  }
  const filters: ReportFilterSet = {
    devices: reportList(req.query.devices),
    parameters: reportList(req.query.parameters),
    provenance: reportList(req.query.provenance).filter(reportProvenance),
    quality: req.query.quality === "validated" || req.query.quality === "source-reported" ? req.query.quality : "all",
    status: req.query.status === "active" || req.query.status === "warning" || req.query.status === "normal" ? req.query.status : "all",
  };
  const reportType = requestedType as ScadaReportType;
  if (!filters.provenance.length && (reportType === "live" || reportType === "live-data")) filters.provenance = ["live"];
  if (!filters.provenance.length && (reportType === "historical" || reportType === "historical-saved")) filters.provenance = ["latest-saved", "historical-saved"];
  const complete = req.query.complete === "true";
  const requestedPage = Number(req.query.page);
  const requestedPageSize = Number(req.query.pageSize);
  const MAX_REPORT_PAGE = 10_000;
  if (Number.isInteger(requestedPage) && requestedPage > MAX_REPORT_PAGE) {
    res.status(400).json({ message: `Use a report page no greater than ${MAX_REPORT_PAGE}.` });
    return;
  }
  const pageSize = Number.isInteger(requestedPageSize) ? Math.min(Math.max(requestedPageSize, 25), 500) : 200;
  const page = Number.isInteger(requestedPage) ? Math.max(requestedPage, 1) : 1;
  const savedEvidenceRequested = filters.provenance.length === 0 || filters.provenance.some((provenance) => provenance === "latest-saved" || provenance === "historical-saved");
  const records: ScadaReportRecord[] = [];
  const excludedEvidence: Array<{ reason: string; source: string; parameter: string }> = [];
  const addRecord = (record: ScadaReportRecord) => {
    if (keepReportRecord(record, reportType, filters)) records.push(record);
  };
  const exclude = (reason: string, source: string, parameter: string) => {
    excludedEvidence.push({ reason, source, parameter });
  };

  try {
    const boundedLiveRecord = latestMessage ? validatedLiveReportRecord(latestMessage) : undefined;
    // Normal previews use one canonical SQL relation so the optional current
    // live observation participates in the same filters, totals, ordering,
    // paging, and bounded chart selection as durable evidence.
    if (!complete) {
      const bounded = await queryBoundedScadaReport({
        topic: subscriptionTopic,
        defaultSite: configuredMqttPlantSite,
        siteName,
        from: rangeStart,
        to: rangeEnd,
        reportType,
        filters,
        page,
        pageSize,
        liveRecord: boundedLiveRecord,
      });
      const aggregate = bounded.aggregate;
      const numericRecords = bounded.chartRecords;
      const chartGroups = [...new Map(numericRecords.map((record) => [`${record.parameter}|${record.unit}|${record.deviceId ?? ""}`, record])).values()];
      const charts = chartGroups.slice(0, 6).map((chartSignal) => {
        const data = numericRecords
          .filter((record) => record.unit === chartSignal.unit && record.parameter === chartSignal.parameter && record.deviceId === chartSignal.deviceId)
          .slice(0, 80).reverse()
          .map((record) => ({ time: record.observedAt, value: record.value as number, label: record.deviceName ?? record.parameter }));
        return data.length > 1 ? { kind: "line" as const, title: `Validated ${chartSignal.displayLabel} trend`, unit: chartSignal.unit, data } : null;
      }).filter(Boolean);
      const totalRecords = Number(aggregate.total_records ?? 0);
      const excludedRaw = Number(aggregate.excluded_raw ?? 0);
      const excludedSnapshots = Number(aggregate.excluded_snapshots ?? 0);
      const excludedCount = excludedRaw + excludedSnapshots;
      const excludedByReason = [
        ...(excludedRaw ? [{ reason: "Raw or unvalidated engineering value excluded from report values.", count: excludedRaw }] : []),
        ...(excludedSnapshots ? [{ reason: "Saved snapshot was incomplete or missing.", count: excludedSnapshots }] : []),
      ];
      const latestObservedAt = aggregate.latest_observed_at;
      const latestReceivedAt = aggregate.latest_received_at;
      res.set("Cache-Control", "no-store").json({
        title: reportTitle(reportType),
        category: reportType,
        siteName: siteName || configuredMqttPlantSite,
        period: { from: rangeStart.toISOString(), to: rangeEnd.toISOString(), label: `${rangeStart.toLocaleDateString("en-GB")} — ${rangeEnd.toLocaleDateString("en-GB")}` },
        generatedAt: new Date().toISOString(),
        sourceStatus: latestMessage ? "Live delivery remains active; report preview uses a separate read-only query." : "No current live payload; preview uses saved evidence only.",
        filters: { ...filters, reportType },
        summary: [
          { label: "Validated records", value: Number(aggregate.validated_records ?? 0), unit: "", detail: "Engineering values with explicit source validation.", quality: "validated" },
          { label: "Source-reported events", value: Number(aggregate.source_reported_records ?? 0), unit: "", detail: "Alarms and communication evidence are not engineering conversions.", quality: "source-reported" },
          { label: "Inverter/device context", value: Number(aggregate.unique_devices ?? 0), unit: "", detail: "Explicitly identified devices in this report.", quality: "validated" },
          { label: "Excluded evidence", value: excludedCount, unit: "", detail: "Raw or unvalidated values are retained as exclusion context only.", quality: excludedCount ? "raw" : "validated" },
        ],
        charts,
        freshness: {
          latestObservedAt: latestObservedAt instanceof Date ? latestObservedAt.toISOString() : latestObservedAt ?? null,
          latestReceivedAt: latestReceivedAt instanceof Date ? latestReceivedAt.toISOString() : latestReceivedAt ?? null,
        },
        records: bounded.records,
        pagination: { page, pageSize, totalRecords, totalPages: Math.max(1, Math.ceil(totalRecords / pageSize)), complete: false },
        excludedEvidence: { count: excludedCount, byReason: excludedByReason },
        alarmSummary: { reported: Number(aggregate.alarms ?? 0), sourceReported: Number(aggregate.alarms ?? 0), active: Number(aggregate.active_alarms ?? 0) },
        communicationSummary: { events: Number(aggregate.communication_events ?? 0), warnings: Number(aggregate.communication_warnings ?? 0) },
        qualityNotes: [
          "Customer-facing report values are shown only when source identity, unit, semantic meaning, and scaling validation are explicit.",
          "Raw or unvalidated records are not converted, estimated, or shown as report values; they are counted as excluded evidence.",
          "Live, latest saved, and historical saved provenance are kept distinct for every included record.",
        ],
        attribution: "Powered by Automystics Technologies Pvt Ltd.",
      });
      return;
    }
    const snapshotWhere = and(
      eq(mqttSnapshotsTable.topic, subscriptionTopic),
      gte(mqttSnapshotsTable.windowEndedAt, rangeStart),
      lte(mqttSnapshotsTable.windowStartedAt, rangeEnd),
    );
    const measurementWhere = and(
        eq(mqttInverterMeasurementHistoryTable.topic, subscriptionTopic),
        ...(siteName ? [eq(mqttInverterMeasurementHistoryTable.siteName, siteName)] : []),
        ...(filters.devices.length ? [inArray(mqttInverterMeasurementHistoryTable.inverterId, filters.devices)] : []),
        ...(filters.parameters.length ? [inArray(mqttInverterMeasurementHistoryTable.parameter, filters.parameters)] : []),
        gte(mqttInverterMeasurementHistoryTable.observedAt, rangeStart),
        lte(mqttInverterMeasurementHistoryTable.observedAt, rangeEnd),
      );
    const energyWhere = and(
        eq(mqttInverterEnergyHistoryTable.topic, subscriptionTopic),
        ...(siteName ? [eq(mqttInverterEnergyHistoryTable.siteName, siteName)] : []),
        ...(filters.devices.length ? [inArray(mqttInverterEnergyHistoryTable.inverterId, filters.devices)] : []),
        ...(filters.parameters.length ? [inArray(mqttInverterEnergyHistoryTable.parameter, filters.parameters)] : []),
        gte(mqttInverterEnergyHistoryTable.observedAt, rangeStart),
        lte(mqttInverterEnergyHistoryTable.observedAt, rangeEnd),
      );
    const communicationWhere = and(
        eq(mqttCommunicationEventsTable.topic, subscriptionTopic),
        gte(mqttCommunicationEventsTable.receivedAt, rangeStart),
        lte(mqttCommunicationEventsTable.receivedAt, rangeEnd),
      );
    const [snapshots, measurements, energyRecords, communicationEvents] = await Promise.all([
      savedEvidenceRequested ? db.select().from(mqttSnapshotsTable).where(snapshotWhere).orderBy(asc(mqttSnapshotsTable.capturedAt)) : Promise.resolve([]),
      savedEvidenceRequested ? db.select().from(mqttInverterMeasurementHistoryTable).where(measurementWhere).orderBy(asc(mqttInverterMeasurementHistoryTable.observedAt), asc(mqttInverterMeasurementHistoryTable.receivedAt)) : Promise.resolve([]),
      savedEvidenceRequested ? db.select().from(mqttInverterEnergyHistoryTable).where(energyWhere).orderBy(asc(mqttInverterEnergyHistoryTable.observedAt), asc(mqttInverterEnergyHistoryTable.receivedAt)) : Promise.resolve([]),
      savedEvidenceRequested && !siteName ? db.select().from(mqttCommunicationEventsTable).where(communicationWhere).orderBy(asc(mqttCommunicationEventsTable.receivedAt)) : Promise.resolve([]),
    ]);

    const scopedSnapshots = snapshots.map((snapshot) => ({ snapshot, evidence: snapshotEvidence(snapshot) })).filter(({ evidence }) => {
      if (!siteName) return true;
      return evidence.parameters.some((parameter) => (sourceText(parameter, ["site_name", "siteName", "plant_name", "plantName"]) ?? configuredMqttPlantSite) === siteName);
    });
    const latestSnapshotId = scopedSnapshots.reduce<number | null>((latest, entry) => {
      if (latest === null) return entry.snapshot.id;
      const latestEntry = scopedSnapshots.find((candidate) => candidate.snapshot.id === latest);
      return latestEntry && latestEntry.snapshot.capturedAt >= entry.snapshot.capturedAt ? latest : entry.snapshot.id;
    }, null);
    for (const { snapshot, evidence } of scopedSnapshots) {
      if (evidence.saveStatus !== "saved") {
        exclude("Saved snapshot was incomplete or missing.", "Snapshot scheduler", "snapshot");
        continue;
      }
      const provenance: ReportProvenance = snapshot.id === latestSnapshotId ? "latest-saved" : "historical-saved";
      for (const parameter of evidence.parameters) {
        const parameterSiteName = sourceText(parameter, ["site_name", "siteName", "plant_name", "plantName"]) ?? configuredMqttPlantSite;
        if (siteName && parameterSiteName !== siteName) continue;
        const parameterName = String(parameter.name ?? parameter.parameter ?? "register");
        const category = reportCategoryForParameter(parameterName);
        const sourceName = String(parameter.server_name ?? parameter.source ?? "Saved MQTT snapshot");
        const address = String(parameter.full_addr ?? parameter.address ?? parameter.addr ?? "—");
        const observedAt = parameterObservationTime(parameter) ?? evidence.scheduledFor;
        const observedAtMs = Date.parse(observedAt);
        if (!Number.isFinite(observedAtMs) || observedAtMs < rangeStart.getTime() || observedAtMs > rangeEnd.getTime()) continue;
        const numeric = numericParameterValue(parameter);
        const sourceStatus = sourceText(parameter, ["alarmStatus", "alarm_status", "status", "state", "severity"]);
        const alarm = category === "alarms";
        const quality = alarm ? "source-reported" as const : sourceExplicitlyValidatesEngineeringValue(parameter) ? "validated" as const : "raw" as const;
        if (quality === "raw") {
          exclude("Raw or unvalidated engineering value excluded from report values.", sourceName, parameterName);
          continue;
        }
        addRecord({
          id: stableReportRecordId({ source: `${snapshot.id}-${sourceName}`, siteName: parameterSiteName, deviceId: sourceText(parameter, ["inverter_id", "inverterId", "device_id", "deviceId"]) ?? null, parameter: parameterName, address, observedAt, receivedAt: evidence.capturedAt, value: numeric }),
          recordType: alarm ? "alarm" : "snapshot",
          category,
          siteName: parameterSiteName,
          deviceId: sourceText(parameter, ["inverter_id", "inverterId", "device_id", "deviceId"]) ?? null,
          deviceName: sourceText(parameter, ["inverter_name", "inverterName", "device_name", "deviceName"]) ?? null,
          parameter: parameterName,
          displayLabel: sourceText(parameter, ["display_name", "displayName", "label"]) ?? parameterName,
          value: alarm ? null : numeric,
          unit: alarm ? "" : String(parameter.engineering_unit ?? parameter.unit ?? "source units"),
          address,
          sourceName,
          observedAt,
          receivedAt: evidence.capturedAt,
          provenance,
          quality,
          status: sourceStatus ?? null,
          reason: alarm ? sourceText(parameter, ["reason", "description", "message", "cause"]) ?? "Source-reported alarm/fault evidence." : null,
        });
      }
    }

    for (const sample of measurements) {
      const category = reportCategoryForMeasurement(sample.measurementKind, sample.parameter);
      if (sample.scalingStatus !== "validated") {
        exclude("Raw or unvalidated archived measurement excluded from report values.", sample.sourceName, sample.parameter);
        continue;
      }
      addRecord({
        id: stableReportRecordId({ source: sample.sourceName, siteName: sample.siteName, deviceId: sample.inverterId, parameter: sample.parameter, address: sample.address, observedAt: sample.observedAt.toISOString(), receivedAt: sample.receivedAt.toISOString(), value: sample.value }),
        recordType: "measurement",
        category,
        siteName: sample.siteName,
        deviceId: sample.inverterId,
        deviceName: sample.inverterName,
        parameter: sample.parameter,
        displayLabel: sample.displayLabel,
         measurementKind: sample.measurementKind,
        value: sample.value,
        unit: sample.unit,
        address: sample.address,
        sourceName: sample.sourceName,
        observedAt: sample.observedAt.toISOString(),
        receivedAt: sample.receivedAt.toISOString(),
        provenance: "historical-saved",
        quality: "validated",
        status: null,
        reason: null,
      });
    }

    for (const sample of energyRecords) {
      if (sample.scalingStatus !== "validated") {
        exclude("Raw or unvalidated energy record excluded from report values.", sample.sourceName, sample.parameter);
        continue;
      }
      addRecord({
        id: stableReportRecordId({ source: sample.sourceName, siteName: sample.siteName, deviceId: sample.inverterId, parameter: sample.parameter, address: sample.address, observedAt: sample.observedAt.toISOString(), receivedAt: sample.receivedAt.toISOString(), value: sample.value }),
        recordType: "energy",
        category: "energy",
        siteName: sample.siteName,
        deviceId: sample.inverterId,
        deviceName: sample.inverterName,
        parameter: sample.parameter,
        displayLabel: sample.parameter,
        value: sample.value,
        unit: sample.unit,
        address: sample.address,
        sourceName: sample.sourceName,
        observedAt: sample.observedAt.toISOString(),
        receivedAt: sample.receivedAt.toISOString(),
        provenance: "historical-saved",
        quality: "validated",
        status: null,
        reason: null,
      });
    }

    for (const event of communicationEvents) {
      addRecord({
        id: `communication|${event.id}`,
        recordType: "communication",
        category: "communication",
        siteName: siteName || configuredMqttPlantSite,
        deviceId: null,
        deviceName: null,
        parameter: event.eventType,
        displayLabel: "Communication event",
        value: event.durationMs,
        unit: event.durationMs === null ? "" : "ms",
        address: "—",
        sourceName: "MQTT delivery evidence",
        observedAt: event.receivedAt.toISOString(),
        receivedAt: event.receivedAt.toISOString(),
        provenance: "historical-saved",
        quality: "source-reported",
        status: event.eventType.includes("gap") || event.eventType.includes("interrupt") ? "warning" : null,
        reason: event.reason,
      });
    }

    if (latestMessage && (filters.provenance.length === 0 || filters.provenance.includes("live"))) {
      const parameter = parameterFromPayload(latestMessage.payload);
      const liveObservedAtMs = boundedLiveRecord ? Date.parse(boundedLiveRecord.observedAt) : undefined;
      const liveInRange = liveObservedAtMs !== undefined
        && Number.isFinite(liveObservedAtMs)
        && liveObservedAtMs >= rangeStart.getTime()
        && liveObservedAtMs <= rangeEnd.getTime();
      if (boundedLiveRecord && liveInRange && (!siteName || boundedLiveRecord.siteName === siteName)) {
        addRecord(boundedLiveRecord);
      } else if (!boundedLiveRecord && parameter) {
        const parameterObservedAt = parameterObservationTime(parameter);
        const parameterObservedAtMs = parameterObservedAt ? Date.parse(parameterObservedAt) : NaN;
        if (Number.isFinite(parameterObservedAtMs) && parameterObservedAtMs >= rangeStart.getTime() && parameterObservedAtMs <= rangeEnd.getTime()) {
          exclude("Live source value excluded until unit, semantic, and scaling are explicitly validated.", String(parameter.server_name ?? parameter.source ?? "Live MQTT"), String(parameter.name ?? "register"));
        }
      }
    }

    records.sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt));
    const numericRecords = records.filter((record) => record.value !== null && record.quality === "validated");
    const chartGroups = [...new Map(numericRecords.map((record) => [`${record.parameter}|${record.unit}|${record.deviceId ?? ""}`, record])).values()];
    const charts = chartGroups.slice(0, 6).map((chartSignal) => {
      const chartPoints = numericRecords
        .filter((record) => record.unit === chartSignal.unit && record.parameter === chartSignal.parameter && record.deviceId === chartSignal.deviceId)
        .slice(0, 80)
        .reverse()
        .map((record) => ({
          time: record.observedAt,
          value: record.value as number,
          label: record.deviceName ?? record.parameter,
        }));
      return chartPoints.length > 1
        ? { kind: "line" as const, title: `Validated ${chartSignal.displayLabel} trend`, unit: chartSignal.unit, data: chartPoints }
        : null;
    }).filter((chart): chart is { kind: "line"; title: string; unit: string; data: Array<{ time: string; value: number; label: string }> } => chart !== null);
    const latestEvidence = records.reduce<ScadaReportRecord | null>((latest, record) => {
      if (!latest) return record;
      return Date.parse(record.receivedAt) > Date.parse(latest.receivedAt) ? record : latest;
    }, null);
    const excludedByReason = [...new Map(excludedEvidence.map((item) => [item.reason, 0])).entries()].map(([reason]) => ({
      reason,
      count: excludedEvidence.filter((item) => item.reason === reason).length,
    }));
    const alarmRecords = records.filter((record) => record.recordType === "alarm");
    const communicationRecords = records.filter((record) => record.recordType === "communication");
    const uniqueDevices = new Set(records.map((record) => record.deviceId).filter(Boolean));

    res.set("Cache-Control", "no-store").json({
      title: reportTitle(reportType),
      category: reportType,
      siteName: siteName || configuredMqttPlantSite,
      period: { from: rangeStart.toISOString(), to: rangeEnd.toISOString(), label: `${rangeStart.toLocaleDateString("en-GB")} — ${rangeEnd.toLocaleDateString("en-GB")}` },
      generatedAt: new Date().toISOString(),
      sourceStatus: latestMessage ? "Live delivery remains active; report preview uses a separate read-only query." : "No current live payload; preview uses saved evidence only.",
      filters: { ...filters, reportType },
      summary: [
        { label: "Validated records", value: records.filter((record) => record.quality === "validated").length, unit: "", detail: "Engineering values with explicit source validation.", quality: "validated" },
        { label: "Source-reported events", value: records.filter((record) => record.quality === "source-reported").length, unit: "", detail: "Alarms and communication evidence are not engineering conversions.", quality: "source-reported" },
        { label: "Inverter/device context", value: uniqueDevices.size, unit: "", detail: "Explicitly identified devices in this report.", quality: "validated" },
        { label: "Excluded evidence", value: excludedEvidence.length, unit: "", detail: "Raw or unvalidated values are retained as exclusion context only.", quality: excludedEvidence.length ? "raw" : "validated" },
      ],
       charts,
       freshness: {
         latestObservedAt: latestEvidence?.observedAt ?? null,
         latestReceivedAt: latestEvidence?.receivedAt ?? null,
       },
      records: complete ? records : records.slice((page - 1) * pageSize, page * pageSize),
      pagination: {
        page: complete ? 1 : page,
        pageSize: complete ? records.length : pageSize,
        totalRecords: records.length,
        totalPages: complete ? 1 : Math.max(1, Math.ceil(records.length / pageSize)),
        complete,
      },
      excludedEvidence: { count: excludedEvidence.length, byReason: excludedByReason },
      alarmSummary: { reported: alarmRecords.length, sourceReported: alarmRecords.length, active: alarmRecords.filter((record) => record.status === "active").length },
      communicationSummary: { events: communicationRecords.length, warnings: communicationRecords.filter((record) => record.status === "warning").length },
      qualityNotes: [
        "Customer-facing report values are shown only when source identity, unit, semantic meaning, and scaling validation are explicit.",
        "Raw or unvalidated records are not converted, estimated, or shown as report values; they are counted as excluded evidence.",
        "Live, latest saved, and historical saved provenance are kept distinct for every included record.",
      ],
      attribution: "Powered by Automystics Technologies Pvt Ltd.",
    });
  } catch (error) {
    req.log.error({ err: error, reportType, siteName }, "SCADA report query failed");
    res.status(500).json({ message: "Unable to load the requested report evidence." });
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
    const parameter = parameterFromPayload(event.rawPayload);
    const inverterRecord = parameter
      ? inverterActivePowerObservationFromParameter(parameter, configuredMqttPlantSite)
      : undefined;
    recovered.set(event.deliverySequence, {
      topic: event.topic,
      payload: event.rawPayload,
      receivedAt: event.receivedAt.toISOString(),
      sequence: event.deliverySequence,
      sourceTimestamp: event.sourceTimestamp ?? undefined,
      inverterRecords: inverterRecord ? [inverterRecord] : undefined,
      delivery: isRecord(event.metadata) && event.metadata.delivery === "retained" ? "retained" : "immediate",
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

function bootstrapMessages(highWater: number) {
  return latestBootstrapMessages(
    messageHistory.filter((message) => message.sequence <= highWater),
    (message) => message.parameter ? snapshotParameterKey(message.parameter) : `raw:${message.sequence}`,
    SSE_BOOTSTRAP_MESSAGE_LIMIT,
  );
}

router.get("/mqtt/communication-events", async (req, res): Promise<void> => {
  const siteName = parseSiteName(req.query.siteName);
  if (siteName) {
    if (!await allowGrantedSite(req, res, siteName)) return;
  } else if (!await allowUnscopedScadaEvidence(req, res)) return;
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 50;
  try {
    const events = await db
      .select()
      .from(mqttCommunicationEventsTable)
      .where(eq(mqttCommunicationEventsTable.topic, subscriptionTopic))
      .orderBy(desc(mqttCommunicationEventsTable.receivedAt))
      .limit(limit * 4);
    const filteredEvents = siteName ? events.filter((event) => typeof event.rawPayload === "string" && payloadSiteName(parameterFromPayload(event.rawPayload)) === siteName).slice(0, limit) : events.slice(0, limit);
    res.set("Cache-Control", "no-store").json({ events: filteredEvents });
  } catch (error) {
    req.log.error({ err: error }, "MQTT communication events query failed");
    res.status(500).json({ message: "Unable to load MQTT communication evidence." });
  }
});

router.get("/mqtt/stream", async (req, res) => {
  const siteName = parseSiteName(req.query.siteName);
  if (siteName) {
    if (!await allowGrantedSite(req, res, siteName)) return;
  } else if (!await allowUnscopedScadaEvidence(req, res)) return;
  requestMqttConsumer();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const listenerState: SseListenerState = {
    siteName: siteName || undefined,
    pending: [] as string[],
    deferredMessages: [] as Array<{ event: string; data: unknown; eventId: number }>,
    paused: true,
    backpressured: false,
    flushing: false,
  };
  listeners.set(res, listenerState);
  send(res, "status", status());
  void latestSavedSnapshotEvidence(siteName || undefined)
    .then((snapshot) => {
      if (snapshot && listeners.has(res) && !res.writableEnded) send(res, "snapshot", snapshot);
    })
    .catch((error) => logger.warn({ err: error }, "Latest MQTT snapshot stream hydration failed"));

  const requestedAfter = parseDeliverySequence(req.get("Last-Event-ID"));
  const enqueueSiteMessage = (message: StoredMessage, replay: boolean, recovered: boolean) =>
    messageBelongsToSite(message, siteName || undefined)
      ? enqueueReplayFrame(res, listenerState, "message", { ...message, replay, recovered }, message.sequence)
      : Promise.resolve(true);
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
        // A first-time browser needs current source evidence, not every
        // historical broker frame. Replaying the full process buffer can
        // trigger proxy backpressure and an avoidable reconnect loop.
        for (const message of bootstrapMessages(highWater)) {
              if (!await enqueueSiteMessage(message, true, false)) return;
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
              if (!await enqueueSiteMessage(message, true, false)) return;
            }
          }
        } else {
          for (const message of recovered) {
            if (!await enqueueSiteMessage(message, false, true)) return;
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
        if (message.event !== "message" || messageBelongsToSite(message.data as StoredMessage, siteName || undefined)) {
          if (!await enqueueReplayFrame(res, listenerState, message.event, message.data, message.eventId)) return;
        }
      }
      listenerState.deferredMessages.length = 0;
      listenerState.paused = false;
      flushListener(res, listenerState);
      deliveredThrough = replayVerified ? replayHighWater : requestedAfter;
      recoveryComplete = true;
      if (listenerIsOpen(res)) {
        send(res, "ready", {
          state: "ready",
          replayVerified,
          recoveredThrough: deliveredThrough,
          bootstrap: requestedAfter === undefined,
        });
      }
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
        if (messageBelongsToSite(message, siteName || undefined)) send(res, "message", { ...message, replay: false, recovered: true }, message.sequence);
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

// Live consumption and scheduled persistence are server responsibilities.
// They must continue even when no operator has an SSE browser tab open.
requestMqttConsumer();

export default router;