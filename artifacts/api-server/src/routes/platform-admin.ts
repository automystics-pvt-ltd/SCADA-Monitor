import crypto from "crypto";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { Router, type IRouter, type Request } from "express";
import {
  CreatePlatformOrganizationBody,
  CreatePlatformOrganizationResponse,
  CreatePlatformSiteBody,
  CreatePlatformSiteResponse,
  CreatePlatformTelemetryTestBody,
  CreatePlatformTelemetryTestResponse,
  CreatePlatformUserBody,
  CreatePlatformUserResponse,
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
  ListPlatformTelemetryMappingsResponse,
  ListPlatformTelemetryParametersQueryParams,
  ListPlatformTelemetryMappingsQueryParams,
  ListPlatformTelemetryParametersResponse,
  ListPlatformUsersResponse,
  RunPlatformDatabaseQueryBody,
  RunPlatformDatabaseQueryResponse,
  UpdatePlatformSiteAccessBody,
  UpdatePlatformSiteAccessResponse,
  UpdatePlatformSiteBody,
  UpdatePlatformSiteResponse,
  UpdatePlatformSiteActivationBody,
  UpdatePlatformSiteActivationResponse,
  UpdatePlatformMqttConfigBody,
  UpdatePlatformMqttConfigResponse,
  UpdatePlatformRolePermissionsBody,
  UpdatePlatformRolePermissionsResponse,
  UpdatePlatformUserBody,
  UpdatePlatformUserResponse,
  UpdatePlatformUserStatusBody,
  UpdatePlatformUserStatusResponse,
  UpsertPlatformTelemetryMappingBody,
  UpsertPlatformTelemetryMappingResponse,
  ClearPlatformTelemetryMappingBody,
  ClearPlatformTelemetryMappingResponse,
} from "@workspace/api-zod";
import {
  db,
  plantLocationsTable,
  platformAuditEventsTable,
  platformAdminIdentitiesTable,
  platformAdminSessionsTable,
  platformConfigurationTable,
  platformOrganizationAccessTable,
  platformOrganizationsTable,
  platformSiteAccessTable,
  platformSitesTable,
  platformTelemetryTestsTable,
  platformTelemetryDiscoveriesTable,
  platformTelemetryMappingsTable,
  scadaSessionsTable,
  usersTable,
} from "@workspace/db";
import {
  applyMqttConfiguration,
  broadcastSiteActivation,
  broadcastTelemetryMappingChange,
  getMqttRuntimeStatus,
  invalidateTelemetryMappingCache,
  listLiveTelemetryDevices,
  listLatestDeviceParameters,
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
import { rolePermissions, type RolePermissionsConfig, type ScadaPermission } from "../middlewares/platformSiteAccessPolicy";
import { hashScadaPassword, normalizeScadaUsername } from "../lib/auth";
import { mappingWorkspaceRows, telemetryMappingIdentityKey } from "../lib/telemetry-mapping-workspace";
import { telemetryMappingIsUnchanged } from "../lib/telemetry-mapping-lifecycle";
import { telemetryMappingRequiresDisplayUnit } from "../lib/telemetry-mapping-policy";

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

function telemetryMappingResponse(mapping: typeof platformTelemetryMappingsTable.$inferSelect) {
  return {
    id: mapping.id,
    siteName: mapping.siteName,
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
    status: mapping.status,
    version: mapping.version,
    updatedAt: mapping.updatedAt.toISOString(),
  };
}

async function activeManagedSite(siteName: string) {
  const [site] = await db.select().from(platformSitesTable)
    .where(and(eq(platformSitesTable.siteName, siteName), eq(platformSitesTable.status, "active")))
    .limit(1);
  return site;
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

type ScadaRole = "viewer" | "operator" | "site-engineer" | "site-admin";

function requestedRole(value: string): ScadaRole {
  return value === "operator" || value === "site-engineer" || value === "site-admin" ? value : "viewer";
}

function uniqueIds(values: string[] | undefined) {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function rolePermissionsResponse(config?: RolePermissionsConfig) {
  return {
    viewerPermissions: [...rolePermissions("viewer", config)],
    operatorPermissions: [...rolePermissions("operator", config)],
    siteEngineerPermissions: [...rolePermissions("site-engineer", config)],
    siteAdminPermissions: [...rolePermissions("site-admin", config)],
  };
}

function parseRolePermissions(value: unknown): RolePermissionsConfig | undefined {
  if (!hasRecord(value)) return undefined;
  const allowed = new Set<ScadaPermission>([
    "dashboard", "live-monitoring", "inverter-details", "electrical-parameters", "energy-analytics", "mppt-strings",
    "alarms-faults", "historical-data", "scada-reports", "data-export", "site-configuration", "device-configuration", "user-management",
  ]);
  const parse = (role: "viewer" | "operator" | "site-engineer" | "site-admin") =>
    Array.isArray(value[role]) ? value[role].filter((permission): permission is ScadaPermission => typeof permission === "string" && allowed.has(permission as ScadaPermission)) : undefined;
  return { viewer: parse("viewer"), operator: parse("operator"), "site-engineer": parse("site-engineer"), "site-admin": parse("site-admin") };
}

async function currentRolePermissions() {
  const [saved] = await db.select({ value: platformConfigurationTable.value })
    .from(platformConfigurationTable)
    .where(eq(platformConfigurationTable.key, "role-permissions"))
    .limit(1);
  return parseRolePermissions(saved?.value);
}

async function platformUserPayload(userId: string) {
  const [[user], memberships, grants] = await Promise.all([
    db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1),
    db.select({
      organizationId: platformOrganizationAccessTable.organizationId,
      organizationName: platformOrganizationsTable.name,
      status: platformOrganizationAccessTable.status,
    }).from(platformOrganizationAccessTable)
      .innerJoin(platformOrganizationsTable, eq(platformOrganizationAccessTable.organizationId, platformOrganizationsTable.id))
      .where(eq(platformOrganizationAccessTable.userId, userId))
      .orderBy(asc(platformOrganizationsTable.name)),
    db.select({
      userId: platformSiteAccessTable.userId,
      siteName: platformSiteAccessTable.siteName,
      organizationId: platformSitesTable.organizationId,
      role: platformSiteAccessTable.role,
      status: platformSiteAccessTable.status,
    }).from(platformSiteAccessTable)
      .innerJoin(platformSitesTable, eq(platformSiteAccessTable.siteName, platformSitesTable.siteName))
      .where(eq(platformSiteAccessTable.userId, userId))
      .orderBy(asc(platformSiteAccessTable.siteName)),
  ]);
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    passwordConfigured: Boolean(user.passwordHash),
    name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email || "Unnamed SCADA user",
    firstName: user.firstName,
    lastName: user.lastName,
    accountStatus: user.accountStatus,
    organizations: memberships.map((membership) => ({
      organizationId: membership.organizationId,
      organizationName: membership.organizationName,
      status: membership.status,
    })),
    access: grants.map((grant) => ({
      userId: grant.userId,
      siteName: grant.siteName,
      organizationId: grant.organizationId,
      role: requestedRole(grant.role),
      status: grant.status,
    })),
  };
}

async function validateAssignments(organizationIds: string[], siteAccess: Array<{ siteName: string; role: ScadaRole }>) {
  const requestedSiteNames = uniqueIds(siteAccess.map((grant) => grant.siteName));
  const organizations = organizationIds.length
    ? await db.select().from(platformOrganizationsTable).where(inArray(platformOrganizationsTable.id, organizationIds))
    : [];
  const sites = requestedSiteNames.length
    ? await db.select().from(platformSitesTable).where(inArray(platformSitesTable.siteName, requestedSiteNames))
    : [];
  if (organizations.length !== organizationIds.length || organizations.some((organization) => organization.status !== "active")) {
    throw new Error("Choose active organizations for this user.");
  }
  if (sites.length !== requestedSiteNames.length || sites.some((site) => site.status !== "active")) {
    throw new Error("Choose active managed sites for this user.");
  }
  return { completeOrganizationIds: uniqueIds([...organizationIds, ...sites.map((site) => site.organizationId)]) };
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
      await tx.insert(platformOrganizationAccessTable).values({
        userId: req.platformAdmin!.userId,
        organizationId: createdSite.organizationId,
        status: "active",
      }).onConflictDoUpdate({
        target: [platformOrganizationAccessTable.userId, platformOrganizationAccessTable.organizationId],
        set: { status: "active", updatedAt: new Date() },
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

router.get("/platform-admin/telemetry/parameters", async (req: Request, res): Promise<void> => {
  const query = ListPlatformTelemetryParametersQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Provide a valid managed site and optional device source." });
    return;
  }
  const site = await activeManagedSite(query.data.siteName);
  if (!site) {
    res.status(404).json({ error: "Choose an active managed site." });
    return;
  }
  const [parameters, mappings] = await Promise.all([
    listLatestDeviceParameters(site.siteName, query.data.deviceId),
    db.select().from(platformTelemetryMappingsTable).where(and(
      eq(platformTelemetryMappingsTable.siteName, site.siteName),
      eq(platformTelemetryMappingsTable.status, "active"),
    )),
  ]);
  const workspaceRows = mappingWorkspaceRows(
    parameters,
    mappings.filter((mapping) => !query.data.deviceId || mapping.deviceId === query.data.deviceId),
  );
  const data = ListPlatformTelemetryParametersResponse.parse({
    siteName: site.siteName,
    deviceId: query.data.deviceId ?? null,
    parameters: workspaceRows.map(({ parameter, mapping }) => {
      return {
        observationId: parameter.observationId,
        signalKey: parameter.signalKey,
        siteName: parameter.siteName,
        deviceId: parameter.deviceId,
        deviceName: parameter.deviceName,
        topic: parameter.topic,
        originalName: parameter.originalName,
        normalizedName: parameter.normalizedName,
        displayLabel: parameter.displayLabel,
        category: parameter.category,
        evidenceAvailable: parameter.evidenceAvailable,
        rawValue: parameter.rawValue,
        reportedValue: parameter.reportedValue,
        reportedNumericValue: parameter.reportedNumericValue,
        displayValue: parameter.displayValue ?? null,
        displayNumericValue: parameter.displayNumericValue ?? null,
        displayUnit: parameter.displayUnit ?? null,
        sourceUnit: parameter.sourceUnit,
        address: parameter.address,
        sourceName: parameter.sourceName,
        sourceIdentity: parameter.sourceIdentity,
        observedAt: parameter.observedAt ?? null,
        receivedAt: parameter.receivedAt,
        provenance: parameter.provenance,
        dataQuality: parameter.dataQuality,
        scalingStatus: parameter.scalingStatus,
        mappingValidationStatus: parameter.adminMappingValidationStatus ?? null,
        observationCount: parameter.observationCount ?? 0,
        // The workspace must classify from the same active-mapping row it
        // returns. The catalog status is durable queue metadata, but a
        // concurrent clear cannot make this response say "mapped" while its
        // mapping payload is null.
        mappingLifecycleStatus: mapping ? "mapped" : "unmapped",
        firstSeenAt: parameter.firstSeenAt ?? null,
        lastSeenAt: parameter.lastSeenAt ?? null,
        freshness: parameter.freshness,
        mapping: mapping ? telemetryMappingResponse(mapping) : null,
      };
    }),
  });
  res.set("Cache-Control", "no-store").json(data);
});

router.get("/platform-admin/telemetry/mappings", async (req: Request, res): Promise<void> => {
  const query = ListPlatformTelemetryMappingsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "Provide a valid managed site and optional device source." });
    return;
  }
  const site = await activeManagedSite(query.data.siteName);
  if (!site) {
    res.status(404).json({ error: "Choose an active managed site." });
    return;
  }
  const predicates = [
    eq(platformTelemetryMappingsTable.siteName, site.siteName),
    eq(platformTelemetryMappingsTable.status, "active"),
  ];
  if (query.data.deviceId) predicates.push(eq(platformTelemetryMappingsTable.deviceId, query.data.deviceId));
  const mappings = await db.select().from(platformTelemetryMappingsTable)
    .where(and(...predicates))
    .orderBy(asc(platformTelemetryMappingsTable.displayLabel));
  res.set("Cache-Control", "no-store").json(ListPlatformTelemetryMappingsResponse.parse(mappings.map(telemetryMappingResponse)));
});

