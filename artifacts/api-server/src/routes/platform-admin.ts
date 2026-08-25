import crypto from "crypto";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { Router, type IRouter, type Request } from "express";
import {
  CreatePlatformOrganizationBody,
  CreatePlatformOrganizationResponse,
  CreatePlatformSiteBody,
  CreatePlatformSiteResponse,
  CreatePlatformTelemetryTestBody,
  CreatePlatformTelemetryTestResponse,
  BrowsePlatformDatabaseTableBody,
  BrowsePlatformDatabaseTableResponse,
  GetPlatformDatabaseHealthResponse,
  GetPlatformDatabaseMigrationsResponse,
  GetPlatformAdminAuthUserResponse,
  GetPlatformAdminOverviewResponse,
  GetPlatformMqttConfigResponse,
  GrantPlatformSiteAccessBody,
  GrantPlatformSiteAccessResponse,
  ListPlatformDatabaseTablesResponse,
  ListPlatformAuditEventsResponse,
  ListPlatformOrganizationsResponse,
  ListPlatformSitesResponse,
  ListPlatformTelemetryDevicesResponse,
  ListPlatformUsersResponse,
  RunPlatformDatabaseQueryBody,
  RunPlatformDatabaseQueryResponse,
  UpdatePlatformSiteAccessBody,
  UpdatePlatformSiteAccessResponse,
  UpdatePlatformSiteActivationBody,
  UpdatePlatformSiteActivationResponse,
  UpdatePlatformMqttConfigBody,
  UpdatePlatformMqttConfigResponse,
} from "@workspace/api-zod";
import {
  db,
  plantLocationsTable,
  platformAuditEventsTable,
  platformConfigurationTable,
  platformOrganizationsTable,
  platformSiteAccessTable,
  platformSitesTable,
  platformTelemetryTestsTable,
  usersTable,
} from "@workspace/db";
import {
  applyMqttConfiguration,
  broadcastSiteActivation,
  getMqttRuntimeStatus,
  listLiveTelemetryDevices,
  runLiveTelemetryTest,
  type MqttRuntimeConfiguration,
} from "./mqtt";
import {
  browseApprovedDatabaseTable,
  createApplicationBackup,
  listApprovedDatabaseTables,
  platformDatabaseHealth,
  platformMigrationStatus,
  runReadOnlyDatabaseQuery,
} from "../lib/platform-admin-database";
import {
  platformAdminSessionMiddleware,
  requirePlatformAdmin,
  type PlatformAdminPrincipal,
} from "../middlewares/platformAdminAuthorization";

const router: IRouter = Router();

type MqttConfig = {
  brokerUrl: string;
  topic: string;
  plantSite: string;
  timezone: string;
  credentialsConfigured: boolean;
  pendingApply: boolean;
  applyState: string;
  lastApplyError?: string;
  lastApplyAt?: string;
  connected: boolean;
};

function hasRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function publicAdmin(principal: PlatformAdminPrincipal) {
  return {
    id: principal.userId,
    email: principal.email,
    name: principal.name,
    role: principal.role,
  };
}

async function audit(principal: PlatformAdminPrincipal, action: string, targetType: string, targetId: string, metadata: Record<string, unknown> = {}) {
  await db.insert(platformAuditEventsTable).values({
    actorUserId: principal.userId,
    actorEmail: principal.email,
    action,
    targetType,
    targetId,
    metadata,
  });
}

function platformSiteResponse(
  site: typeof platformSitesTable.$inferSelect,
  organizationName: string,
  location: { latitude: number | null; longitude: number | null } | undefined,
  latestTest?: typeof platformTelemetryTestsTable.$inferSelect,
) {
  return {
    siteName: site.siteName,
    organizationId: site.organizationId,
    organizationName,
    timezone: site.timezone,
    status: site.status,
    activationStatus: site.activationStatus,
    latitude: location?.latitude ?? null,
    longitude: location?.longitude ?? null,
    lastTelemetryTestedAt: latestTest?.finishedAt ?? null,
    lastTelemetryTestResult: latestTest?.result ?? null,
  };
}

