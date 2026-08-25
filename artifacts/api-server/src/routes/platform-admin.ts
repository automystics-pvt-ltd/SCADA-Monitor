import { and, asc, count, desc, eq } from "drizzle-orm";
import { Router, type IRouter, type Request } from "express";
import {
  CreatePlatformOrganizationBody,
  CreatePlatformOrganizationResponse,
  CreatePlatformSiteBody,
  CreatePlatformSiteResponse,
  GetPlatformAdminAuthUserResponse,
  GetPlatformAdminOverviewResponse,
  GetPlatformMqttConfigResponse,
  GrantPlatformSiteAccessBody,
  GrantPlatformSiteAccessResponse,
  ListPlatformAuditEventsResponse,
  ListPlatformOrganizationsResponse,
  ListPlatformSitesResponse,
  ListPlatformUsersResponse,
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
  usersTable,
} from "@workspace/db";
import { applyMqttConfiguration, getMqttRuntimeStatus, type MqttRuntimeConfiguration } from "./mqtt";
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
  const [organization] = await db.insert(platformOrganizationsTable).values({
    name: data.name.trim(),
    slug: data.slug.trim().toLowerCase(),
  }).returning();
  await audit(req.platformAdmin!, "organization.created", "organization", organization.id, { slug: organization.slug });
  res.status(201).json(CreatePlatformOrganizationResponse.parse({
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    status: organization.status,
    siteCount: 0,
  }));
});

router.get("/platform-admin/sites", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      siteName: platformSitesTable.siteName,
      organizationId: platformSitesTable.organizationId,
      organizationName: platformOrganizationsTable.name,
      timezone: platformSitesTable.timezone,
      status: platformSitesTable.status,
      latitude: plantLocationsTable.latitude,
      longitude: plantLocationsTable.longitude,
    })
    .from(platformSitesTable)
    .innerJoin(platformOrganizationsTable, eq(platformSitesTable.organizationId, platformOrganizationsTable.id))
    .leftJoin(plantLocationsTable, eq(platformSitesTable.siteName, plantLocationsTable.siteName))
    .orderBy(asc(platformSitesTable.siteName));
  res.json(ListPlatformSitesResponse.parse(rows.map((site) => ({
    ...site,
    latitude: site.latitude ?? null,
    longitude: site.longitude ?? null,
  }))));
});

router.post("/platform-admin/sites", async (req: Request, res): Promise<void> => {
  const data = CreatePlatformSiteBody.parse(req.body);
  const [organization] = await db.select().from(platformOrganizationsTable)
    .where(and(eq(platformOrganizationsTable.id, data.organizationId), eq(platformOrganizationsTable.status, "active"))).limit(1);
  if (!organization) {
    res.status(400).json({ error: "Choose an active organization." });
    return;
  }
  const [site] = await db.insert(platformSitesTable).values({
    siteName: data.siteName.trim(),
    organizationId: data.organizationId,
    timezone: data.timezone.trim(),
  }).returning();
  if (typeof data.latitude === "number" && typeof data.longitude === "number") {
    await db.insert(plantLocationsTable).values({
      siteName: site.siteName,
      latitude: data.latitude,
      longitude: data.longitude,
    }).onConflictDoUpdate({
      target: plantLocationsTable.siteName,
      set: { latitude: data.latitude, longitude: data.longitude, updatedAt: new Date() },
    });
  }
  await audit(req.platformAdmin!, "site.created", "site", site.siteName, { organizationId: site.organizationId, timezone: site.timezone });
  res.status(201).json(CreatePlatformSiteResponse.parse({
    siteName: site.siteName,
    organizationId: site.organizationId,
    organizationName: organization.name,
    latitude: data.latitude,
    longitude: data.longitude,
    timezone: site.timezone,
    status: site.status,
  }));
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

export default router;