router.put("/platform-admin/telemetry/mappings", async (req: Request, res): Promise<void> => {
  const data = UpsertPlatformTelemetryMappingBody.safeParse(req.body);
  if (!data.success) {
    res.status(400).json({ error: "Provide a complete source identity, destination, label, and category." });
    return;
  }
  const site = await activeManagedSite(data.data.siteName);
  if (!site) {
    res.status(404).json({ error: "Choose an active managed site." });
    return;
  }
  const identity = {
    siteName: site.siteName,
    deviceId: data.data.deviceId,
    sourceIdentity: data.data.sourceIdentity,
    normalizedName: data.data.normalizedName,
    address: data.data.address,
  };
  const parameter = (await listLatestDeviceParameters(site.siteName, data.data.deviceId)).find((candidate) =>
    telemetryMappingIdentityKey({
      siteName: candidate.siteName,
      deviceId: candidate.deviceId,
      sourceIdentity: candidate.sourceIdentity,
      normalizedName: candidate.normalizedName,
      address: candidate.address ?? "—",
    }) === telemetryMappingIdentityKey(identity),
  );
  const multiplier = data.data.scalingMultiplier ?? 1;
  const offset = data.data.scalingOffset ?? 0;
  if (!Number.isFinite(multiplier) || !Number.isFinite(offset) || Math.abs(multiplier) > 1_000_000_000 || Math.abs(offset) > 1_000_000_000) {
    res.status(400).json({ error: "Scaling must use finite multiplier and offset values within the approved operational range." });
    return;
  }
  if (["inverter-identity", "active-power"].includes(data.data.destination) && !data.data.inverterIdentity?.trim()) {
    res.status(400).json({ error: "Choose an inverter identity when mapping an inverter identity or active-power signal." });
    return;
  }
  if (data.data.inverterIdentity && !/^inv[1-5]$/i.test(data.data.inverterIdentity.trim())) {
    res.status(400).json({ error: "Use a managed inverter identity from inv1 through inv5." });
    return;
  }
  const now = new Date();
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${telemetryMappingIdentityKey(identity)}))`);
    const [previous] = await tx.select().from(platformTelemetryMappingsTable).where(and(
      eq(platformTelemetryMappingsTable.siteName, identity.siteName),
      eq(platformTelemetryMappingsTable.deviceId, identity.deviceId),
      eq(platformTelemetryMappingsTable.sourceIdentity, identity.sourceIdentity),
      eq(platformTelemetryMappingsTable.normalizedName, identity.normalizedName),
      eq(platformTelemetryMappingsTable.address, identity.address),
    )).limit(1);
    if (!parameter && !previous) return { kind: "missing" as const };
    const sourceUnit = parameter?.sourceUnit ?? previous?.sourceUnit ?? null;
    if (data.data.sourceUnit !== undefined && data.data.sourceUnit !== null && data.data.sourceUnit !== (sourceUnit ?? "")) {
      return { kind: "invalid-source-unit" as const };
    }
    const displayUnit = data.data.displayUnit?.trim() || sourceUnit || null;
    if (!displayUnit && telemetryMappingRequiresDisplayUnit(data.data.destination)) return { kind: "missing-display-unit" as const };
    const sourceName = parameter?.sourceName ?? previous!.sourceName;
    const nextMapping = {
      sourceName,
      destination: data.data.destination,
      displayLabel: data.data.displayLabel.trim(),
      category: data.data.category.trim(),
      inverterIdentity: data.data.inverterIdentity?.trim() || null,
      sourceUnit,
      displayUnit,
      scalingMultiplier: multiplier,
      scalingOffset: offset,
      scalingStatus: "approved" as const,
      status: "active" as const,
    };
    if (previous && telemetryMappingIsUnchanged(previous, nextMapping)) return { kind: "noop" as const, mapping: previous };
    const [saved] = await tx.insert(platformTelemetryMappingsTable).values({
      ...identity,
      ...nextMapping,
      createdBy: previous?.createdBy ?? req.platformAdmin!.userId,
      updatedBy: req.platformAdmin!.userId,
      clearedAt: null,
    }).onConflictDoUpdate({
      target: [
        platformTelemetryMappingsTable.siteName,
        platformTelemetryMappingsTable.deviceId,
        platformTelemetryMappingsTable.sourceIdentity,
        platformTelemetryMappingsTable.normalizedName,
        platformTelemetryMappingsTable.address,
      ],
      set: {
        ...nextMapping,
        updatedBy: req.platformAdmin!.userId,
        clearedAt: null,
        version: sql`${platformTelemetryMappingsTable.version} + 1`,
        updatedAt: now,
      },
    }).returning();
    if (!saved) throw new Error("The saved telemetry mapping was not returned.");
    await tx.update(platformTelemetryDiscoveriesTable).set({
      mappingStatus: "mapped",
      lastMappingChangedAt: now,
    }).where(and(
      eq(platformTelemetryDiscoveriesTable.siteName, identity.siteName),
      eq(platformTelemetryDiscoveriesTable.deviceId, identity.deviceId),
      eq(platformTelemetryDiscoveriesTable.sourceIdentity, identity.sourceIdentity),
      eq(platformTelemetryDiscoveriesTable.normalizedName, identity.normalizedName),
      eq(platformTelemetryDiscoveriesTable.address, identity.address),
    ));
    await tx.insert(platformAuditEventsTable).values({
      actorUserId: req.platformAdmin!.userId,
      actorEmail: req.platformAdmin!.email,
      action: previous ? "telemetry-mapping.updated" : "telemetry-mapping.created",
      targetType: "telemetry-mapping",
      targetId: saved.id,
      metadata: {
        ...identity,
        sourceName,
        destination: saved.destination,
        sourceUnit: saved.sourceUnit,
        displayUnit: saved.displayUnit,
        scalingMultiplier: saved.scalingMultiplier,
        scalingOffset: saved.scalingOffset,
        version: saved.version,
      },
    });
    return { kind: "saved" as const, mapping: saved };
  });
  if (outcome.kind === "missing") {
    res.status(400).json({ error: "A new mapping must match currently discovered source evidence from this exact site, device, source, and register." });
    return;
  }
  if (outcome.kind === "invalid-source-unit") {
    res.status(400).json({ error: "The source unit must match the current or previously saved source unit. Mapping cannot invent a unit." });
    return;
  }
  if (outcome.kind === "missing-display-unit") {
    res.status(400).json({ error: "Choose a confirmed display unit for this numeric mapping, or wait for the device to report its source unit. Alarm, fault, communication, data-quality, and inverter identity mappings are explicitly unitless." });
    return;
  }
  if (outcome.kind === "noop") {
    res.set("Cache-Control", "no-store").json(UpsertPlatformTelemetryMappingResponse.parse(telemetryMappingResponse(outcome.mapping)));
    return;
  }
  const mapping = outcome.mapping;
  invalidateTelemetryMappingCache();
  broadcastTelemetryMappingChange(mapping.siteName, mapping.updatedAt.toISOString());
  res.json(UpsertPlatformTelemetryMappingResponse.parse(telemetryMappingResponse(mapping)));
});

router.post("/platform-admin/telemetry/mappings/clear", async (req: Request, res): Promise<void> => {
  const data = ClearPlatformTelemetryMappingBody.safeParse(req.body);
  if (!data.success) {
    res.status(400).json({ error: "Provide the complete saved mapping identity to clear it." });
    return;
  }
  const now = new Date();
  const mapping = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${telemetryMappingIdentityKey(data.data)}))`);
    const [saved] = await tx.update(platformTelemetryMappingsTable).set({
      status: "cleared",
      clearedAt: now,
      updatedAt: now,
      updatedBy: req.platformAdmin!.userId,
      version: sql`${platformTelemetryMappingsTable.version} + 1`,
    }).where(and(
      eq(platformTelemetryMappingsTable.siteName, data.data.siteName),
      eq(platformTelemetryMappingsTable.deviceId, data.data.deviceId),
      eq(platformTelemetryMappingsTable.sourceIdentity, data.data.sourceIdentity),
      eq(platformTelemetryMappingsTable.normalizedName, data.data.normalizedName),
      eq(platformTelemetryMappingsTable.address, data.data.address),
      eq(platformTelemetryMappingsTable.status, "active"),
    )).returning();
    if (!saved) return undefined;
    await tx.update(platformTelemetryDiscoveriesTable).set({
      mappingStatus: "unmapped",
      lastMappingChangedAt: now,
    }).where(and(
      eq(platformTelemetryDiscoveriesTable.siteName, saved.siteName),
      eq(platformTelemetryDiscoveriesTable.deviceId, saved.deviceId),
      eq(platformTelemetryDiscoveriesTable.sourceIdentity, saved.sourceIdentity),
      eq(platformTelemetryDiscoveriesTable.normalizedName, saved.normalizedName),
      eq(platformTelemetryDiscoveriesTable.address, saved.address),
    ));
    await tx.insert(platformAuditEventsTable).values({
      actorUserId: req.platformAdmin!.userId,
      actorEmail: req.platformAdmin!.email,
      action: "telemetry-mapping.cleared",
      targetType: "telemetry-mapping",
      targetId: saved.id,
      metadata: {
        siteName: saved.siteName,
        deviceId: saved.deviceId,
        sourceIdentity: saved.sourceIdentity,
        normalizedName: saved.normalizedName,
        address: saved.address,
        version: saved.version,
      },
    });
    return saved;
  });
  if (!mapping) {
    res.status(404).json({ error: "No active mapping exists for that exact site, device, source, and register." });
    return;
  }
  invalidateTelemetryMappingCache();
  broadcastTelemetryMappingChange(mapping.siteName, mapping.updatedAt.toISOString());
  res.json(ClearPlatformTelemetryMappingResponse.parse(telemetryMappingResponse(mapping)));
});

