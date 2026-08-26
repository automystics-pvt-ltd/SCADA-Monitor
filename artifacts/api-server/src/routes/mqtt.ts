import { Router, type IRouter, type Response } from "express";
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import mqtt, { type MqttClient } from "mqtt";
import { resolve } from "node:path";
import {
  db,
  mqttCommunicationEventsTable,
  mqttConsumerLeasesTable,
  mqttDeliverySequencesTable,
  mqttInverterEnergyHistoryTable,
  mqttInverterMeasurementHistoryTable,
  mqttSnapshotsTable,
  platformConfigurationTable,
  platformSitesTable,
  plantCalibrationProfilesTable,
  plantLocationsTable,
  platformTelemetryDiscoveriesTable,
  platformTelemetryMappingsTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { getScadaSessionId, getScadaSessionUserId } from "../lib/auth";
import { closeScadaSessionStreams, registerScadaSessionStream, unregisterScadaSessionStream } from "../lib/scada-session-streams";
import { requireScadaSession } from "../middlewares/authMiddleware";
import { allowGrantedSite, allowSitePermission, allowUnscopedScadaEvidence, grantedSiteNames, siteAccess } from "../middlewares/platformSiteAccess";
import { deviceCommunicationState, heartbeatWindows, latestBootstrapMessages, medianCadenceMs, recoveryNeedsResync, retainValidSourceTimestamp, sourceTimestampIso, sourceTimestampMilliseconds, telemetryParameterFromRawPayload } from "../lib/telemetry-reliability";
import { inverterActivePowerObservationFromParameter, inverterEnergyObservationFromParameter, inverterMeasurementObservationFromParameter, type InverterActivePowerObservation } from "../lib/inverter-energy";
import { applyTrn246TelemetryCalibration } from "../lib/trn246-telemetry-calibration";
import { canonicalTelemetrySourceIdentity, deviceParameterFreshness, discoverDeviceParameters, discoverDeviceParametersFromRawPayload, latestDeviceParameterWins, type DiscoveredDeviceParameter } from "../lib/device-parameter-discovery";
import { applyActiveTelemetryMappings } from "../lib/telemetry-mapping-resolution";
import { managedSourceIdentity, telemetryCaptureSite } from "../lib/telemetry-capture-site";
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
import { SnapshotOfflineQueue, type SnapshotOfflineQueueEntry } from "../lib/snapshot-offline-queue";

const router: IRouter = Router();
router.use("/mqtt", requireScadaSession);
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
let configuredManagedSiteFallback: string | undefined;

function payloadSiteName(payload: unknown) {
  return isRecord(payload) ? parseSiteName(payload.site_name ?? payload.siteName ?? payload.plant_name ?? payload.plantName) : "";
}

function messageBelongsToSite(message: StoredMessage, siteName?: string) {
  if (!siteName) return true;
  const parameter = message.parameter ?? parameterFromPayload(message.payload);
  const explicitSiteName = payloadSiteName(parameter);
  if (explicitSiteName) return explicitSiteName === siteName;
  return configuredManagedSiteFallback === siteName;
}

function snapshotBelongsToSite(snapshot: { data: unknown }, siteName?: string) {
  if (!siteName) return true;
  if (!isRecord(snapshot.data)) return false;
  const messages = Array.isArray(snapshot.data.messages) ? snapshot.data.messages : [];
  const parameters = [
    ...(Array.isArray(snapshot.data.latestParameters) ? snapshot.data.latestParameters : []),
    ...(Array.isArray(snapshot.data.parameters) ? snapshot.data.parameters : []),
  ];
  const discovered = Array.isArray(snapshot.data.latestDiscoveredParameters)
    ? snapshot.data.latestDiscoveredParameters
    : isRecord(snapshot.data.latestDiscoveredParameters)
      ? Object.values(snapshot.data.latestDiscoveredParameters)
      : [];
  return messages.some((message) => isRecord(message) && typeof message.payload === "string"
    && messageBelongsToSite({ ...message, sequence: 0, receivedAt: "", topic: "" } as StoredMessage, siteName))
    || parameters.some((parameter) => payloadSiteName(parameter) === siteName)
    || discovered.some((parameter) => isRecord(parameter) && (parameter.siteName === siteName || parameter.site_name === siteName));
}

export type StoredMessage = {
  topic: string;
  payload: string;
  parameter?: Record<string, unknown>;
  discoveredParameters?: DiscoveredDeviceParameter[];
  receivedAt: string;
  sequence: number;
  sourceTimestamp?: string;
  inverterRecords?: InverterActivePowerObservation[];
  delivery: "immediate" | "retained";
  // The site resolved for this exact delivery (explicit payload site, sole
  // managed site, or configured fallback). Scoped to snapshot persistence
  // only -- other consumers of `parameter` intentionally re-resolve site
  // identity themselves (see canonicalizeCapturedSnapshotParameter).
  captureSiteName: string;
};
export type LiveTelemetryDevice = {
  siteName: string;
  deviceId: string;
  deviceName: string;
  lastReceivedAt: string;
};
const activeTelemetryMappingCache = new Map<string, {
  expiresAt: number;
  mappings: typeof platformTelemetryMappingsTable.$inferSelect[];
}>();

/** Clears the short-lived resolver cache after an audited Admin map changes. */
export function invalidateTelemetryMappingCache() {
  activeTelemetryMappingCache.clear();
}

/**
 * The monitor resolves mapping overlays locally for long-lived and saved
 * evidence. Return the full approved display configuration, not only the
 * source identity, so that a saved map can produce the same display evidence
 * as the authoritative server resolver.
 */
export function scadaTelemetryMappingResponse(mapping: typeof platformTelemetryMappingsTable.$inferSelect) {
  return {
    id: mapping.id,
    deviceId: mapping.deviceId,
    sourceIdentity: mapping.sourceIdentity,
    sourceName: mapping.sourceName,
    normalizedName: mapping.normalizedName,
    address: mapping.address,
    destination: mapping.destination,
    displayLabel: mapping.displayLabel,
    category: mapping.category,
    inverterIdentity: mapping.inverterIdentity,
    sourceUnit: mapping.sourceUnit,
    displayUnit: mapping.displayUnit,
    scalingMultiplier: mapping.scalingMultiplier,
    scalingOffset: mapping.scalingOffset,
    scalingStatus: mapping.scalingStatus,
    version: mapping.version,
  };
}

async function activeTelemetryMappingsForSite(siteName: string) {
  const cached = activeTelemetryMappingCache.get(siteName);
  if (cached && cached.expiresAt > Date.now()) return cached.mappings;
  const mappings = await db.select().from(platformTelemetryMappingsTable).where(and(
    eq(platformTelemetryMappingsTable.siteName, siteName),
    eq(platformTelemetryMappingsTable.status, "active"),
  ));
  activeTelemetryMappingCache.set(siteName, { mappings, expiresAt: Date.now() + 5_000 });
  return mappings;
}
export type LiveTelemetryTestResult = {
  result: "success" | "no-telemetry" | "error";
  brokerStatus: string;
  subscriptionStatus: string;
  deviceStatus: string;
  topic: string;
  lastReceivedAt?: string;
  dataFrequencySeconds?: number;
  actualValue?: string;
  dataQuality: string;
  messageCount: number;
  communicationErrors: string[];
  evidence: Record<string, unknown>;
};
type TelemetryTestWaiter = {
  siteName: string;
  deviceId: string;
  acceptsConfiguredSiteFallback: boolean;
  resolve: (message: StoredMessage | undefined) => void;
  timer: NodeJS.Timeout;
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
  topic: string;
  timezone: string;
  messages: StoredMessage[];
  latestParameters: Record<string, Record<string, unknown>>;
  latestDiscoveredParameters: Record<string, DiscoveredDeviceParameter>;
};
type SnapshotOfflinePayload = {
  topic: string;
  timezone: string;
  buffer: {
    startedAt: string;
    slotKey: string;
    messages: StoredMessage[];
    latestParameters: Record<string, Record<string, unknown>>;
    latestDiscoveredParameters: Record<string, DiscoveredDeviceParameter>;
  };
};
type SnapshotSaveStatus = "saved" | "missing" | "incomplete";
type SavedKpiMetric = {
  parameter: string;
  value: number;
  rawData: string;
  address: string;
  sourceTimestamp?: string;
  sourceReportedValue?: string;
  sourceReportedUnit?: string;
  transportRawValue?: string;
  sourceIdentity?: string;
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

export type SavedParameterEvidence = Record<string, unknown> & {
  sourceIdentity: string;
  originalName: string;
  normalizedName: string;
  displayLabel: string;
  originalValue: string;
  transportRawValue: string | null;
  sourceReportedValue: string | null;
  normalizedValue: number | null;
  sourceUnit: string | null;
  displayUnit: string | null;
  dataQuality: "validated" | "raw" | "source-reported";
  scalingStatus: "validated" | "raw";
  validationStatus: "validated" | "raw";
  observedAt?: string;
  receivedAt?: string;
  siteName?: string;
  deviceId?: string;
  deviceName?: string;
  sourceName: string;
  address: string;
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
  installedDcCapacityKwp: number | null;
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
const telemetryTestWaiters = new Set<TelemetryTestWaiter>();
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
const snapshotOfflineQueue = new SnapshotOfflineQueue<SnapshotOfflinePayload>(
  process.env.SCADA_SNAPSHOT_QUEUE_PATH
    ?? resolve(process.cwd(), ".runtime", "mqtt-snapshot-offline-queue.json"),
);
let offlineQueuedSnapshotCount = 0;
let offlineQueuedMessageCount = 0;

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

export function broadcastSiteActivation(siteName: string, activationStatus: "active" | "inactive", changedAt: string) {
  for (const [listener, state] of listeners) {
    if (state.siteName !== siteName) continue;
    send(listener, "site-activation", { siteName, activationStatus, changedAt });
    if (activationStatus === "inactive") {
      listener.end();
      listeners.delete(listener);
    }
  }
}

/**
 * Mapping updates do not wait for the next broker frame. Connected SCADA
 * sessions for the affected site reload their active mapping set immediately.
 */
export function broadcastTelemetryMappingChange(siteName: string, changedAt: string) {
  for (const [listener, state] of listeners) {
    if (state.siteName !== siteName) continue;
    send(listener, "telemetry-mapping", { siteName, changedAt });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicCalibrationProfile(record: {
  siteName: string;
  version: string;
  status: string;
  installedDcCapacityKwp: number | null;
  sources: unknown;
  approvedBy: string;
  approvedAt: Date;
}): PublicPlantCalibrationProfile | null {
  if (record.status !== "approved" || !Array.isArray(record.sources)) return null;
  const sources = parseCalibrationSources(record.sources);
  const installedDcCapacityKwp = typeof record.installedDcCapacityKwp === "number" && Number.isFinite(record.installedDcCapacityKwp) && record.installedDcCapacityKwp > 0
    ? record.installedDcCapacityKwp
    : null;
  if (!sources) return null;
  return {
    siteName: record.siteName,
    version: record.version,
    status: "approved",
    installedDcCapacityKwp,
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

export function parameterFromPayload(rawPayload: string): Record<string, unknown> | undefined {
  const parameter = telemetryParameterFromRawPayload(rawPayload);
  return parameter ? applyTrn246TelemetryCalibration(parameter) : undefined;
}

function sourceTimestampFromPayload(rawPayload: string) {
  const parameter = parameterFromPayload(rawPayload);
  return parameter ? parameterObservationTime(parameter) : undefined;
}

export function snapshotParameterKey(parameter: Record<string, unknown>) {
  // Keep every live source/register tuple available until the scheduled save.
  // `addr` is absent on some Modbus payloads, while `full_addr` and source
  // identity still distinguish separate raw signals.
  return savedParameterEvidenceIdentity(parameter);
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

function emptySnapshotBuffer(startedAt: Date, key: string, topic = subscriptionTopic, timezone = plantTimezone): SnapshotBuffer {
  return {
    startedAt,
    slotKey: key,
    topic,
    timezone,
    messages: [],
    latestParameters: {},
    latestDiscoveredParameters: {},
  };
}

function snapshotRetryId(topic: string, scheduledFor: Date) {
  return `scheduled:${Buffer.from(`${topic}\u0000${scheduledFor.toISOString()}`).toString("base64url")}`;
}

function snapshotOfflinePayload(buffer: SnapshotBuffer): SnapshotOfflinePayload {
  return {
    topic: buffer.topic,
    timezone: buffer.timezone,
    buffer: {
      startedAt: buffer.startedAt.toISOString(),
      slotKey: buffer.slotKey,
      messages: buffer.messages,
      latestParameters: buffer.latestParameters,
      latestDiscoveredParameters: buffer.latestDiscoveredParameters,
    },
  };
}

function snapshotBufferFromOfflinePayload(payload: SnapshotOfflinePayload): SnapshotBuffer | undefined {
  if (!isRecord(payload) || typeof payload.topic !== "string" || !payload.topic || typeof payload.timezone !== "string" || !isRecord(payload.buffer)) return undefined;
  const startedAt = new Date(String(payload.buffer.startedAt ?? ""));
  if (!Number.isFinite(startedAt.getTime()) || typeof payload.buffer.slotKey !== "string") return undefined;
  if (!Array.isArray(payload.buffer.messages) || !isRecord(payload.buffer.latestParameters) || !isRecord(payload.buffer.latestDiscoveredParameters)) return undefined;
  return {
    startedAt,
    slotKey: payload.buffer.slotKey,
    topic: payload.topic,
    timezone: validTimezone(payload.timezone),
    messages: payload.buffer.messages as StoredMessage[],
    latestParameters: payload.buffer.latestParameters as Record<string, Record<string, unknown>>,
    latestDiscoveredParameters: payload.buffer.latestDiscoveredParameters as Record<string, DiscoveredDeviceParameter>,
  };
}

function queuedSnapshotMessageCount(entries: SnapshotOfflineQueueEntry<SnapshotOfflinePayload>[]) {
  return entries.reduce((total, entry) => total + (Array.isArray(entry.payload.buffer?.messages) ? entry.payload.buffer.messages.length : 0), 0);
}

function setOfflineQueueMetrics(entries: SnapshotOfflineQueueEntry<SnapshotOfflinePayload>[]) {
  offlineQueuedSnapshotCount = entries.length;
  offlineQueuedMessageCount = queuedSnapshotMessageCount(entries);
}

async function stageSnapshotForRetry(buffer: SnapshotBuffer, scheduledFor: Date) {
  const entry: SnapshotOfflineQueueEntry<SnapshotOfflinePayload> = {
    id: snapshotRetryId(buffer.topic, scheduledFor),
    scheduledFor: scheduledFor.toISOString(),
    queuedAt: new Date().toISOString(),
    payload: snapshotOfflinePayload(buffer),
  };
  const entries = await snapshotOfflineQueue.upsert(entry);
  setOfflineQueueMetrics(entries);
  return { entry, entries };
}

async function removeStagedSnapshot(entryId: string) {
  const entries = await snapshotOfflineQueue.remove(entryId);
  setOfflineQueueMetrics(entries);
}

async function clearStagedSnapshotAfterConfirmation(entryId: string, scheduledFor: string) {
  try {
    await removeStagedSnapshot(entryId);
  } catch (error) {
    snapshotError = "Snapshot is saved, but local retry-queue cleanup is pending.";
    logger.warn({ err: error, scheduledFor }, "MQTT snapshot retry queue cleanup failed");
    broadcast("status", status());
  }
}

function numericParameterValue(parameter: Record<string, unknown>) {
  const evidence = sourceReportedEvidence(parameter);
  const candidate = evidence.isSourceReported ? evidence.sourceReportedValue : parameter.data;
  const value = typeof candidate === "number" ? candidate : typeof candidate === "string" ? Number(candidate) : NaN;
  return Number.isFinite(value) ? value : null;
}

function sourceReportedEvidence(parameter: Record<string, unknown>) {
  const mappingStatus = parameter.source_mapping_status ?? parameter.sourceMappingStatus;
  const rawMapping = mappingStatus !== undefined && mappingStatus !== null && mappingStatus !== "" && mappingStatus !== "source-reported";
  const reportedValue = rawMapping ? undefined : parameter.reported_value ?? parameter.reportedValue ?? parameter.customer_value ?? parameter.customerValue ?? parameter.engineering_value ?? parameter.engineeringValue;
  const reportedUnit = rawMapping ? undefined : parameter.reported_unit ?? parameter.reportedUnit ?? parameter.customer_unit ?? parameter.customerUnit ?? parameter.source_unit ?? parameter.sourceUnit ?? parameter.engineering_unit ?? parameter.engineeringUnit;
  const transportRawValue = parameter.raw_data ?? parameter.rawValue ?? parameter.raw_value ?? parameter.source_raw_value ?? parameter.sourceRawValue;
  return {
    sourceReportedValue: reportedValue === undefined || reportedValue === null ? null : String(reportedValue),
    sourceReportedUnit: reportedUnit === undefined || reportedUnit === null ? null : String(reportedUnit),
    transportRawValue: transportRawValue === undefined || transportRawValue === null ? null : String(transportRawValue),
    sourceIdentity: typeof parameter.source_identity === "string" ? parameter.source_identity : typeof parameter.sourceIdentity === "string" ? parameter.sourceIdentity : null,
    isSourceReported: reportedValue !== undefined && reportedValue !== null,
  };
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
    ...Object.fromEntries(Object.entries(sourceReportedEvidence(latest.parameter)).filter(([key, value]) => key !== "isSourceReported" && value !== null)) as Pick<SavedKpiMetric, "sourceReportedValue" | "sourceReportedUnit" | "transportRawValue" | "sourceIdentity">,
  };
}

export function normalizeSavedSnapshotParameter(parameter: Record<string, unknown>) {
  // Schema-v4 snapshots retain discovered parameters as a presentation-oriented
  // shape. Normalize it at the persistence boundary so KPI and report consumers
  // receive the same source evidence aliases as live MQTT parameters.
  return {
    ...parameter,
    name: parameter.name ?? parameter.parameter ?? parameter.originalName,
    data: parameter.data ?? parameter.rawValue ?? parameter.value,
    raw_data: parameter.raw_data ?? parameter.rawValue ?? parameter.raw_value,
    full_addr: parameter.full_addr ?? parameter.address ?? parameter.addr,
    date_iso_8601: parameter.date_iso_8601 ?? parameter.observedAt,
    timestamp: parameter.timestamp ?? parameter.observedAt,
    reported_value: parameter.reported_value ?? parameter.reportedValue,
    reported_unit: parameter.reported_unit ?? parameter.reportedUnit ?? parameter.sourceUnit,
    source_unit: parameter.source_unit ?? parameter.sourceUnit,
    source_identity: parameter.source_identity ?? parameter.sourceIdentity,
    source_mapping_status: parameter.source_mapping_status ?? parameter.sourceMappingStatus,
    server_name: parameter.server_name ?? parameter.sourceName,
  };
}

function evidenceString(value: unknown) {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : String(value);
}

function firstEvidenceString(...values: unknown[]) {
  for (const value of values) {
    const text = evidenceString(value);
    if (text !== null && text.trim()) return text;
  }
  return null;
}

function normalizedEvidenceName(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function savedParameterEvidenceIdentity(parameter: Record<string, unknown>) {
  const sourceIdentity = firstEvidenceString(parameter.sourceIdentity, parameter.source_identity);
  if (sourceIdentity) return sourceIdentity;
  const siteName = firstEvidenceString(parameter.siteName, parameter.site_name, parameter.plantName, parameter.plant_name) ?? "";
  const sourceName = firstEvidenceString(parameter.sourceName, parameter.server_name, parameter.source, parameter.server) ?? "Saved MQTT snapshot";
  const originalName = firstEvidenceString(parameter.originalName, parameter.name, parameter.parameter, parameter.tag) ?? "register";
  const address = firstEvidenceString(parameter.address, parameter.full_addr, parameter.addr) ?? "—";
  return `${siteName}|${sourceName}|${normalizedEvidenceName(originalName)}|${address}`;
}

function savedParameterObservation(parameter: Record<string, unknown>) {
  return firstEvidenceString(parameter.observedAt, parameter.date_iso_8601, parameter.timestamp, parameter.date);
}

/**
 * A schema-v4 record is an immutable source-evidence envelope. The aliases
 * keep legacy KPI consumers working, while the explicit fields give every new
 * saved-data consumer one honest contract: source value, transport value,
 * approved normalized value, quality, validation and provenance are distinct.
 */
export function canonicalSavedSnapshotParameter(input: Record<string, unknown>): SavedParameterEvidence {
  const parameter: Record<string, unknown> = normalizeSavedSnapshotParameter(input);
  const originalName = firstEvidenceString(parameter.originalName, parameter.name, parameter.parameter, parameter.tag) ?? "register";
  const sourceReportedValue = firstEvidenceString(
    parameter.reported_value, parameter.reportedValue,
    parameter.customer_value, parameter.customerValue,
    parameter.engineering_value, parameter.engineeringValue,
  );
  const transportRawValue = firstEvidenceString(
    parameter.transportRawValue, parameter.transport_raw_value,
    parameter.raw_data, parameter.rawValue, parameter.raw_value,
    parameter.source_raw_value, parameter.sourceRawValue,
  );
  const declaredValue = sourceReportedValue ?? firstEvidenceString(parameter.data, parameter.value);
  const rawScaling = String(parameter.scalingStatus ?? parameter.scaling_status ?? "").toLowerCase() === "validated"
    || String(parameter.validationStatus ?? parameter.validation_status ?? "").toLowerCase() === "validated"
    || parameter.scaling_validated === true
    || parameter.scalingValidated === true;
  const sourceMappingStatus = String(parameter.source_mapping_status ?? parameter.sourceMappingStatus ?? "").toLowerCase();
  const dataQuality = rawScaling
    ? "validated" as const
    : sourceMappingStatus === "source-reported" || sourceReportedValue !== null
      ? "source-reported" as const
      : "raw" as const;
  const displayCandidate = parameter.displayNumericValue ?? parameter.display_value ?? parameter.normalizedValue;
  const sourceCandidate = sourceReportedValue ?? parameter.value;
  const candidate = rawScaling ? displayCandidate ?? sourceCandidate : null;
  const normalizedValue = typeof candidate === "number"
    ? candidate
    : typeof candidate === "string" && candidate.trim() !== "" && Number.isFinite(Number(candidate))
      ? Number(candidate)
      : null;
  const sourceUnit = firstEvidenceString(
    parameter.sourceUnit, parameter.source_unit,
    parameter.reported_unit, parameter.reportedUnit,
    parameter.customer_unit, parameter.customerUnit,
  );
  const displayUnit = firstEvidenceString(parameter.displayUnit, parameter.display_unit, parameter.unit, parameter.engineering_unit, parameter.engineeringUnit);
  const observedAt = savedParameterObservation(parameter) ?? undefined;
  const receivedAt = firstEvidenceString(parameter.receivedAt, parameter.received_at) ?? undefined;
  const siteName = firstEvidenceString(parameter.siteName, parameter.site_name, parameter.plantName, parameter.plant_name) ?? undefined;
  const deviceId = firstEvidenceString(parameter.deviceId, parameter.device_id, parameter.inverterId, parameter.inverter_id) ?? undefined;
  const deviceName = firstEvidenceString(parameter.deviceName, parameter.device_name, parameter.inverterName, parameter.inverter_name) ?? undefined;
  const sourceName = firstEvidenceString(parameter.sourceName, parameter.server_name, parameter.source, parameter.server) ?? "Saved MQTT snapshot";
  const address = firstEvidenceString(parameter.address, parameter.full_addr, parameter.addr) ?? "—";

  return {
    ...parameter,
    sourceIdentity: savedParameterEvidenceIdentity(parameter),
    originalName,
    normalizedName: firstEvidenceString(parameter.normalizedName) ?? normalizedEvidenceName(originalName),
    displayLabel: firstEvidenceString(parameter.displayLabel, parameter.display_name, parameter.displayName, parameter.label) ?? originalName,
    originalValue: declaredValue ?? transportRawValue ?? "",
    transportRawValue,
    sourceReportedValue,
    normalizedValue,
    sourceUnit,
    displayUnit,
    dataQuality,
    scalingStatus: rawScaling ? "validated" : "raw",
    validationStatus: rawScaling ? "validated" : "raw",
    ...(observedAt ? { observedAt } : {}),
    ...(receivedAt ? { receivedAt } : {}),
    ...(siteName ? { siteName } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(deviceName ? { deviceName } : {}),
    sourceName,
    address,
    // Legacy consumers need these transport aliases; normalized engineering
    // values remain separate and are never substituted into raw evidence.
    name: parameter.name ?? originalName,
    raw_data: parameter.raw_data ?? transportRawValue ?? "",
    full_addr: parameter.full_addr ?? address,
    source_identity: parameter.source_identity ?? savedParameterEvidenceIdentity(parameter),
    source_mapping_status: parameter.source_mapping_status ?? parameter.sourceMappingStatus ?? (sourceReportedValue !== null ? "source-reported" : "raw"),
    reported_value: parameter.reported_value ?? sourceReportedValue ?? undefined,
    reported_unit: parameter.reported_unit ?? sourceUnit ?? undefined,
    source_unit: parameter.source_unit ?? sourceUnit ?? undefined,
  };
}

export function canonicalSavedSnapshotParameters(data: unknown) {
  if (!isRecord(data)) return [] as SavedParameterEvidence[];
  const discovered = Array.isArray(data.latestDiscoveredParameters)
    ? data.latestDiscoveredParameters
    : isRecord(data.latestDiscoveredParameters) ? Object.values(data.latestDiscoveredParameters) : [];
  const raw = Array.isArray(data.latestParameters)
    ? data.latestParameters
    : isRecord(data.latestParameters) ? Object.values(data.latestParameters) : [];
  const latest = new Map<string, SavedParameterEvidence>();
  for (const candidate of [...raw, ...discovered]) {
    if (!isRecord(candidate)) continue;
    const normalized = normalizeSavedSnapshotParameter(candidate);
    const calibrated = {
      ...applyTrn246TelemetryCalibration(normalized),
      // Calibration may add presentation annotations, but a saved source
      // identity is part of the original record and must never be rewritten.
      source_identity: normalized.source_identity,
    };
    const parameter = canonicalSavedSnapshotParameter(calibrated);
    const existing = latest.get(parameter.sourceIdentity);
    const incomingTime = sourceTimestampMilliseconds(parameter.observedAt ?? parameter.receivedAt) ?? 0;
    const existingTime = existing ? sourceTimestampMilliseconds(existing.observedAt ?? existing.receivedAt) ?? 0 : -1;
    if (!existing || incomingTime >= existingTime) latest.set(parameter.sourceIdentity, parameter);
  }
  return [...latest.values()].sort((left, right) =>
    left.displayLabel.localeCompare(right.displayLabel)
    || left.sourceIdentity.localeCompare(right.sourceIdentity),
  );
}

function snapshotSaveStatus(data: unknown, messageCount: number, parameterCount: number): SnapshotSaveStatus {
  if (isRecord(data) && data.saveStatus === "missing") return "missing";
  if (isRecord(data) && data.saveStatus === "incomplete") return "incomplete";
  if (!messageCount) return "missing";
  return parameterCount ? "saved" : "incomplete";
}

export function snapshotEvidence(snapshot: {
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
  const parameters = canonicalSavedSnapshotParameters(data);
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

export function persistenceSchedule(now: Date) {
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

export function isPersistenceWindowOpen(now: Date) {
  return persistenceSchedule(now).collecting;
}

export function canWriteScheduledSnapshot(
  now: Date,
  scheduledFor: Date,
  allowFinalBoundaryClose = false,
) {
  if (isPersistenceWindowOpen(now)) return true;
  if (!allowFinalBoundaryClose) return false;

  const currentLocal = zonedParts(now, plantTimezone);
  const scheduledLocal = zonedParts(scheduledFor, plantTimezone);
  return currentLocal.year === scheduledLocal.year
    && currentLocal.month === scheduledLocal.month
    && currentLocal.day === scheduledLocal.day
    && currentLocal.hour * 60 + currentLocal.minute === PERSISTENCE_END_MINUTE
    && scheduledFor.getTime() === localBoundary(scheduledLocal, PERSISTENCE_END_MINUTE).getTime();
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
  if (parameter) {
    const canonicalParameter = canonicalizeCapturedSnapshotParameter(parameter, message);
    snapshotBuffer.latestParameters[snapshotParameterKey(canonicalParameter)] = canonicalParameter;
  }
  for (const discovered of message.discoveredParameters ?? []) {
    snapshotBuffer.latestDiscoveredParameters[discovered.signalKey] = discovered;
  }
}

/**
 * A raw MQTT/Modbus parameter has no resolved site identity of its own -- an
 * unscoped broker feed only gets one once `captureMqttMessage` resolves it.
 * Discovery stamps that resolved site into every discovered parameter's
 * identity, but the raw representation of the exact same physical register
 * previously kept whatever (often absent, or calibration-only) identity it
 * was parsed with. Left alone, the two representations of one register never
 * collapse into a single saved record. Stamp the same site-qualified
 * identity discovery would compute so `canonicalSavedSnapshotParameters` can
 * merge them onto one row instead of saving duplicates.
 */
export function canonicalizeCapturedSnapshotParameter(parameter: Record<string, unknown>, message: StoredMessage) {
  const canonical = canonicalTelemetrySourceIdentity(parameter, {
    siteName: message.captureSiteName,
    topic: message.topic,
    receivedAt: message.receivedAt,
    provenance: message.delivery === "retained" ? "retained" : "live",
  });
  if (!canonical) return parameter;
  return {
    ...parameter,
    site_name: message.captureSiteName,
    source_identity: canonical.sourceIdentity,
    sourceIdentity: canonical.sourceIdentity,
  };
}

function snapshotOutcome(buffer: SnapshotBuffer) {
  if (!buffer.messages.length) {
    return {
      saveStatus: "missing" as const,
      missingReason: "No MQTT telemetry was available in this completed scheduled window.",
    };
  }
  if (!Object.keys(buffer.latestParameters).length && !Object.keys(buffer.latestDiscoveredParameters).length) {
    return {
      saveStatus: "incomplete" as const,
      missingReason: "MQTT messages arrived, but none contained a valid telemetry parameter.",
    };
  }
  return { saveStatus: "saved" as const, missingReason: undefined };
}

async function persistSnapshot(
  buffer: SnapshotBuffer,
  scheduledFor: Date,
  savedAt = new Date(),
  existingQueueEntry?: SnapshotOfflineQueueEntry<SnapshotOfflinePayload>,
  allowFinalBoundaryClose = false,
) {
  if (!canWriteScheduledSnapshot(new Date(), scheduledFor, allowFinalBoundaryClose)) return false;
  const scheduledForIso = scheduledFor.toISOString();
  let queuedEntry = existingQueueEntry;
  let queuedEntries: SnapshotOfflineQueueEntry<SnapshotOfflinePayload>[];
  try {
    if (queuedEntry) {
      queuedEntries = await snapshotOfflineQueue.list();
      setOfflineQueueMetrics(queuedEntries);
    } else {
      const staged = await stageSnapshotForRetry(buffer, scheduledFor);
      queuedEntry = staged.entry;
      queuedEntries = staged.entries;
    }
  } catch (error) {
    snapshotError = "Snapshot could not be placed in the local retry queue.";
    logger.error({ err: error, scheduledFor: scheduledForIso }, "MQTT snapshot retry queue write failed");
    broadcast("status", status());
    return false;
  }

  const olderQueuedSnapshot = queuedEntries.find((candidate) =>
    candidate.id !== queuedEntry!.id
    && candidate.payload.topic === buffer.topic
    && Date.parse(candidate.scheduledFor) < scheduledFor.getTime());
  if (olderQueuedSnapshot) {
    snapshotError = "A prior scheduled snapshot is awaiting backend confirmation; queued snapshots will sync in chronological order.";
    broadcast("status", status());
    return false;
  }

  try {
    const outcome = snapshotOutcome(buffer);
    const calibrationProfile = await currentPlantCalibrationProfile();
    if (!canWriteScheduledSnapshot(new Date(), scheduledFor, allowFinalBoundaryClose)) {
      // The queue entry remains durable for the next daytime window. Do not
      // turn a retry admitted before close into an overnight database write.
      return false;
    }
    const [inserted] = await db.insert(mqttSnapshotsTable).values({
      windowStartedAt: buffer.startedAt,
      windowEndedAt: scheduledFor,
      capturedAt: savedAt,
      topic: buffer.topic,
      messageCount: buffer.messages.length,
      parameterCount: canonicalSavedSnapshotParameters({
        latestParameters: buffer.latestParameters,
        latestDiscoveredParameters: buffer.latestDiscoveredParameters,
      }).length,
      data: {
        schemaVersion: 4,
        recordType: "scheduled-telemetry-snapshot",
        saveStatus: outcome.saveStatus,
        missingReason: outcome.missingReason,
        scheduledFor: scheduledForIso,
        capturedAt: savedAt.toISOString(),
        timezone: buffer.timezone,
        messages: buffer.messages,
        latestParameters: Object.values(buffer.latestParameters),
        latestDiscoveredParameters: Object.values(buffer.latestDiscoveredParameters),
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
        .where(and(eq(mqttSnapshotsTable.topic, buffer.topic), eq(mqttSnapshotsTable.windowEndedAt, scheduledFor)))
        .limit(10);
      const existing = existingCandidates.find((candidate) => isRecord(candidate.data) && candidate.data.schemaVersion === 4);
      if (existing) {
        const evidence = snapshotEvidence(existing);
        setLastSnapshot(evidence);
        snapshotError = undefined;
        broadcast("snapshot", evidence);
        broadcast("status", status());
        await clearStagedSnapshotAfterConfirmation(queuedEntry.id, scheduledForIso);
      }
      return true;
    }

    const evidence = snapshotEvidence(inserted);
    setLastSnapshot(evidence);
    snapshotError = undefined;
    broadcast("snapshot", evidence);
    broadcast("status", status());
    await clearStagedSnapshotAfterConfirmation(queuedEntry.id, scheduledForIso);
    logger.info({ scheduledFor: scheduledForIso, saveStatus: outcome.saveStatus, messageCount: buffer.messages.length, parameterCount: inserted.parameterCount }, "MQTT snapshot stored");
    return true;
  } catch (error) {
    snapshotError = error instanceof Error ? error.message : "Snapshot write failed";
    logger.error({ err: error, scheduledFor: scheduledForIso }, "MQTT snapshot write failed; staged retry remains available");
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

type SavedParameterHistorySnapshot = {
  id: number;
  topic: string;
  windowStartedAt: Date;
  windowEndedAt: Date;
  capturedAt: Date;
  messageCount: number;
  parameterCount: number;
  data: unknown;
};

export type SavedParameterHistoryRecord = SavedParameterEvidence & {
  snapshotId: number;
  scheduledFor: string;
  capturedAt: string;
  windowStartedAt: string;
  windowEndedAt: string;
  provenance: "saved-snapshot";
};

function savedParameterBelongsToSite(parameter: SavedParameterEvidence, siteName: string) {
  const explicitSite = parameter.siteName ?? payloadSiteName(parameter);
  return !explicitSite || explicitSite === siteName;
}

/**
 * Flatten immutable successful snapshots into a bounded saved-only history.
 * Dedupe is intentionally per scheduled record: a stable signal can appear in
 * later snapshots so that charts retain their complete temporal evidence.
 */
export function pageSavedParameterHistory(
  snapshots: SavedParameterHistorySnapshot[],
  options: { siteName: string; page: number; pageSize: number },
) {
  const records = snapshots.flatMap((snapshot) => {
    if (!snapshotBelongsToSite(snapshot, options.siteName)) return [] as SavedParameterHistoryRecord[];
    const evidence = snapshotEvidence(snapshot);
    if (evidence.saveStatus !== "saved") return [] as SavedParameterHistoryRecord[];
    return evidence.parameters
      .filter((parameter): parameter is SavedParameterEvidence => isRecord(parameter))
      .filter((parameter) => savedParameterBelongsToSite(parameter, options.siteName))
      .map((parameter) => ({
        ...parameter,
        snapshotId: evidence.id,
        scheduledFor: evidence.scheduledFor,
        capturedAt: evidence.capturedAt,
        windowStartedAt: evidence.windowStartedAt,
        windowEndedAt: evidence.windowEndedAt,
        provenance: "saved-snapshot" as const,
      }));
  }).sort((left, right) => {
    const leftTime = sourceTimestampMilliseconds(left.observedAt ?? left.capturedAt) ?? 0;
    const rightTime = sourceTimestampMilliseconds(right.observedAt ?? right.capturedAt) ?? 0;
    return rightTime - leftTime
      || right.capturedAt.localeCompare(left.capturedAt)
      || left.sourceIdentity.localeCompare(right.sourceIdentity);
  });
  const start = (options.page - 1) * options.pageSize;
  return {
    total: records.length,
    records: records.slice(start, start + options.pageSize),
  };
}

async function reconcileCompletedWindows(now = new Date()) {
  const { schedule, boundaries } = completedWindowBoundaries(now);
  if (!schedule.collecting) return;
  if (reconciledScheduleDate === schedule.localDate) return;

  for (const boundary of boundaries) {
    if (!isPersistenceWindowOpen(new Date())) return;
    const windowStartedAt = new Date(boundary.getTime() - PERSISTENCE_INTERVAL_MINUTES * 60_000);
    const saved = await persistSnapshot(emptySnapshotBuffer(windowStartedAt, slotKey(zonedParts(windowStartedAt, plantTimezone))), boundary, now);
    if (!saved) return;
  }
  reconciledScheduleDate = schedule.localDate;
}

async function retryFailedSnapshots() {
  while (true) {
    if (!isPersistenceWindowOpen(new Date())) return;
    let entry: SnapshotOfflineQueueEntry<SnapshotOfflinePayload> | undefined;
    try {
      const entries = await snapshotOfflineQueue.list();
      setOfflineQueueMetrics(entries);
      entry = entries[0];
    } catch (error) {
      snapshotError = "Snapshot retry queue could not be read.";
      logger.error({ err: error }, "MQTT snapshot retry queue read failed");
      return;
    }
    if (!entry) return;
    const buffer = snapshotBufferFromOfflinePayload(entry.payload);
    const scheduledFor = new Date(entry.scheduledFor);
    if (!buffer || !Number.isFinite(scheduledFor.getTime())) {
      snapshotError = "A corrupt snapshot retry entry needs operator review.";
      logger.error({ entryId: entry.id }, "MQTT snapshot retry entry could not be restored");
      return;
    }
    if (!isPersistenceWindowOpen(new Date())) return;
    const stored = await persistSnapshot(buffer, scheduledFor, new Date(), entry);
    if (!stored) return;
  }
}

async function runSnapshotSchedule(now = new Date()) {
  const schedule = persistenceSchedule(now);
  await retryFailedSnapshots();
  if (schedule.collecting) {
    if (!snapshotBuffer) snapshotBuffer = emptySnapshotBuffer(schedule.currentSlotStart, schedule.currentSlotKey);
    else if (snapshotBuffer.slotKey !== schedule.currentSlotKey) {
      const previousBuffer = snapshotBuffer;
      snapshotBuffer = emptySnapshotBuffer(schedule.currentSlotStart, schedule.currentSlotKey);
      await persistSnapshot(previousBuffer, schedule.currentSlotStart, now);
    }
  } else if (schedule.minutes === PERSISTENCE_END_MINUTE && snapshotBuffer) {
    const lastBoundary = localDateTimeToUtc({ ...schedule.local, hour: 18, minute: 0, second: 0 }, plantTimezone);
    const previousBuffer = snapshotBuffer;
    snapshotBuffer = undefined;
    await persistSnapshot(previousBuffer, lastBoundary, now, undefined, true);
  } else if (schedule.minutes > PERSISTENCE_END_MINUTE || schedule.minutes < PERSISTENCE_START_MINUTE) {
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
  if (process.env.NODE_ENV === "test") return;
  void loadRuntimeConfiguration()
    .then(() => soleManagedSiteForConfiguredFallback())
    .then(() => {
      startSnapshotTimer();
      startCommunicationTimer();
      void renewConsumerLease();
      if (!consumerLeaseTimer) {
        consumerLeaseTimer = setInterval(() => void renewConsumerLease(), MQTT_CONSUMER_LEASE_RENEWAL_MS);
      }
    })
    .catch((error) => logger.warn({ err: error }, "MQTT runtime configuration or managed-site attribution could not be loaded"));
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
      scheduleState: schedule.collecting ? "active" : "paused",
      currentWindow: snapshotBuffer?.slotKey,
      nextScheduledAt: schedule.nextScheduledAt.toISOString(),
      resumeAt: schedule.nextScheduledAt.toISOString(),
      pendingMessages: (snapshotBuffer?.messages.length ?? 0) + offlineQueuedMessageCount,
      offlineQueuedSnapshots: offlineQueuedSnapshotCount,
      offlineQueuedMessages: offlineQueuedMessageCount,
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

function deviceFromMessage(message: StoredMessage): LiveTelemetryDevice | undefined {
  const parameter = message.parameter ?? parameterFromPayload(message.payload);
  if (!parameter) return undefined;
  const inverter = message.inverterRecords?.[0];
  const sourceName = sourceText(parameter, ["server_name", "serverName", "source_name", "sourceName", "source"]);
  const sourceId = sourceText(parameter, ["server_id", "serverId", "source_id", "sourceId"])
    ?? ["server_id", "serverId", "source_id", "sourceId"]
      .map((key) => parameter[key])
      .find((value): value is number => typeof value === "number" && Number.isFinite(value))
      ?.toString();
  const deviceId = inverter?.inverterId
    ?? sourceText(parameter, ["inverter_id", "inverterId", "device_id", "deviceId", "device", "id"])
    ?? (sourceName && sourceId ? `${sourceName}:${sourceId}` : sourceName ?? sourceId);
  if (!deviceId) return undefined;
  const deviceName = inverter?.inverterName
    ?? (sourceName && sourceId ? `${sourceName} · source ${sourceId}` : sourceName ?? sourceId)
    ?? sourceText(parameter, ["inverter_name", "inverterName", "device_name", "deviceName", "name"])
    ?? deviceId;
  const siteName = payloadSiteName(parameter) || configuredMqttPlantSite;
  return { siteName, deviceId, deviceName, lastReceivedAt: message.receivedAt };
}

function messageHasExplicitSiteName(message: StoredMessage) {
  const parameter = message.parameter ?? parameterFromPayload(message.payload);
  return Boolean(parameter && payloadSiteName(parameter));
}

async function soleManagedSiteForConfiguredFallback() {
  const sites = await db.select({ siteName: platformSitesTable.siteName })
    .from(platformSitesTable)
    .where(eq(platformSitesTable.status, "active"))
    .limit(2);
  configuredManagedSiteFallback = sites.length === 1 ? sites[0]?.siteName : undefined;
  return configuredManagedSiteFallback;
}

function testMessageMatches(message: StoredMessage, siteName: string, deviceId: string, acceptsConfiguredSiteFallback = false) {
  const device = deviceFromMessage(message);
  return message.delivery === "immediate"
    && (device?.siteName === siteName
      || (acceptsConfiguredSiteFallback
        && device?.siteName === configuredMqttPlantSite
        && !messageHasExplicitSiteName(message)))
    && device.deviceId === deviceId;
}

function notifyTelemetryTestWaiters(message: StoredMessage) {
  for (const waiter of telemetryTestWaiters) {
    if (!testMessageMatches(message, waiter.siteName, waiter.deviceId, waiter.acceptsConfiguredSiteFallback)) continue;
    clearTimeout(waiter.timer);
    telemetryTestWaiters.delete(waiter);
    waiter.resolve(message);
  }
}

function waitForLiveTelemetry(siteName: string, deviceId: string, timeoutMs: number, acceptsConfiguredSiteFallback: boolean) {
  return new Promise<StoredMessage | undefined>((resolve) => {
    const waiter: TelemetryTestWaiter = {
      siteName,
      deviceId,
      acceptsConfiguredSiteFallback,
      resolve,
      timer: setTimeout(() => {
        telemetryTestWaiters.delete(waiter);
        resolve(undefined);
      }, timeoutMs),
    };
    telemetryTestWaiters.add(waiter);
  });
}

function actualTelemetryValue(message: StoredMessage) {
  const parameter = message.parameter ?? parameterFromPayload(message.payload);
  if (!parameter) return undefined;
  const value = numericParameterValue(parameter);
  if (value === null) return undefined;
  const label = sourceText(parameter, ["display_name", "displayName", "label", "name", "parameter"]) ?? "Telemetry value";
  const unit = sourceText(parameter, ["engineering_unit", "unit"]);
  return `${label}: ${value}${unit ? ` ${unit}` : ""}`;
}

export async function listLiveTelemetryDevices() {
  const fallbackManagedSite = await soleManagedSiteForConfiguredFallback();
  const latest = new Map<string, LiveTelemetryDevice>();
  for (const message of messageHistory) {
    if (message.delivery !== "immediate") continue;
    const discovered = deviceFromMessage(message);
    const device = discovered && !messageHasExplicitSiteName(message) && fallbackManagedSite
      ? { ...discovered, siteName: fallbackManagedSite }
      : discovered;
    if (!device) continue;
    const key = `${device.siteName}:${device.deviceId}`;
    const existing = latest.get(key);
    if (!existing || Date.parse(device.lastReceivedAt) >= Date.parse(existing.lastReceivedAt)) latest.set(key, device);
  }
  return [...latest.values()].sort((left, right) =>
    left.siteName.localeCompare(right.siteName) || left.deviceName.localeCompare(right.deviceName));
}

function discoveryCatalogParameter(discovery: typeof platformTelemetryDiscoveriesTable.$inferSelect): DiscoveredDeviceParameter {
  return {
    observationId: `catalog:${discovery.id}`,
    signalKey: [discovery.siteName, discovery.deviceId, discovery.sourceIdentity, discovery.normalizedName, discovery.address].join("|"),
    siteName: discovery.siteName,
    deviceId: discovery.deviceId,
    deviceName: discovery.deviceName,
    topic: discovery.topic,
    originalName: discovery.originalName,
    normalizedName: discovery.normalizedName,
    displayLabel: discovery.originalName,
    category: "Discovered / Other Parameters",
    rawValue: discovery.rawValue,
    reportedValue: discovery.reportedValue,
    reportedNumericValue: discovery.reportedNumericValue,
    displayValue: null,
    displayNumericValue: null,
    displayUnit: null,
    value: discovery.reportedNumericValue,
    unit: discovery.sourceUnit,
    sourceUnit: discovery.sourceUnit,
    address: discovery.address === "—" ? null : discovery.address,
    sourceName: discovery.sourceName,
    sourceIdentity: discovery.sourceIdentity,
    sourceMappingStatus: discovery.sourceMappingStatus,
    observedAt: discovery.observedAt?.toISOString(),
    receivedAt: discovery.receivedAt.toISOString(),
    provenance: discovery.provenance,
    dataQuality: discovery.dataQuality,
    scalingStatus: discovery.scalingStatus,
    observationCount: discovery.observationCount,
    mappingLifecycleStatus: discovery.mappingStatus,
    firstSeenAt: discovery.firstSeenAt.toISOString(),
    lastSeenAt: discovery.lastSeenAt.toISOString(),
  };
}

async function persistDiscoveredParameterCatalog(parameters: DiscoveredDeviceParameter[]) {
  if (!parameters.length) return;
  const now = new Date();
  const mappingIdentityKeys = [...new Set(parameters.map((parameter) => [
    parameter.siteName,
    parameter.deviceId,
    parameter.sourceIdentity,
    parameter.normalizedName,
    parameter.address ?? "—",
  ].join("\u001f")))].sort();
  const values = parameters.map((parameter) => {
    const receivedAt = new Date(parameter.receivedAt);
    const safeReceivedAt = Number.isNaN(receivedAt.getTime()) ? now : receivedAt;
    return {
      siteName: parameter.siteName,
      deviceId: parameter.deviceId,
      deviceName: parameter.deviceName,
      topic: parameter.topic,
      sourceIdentity: parameter.sourceIdentity,
      sourceName: parameter.sourceName,
      originalName: parameter.originalName,
      normalizedName: parameter.normalizedName,
      address: parameter.address ?? "—",
      rawValue: parameter.rawValue,
      reportedValue: parameter.reportedValue,
      reportedNumericValue: parameter.reportedNumericValue,
      sourceUnit: parameter.sourceUnit,
      observedAt: parameter.observedAt ? new Date(parameter.observedAt) : null,
      receivedAt: safeReceivedAt,
      provenance: parameter.provenance,
      sourceMappingStatus: parameter.sourceMappingStatus,
      dataQuality: parameter.dataQuality,
      scalingStatus: parameter.scalingStatus,
      lastSeenAt: safeReceivedAt,
      observationCount: 1,
      // Consult the mapping table inside this write instead of trusting a
      // possibly stale in-memory mapping overlay during map/clear races.
      mappingStatus: sql`CASE WHEN EXISTS (
        SELECT 1 FROM ${platformTelemetryMappingsTable} AS mapping
        WHERE mapping.site_name = ${parameter.siteName}
          AND mapping.device_id = ${parameter.deviceId}
          AND mapping.source_identity = ${parameter.sourceIdentity}
          AND mapping.normalized_name = ${parameter.normalizedName}
          AND mapping.address = ${parameter.address ?? "—"}
          AND mapping.status = 'active'
      ) THEN 'mapped' ELSE 'unmapped' END`,
    };
  });
  await db.transaction(async (tx) => {
    // The first discovery row has no watermark yet. Locking the exact identity
    // serializes its insert with a concurrent Admin map/clear transaction so
    // either writer observes the other's committed mapping state.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext(lock_key))
      FROM (
        SELECT lock_key
        FROM (VALUES ${sql.join(mappingIdentityKeys.map((key) => sql`(${key})`), sql`, `)}) AS identities(lock_key)
        ORDER BY lock_key
      ) AS ordered_identities
    `);
    await tx.insert(platformTelemetryDiscoveriesTable).values(values).onConflictDoUpdate({
      target: [
        platformTelemetryDiscoveriesTable.siteName,
        platformTelemetryDiscoveriesTable.deviceId,
        platformTelemetryDiscoveriesTable.sourceIdentity,
        platformTelemetryDiscoveriesTable.normalizedName,
        platformTelemetryDiscoveriesTable.address,
      ],
      set: {
        deviceName: sql`excluded.device_name`,
        topic: sql`excluded.topic`,
        sourceName: sql`excluded.source_name`,
        originalName: sql`excluded.original_name`,
        rawValue: sql`excluded.raw_value`,
        reportedValue: sql`excluded.reported_value`,
        reportedNumericValue: sql`excluded.reported_numeric_value`,
        sourceUnit: sql`excluded.source_unit`,
        observedAt: sql`excluded.observed_at`,
        receivedAt: sql`excluded.received_at`,
        provenance: sql`excluded.provenance`,
        sourceMappingStatus: sql`excluded.source_mapping_status`,
        dataQuality: sql`excluded.data_quality`,
        scalingStatus: sql`excluded.scaling_status`,
        lastSeenAt: sql`greatest(${platformTelemetryDiscoveriesTable.lastSeenAt}, excluded.last_seen_at)`,
        observationCount: sql`${platformTelemetryDiscoveriesTable.observationCount} + 1`,
        mappingStatus: sql`CASE
          WHEN ${platformTelemetryDiscoveriesTable.lastMappingChangedAt} IS NOT NULL
            AND ${platformTelemetryDiscoveriesTable.lastMappingChangedAt} >= excluded.received_at
          THEN ${platformTelemetryDiscoveriesTable.mappingStatus}
          WHEN EXISTS (
            SELECT 1 FROM ${platformTelemetryMappingsTable} AS mapping
            WHERE mapping.site_name = ${platformTelemetryDiscoveriesTable.siteName}
              AND mapping.device_id = ${platformTelemetryDiscoveriesTable.deviceId}
              AND mapping.source_identity = ${platformTelemetryDiscoveriesTable.sourceIdentity}
              AND mapping.normalized_name = ${platformTelemetryDiscoveriesTable.normalizedName}
              AND mapping.address = ${platformTelemetryDiscoveriesTable.address}
              AND mapping.status = 'active'
          ) THEN 'mapped'
          ELSE 'unmapped'
        END`,
      },
    });
  });
}

/**
 * Returns the latest complete source evidence per stable parameter identity.
 * Both Platform Admin and SCADA consume this single aggregation so a mapping
 * cannot be saved against a different interpretation than an operator sees.
 */
export async function listLatestDeviceParameters(siteName: string, deviceId?: string) {
  const latest = new Map<string, DiscoveredDeviceParameter>();
  const parameterIdentityKey = (parameter: DiscoveredDeviceParameter) => [
    parameter.siteName,
    parameter.deviceId,
    parameter.sourceIdentity,
    parameter.normalizedName,
    parameter.address ?? "—",
  ].join("\u001f");
  const add = (parameter: DiscoveredDeviceParameter) => {
    if (parameter.siteName !== siteName || (deviceId && parameter.deviceId !== deviceId)) return;
    const identity = parameterIdentityKey(parameter);
    const existing = latest.get(identity);
    if (latestDeviceParameterWins(existing, parameter)) latest.set(identity, parameter);
  };

  const fallbackManagedSite = await soleManagedSiteForConfiguredFallback();
  const canAdoptLegacyConfiguredSource = fallbackManagedSite === siteName && configuredMqttPlantSite !== siteName;
  const discoveryConditions = [canAdoptLegacyConfiguredSource
    ? or(
      eq(platformTelemetryDiscoveriesTable.siteName, siteName),
      eq(platformTelemetryDiscoveriesTable.siteName, configuredMqttPlantSite),
    )
    : eq(platformTelemetryDiscoveriesTable.siteName, siteName)];
  if (deviceId) discoveryConditions.push(eq(platformTelemetryDiscoveriesTable.deviceId, deviceId));
  const catalogDiscoveries = await db.select().from(platformTelemetryDiscoveriesTable)
    .where(and(...discoveryConditions))
    .orderBy(desc(platformTelemetryDiscoveriesTable.lastSeenAt));
  for (const discovery of catalogDiscoveries) {
    const parameter = discoveryCatalogParameter(discovery);
    add(
      canAdoptLegacyConfiguredSource && discovery.siteName === configuredMqttPlantSite
        ? {
          ...parameter,
          siteName,
          sourceIdentity: managedSourceIdentity(siteName, parameter.sourceName, parameter.normalizedName, parameter.address),
          signalKey: [
            siteName,
            parameter.deviceId,
            managedSourceIdentity(siteName, parameter.sourceName, parameter.normalizedName, parameter.address),
            parameter.normalizedName,
            parameter.address ?? "—",
          ].join("|"),
        }
        : parameter,
    );
  }

  for (const message of messageHistory) {
    for (const parameter of message.discoveredParameters ?? []) add(parameter);
  }
  const snapshots = await db.select()
    .from(mqttSnapshotsTable)
    .where(eq(mqttSnapshotsTable.topic, subscriptionTopic))
    .orderBy(desc(mqttSnapshotsTable.windowEndedAt), desc(mqttSnapshotsTable.capturedAt))
    .limit(24);
  for (const snapshot of snapshots) {
    if (snapshotSaveStatus(snapshot.data, snapshot.messageCount, snapshot.parameterCount) !== "saved") continue;
    for (const parameter of snapshotDiscoveredParameters(snapshot, siteName)) add(parameter);
  }

  const mappings = await activeTelemetryMappingsForSite(siteName);
  const now = Date.now();
  return applyActiveTelemetryMappings([...latest.values()]
    .sort((left, right) => {
      const rightTime = Date.parse(right.observedAt ?? right.receivedAt);
      const leftTime = Date.parse(left.observedAt ?? left.receivedAt);
      return rightTime - leftTime || left.displayLabel.localeCompare(right.displayLabel);
    })
    .map((parameter) => ({ ...parameter, ...deviceParameterFreshness(parameter, now) })), mappings.filter((mapping) => !deviceId || mapping.deviceId === deviceId));
}

export async function runLiveTelemetryTest(siteName: string, deviceId: string, timeoutSeconds: number): Promise<LiveTelemetryTestResult> {
  requestMqttConsumer();
  const startedAt = new Date();
  const initialHighWater = messageHistory.at(-1)?.sequence ?? 0;
  const acceptsConfiguredSiteFallback = await soleManagedSiteForConfiguredFallback() === siteName;
  const initialRuntime = status();
  const existingFreshEvidence = [...messageHistory].reverse().find((candidate) =>
    testMessageMatches(candidate, siteName, deviceId, acceptsConfiguredSiteFallback)
    && Date.now() - Date.parse(candidate.receivedAt) <= initialRuntime.communication.staleAfterMs);
  const message = existingFreshEvidence
    ?? await waitForLiveTelemetry(siteName, deviceId, timeoutSeconds * 1_000, acceptsConfiguredSiteFallback);
  const runtime = status();
  const communication = runtime.communication;
  const latestForDevice = [...messageHistory].reverse().find((candidate) =>
    testMessageMatches(candidate, siteName, deviceId, acceptsConfiguredSiteFallback));
  const received = message ?? latestForDevice;
  const processedValue = message ? actualTelemetryValue(message) : undefined;
  const messagesReceived = messageHistory.filter((candidate) =>
    candidate.sequence > initialHighWater && testMessageMatches(candidate, siteName, deviceId, acceptsConfiguredSiteFallback)).length;
  const communicationErrors = [
    runtime.error,
    communication.activeInterruption?.reason,
    communication.persistenceError,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const result: LiveTelemetryTestResult["result"] = message && processedValue
    ? "success"
    : message
      ? "error"
      : "no-telemetry";
  const dataQuality = !message
    ? "unavailable"
    : processedValue
      ? "source-backed"
      : "received-unprocessed";
  if (message && !processedValue) communicationErrors.push("A live MQTT message arrived but did not contain a processable numeric telemetry value.");
  return {
    result,
    brokerStatus: runtime.connected ? "connected" : "disconnected",
    subscriptionStatus: communication.subscriptionState,
    deviceStatus: message ? "live" : communication.deviceCommunication,
    topic: runtime.topic,
    lastReceivedAt: received?.receivedAt,
    dataFrequencySeconds: communication.dataFrequencySeconds,
    actualValue: processedValue,
    dataQuality,
    messageCount: message ? Math.max(1, messagesReceived) : messagesReceived,
    communicationErrors,
    evidence: {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      matchingSequence: message?.sequence,
      matchingSourceTimestamp: message?.sourceTimestamp,
      matchingDelivery: message?.delivery,
      observedSiteName: received ? deviceFromMessage(received)?.siteName : undefined,
      observedDeviceId: received ? deviceFromMessage(received)?.deviceId : undefined,
    },
  };
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
  const captureSiteName = telemetryCaptureSite(
    payloadSiteName(parameter),
    await soleManagedSiteForConfiguredFallback(),
    configuredMqttPlantSite,
  );
  const rawDiscoveredParameters = discoverDeviceParametersFromRawPayload(rawPayload, {
    siteName: captureSiteName,
    topic,
    receivedAt,
    provenance: retained ? "retained" : "live",
  });
  let discoveredParameters = rawDiscoveredParameters;
  try {
    const mappings = await activeTelemetryMappingsForSite(captureSiteName);
    discoveredParameters = applyActiveTelemetryMappings(rawDiscoveredParameters, mappings);
    await persistDiscoveredParameterCatalog(discoveredParameters);
  } catch (error) {
    // A database migration or mapping-service failure must not discard a raw
    // MQTT delivery. The error is logged explicitly; the next delivery retries
    // the durable catalog and authoritative mapping overlay.
    logger.error({ err: error, siteName: captureSiteName }, "Unable to persist or resolve centralized telemetry mapping");
  }
  const inverterRecord = parameter
    ? inverterActivePowerObservationFromParameter(parameter, captureSiteName)
    : undefined;
  const message: StoredMessage = {
    topic,
    payload: rawPayload,
    parameter,
    discoveredParameters,
    receivedAt,
    sequence: await allocateDeliverySequence(),
    sourceTimestamp: parameter ? parameterObservationTime(parameter) : undefined,
    inverterRecords: inverterRecord ? [inverterRecord] : undefined,
    delivery: retained ? "retained" : "immediate",
    captureSiteName,
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
  notifyTelemetryTestWaiters(message);
  broadcast("message", message, message.sequence);
  broadcast("status", status());

  const energy = parameter ? inverterEnergyObservationFromParameter(parameter, captureSiteName) : undefined;
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

  const measurement = parameter ? inverterMeasurementObservationFromParameter(parameter, captureSiteName) : undefined;
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
  if (siteName && !await allowSitePermission(req, res, siteName, "historical-data")) return;
  if (!siteName && !await allowUnscopedScadaEvidence(req, res)) return;
  try {
    const inactiveManagedSites = new Set((await db
      .select({ siteName: platformSitesTable.siteName })
      .from(platformSitesTable)
      .where(eq(platformSitesTable.activationStatus, "inactive")))
      .map((site) => site.siteName));
    const snapshots = await db
      .select()
      .from(mqttSnapshotsTable)
      .orderBy(desc(mqttSnapshotsTable.capturedAt))
      .limit(100);
    res.json({
      snapshots: snapshots
        .filter((snapshot) => snapshotBelongsToSite(snapshot, siteName || undefined))
        .filter((snapshot) => ![...inactiveManagedSites].some((inactiveSite) => snapshotBelongsToSite(snapshot, inactiveSite)))
        .slice(0, 20),
    });
  } catch (error) {
    logger.error({ err: error }, "MQTT snapshots query failed");
    res.status(500).json({ message: "Unable to load stored MQTT snapshots" });
  }
});

router.get("/mqtt/snapshots/latest", async (req, res): Promise<void> => {
  const siteName = parseSiteName(req.query.siteName);
  if (siteName) {
    if (!await allowGrantedSite(req, res, siteName)) return;
    if (!await allowSitePermission(req, res, siteName, "historical-data")) return;
  } else if (!await allowUnscopedScadaEvidence(req, res)) {
    return;
  }
  try {
    const snapshot = await latestSavedSnapshotEvidence(siteName || undefined);
    res.set("Cache-Control", "no-store").json({ snapshot });
  } catch (error) {
    req.log.error({ err: error }, "Latest MQTT snapshot query failed");
    res.status(500).json({ message: "Unable to load the latest saved MQTT snapshot." });
  }
});

router.get("/mqtt/saved-parameters", async (req, res): Promise<void> => {
  const siteName = parseSiteName(req.query.siteName);
  const requestedPage = typeof req.query.page === "string" ? Number(req.query.page) : 1;
  const requestedPageSize = typeof req.query.pageSize === "string" ? Number(req.query.pageSize) : 120;
  const page = Number.isInteger(requestedPage) ? Math.max(1, requestedPage) : 1;
  const pageSize = Number.isInteger(requestedPageSize) ? Math.min(300, Math.max(1, requestedPageSize)) : 120;
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 48 * 60 * 60_000);
  const requestedFrom = typeof req.query.from === "string" ? new Date(req.query.from) : defaultFrom;
  const requestedTo = typeof req.query.to === "string" ? new Date(req.query.to) : now;
  const from = Number.isFinite(requestedFrom.getTime()) ? requestedFrom : defaultFrom;
  const to = Number.isFinite(requestedTo.getTime()) ? requestedTo : now;
  if (!siteName || siteName.length > 160 || from > to || to.getTime() - from.getTime() > 31 * 24 * 60 * 60_000) {
    res.status(400).json({ message: "Use an assigned site and a valid saved-data range up to 31 days." });
    return;
  }
  if (!await allowGrantedSite(req, res, siteName)) return;
  if (!await allowSitePermission(req, res, siteName, "historical-data")) return;
  try {
    const snapshots = await db.select().from(mqttSnapshotsTable)
      .where(and(
        eq(mqttSnapshotsTable.topic, subscriptionTopic),
        gte(mqttSnapshotsTable.windowEndedAt, from),
        lte(mqttSnapshotsTable.windowStartedAt, to),
      ))
      .orderBy(desc(mqttSnapshotsTable.windowEndedAt), desc(mqttSnapshotsTable.capturedAt));
    const history = pageSavedParameterHistory(snapshots, { siteName, page, pageSize });
    res.set("Cache-Control", "no-store").json({
      siteName,
      savedOnly: true,
      range: { from: from.toISOString(), to: to.toISOString() },
      page,
      pageSize,
      total: history.total,
      records: history.records,
    });
  } catch (error) {
    req.log.error({ err: error, siteName }, "Saved MQTT parameter history query failed");
    res.status(500).json({ message: "Unable to load saved parameter evidence." });
  }
});

router.get("/mqtt/site-locations", async (req, res) => {
  try {
    const granted = await grantedSiteNames(req);
    const locations = await db
      .select()
      .from(plantLocationsTable)
      .innerJoin(platformSitesTable, eq(plantLocationsTable.siteName, platformSitesTable.siteName))
      .where(eq(platformSitesTable.status, "active"))
      .orderBy(asc(plantLocationsTable.siteName));
    res.set("Cache-Control", "no-store").json({
      locations: (granted ? locations.filter(({ plant_locations }) => granted.has(plant_locations.siteName)) : locations)
        .map(({ plant_locations }) => plant_locations),
    });
  } catch (error) {
    logger.error({ err: error }, "Plant locations query failed");
    res.status(500).json({ message: "Unable to load saved plant locations" });
  }
});

router.get("/mqtt/site-access", async (req, res) => {
  try {
    const access = await siteAccess(req);
    const managedSites = await db
      .select({ siteName: platformSitesTable.siteName, activationStatus: platformSitesTable.activationStatus })
      .from(platformSitesTable)
      .where(eq(platformSitesTable.status, "active"));
    const visibleManagedSites = access.global
      ? managedSites
      : managedSites.filter((site) => access.roles.has(site.siteName));
    const visibleSiteNames = access.global
      ? visibleManagedSites.map((site) => site.siteName)
      : [...access.sites];
    res.set("Cache-Control", "no-store").json({
      sites: visibleSiteNames.sort(),
      roles: Object.fromEntries(access.roles),
      global: access.global,
      policy: access.global ? "global" : "assigned-sites",
      activations: Object.fromEntries(visibleManagedSites.map((site) => [site.siteName, site.activationStatus])),
    });
  } catch (error) {
    req.log.error({ err: error }, "SCADA site access query failed");
    res.status(500).json({ message: "Site access could not be loaded. Please retry." });
  }
});

router.get("/mqtt/calibration-profile", async (req, res): Promise<void> => {
  const siteName = parseSiteName(req.query.siteName) || configuredMqttPlantSite;
  if (siteName.length > 160) {
    res.status(400).json({ message: "A valid plant/site name is required." });
    return;
  }
  if (!await allowGrantedSite(req, res, siteName)) return;
  if (!await allowSitePermission(req, res, siteName, "device-configuration")) return;
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
  if (!req.isScadaAuthenticated()) {
    res.status(401).json({ message: "Operator sign-in is required to verify calibration mappings against live broker evidence." });
    return;
  }
  if (!await allowGrantedSite(req, res, siteName)) return;
  if (!await allowSitePermission(req, res, siteName, "device-configuration")) return;
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
  const capacityInput = req.body?.installedDcCapacityKwp;
  const installedDcCapacityKwp = capacityInput === undefined || capacityInput === null || capacityInput === ""
    ? null
    : typeof capacityInput === "number" ? capacityInput : Number(capacityInput);
  const sources = parseCalibrationSources(req.body?.sources);
  if (!siteName || siteName.length > 160 || (installedDcCapacityKwp !== null && (!Number.isFinite(installedDcCapacityKwp) || installedDcCapacityKwp <= 0 || installedDcCapacityKwp > 10_000_000)) || !sources) {
    res.status(400).json({ message: "One or more complete, confirmed source-register mappings are required. Installed DC capacity is optional, but required before Specific Yield can be verified." });
    return;
  }
  if (!req.isScadaAuthenticated()) {
    res.status(401).json({ message: "Operator sign-in is required to approve a plant calibration profile." });
    return;
  }
  if (!await allowGrantedSite(req, res, siteName)) return;
  if (!await allowSitePermission(req, res, siteName, "device-configuration")) return;
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
  const approvedBy = req.scadaUser.email ? `email:${req.scadaUser.email.toLowerCase()}` : `id:${req.scadaUser.id}`;
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
  const normalizedName = name.replace(/[^a-z0-9]/g, "");
  return /(voltage|current|amper|activepower|actpow|realpower|powerfactor|frequency|hz|pf)/.test(normalizedName);
}

router.get("/mqtt/electrical-history", async (req, res) => {
  const siteName = parseSiteName(req.query.siteName);
  if (siteName) {
    if (!await allowGrantedSite(req, res, siteName)) return;
    if (!await allowSitePermission(req, res, siteName, "electrical-parameters")) return;
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
      const savedEvidence = snapshotEvidence(snapshot);
      const scheduledFor = savedEvidence.scheduledFor;
      const saveStatus = savedEvidence.saveStatus;
      const timezone = savedEvidence.timezone;
      const discoveredElectrical = savedEvidence.parameters.filter(isElectricalParameter);
      if (discoveredElectrical.length) {
        for (const parameter of discoveredElectrical) {
          const receivedAt = parameterObservationTime(parameter) ?? savedEvidence.capturedAt;
          const receivedTime = new Date(receivedAt);
          if (Number.isNaN(receivedTime.getTime()) || receivedTime < rangeStart || receivedTime > rangeEnd) continue;
          samples.push({
            ...parameter,
            timestamp: receivedAt,
            topic: snapshot.topic,
            snapshotCapturedAt: snapshot.capturedAt.toISOString(),
            snapshotScheduledFor: scheduledFor,
            snapshotSaveStatus: saveStatus,
            snapshotTimezone: timezone,
          });
        }
        continue;
      }

      // Legacy snapshots predate persisted discovered-parameter evidence.
      // Reparse their raw message payload only when the schema-v4 projection
      // has no electrical parameters to preserve.
      if (!isRecord(snapshot.data) || !Array.isArray(snapshot.data.messages)) continue;
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

function isStoredDiscoveredParameter(value: unknown): value is DiscoveredDeviceParameter {
  if (!isRecord(value)) return false;
  return typeof value.observationId === "string"
    && typeof value.signalKey === "string"
    && typeof value.siteName === "string"
    && typeof value.deviceId === "string"
    && typeof value.deviceName === "string"
    && typeof value.originalName === "string"
    && typeof value.normalizedName === "string"
    && typeof value.displayLabel === "string"
    && typeof value.rawValue === "string"
    && typeof value.sourceName === "string"
    && typeof value.receivedAt === "string"
    && typeof value.topic === "string"
    && ["Overview", "Electrical", "Energy", "MPPT / Strings", "Temperature", "Alarms / Faults", "Communication", "Discovered / Other Parameters"].includes(String(value.category))
    && ["validated", "raw", "source-reported"].includes(String(value.dataQuality))
    && ["validated", "raw"].includes(String(value.scalingStatus));
}

function explicitlyScopedLegacySnapshotParameters(data: Record<string, unknown>, siteName: string) {
  const latest = Array.isArray(data.latestParameters) ? data.latestParameters : [];
  const legacy = Array.isArray(data.parameters) ? data.parameters : [];
  return [...latest, ...legacy]
    .filter(isRecord)
    .filter((parameter) => payloadSiteName(parameter) === siteName);
}

function snapshotDiscoveredParameters(snapshot: {
  topic: string;
  capturedAt: Date;
  data: unknown;
}, siteName: string) {
  if (!isRecord(snapshot.data)) return [] as DiscoveredDeviceParameter[];
  const receivedAt = snapshot.capturedAt.toISOString();
  const stored: unknown[] = Array.isArray(snapshot.data.latestDiscoveredParameters)
    ? snapshot.data.latestDiscoveredParameters.map((parameter) => isRecord(parameter) ? { ...parameter, provenance: "snapshot", receivedAt } : parameter)
    : explicitlyScopedLegacySnapshotParameters(snapshot.data, siteName)
      .flatMap((parameter) => discoverDeviceParameters(parameter, {
        siteName,
        topic: snapshot.topic,
        receivedAt,
        provenance: "snapshot",
      }));
  return stored.filter(isStoredDiscoveredParameter).filter((parameter) => parameter.siteName === siteName);
}

router.get("/mqtt/device-parameters", async (req, res): Promise<void> => {
  const siteName = parseSiteName(req.query.siteName);
  const deviceId = typeof req.query.deviceId === "string" ? req.query.deviceId.trim() : "";
  const requestedLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 160;
  const limit = Number.isInteger(requestedLimit) ? Math.min(300, Math.max(1, requestedLimit)) : 160;
  if (!siteName || siteName.length > 160 || deviceId.length > 160) {
    res.status(400).json({ message: "Use a valid assigned plant/site and optional device identifier." });
    return;
  }
  if (!await allowGrantedSite(req, res, siteName)) return;
  if (!await allowSitePermission(req, res, siteName, "historical-data")) return;

  try {
    const parameters = (await listLatestDeviceParameters(siteName, deviceId || undefined)).slice(0, limit);

    res.set("Cache-Control", "no-store").json({
      siteName,
      deviceId: deviceId || undefined,
      parameters,
      bounded: { limit, liveWindow: messageHistory.length, snapshotWindow: 24 },
    });
  } catch (error) {
    logger.error({ err: error, siteName, deviceId }, "Latest device parameter query failed");
    res.status(500).json({ message: "Unable to load source-backed device parameters." });
  }
});

router.get("/mqtt/telemetry-mappings", async (req, res): Promise<void> => {
  const siteName = parseSiteName(req.query.siteName);
  const deviceId = typeof req.query.deviceId === "string" ? req.query.deviceId.trim() : "";
  if (!siteName || siteName.length > 160 || deviceId.length > 160) {
    res.status(400).json({ message: "Use a valid assigned plant/site and optional device identifier." });
    return;
  }
  if (!await allowGrantedSite(req, res, siteName)) return;
  if (!await allowSitePermission(req, res, siteName, "live-monitoring")) return;

  const conditions = [
    eq(platformTelemetryMappingsTable.siteName, siteName),
    eq(platformTelemetryMappingsTable.status, "active"),
  ];
  if (deviceId) conditions.push(eq(platformTelemetryMappingsTable.deviceId, deviceId));
  const mappings = await db.select().from(platformTelemetryMappingsTable)
    .where(and(...conditions))
    .orderBy(asc(platformTelemetryMappingsTable.displayLabel));
  res.set("Cache-Control", "no-store").json({
    siteName,
    mappings: mappings.map(scadaTelemetryMappingResponse),
  });
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
  if (!await allowSitePermission(req, res, siteName, "historical-data")) return;

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
  if (!await allowSitePermission(req, res, siteName, "historical-data")) return;

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
    if (granted.size === 0) {
      res.status(403).json({ message: "Select one of your assigned sites before requesting a report." });
      return;
    }
    if (granted.size !== 1) {
      res.status(400).json({ message: "Select one assigned plant/site before requesting a report." });
      return;
    }
    siteName = [...granted][0];
  }
  if (!siteName && granted === null && !await allowUnscopedScadaEvidence(req, res)) return;
  if (siteName && !await allowGrantedSite(req, res, siteName)) return;
  if (siteName && !await allowSitePermission(req, res, siteName, "scada-reports")) return;
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
  if (complete && siteName && !await allowSitePermission(req, res, siteName, "data-export")) return;
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
        const reportedEvidence = sourceReportedEvidence(parameter);
        const quality = alarm ? "source-reported" as const : sourceExplicitlyValidatesEngineeringValue(parameter) ? "validated" as const : reportedEvidence.isSourceReported ? "source-reported" as const : "raw" as const;
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
          value: quality === "validated" ? numeric : null,
          unit: quality === "validated" ? String(parameter.engineering_unit ?? parameter.unit ?? "source units") : "",
          address,
          sourceName,
          observedAt,
          receivedAt: evidence.capturedAt,
          provenance,
          quality,
          status: sourceStatus ?? null,
          reason: alarm ? sourceText(parameter, ["reason", "description", "message", "cause"]) ?? "Source-reported alarm/fault evidence." : null,
          sourceReportedValue: reportedEvidence.sourceReportedValue,
          sourceReportedUnit: reportedEvidence.sourceReportedUnit,
          transportRawValue: reportedEvidence.transportRawValue,
          sourceIdentity: reportedEvidence.sourceIdentity,
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
      // Replay/recovery messages never re-enter queueSnapshotMessage -- this
      // is only a type placeholder, never consulted for persisted evidence.
      captureSiteName: configuredMqttPlantSite,
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
    if (!await allowSitePermission(req, res, siteName, "live-monitoring")) return;
  } else if (!await allowUnscopedScadaEvidence(req, res)) {
    return;
  }
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
  const scadaSessionId = getScadaSessionId(req);
  const scadaUserId = req.isScadaAuthenticated() ? req.scadaUser.id : undefined;
  const siteName = parseSiteName(req.query.siteName);
  if (siteName) {
    if (!await allowGrantedSite(req, res, siteName)) return;
    if (!await allowSitePermission(req, res, siteName, "live-monitoring")) return;
  } else if (!await allowUnscopedScadaEvidence(req, res)) {
    return;
  }
  await soleManagedSiteForConfiguredFallback();
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
  if (scadaSessionId && scadaUserId) registerScadaSessionStream(scadaSessionId, scadaUserId, res);
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
  const sessionValidation = scadaSessionId
    ? setInterval(() => {
      void getScadaSessionUserId(scadaSessionId).then((userId) => {
        if (!userId) closeScadaSessionStreams(scadaSessionId);
      }).catch((error) => logger.warn({ err: error }, "SCADA stream session validation failed"));
    }, 15_000)
    : undefined;
  req.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(ledgerFanout);
    if (sessionValidation) clearInterval(sessionValidation);
    listeners.delete(res);
    if (scadaSessionId) unregisterScadaSessionStream(scadaSessionId, res);
    res.end();
  });
});

// Live consumption and scheduled persistence are server responsibilities.
// They must continue even when no operator has an SSE browser tab open.
requestMqttConsumer();

export default router;