async function brokerConfiguration(): Promise<MqttConfig> {
  const [saved] = await db
    .select()
    .from(platformConfigurationTable)
    .where(eq(platformConfigurationTable.key, "mqtt"))
    .limit(1);
  const value = hasRecord(saved?.value) ? saved.value : {};
  const brokerUrl = typeof value.brokerUrl === "string" ? value.brokerUrl : process.env.MQTT_BROKER_URL ?? "mqtt://76.13.4.214";
  const topic = typeof value.topic === "string" ? value.topic : process.env.MQTT_TOPIC ?? "trn246/modbus";
  const plantSite = typeof value.plantSite === "string" ? value.plantSite : process.env.MQTT_PLANT_SITE?.trim() || topic;
  const timezone = typeof value.timezone === "string" ? value.timezone : process.env.MQTT_PLANT_TIMEZONE ?? process.env.PLANT_TIMEZONE ?? "Asia/Kolkata";
  const runtime = getMqttRuntimeStatus();
  const pendingApply = brokerUrl !== runtime.brokerUrl || topic !== runtime.topic || plantSite !== runtime.plantSite || timezone !== runtime.timezone;
  return {
    brokerUrl,
    topic,
    plantSite,
    timezone,
    credentialsConfigured: Boolean(process.env.MQTT_USERNAME && process.env.MQTT_PASSWORD),
    pendingApply,
    applyState: runtime.applyState,
    lastApplyError: runtime.lastApplyError,
    lastApplyAt: runtime.lastApplyAt,
    connected: runtime.connected,
  };
}

router.use(platformAdminSessionMiddleware);

router.get("/platform-admin/auth/user", (req, res) => {
  const data = GetPlatformAdminAuthUserResponse.parse({
    user: req.platformAdmin ? publicAdmin(req.platformAdmin) : null,
    admin: Boolean(req.platformAdmin),
  });
  res.set("Cache-Control", "no-store").json(data);
});

router.use("/platform-admin", requirePlatformAdmin);

router.get("/platform-admin/overview", async (req: Request, res): Promise<void> => {
  const principal = req.platformAdmin!;
  const [[organizationCount], [siteCount], [userCount], [accessCount], config] = await Promise.all([
    db.select({ value: count() }).from(platformOrganizationsTable),
    db.select({ value: count() }).from(platformSitesTable),
    db.select({ value: count() }).from(usersTable),
    db.select({ value: count() }).from(platformSiteAccessTable).where(eq(platformSiteAccessTable.status, "active")),
    brokerConfiguration(),
  ]);
  const events = await db.select().from(platformAuditEventsTable).orderBy(desc(platformAuditEventsTable.createdAt)).limit(8);
  const data = GetPlatformAdminOverviewResponse.parse({
    organizationCount: Number(organizationCount?.value ?? 0),
    siteCount: Number(siteCount?.value ?? 0),
    userCount: Number(userCount?.value ?? 0),
    activeAccessGrantCount: Number(accessCount?.value ?? 0),
    broker: config,
    communication: getMqttRuntimeStatus().communication,
    recentAudit: events.map((event) => ({
      id: event.id,
      actorEmail: event.actorEmail,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      createdAt: event.createdAt.toISOString(),
      metadata: hasRecord(event.metadata) ? event.metadata : {},
    })),
  });
  await audit(principal, "platform.overview.read", "platform", "overview");
  res.json(data);
});

router.get("/platform-admin/organizations", async (_req, res): Promise<void> => {
  const organizations = await db.select().from(platformOrganizationsTable).orderBy(asc(platformOrganizationsTable.name));
  const sites = await db.select({ organizationId: platformSitesTable.organizationId }).from(platformSitesTable);
  const countByOrganization = new Map<string, number>();
  for (const site of sites) countByOrganization.set(site.organizationId, (countByOrganization.get(site.organizationId) ?? 0) + 1);
  res.json(ListPlatformOrganizationsResponse.parse(organizations.map((organization) => ({
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    status: organization.status,
    siteCount: countByOrganization.get(organization.id) ?? 0,
  }))));
});