router.patch("/platform-admin/sites", async (req: Request, res): Promise<void> => {
  const data = UpdatePlatformSiteBody.parse(req.body);
  const siteName = data.siteName.trim();
  const hasLatitude = Object.prototype.hasOwnProperty.call(data, "latitude");
  const hasLongitude = Object.prototype.hasOwnProperty.call(data, "longitude");
  if (hasLatitude !== hasLongitude) {
    res.status(400).json({ error: "Provide both latitude and longitude, or clear both coordinates together." });
    return;
  }
  const [site] = await db.select().from(platformSitesTable).where(eq(platformSitesTable.siteName, siteName)).limit(1);
  if (!site) {
    res.status(404).json({ error: "Choose a managed site." });
    return;
  }
  const organizationId = data.organizationId?.trim() || site.organizationId;
  const timezone = data.timezone?.trim() || site.timezone;
  if (!timezone) {
    res.status(400).json({ error: "Timezone cannot be blank." });
    return;
  }
  const [organization] = await db
    .select()
    .from(platformOrganizationsTable)
    .where(and(eq(platformOrganizationsTable.id, organizationId), eq(platformOrganizationsTable.status, "active")))
    .limit(1);
  if (!organization) {
    res.status(404).json({ error: "Choose an active organization." });
    return;
  }
  try {
    const updated = await db.transaction(async (tx) => {
      const [updatedSite] = await tx.update(platformSitesTable).set({
        organizationId,
        timezone,
      }).where(eq(platformSitesTable.siteName, siteName)).returning();
      if (hasLatitude && hasLongitude) {
        if (data.latitude === null && data.longitude === null) {
          await tx.delete(plantLocationsTable).where(eq(plantLocationsTable.siteName, siteName));
        } else if (typeof data.latitude === "number" && typeof data.longitude === "number") {
          await tx.insert(plantLocationsTable).values({
            siteName,
            latitude: data.latitude,
            longitude: data.longitude,
          }).onConflictDoUpdate({
            target: plantLocationsTable.siteName,
            set: { latitude: data.latitude, longitude: data.longitude, updatedAt: new Date() },
          });
        } else {
          throw new Error("Coordinates must be both numbers or both null.");
        }
      }
      return updatedSite;
    });
    const [location] = await db.select({
      latitude: plantLocationsTable.latitude,
      longitude: plantLocationsTable.longitude,
    }).from(plantLocationsTable).where(eq(plantLocationsTable.siteName, siteName)).limit(1);
    const [latestTest] = await db
      .select()
      .from(platformTelemetryTestsTable)
      .where(eq(platformTelemetryTestsTable.siteName, siteName))
      .orderBy(desc(platformTelemetryTestsTable.finishedAt))
      .limit(1);
    await audit(req.platformAdmin!, "site.updated", "site", siteName, {
      organizationId: updated.organizationId,
      previousOrganizationId: site.organizationId,
      timezone: updated.timezone,
      previousTimezone: site.timezone,
      locationChanged: hasLatitude && hasLongitude,
      locationCleared: hasLatitude && hasLongitude && data.latitude === null && data.longitude === null,
    });
    res.json(UpdatePlatformSiteResponse.parse(platformSiteResponse(updated, organization.name, location, latestTest)));
  } catch (error) {
    req.log.warn({ err: error, siteName }, "Platform site update failed");
    res.status(500).json({ error: "The site could not be updated. Try again." });
  }
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
  const users = await db.select({ id: usersTable.id }).from(usersTable).orderBy(asc(usersTable.email));
  const payloads = (await Promise.all(users.map((user) => platformUserPayload(user.id)))).filter((user): user is NonNullable<typeof user> => Boolean(user));
  res.json(ListPlatformUsersResponse.parse(payloads));
});

