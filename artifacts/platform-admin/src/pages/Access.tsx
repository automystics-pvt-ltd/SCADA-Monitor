import { useEffect, useMemo, useState } from "react"
import {
  getGetPlatformRolePermissionsQueryKey,
  getListPlatformUsersQueryKey,
  useCreatePlatformUser,
  useGetPlatformRolePermissions,
  useListPlatformOrganizations,
  useListPlatformSites,
  useListPlatformUsers,
  useUpdatePlatformRolePermissions,
  useUpdatePlatformUser,
  useUpdatePlatformUserStatus,
  type PlatformRole,
  type PlatformUser,
  type PlatformUserInput,
  type PlatformUserStatusInputAccountStatus,
  type ScadaPermission,
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"
import { CheckCircle2, KeyRound, Pencil, Plus, RotateCcw, ShieldAlert, ShieldCheck, Trash2, UserCog, UserMinus } from "lucide-react"

const roles: Array<{ value: PlatformRole; label: string; description: string }> = [
  { value: "viewer", label: "Viewer", description: "Read-only SCADA access" },
  { value: "site-engineer", label: "Site Engineer", description: "Monitoring, analytics, reporting, and device work" },
  { value: "operator", label: "Operator", description: "Legacy-compatible engineering operator" },
  { value: "site-admin", label: "Site Admin", description: "Full control of assigned site configuration" },
]

const permissionLabels: Record<ScadaPermission, string> = {
  dashboard: "Dashboard",
  "live-monitoring": "Live monitoring",
  "inverter-details": "Inverter details",
  "electrical-parameters": "Electrical parameters",
  "energy-analytics": "Energy analytics",
  "mppt-strings": "MPPT & strings",
  "alarms-faults": "Alarms & faults",
  "historical-data": "Historical data",
  "scada-reports": "SCADA reports",
  "data-export": "Data export",
  "site-configuration": "Site configuration",
  "device-configuration": "Device configuration",
  "user-management": "User management",
}

const allPermissions = Object.keys(permissionLabels) as ScadaPermission[]

type UserDraft = PlatformUserInput

const blankDraft = (): UserDraft => ({
  email: "",
  firstName: "",
  lastName: "",
  organizationIds: [],
  siteAccess: [],
})

function roleLabel(role: PlatformRole) {
  return roles.find((item) => item.value === role)?.label ?? role
}

function statusTone(status: PlatformUser["accountStatus"]) {
  if (status === "active") return "success"
  if (status === "inactive") return "secondary"
  return "destructive"
}

export default function Access() {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  const { data: users, isLoading: usersLoading } = useListPlatformUsers()
  const { data: sites } = useListPlatformSites()
  const { data: organizations } = useListPlatformOrganizations()
  const { data: rolePolicy } = useGetPlatformRolePermissions()
  const createUser = useCreatePlatformUser()
  const updateUser = useUpdatePlatformUser()
  const updateStatus = useUpdatePlatformUserStatus()
  const updateRolePermissions = useUpdatePlatformRolePermissions()
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingUser, setEditingUser] = useState<PlatformUser | null>(null)
  const [draft, setDraft] = useState<UserDraft>(blankDraft)
  const [permissionRole, setPermissionRole] = useState<PlatformRole>("viewer")
  const [permissionDraft, setPermissionDraft] = useState<ScadaPermission[]>([])

  const activeSites = useMemo(() => sites?.filter((site) => site.status === "active") ?? [], [sites])

  useEffect(() => {
    if (!rolePolicy) return
    const source = permissionRole === "viewer"
      ? rolePolicy.viewerPermissions
      : permissionRole === "operator"
        ? rolePolicy.operatorPermissions
        : permissionRole === "site-engineer"
          ? rolePolicy.siteEngineerPermissions
          : rolePolicy.siteAdminPermissions
    setPermissionDraft(source)
  }, [permissionRole, rolePolicy])

  const refreshUsers = () => queryClient.invalidateQueries({ queryKey: getListPlatformUsersQueryKey() })

  const openCreate = () => {
    setEditingUser(null)
    setDraft(blankDraft())
    setEditorOpen(true)
  }

  const openEdit = (user: PlatformUser) => {
    setEditingUser(user)
    setDraft({
      email: user.email ?? "",
      firstName: user.firstName ?? "",
      lastName: user.lastName ?? "",
      organizationIds: user.organizations.filter((organization) => organization.status === "active").map((organization) => organization.organizationId),
      siteAccess: user.access
        .filter((grant) => grant.status === "active")
        .map((grant) => ({ siteName: grant.siteName, role: grant.role })),
    })
    setEditorOpen(true)
  }

  const setSiteAssignment = (siteName: string, enabled: boolean) => {
    setDraft((current) => {
      const currentAccess = current.siteAccess ?? []
      if (enabled && !currentAccess.some((grant) => grant.siteName === siteName)) {
        return { ...current, siteAccess: [...currentAccess, { siteName, role: "viewer" }] }
      }
      return { ...current, siteAccess: currentAccess.filter((grant) => grant.siteName !== siteName) }
    })
  }

  const setSiteRole = (siteName: string, role: PlatformRole) => {
    setDraft((current) => ({
      ...current,
      siteAccess: (current.siteAccess ?? []).map((grant) => grant.siteName === siteName ? { ...grant, role } : grant),
    }))
  }

  const setOrganization = (organizationId: string, enabled: boolean) => {
    setDraft((current) => ({
      ...current,
      organizationIds: enabled
        ? [...new Set([...(current.organizationIds ?? []), organizationId])]
        : (current.organizationIds ?? []).filter((id) => id !== organizationId),
    }))
  }

  const saveUser = () => {
    if (!draft.email.trim()) {
      toast({ title: "Email is required", description: "Enter the user's sign-in email before saving.", variant: "destructive" })
      return
    }
    const data = {
      ...draft,
      email: draft.email.trim().toLowerCase(),
      firstName: draft.firstName?.trim() || undefined,
      lastName: draft.lastName?.trim() || undefined,
      organizationIds: draft.organizationIds ?? [],
      siteAccess: draft.siteAccess ?? [],
    }
    const options = {
      onSuccess: () => {
        toast({ title: editingUser ? "User access updated" : "User provisioned", description: "The user’s account, organization, site, and role assignments are current." })
        void refreshUsers()
        setEditorOpen(false)
      },
      onError: (error: Error) => toast({ title: "Unable to save user", description: error.message, variant: "destructive" }),
    }
    if (editingUser) {
      updateUser.mutate({ data: { ...data, userId: editingUser.id } }, options)
    } else {
      createUser.mutate({ data }, options)
    }
  }

  const changeStatus = (user: PlatformUser, accountStatus: PlatformUserStatusInputAccountStatus) => {
    updateStatus.mutate({ data: { userId: user.id, accountStatus } }, {
      onSuccess: () => {
        toast({
          title: accountStatus === "active" ? "Account activated" : accountStatus === "inactive" ? "Account deactivated" : "Account deleted",
          description: accountStatus === "deleted" ? "All organization and site access was revoked." : "The status is enforced on the next SCADA request.",
        })
        void refreshUsers()
      },
      onError: (error: Error) => toast({ title: "Unable to update account", description: error.message, variant: "destructive" }),
    })
  }

  const saveRolePolicy = () => {
    if (!rolePolicy) return
    const data = {
      ...rolePolicy,
      viewerPermissions: permissionRole === "viewer" ? permissionDraft : rolePolicy.viewerPermissions,
      operatorPermissions: permissionRole === "operator" ? permissionDraft : rolePolicy.operatorPermissions,
      siteEngineerPermissions: permissionRole === "site-engineer" ? permissionDraft : rolePolicy.siteEngineerPermissions,
      siteAdminPermissions: permissionRole === "site-admin" ? permissionDraft : rolePolicy.siteAdminPermissions,
    }
    updateRolePermissions.mutate({ data }, {
      onSuccess: () => {
        toast({ title: `${roleLabel(permissionRole)} permissions saved`, description: "Changes are enforced by the SCADA API for future requests." })
        void queryClient.invalidateQueries({ queryKey: getGetPlatformRolePermissionsQueryKey() })
      },
      onError: (error: Error) => toast({ title: "Unable to save role permissions", description: error.message, variant: "destructive" }),
    })
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-primary">Identity & access control</p>
          <h1 className="text-3xl font-bold tracking-tight">SCADA user access</h1>
          <p className="mt-1 max-w-2xl text-muted-foreground">Provision accounts, scope each user to tenant organizations and sites, then apply role permissions at the API boundary.</p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" />
          Provision user
        </Button>
      </header>

      <Dialog open={editorOpen} onOpenChange={(open) => !open && setEditorOpen(false)}>
        <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingUser ? "Manage SCADA user" : "Provision SCADA user"}</DialogTitle>
            <DialogDescription>Site assignments automatically retain the required organization membership. The user can sign in only when their account is active.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="user-email">Sign-in email</Label>
              <Input id="user-email" value={draft.email} disabled={Boolean(editingUser)} onChange={(event) => setDraft({ ...draft, email: event.target.value })} placeholder="engineer@company.com" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="user-first-name">First name</Label>
                <Input id="user-first-name" value={draft.firstName ?? ""} onChange={(event) => setDraft({ ...draft, firstName: event.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="user-last-name">Last name</Label>
                <Input id="user-last-name" value={draft.lastName ?? ""} onChange={(event) => setDraft({ ...draft, lastName: event.target.value })} />
              </div>
            </div>
          </div>
          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold">Organization membership</h3>
              <p className="text-xs text-muted-foreground">Assign one or more tenant organizations. Sites below provide the precise data scope.</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {organizations?.map((organization) => {
                const selected = (draft.organizationIds ?? []).includes(organization.id)
                return <label key={organization.id} className="flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm hover:bg-muted/50">
                  <Checkbox checked={selected} onCheckedChange={(checked) => setOrganization(organization.id, checked === true)} />
                  <span className="min-w-0">
                    <span className="block font-medium">{organization.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{organization.slug}</span>
                  </span>
                </label>
              })}
            </div>
          </section>
          <section className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold">Explicit site access</h3>
              <p className="text-xs text-muted-foreground">A user can only retrieve telemetry and reports for selected sites. Choose a role for every assigned site.</p>
            </div>
            <div className="space-y-2">
              {activeSites.map((site) => {
                const assignment = (draft.siteAccess ?? []).find((grant) => grant.siteName === site.siteName)
                return <div key={site.siteName} className="grid items-center gap-3 rounded-md border p-3 sm:grid-cols-[1fr_190px]">
                  <label className="flex cursor-pointer items-center gap-3">
                    <Checkbox checked={Boolean(assignment)} onCheckedChange={(checked) => setSiteAssignment(site.siteName, checked === true)} />
                    <span>
                      <span className="block text-sm font-medium">{site.siteName}</span>
                      <span className="block text-xs text-muted-foreground">{site.organizationName} · {site.activationStatus}</span>
                    </span>
                  </label>
                  <Select value={assignment?.role ?? "viewer"} disabled={!assignment} onValueChange={(role: PlatformRole) => setSiteRole(site.siteName, role)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{roles.map((role) => <SelectItem key={role.value} value={role.value}>{role.label}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              })}
              {!activeSites.length && <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">Create and activate a managed site before assigning SCADA access.</p>}
            </div>
          </section>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditorOpen(false)}>Cancel</Button>
            <Button onClick={saveUser} disabled={createUser.isPending || updateUser.isPending}>{createUser.isPending || updateUser.isPending ? "Saving…" : editingUser ? "Save access" : "Provision user"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="text-lg">Accounts and assignments</CardTitle>
          <CardDescription>Inactive and deleted accounts are denied by the backend even if an older browser session is still open.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Organizations</TableHead>
                  <TableHead>Site roles</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usersLoading ? <TableRow><TableCell colSpan={5} className="h-24 text-center">Loading users…</TableCell></TableRow> : !users?.length ? (
                  <TableRow><TableCell colSpan={5} className="h-28 text-center text-muted-foreground"><KeyRound className="mx-auto mb-2 h-7 w-7 opacity-30" />No SCADA users have been provisioned.</TableCell></TableRow>
                ) : users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="min-w-[190px]">
                      <div className="font-medium">{user.name}</div>
                      <div className="text-xs text-muted-foreground">{user.email}</div>
                    </TableCell>
                    <TableCell><Badge variant={statusTone(user.accountStatus)}>{user.accountStatus}</Badge></TableCell>
                    <TableCell className="min-w-[160px]"><div className="flex flex-wrap gap-1">{user.organizations.filter((organization) => organization.status === "active").map((organization) => <Badge key={organization.organizationId} variant="outline">{organization.organizationName}</Badge>) || <span className="text-sm text-muted-foreground">—</span>}</div></TableCell>
                    <TableCell className="min-w-[230px]"><div className="flex flex-wrap gap-1">{user.access.filter((grant) => grant.status === "active").map((grant) => <Badge key={grant.siteName} variant="secondary">{grant.siteName} · {roleLabel(grant.role)}</Badge>) || <span className="text-sm text-muted-foreground">No site access</span>}</div></TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="icon" variant="ghost" title="Manage user" onClick={() => openEdit(user)}><Pencil className="h-4 w-4" /></Button>
                        {user.accountStatus !== "active" && <Button size="icon" variant="ghost" title="Activate account" disabled={updateStatus.isPending} onClick={() => changeStatus(user, "active")}><RotateCcw className="h-4 w-4 text-emerald-600" /></Button>}
                        {user.accountStatus === "active" && <Button size="icon" variant="ghost" title="Deactivate account" disabled={updateStatus.isPending} onClick={() => changeStatus(user, "inactive")}><UserMinus className="h-4 w-4 text-amber-600" /></Button>}
                        {user.accountStatus !== "deleted" && <Button size="icon" variant="ghost" title="Delete account and revoke access" disabled={updateStatus.isPending} onClick={() => changeStatus(user, "deleted")}><Trash2 className="h-4 w-4 text-destructive" /></Button>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-3 border-b sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg"><UserCog className="h-5 w-5 text-primary" />Role permissions</CardTitle>
            <CardDescription>These permissions are evaluated by the SCADA API; navigation visibility alone never grants access.</CardDescription>
          </div>
          <Select value={permissionRole} onValueChange={(role: PlatformRole) => setPermissionRole(role)}>
            <SelectTrigger className="w-full sm:w-[190px]"><SelectValue /></SelectTrigger>
            <SelectContent>{roles.map((role) => <SelectItem key={role.value} value={role.value}>{role.label}</SelectItem>)}</SelectContent>
          </Select>
        </CardHeader>
        <CardContent className="p-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {allPermissions.map((permission) => {
              const checked = permissionDraft.includes(permission)
              return <label key={permission} className="flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm hover:bg-muted/50">
                <Checkbox checked={checked} onCheckedChange={(next) => setPermissionDraft((current) => next === true ? [...new Set([...current, permission])] : current.filter((item) => item !== permission))} />
                <span>{permissionLabels[permission]}</span>
              </label>
            })}
          </div>
          <div className="mt-5 flex flex-col gap-3 rounded-md bg-muted/60 p-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">{roleLabel(permissionRole)}: {permissionDraft.length} of {allPermissions.length} capabilities enabled.</p>
            <Button size="sm" onClick={saveRolePolicy} disabled={!rolePolicy || updateRolePermissions.isPending}><ShieldCheck className="mr-2 h-4 w-4" />{updateRolePermissions.isPending ? "Saving…" : "Save role permissions"}</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}