router.post("/platform-admin/organizations", async (req: Request, res): Promise<void> => {
  const data = CreatePlatformOrganizationBody.parse(req.body);
  const name = data.name.trim();
  const slug = data.slug.trim().toLowerCase();
  if (name.length < 2 || slug.length < 2) {
    res.status(400).json({ error: "Organization name and slug cannot be blank." });
    return;
  }
  try {
    const [organization] = await db.insert(platformOrganizationsTable).values({ name, slug }).returning();
    await audit(req.platformAdmin!, "organization.created", "organization", organization.id, { slug: organization.slug });
    res.status(201).json(CreatePlatformOrganizationResponse.parse({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      status: organization.status,
      siteCount: 0,
    }));
  } catch (error) {
    const code = hasRecord(error) && typeof error.code === "string" ? error.code : "";
    req.log.warn({ err: error, slug }, "Platform organization creation failed");
    if (code === "23505") {
      res.status(409).json({ error: "That organization slug is already in use." });
      return;
    }
    res.status(500).json({ error: "The organization could not be created. Try again." });
  }
});

router.get("/platform-admin/sites", async (_req, res): Promise<void> => {
  const [rows, tests] = await Promise.all([
    db
      .select({
        site: platformSitesTable,
        organizationName: platformOrganizationsTable.name,
        latitude: plantLocationsTable.latitude,
        longitude: plantLocationsTable.longitude,
      })
      .from(platformSitesTable)
      .innerJoin(platformOrganizationsTable, eq(platformSitesTable.organizationId, platformOrganizationsTable.id))
      .leftJoin(plantLocationsTable, eq(platformSitesTable.siteName, plantLocationsTable.siteName))
      .orderBy(asc(platformSitesTable.siteName)),
    db.select().from(platformTelemetryTestsTable).orderBy(desc(platformTelemetryTestsTable.finishedAt)),
  ]);
  const latestTestBySite = new Map<string, typeof platformTelemetryTestsTable.$inferSelect>();
  for (const test of tests) {
    if (!latestTestBySite.has(test.siteName)) latestTestBySite.set(test.siteName, test);
  }
  res.json(ListPlatformSitesResponse.parse(rows.map((row) =>
    platformSiteResponse(row.site, row.organizationName, row, latestTestBySite.get(row.site.siteName)))));
});

router.post("/platform-admin/sites", async (req: Request, res): Promise<void> => {
  const data = CreatePlatformSiteBody.parse(req.body);
  const siteName = data.siteName.trim();
  const timezone = data.timezone.trim();
  if (siteName.length < 2 || timezone.length < 1) {
    res.status(400).json({ error: "Site name and timezone cannot be blank." });
    return;
  }
  const [organization] = await db.select().from(platformOrganizationsTable)
    .where(and(eq(platformOrganizationsTable.id, data.organizationId), eq(platformOrganizationsTable.status, "active"))).limit(1);
  if (!organization) {
    res.status(400).json({ error: "Choose an active organization." });
    return;
  }
  try {
    const site = await db.transaction(async (tx) => {
      const [createdSite] = await tx.insert(platformSitesTable).values({
        siteName,
        organizationId: data.organizationId,
        timezone,
        // Legacy sites remain active from the database default. Newly provisioned
        // sites require a successful live test followed by explicit activation.
        activationStatus: "inactive",
        activationUpdatedBy: req.platformAdmin!.userId,
      }).returning();
      if (typeof data.latitude === "number" && typeof data.longitude === "number") {
        await tx.insert(plantLocationsTable).values({
          siteName: createdSite.siteName,
          latitude: data.latitude,
          longitude: data.longitude,
        }).onConflictDoUpdate({
          target: plantLocationsTable.siteName,
          set: { latitude: data.latitude, longitude: data.longitude, updatedAt: new Date() },
        });
      }
      await tx.insert(platformSiteAccessTable).values({
        userId: req.platformAdmin!.userId,
        siteName: createdSite.siteName,
        role: "site-admin",
      }).onConflictDoUpdate({
        target: [platformSiteAccessTable.userId, platformSiteAccessTable.siteName],
        set: { role: "site-admin", status: "active", updatedAt: new Date() },
      });
      return createdSite;
    });
    await audit(req.platformAdmin!, "site.created", "site", site.siteName, {
      organizationId: site.organizationId,
      timezone: site.timezone,
      creatorAccess: "site-admin",
      activationStatus: site.activationStatus,
    });
    res.status(201).json(CreatePlatformSiteResponse.parse(platformSiteResponse(
      site,
      organization.name,
      { latitude: data.latitude ?? null, longitude: data.longitude ?? null },
    )));
  } catch (error) {
    const code = hasRecord(error) && typeof error.code === "string" ? error.code : "";
    req.log.warn({ err: error, siteName }, "Platform site creation failed");
    if (code === "23505") {
      res.status(409).json({ error: "That site name is already in use." });
      return;
    }
    res.status(500).json({ error: "The site could not be created. Try again." });
  }
});