router.post("/platform-admin/users", async (req: Request, res): Promise<void> => {
  const data = CreatePlatformUserBody.parse(req.body);
  const email = data.email.trim().toLowerCase();
  const username = normalizeScadaUsername(data.username);
  if (!username) {
    res.status(400).json({ error: "Choose a username using 3-64 letters, numbers, dots, dashes, or underscores." });
    return;
  }
  const organizationIds = uniqueIds(data.organizationIds);
  const siteAccess = (data.siteAccess ?? []).map((grant) => ({ siteName: grant.siteName.trim(), role: requestedRole(grant.role) }));
  if (new Set(siteAccess.map((grant) => grant.siteName)).size !== siteAccess.length) {
    res.status(400).json({ error: "Assign each site only once; update its role in the existing assignment." });
    return;
  }
  const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (existing) {
    res.status(409).json({ error: "A SCADA user with this email already exists. Use Manage to update their access." });
    return;
  }
  const [existingUsername] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.username, username)).limit(1);
  if (existingUsername) {
    res.status(409).json({ error: "That SCADA username is already in use. Choose a different username." });
    return;
  }
  try {
    const assignments = await validateAssignments(organizationIds, siteAccess);
    const passwordHash = await hashScadaPassword(data.password);
    const [created] = await db.transaction(async (tx) => {
      const [user] = await tx.insert(usersTable).values({
        email,
        username,
        passwordHash,
        passwordSetAt: new Date(),
        firstName: data.firstName?.trim() || null,
        lastName: data.lastName?.trim() || null,
        accountStatus: "active",
      }).returning();
      if (assignments.completeOrganizationIds.length) {
        await tx.insert(platformOrganizationAccessTable).values(assignments.completeOrganizationIds.map((organizationId) => ({
          userId: user.id,
          organizationId,
          status: "active" as const,
        })));
      }
      if (siteAccess.length) {
        await tx.insert(platformSiteAccessTable).values(siteAccess.map((grant) => ({
          userId: user.id,
          siteName: grant.siteName,
          role: grant.role,
          status: "active" as const,
        })));
      }
      return [user];
    });
    const payload = await platformUserPayload(created.id);
    if (!payload) throw new Error("Provisioned user could not be loaded.");
    await audit(req.platformAdmin!, "user.provisioned", "user", created.id, {
      email,
      username,
      passwordConfigured: true,
      organizationCount: payload.organizations.length,
      siteGrantCount: payload.access.length,
    });
    res.status(201).json(CreatePlatformUserResponse.parse(payload));
  } catch (error) {
    const message = error instanceof Error ? error.message : "The SCADA user could not be provisioned.";
    res.status(message.includes("Choose active") ? 400 : 500).json({ error: message });
  }
});