router.get("/platform-admin/telemetry/devices", async (_req, res): Promise<void> => {
  res.set("Cache-Control", "no-store").json(ListPlatformTelemetryDevicesResponse.parse(await listLiveTelemetryDevices()));
});

router.post("/platform-admin/telemetry-tests", async (req: Request, res): Promise<void> => {
  const data = CreatePlatformTelemetryTestBody.parse(req.body);
  const [site] = await db.select().from(platformSitesTable).where(eq(platformSitesTable.siteName, data.siteName)).limit(1);
  if (!site) {
    res.status(404).json({ error: "Choose a managed site." });
    return;
  }
  if (site.status !== "active") {
    res.status(400).json({ error: "Archived sites cannot run telemetry tests." });
    return;
  }
  const device = (await listLiveTelemetryDevices()).find((candidate) =>
    candidate.siteName === site.siteName && candidate.deviceId === data.deviceId);
  if (!device) {
    res.status(400).json({ error: "Choose a device that has been observed in live telemetry for this site." });
    return;
  }

  const startedAt = new Date();
  const result = await runLiveTelemetryTest(site.siteName, device.deviceId, data.timeoutSeconds);
  const finishedAt = new Date();
  const [test] = await db.insert(platformTelemetryTestsTable).values({
    siteName: site.siteName,
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    result: result.result,
    startedAt,
    finishedAt,
    timeoutSeconds: data.timeoutSeconds,
    brokerStatus: result.brokerStatus,
    subscriptionStatus: result.subscriptionStatus,
    deviceStatus: result.deviceStatus,
    lastReceivedAt: result.lastReceivedAt ? new Date(result.lastReceivedAt) : undefined,
    dataFrequencySeconds: result.dataFrequencySeconds,
    actualValue: result.actualValue,
    dataQuality: result.dataQuality,
    messageCount: result.messageCount,
    communicationErrors: result.communicationErrors,
    evidence: result.evidence,
    createdBy: req.platformAdmin!.userId,
  }).returning();
  await audit(req.platformAdmin!, "telemetry.tested", "site-device", `${site.siteName}:${device.deviceId}`, {
    result: test.result,
    messageCount: test.messageCount,
    dataQuality: test.dataQuality,
    brokerStatus: test.brokerStatus,
    subscriptionStatus: test.subscriptionStatus,
  });
  res.json(CreatePlatformTelemetryTestResponse.parse({
    id: test.id,
    siteName: test.siteName,
    deviceId: test.deviceId,
    deviceName: test.deviceName,
    result: test.result,
    startedAt: test.startedAt,
    finishedAt: test.finishedAt,
    timeoutSeconds: test.timeoutSeconds,
    brokerStatus: test.brokerStatus,
    subscriptionStatus: test.subscriptionStatus,
    deviceStatus: test.deviceStatus,
    topic: getMqttRuntimeStatus().topic,
    lastReceivedAt: test.lastReceivedAt ?? null,
    dataFrequencySeconds: test.dataFrequencySeconds ?? null,
    actualValue: test.actualValue ?? null,
    dataQuality: test.dataQuality,
    messageCount: test.messageCount,
    communicationErrors: Array.isArray(test.communicationErrors) ? test.communicationErrors : [],
    evidence: hasRecord(test.evidence) ? test.evidence : {},
  }));
});