router.patch("/platform-admin/users", async (req: Request, res): Promise<void> => {
  const data = UpdatePlatformUserBody.parse(req.body);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, data.userId)).limit(1);
  if (!user) {
    res.status(404).json({ error: "Choose an existing SCADA user." });
    return;
  }
  const organizationIds = data.organizationIds === undefined ? undefined : uniqueIds(data.organizationIds);
  const siteAccess = data.siteAccess === undefined ? undefined : data.siteAccess.map((grant) => ({ siteName: grant.siteName.trim(), role: requestedRole(grant.role) }));
  const username = data.username === undefined ? user.username : normalizeScadaUsername(data.username);
  if (data.username !== undefined && !username) {
    res.status(400).json({ error: "Choose a username using 3-64 letters, numbers, dots, dashes, or underscores." });
    return;
  }
  if (data.password !== undefined && !username) {
    res.status(400).json({ error: "Set a SCADA username before setting a password." });
    return;
  }
  if (siteAccess && new Set(siteAccess.map((grant) => grant.siteName)).size !== siteAccess.length) {
    res.status(400).json({ error: "Assign each site only once; update its role in the existing assignment." });
    return;
  }
  try {
    if (data.username !== undefined && username !== user.username) {
      const [existingUsername] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.username, username!)).limit(1);
      if (existingUsername) {
        res.status(409).json({ error: "That SCADA username is already in use. Choose a different username." });
        return;
      }
    }
    const passwordHash = data.password === undefined ? undefined : await hashScadaPassword(data.password);
    let completeOrganizationIds = organizationIds;
    if (organizationIds !== undefined || siteAccess !== undefined) {
      const existingGrants = siteAccess === undefined
        ? await db.select({ siteName: platformSiteAccessTable.siteName, role: platformSiteAccessTable.role }).from(platformSiteAccessTable)
          .where(and(eq(platformSiteAccessTable.userId, user.id), eq(platformSiteAccessTable.status, "active")))
        : siteAccess;
      const assignments = await validateAssignments(organizationIds ?? [], existingGrants.map((grant) => ({ siteName: grant.siteName, role: requestedRole(grant.role) })));
      completeOrganizationIds = assignments.completeOrganizationIds;
    }
    await db.transaction(async (tx) => {
      await tx.update(usersTable).set({
        username,
        passwordHash: passwordHash ?? user.passwordHash,
        passwordSetAt: passwordHash ? new Date() : user.passwordSetAt,
        firstName: data.firstName === undefined ? user.firstName : data.firstName.trim() || null,
        lastName: data.lastName === undefined ? user.lastName : data.lastName.trim() || null,
        updatedAt: new Date(),
      }).where(eq(usersTable.id, user.id));
      if (passwordHash) {
        await tx.delete(scadaSessionsTable).where(eq(scadaSessionsTable.userId, user.id));
      }
      if (completeOrganizationIds !== undefined) {
        await tx.update(platformOrganizationAccessTable).set({ status: "revoked", updatedAt: new Date() })
          .where(eq(platformOrganizationAccessTable.userId, user.id));
        if (completeOrganizationIds.length) {
          for (const organizationId of completeOrganizationIds) {
            await tx.insert(platformOrganizationAccessTable).values({ userId: user.id, organizationId, status: "active" })
              .onConflictDoUpdate({
                target: [platformOrganizationAccessTable.userId, platformOrganizationAccessTable.organizationId],
                set: { status: "active", updatedAt: new Date() },
              });
          }
        }
      }
      if (siteAccess !== undefined) {
        await tx.update(platformSiteAccessTable).set({ status: "revoked", updatedAt: new Date() })
          .where(eq(platformSiteAccessTable.userId, user.id));
        for (const grant of siteAccess) {
          await tx.insert(platformSiteAccessTable).values({ userId: user.id, siteName: grant.siteName, role: grant.role, status: "active" })
            .onConflictDoUpdate({
              target: [platformSiteAccessTable.userId, platformSiteAccessTable.siteName],
              set: { role: grant.role, status: "active", updatedAt: new Date() },
            });
        }
      }
    });
    const payload = await platformUserPayload(user.id);
    if (!payload) throw new Error("Updated user could not be loaded.");
    await audit(req.platformAdmin!, "user.updated", "user", user.id, {
      username: payload.username,
      passwordReset: Boolean(passwordHash),
      organizationCount: payload.organizations.filter((organization) => organization.status === "active").length,
      siteGrantCount: payload.access.filter((grant) => grant.status === "active").length,
    });
    res.json(UpdatePlatformUserResponse.parse(payload));
  } catch (error) {
    const message = error instanceof Error ? error.message : "The SCADA user could not be updated.";
    res.status(message.includes("Choose active") ? 400 : 500).json({ error: message });
  }
});

router.post("/platform-admin/users/status", async (req: Request, res): Promise<void> => {
  const data = UpdatePlatformUserStatusBody.parse(req.body);
  if (data.userId === req.platformAdmin!.userId && data.accountStatus !== "active") {
    res.status(400).json({ error: "You cannot deactivate or delete your own Platform Administrator account." });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, data.userId)).limit(1);
  if (!user) {
    res.status(404).json({ error: "Choose an existing SCADA user." });
    return;
  }
  await db.transaction(async (tx) => {
    await tx.update(usersTable).set({
      accountStatus: data.accountStatus,
      deactivatedAt: data.accountStatus === "active" ? null : new Date(),
      updatedAt: new Date(),
    }).where(eq(usersTable.id, user.id));
    if (data.accountStatus === "deleted") {
      await tx.update(platformSiteAccessTable).set({ status: "revoked", updatedAt: new Date() })
        .where(eq(platformSiteAccessTable.userId, user.id));
      await tx.update(platformOrganizationAccessTable).set({ status: "revoked", updatedAt: new Date() })
        .where(eq(platformOrganizationAccessTable.userId, user.id));
    }
    if (data.accountStatus !== "active") {
      await tx.delete(scadaSessionsTable).where(eq(scadaSessionsTable.userId, user.id));
      const identities = await tx.select({ id: platformAdminIdentitiesTable.id })
        .from(platformAdminIdentitiesTable)
        .where(eq(platformAdminIdentitiesTable.userId, user.id));
      if (identities.length) {
        await tx.delete(platformAdminSessionsTable)
          .where(inArray(platformAdminSessionsTable.adminIdentityId, identities.map((identity) => identity.id)));
      }
    }
  });
  const payload = await platformUserPayload(user.id);
  if (!payload) {
    res.status(500).json({ error: "Updated user could not be loaded." });
    return;
  }
  await audit(req.platformAdmin!, `user.${data.accountStatus}`, "user", user.id, {
    previousStatus: user.accountStatus,
    accountStatus: data.accountStatus,
  });
  res.json(UpdatePlatformUserStatusResponse.parse(payload));
});