router.post("/platform-admin/sites/activation", async (req: Request, res): Promise<void> => {
  const data = UpdatePlatformSiteActivationBody.parse(req.body);
  const [site] = await db.select().from(platformSitesTable).where(eq(platformSitesTable.siteName, data.siteName)).limit(1);
  if (!site) {
    res.status(404).json({ error: "Choose a managed site." });
    return;
  }
  if (site.status !== "active") {
    res.status(400).json({ error: "Archived sites cannot be activated or deactivated." });
    return;
  }
  const [latestTest] = await db
    .select()
    .from(platformTelemetryTestsTable)
    .where(eq(platformTelemetryTestsTable.siteName, site.siteName))
    .orderBy(desc(platformTelemetryTestsTable.finishedAt))
    .limit(1);
  if (data.activationStatus === "active" && latestTest?.result !== "success") {
    res.status(400).json({ error: "Run a successful live telemetry test before activating this site." });
    return;
  }
  const now = new Date();
  const updated = await db.transaction(async (tx) => {
    const [activatedSite] = await tx.update(platformSitesTable).set({
      activationStatus: data.activationStatus,
      activationUpdatedAt: now,
      activationUpdatedBy: req.platformAdmin!.userId,
    }).where(eq(platformSitesTable.siteName, site.siteName)).returning();
    await tx.insert(platformSiteAccessTable).values({
      userId: req.platformAdmin!.userId,
      siteName: activatedSite.siteName,
      role: "site-admin",
    }).onConflictDoUpdate({
      target: [platformSiteAccessTable.userId, platformSiteAccessTable.siteName],
      set: { role: "site-admin", status: "active", updatedAt: now },
    });
    return activatedSite;
  });
  await audit(req.platformAdmin!, data.activationStatus === "active" ? "site.activated" : "site.deactivated", "site", updated.siteName, {
    previousActivationStatus: site.activationStatus,
    activationStatus: updated.activationStatus,
    telemetryTestId: latestTest?.id ?? null,
  });
  broadcastSiteActivation(updated.siteName, updated.activationStatus, now.toISOString());
  const [organization] = await db.select().from(platformOrganizationsTable).where(eq(platformOrganizationsTable.id, updated.organizationId)).limit(1);
  const [location] = await db.select({
    latitude: plantLocationsTable.latitude,
    longitude: plantLocationsTable.longitude,
  }).from(plantLocationsTable).where(eq(plantLocationsTable.siteName, updated.siteName)).limit(1);
  res.json(UpdatePlatformSiteActivationResponse.parse(platformSiteResponse(updated, organization?.name ?? "Unknown organization", location, latestTest)));
});

router.get("/platform-admin/users", async (_req, res): Promise<void> => {
  const [users, access] = await Promise.all([
    db.select().from(usersTable).orderBy(asc(usersTable.email)),
    db.select().from(platformSiteAccessTable).orderBy(asc(platformSiteAccessTable.siteName)),
  ]);
  const accessByUser = new Map<string, typeof access>();
  for (const grant of access) {
    const grants = accessByUser.get(grant.userId) ?? [];
    grants.push(grant);
    accessByUser.set(grant.userId, grants);
  }
  res.json(ListPlatformUsersResponse.parse(users.map((user) => ({
    id: user.id,
    email: user.email,
    name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email || "Unnamed SCADA user",
    access: (accessByUser.get(user.id) ?? []).map((grant) => ({
      userId: grant.userId,
      siteName: grant.siteName,
      organizationId: "",
      role: grant.role,
      status: grant.status,
    })),
  }))));
});

router.post("/platform-admin/access", async (req: Request, res): Promise<void> => {
  const data = GrantPlatformSiteAccessBody.parse(req.body);
  const [site] = await db.select().from(platformSitesTable).where(eq(platformSitesTable.siteName, data.siteName)).limit(1);
  if (!site) {
    res.status(400).json({ error: "Choose a managed site." });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, data.userId)).limit(1);
  if (!user) {
    res.status(400).json({ error: "Choose an existing SCADA user." });
    return;
  }
  const [grant] = await db.insert(platformSiteAccessTable).values({
    userId: data.userId,
    siteName: data.siteName,
    role: data.role,
  }).onConflictDoUpdate({
    target: [platformSiteAccessTable.userId, platformSiteAccessTable.siteName],
    set: { role: data.role, status: "active", updatedAt: new Date() },
  }).returning();
  await audit(req.platformAdmin!, "site-access.granted", "site-access", grant.id, {
    userId: grant.userId,
    siteName: grant.siteName,
    role: grant.role,
  });
  res.status(201).json(GrantPlatformSiteAccessResponse.parse({
    userId: grant.userId,
    siteName: grant.siteName,
    organizationId: site.organizationId,
    role: grant.role,
    status: grant.status,
  }));
});

router.patch("/platform-admin/access", async (req: Request, res): Promise<void> => {
  const data = UpdatePlatformSiteAccessBody.parse(req.body);
  const [site, user] = await Promise.all([
    db.select().from(platformSitesTable).where(eq(platformSitesTable.siteName, data.siteName)).limit(1),
    db.select().from(usersTable).where(eq(usersTable.id, data.userId)).limit(1),
  ]);
  if (!site[0]) {
    res.status(400).json({ error: "Choose a managed site." });
    return;
  }
  if (!user[0]) {
    res.status(400).json({ error: "Choose an existing SCADA user." });
    return;
  }
  const [grant] = await db.insert(platformSiteAccessTable).values({
    userId: data.userId,
    siteName: data.siteName,
    role: data.role,
    status: data.status,
  }).onConflictDoUpdate({
    target: [platformSiteAccessTable.userId, platformSiteAccessTable.siteName],
    set: { role: data.role, status: data.status, updatedAt: new Date() },
  }).returning();
  await audit(req.platformAdmin!, data.status === "revoked" ? "site-access.revoked" : "site-access.updated", "site-access", grant.id, {
    userId: grant.userId,
    siteName: grant.siteName,
    role: grant.role,
    status: grant.status,
  });
  res.json(UpdatePlatformSiteAccessResponse.parse({
    userId: grant.userId,
    siteName: grant.siteName,
    organizationId: site[0].organizationId,
    role: grant.role,
    status: grant.status,
  }));
});

router.get("/platform-admin/mqtt-config", async (_req, res): Promise<void> => {
  res.json(GetPlatformMqttConfigResponse.parse(await brokerConfiguration()));
});

router.patch("/platform-admin/mqtt-config", async (req: Request, res): Promise<void> => {
  const data = UpdatePlatformMqttConfigBody.parse(req.body);
  const value = {
    brokerUrl: data.brokerUrl.trim(),
    topic: data.topic.trim(),
    plantSite: data.plantSite.trim(),
    timezone: data.timezone.trim(),
  };
  await db.insert(platformConfigurationTable).values({
    key: "mqtt",
    value,
    updatedBy: req.platformAdmin!.userId,
  }).onConflictDoUpdate({
    target: platformConfigurationTable.key,
    set: { value, updatedBy: req.platformAdmin!.userId, updatedAt: new Date() },
  });
  await audit(req.platformAdmin!, "mqtt.configuration.staged", "mqtt", "connection", {
    brokerUrl: value.brokerUrl,
    topic: value.topic,
    plantSite: value.plantSite,
    timezone: value.timezone,
  });
  res.json(UpdatePlatformMqttConfigResponse.parse({
    ...value,
    credentialsConfigured: Boolean(process.env.MQTT_USERNAME && process.env.MQTT_PASSWORD),
    pendingApply: true,
  }));
});

router.post("/platform-admin/mqtt-config/apply", async (req: Request, res): Promise<void> => {
  const config = await brokerConfiguration();
  if (!config.pendingApply) {
    res.json(UpdatePlatformMqttConfigResponse.parse(config));
    return;
  }
  const next: MqttRuntimeConfiguration = {
    brokerUrl: config.brokerUrl,
    topic: config.topic,
    plantSite: config.plantSite,
    timezone: config.timezone,
  };
  const applied = await applyMqttConfiguration(next);
  const result = await brokerConfiguration();
  await audit(req.platformAdmin!, applied ? "mqtt.configuration.applied" : "mqtt.configuration.rollback", "mqtt", "connection", {
    brokerUrl: applied ? next.brokerUrl : result.brokerUrl,
    topic: applied ? next.topic : result.topic,
    applied,
  });
  res.status(applied ? 200 : 502).json(UpdatePlatformMqttConfigResponse.parse(result));
});

router.get("/platform-admin/audit", async (_req, res): Promise<void> => {
  const events = await db.select().from(platformAuditEventsTable).orderBy(desc(platformAuditEventsTable.createdAt)).limit(150);
  res.json(ListPlatformAuditEventsResponse.parse(events.map((event) => ({
    id: event.id,
    actorEmail: event.actorEmail,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    createdAt: event.createdAt.toISOString(),
    metadata: hasRecord(event.metadata) ? event.metadata : {},
  }))));
});