router.get("/platform-admin/role-permissions", async (_req, res): Promise<void> => {
  res.json(UpdatePlatformRolePermissionsResponse.parse(rolePermissionsResponse(await currentRolePermissions())));
});

router.patch("/platform-admin/role-permissions", async (req: Request, res): Promise<void> => {
  const data = UpdatePlatformRolePermissionsBody.parse(req.body);
  const value: Required<RolePermissionsConfig> = {
    viewer: data.viewerPermissions,
    operator: data.operatorPermissions,
    "site-engineer": data.siteEngineerPermissions,
    "site-admin": data.siteAdminPermissions,
  };
  await db.insert(platformConfigurationTable).values({
    key: "role-permissions",
    value,
    updatedBy: req.platformAdmin!.userId,
  }).onConflictDoUpdate({
    target: platformConfigurationTable.key,
    set: { value, updatedBy: req.platformAdmin!.userId, updatedAt: new Date() },
  });
  await audit(req.platformAdmin!, "role-permissions.updated", "platform-policy", "role-permissions", {
    viewer: value.viewer.length,
    operator: value.operator.length,
    siteEngineer: value["site-engineer"].length,
    siteAdmin: value["site-admin"].length,
  });
  res.json(UpdatePlatformRolePermissionsResponse.parse(rolePermissionsResponse(value)));
});

router.post("/platform-admin/access", async (req: Request, res): Promise<void> => {
  const data = GrantPlatformSiteAccessBody.parse(req.body);
  const [site] = await db.select().from(platformSitesTable).where(eq(platformSitesTable.siteName, data.siteName)).limit(1);
  if (!site) {
    res.status(400).json({ error: "Choose a managed site." });
    return;
  }
  if (site.status !== "active" || site.activationStatus !== "active") {
    res.status(400).json({ error: "Choose an active site with verified telemetry before granting access." });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, data.userId)).limit(1);
  if (!user) {
    res.status(400).json({ error: "Choose an existing SCADA user." });
    return;
  }
  const grant = await db.transaction(async (tx) => {
    const [savedGrant] = await tx.insert(platformSiteAccessTable).values({
      userId: data.userId,
      siteName: data.siteName,
      role: data.role,
    }).onConflictDoUpdate({
      target: [platformSiteAccessTable.userId, platformSiteAccessTable.siteName],
      set: { role: data.role, status: "active", updatedAt: new Date() },
    }).returning();
    await tx.insert(platformOrganizationAccessTable).values({
      userId: data.userId,
      organizationId: site.organizationId,
      status: "active",
    }).onConflictDoUpdate({
      target: [platformOrganizationAccessTable.userId, platformOrganizationAccessTable.organizationId],
      set: { status: "active", updatedAt: new Date() },
    });
    return savedGrant;
  });
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
  if (data.status === "active" && (site[0].status !== "active" || site[0].activationStatus !== "active")) {
    res.status(400).json({ error: "Choose an active site with verified telemetry before granting access." });
    return;
  }
  const grant = await db.transaction(async (tx) => {
    const [savedGrant] = await tx.insert(platformSiteAccessTable).values({
    userId: data.userId,
    siteName: data.siteName,
    role: data.role,
    status: data.status,
    }).onConflictDoUpdate({
      target: [platformSiteAccessTable.userId, platformSiteAccessTable.siteName],
      set: { role: data.role, status: data.status, updatedAt: new Date() },
    }).returning();
    if (data.status === "active") {
      await tx.insert(platformOrganizationAccessTable).values({
        userId: data.userId,
        organizationId: site[0].organizationId,
        status: "active",
      }).onConflictDoUpdate({
        target: [platformOrganizationAccessTable.userId, platformOrganizationAccessTable.organizationId],
        set: { status: "active", updatedAt: new Date() },
      });
    }
    return savedGrant;
  });
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