router.get("/platform-admin/database/health", async (req: Request, res): Promise<void> => {
  const health = await platformDatabaseHealth();
  void audit(req.platformAdmin!, "database.health.read", "database", "health", { status: health.status, latencyMs: health.latencyMs })
    .catch((error) => req.log.warn({ err: error }, "Platform database health audit could not be recorded"));
  res.status(health.status === "ok" ? 200 : 503).json(GetPlatformDatabaseHealthResponse.parse(health));
});

router.get("/platform-admin/database/tables", async (req: Request, res): Promise<void> => {
  try {
    const tables = await listApprovedDatabaseTables();
    await audit(req.platformAdmin!, "database.tables.listed", "database", "approved-tables", { tableCount: tables.length });
    res.json(ListPlatformDatabaseTablesResponse.parse(tables));
  } catch (error) {
    req.log.error({ err: error }, "Platform database table list failed");
    res.status(503).json({ error: "Approved database tables are temporarily unavailable." });
  }
});

router.post("/platform-admin/database/rows", async (req: Request, res): Promise<void> => {
  const data = BrowsePlatformDatabaseTableBody.parse(req.body);
  if (!Number.isInteger(data.page) || !Number.isInteger(data.pageSize)) {
    res.status(400).json({ error: "Page and page size must be whole numbers." });
    return;
  }
  try {
    const records = await browseApprovedDatabaseTable({
      tableName: data.tableName,
      page: data.page,
      pageSize: data.pageSize,
      search: data.search,
    });
    await audit(req.platformAdmin!, "database.table.browsed", "database-table", records.table.name, {
      page: records.page,
      pageSize: records.pageSize,
      searchApplied: Boolean(data.search?.trim()),
    });
    res.json(BrowsePlatformDatabaseTableResponse.parse(records));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to browse this table.";
    await audit(req.platformAdmin!, "database.table.rejected", "database-table", data.tableName, { reason: message });
    res.status(400).json({ error: message });
  }
});

router.get("/platform-admin/database/migrations", async (req: Request, res): Promise<void> => {
  try {
    const migrations = await platformMigrationStatus();
    await audit(req.platformAdmin!, "database.migrations.read", "database", "schema", {
      status: migrations.status,
      presentTables: migrations.presentTables,
      expectedTables: migrations.expectedTables,
    });
    res.json(GetPlatformDatabaseMigrationsResponse.parse(migrations));
  } catch (error) {
    req.log.error({ err: error }, "Platform migration status query failed");
    res.status(503).json({ error: "Database schema status is temporarily unavailable." });
  }
});

router.get("/platform-admin/database/backup", async (req: Request, res): Promise<void> => {
  try {
    const backup = await createApplicationBackup();
    await audit(req.platformAdmin!, "database.backup.downloaded", "database", "application-export", {
      tableCount: backup.tables.length,
      rowLimitPerTable: backup.rowLimitPerTable,
    });
    const stamp = backup.generatedAt.replace(/[:.]/g, "-");
    res
      .set("Content-Type", "application/json; charset=utf-8")
      .set("Content-Disposition", `attachment; filename="platform-application-export-${stamp}.json"`)
      .set("Cache-Control", "no-store")
      .json(backup);
  } catch (error) {
    req.log.error({ err: error }, "Platform application backup failed");
    res.status(503).json({ error: "Application data export is temporarily unavailable." });
  }
});

router.post("/platform-admin/database/query", async (req: Request, res): Promise<void> => {
  const data = RunPlatformDatabaseQueryBody.parse(req.body);
  try {
    const result = await runReadOnlyDatabaseQuery(data.query);
    await audit(req.platformAdmin!, "database.query.executed", "database-query", result.queryFingerprint, {
      queryLength: result.queryLength,
      rowCount: result.rowCount,
      truncated: result.truncated,
      durationMs: result.durationMs,
    });
    res.json(RunPlatformDatabaseQueryResponse.parse(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Database query was rejected.";
    const fingerprint = crypto.createHash("sha256").update(data.query.trim()).digest("hex").slice(0, 16);
    await audit(req.platformAdmin!, "database.query.rejected", "database-query", fingerprint, { queryLength: data.query.length, reason: message });
    res.status(/five-second/i.test(message) ? 408 : 400).json({ error: message });
  }
});

export default router;