import { useState } from "react"
import { 
  useListPlatformSites, 
  useCreatePlatformSite,
  useUpdatePlatformSite,
  useUpdatePlatformSiteActivation,
  useListPlatformOrganizations,
  getListPlatformSitesQueryKey,
  getListPlatformOrganizationsQueryKey,
  type PlatformSite,
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import * as z from "zod"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"
import { MapPin, MapPinOff, Pause, Pencil, Play, Plus } from "lucide-react"

const coordinate = z.preprocess(
  (value) => value === "" || value === undefined ? null : value,
  z.coerce.number().min(-180).max(180).nullable(),
)
const siteSchema = z.object({
  siteName: z.string().min(2, "Name must be at least 2 characters").max(160),
  organizationId: z.string().min(1, "Organization is required"),
  timezone: z.string().min(1, "Timezone is required").max(80),
  latitude: z.preprocess(
    (value) => value === "" || value === undefined ? null : value,
    z.coerce.number().min(-90).max(90).nullable(),
  ),
  longitude: coordinate,
})

export default function Sites() {
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [editingSite, setEditingSite] = useState<PlatformSite | null>(null)
  const [pendingActivationSite, setPendingActivationSite] = useState<PlatformSite | null>(null)
  const { data: sites, isLoading: isLoadingSites } = useListPlatformSites()
  const { data: orgs } = useListPlatformOrganizations()
  const createSite = useCreatePlatformSite()
  const updateSite = useUpdatePlatformSite()
  const updateActivation = useUpdatePlatformSiteActivation()
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const form = useForm<z.infer<typeof siteSchema>>({
    resolver: zodResolver(siteSchema),
    defaultValues: {
      siteName: "",
      organizationId: "",
      timezone: "UTC",
      latitude: null,
      longitude: null,
    },
  })

  const closeSiteDialog = () => {
    setIsCreateOpen(false)
    setEditingSite(null)
    form.reset()
  }

  const openCreateDialog = () => {
    setEditingSite(null)
    form.reset({
      siteName: "",
      organizationId: "",
      timezone: "UTC",
      latitude: null,
      longitude: null,
    })
    setIsCreateOpen(true)
  }

  const openEditDialog = (site: PlatformSite) => {
    setIsCreateOpen(false)
    setEditingSite(site)
    form.reset({
      siteName: site.siteName,
      organizationId: site.organizationId,
      timezone: site.timezone,
      latitude: site.latitude,
      longitude: site.longitude,
    })
  }

  const onSubmit = (values: z.infer<typeof siteSchema>) => {
    if (values.latitude === null !== (values.longitude === null)) {
      toast({ title: "Location is incomplete", description: "Enter both coordinates or clear both location fields.", variant: "destructive" })
      return
    }
    const options = {
      onSuccess: () => {
        toast({
          title: editingSite ? "Site updated" : "Site created and access assigned",
          description: editingSite ? "The site metadata and location master are up to date." : "Verify live telemetry and activate the site before SCADA data becomes available.",
        })
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: getListPlatformSitesQueryKey() }),
          queryClient.invalidateQueries({ queryKey: getListPlatformOrganizationsQueryKey() }),
        ])
        closeSiteDialog()
      },
      onError: (error: unknown) => {
        toast({
          title: editingSite ? "Failed to update site" : "Failed to create site",
          description: error instanceof Error ? error.message : "Check the site details and try again.",
          variant: "destructive",
        })
      },
    }
    if (editingSite) {
      updateSite.mutate({ data: values }, options)
    } else {
      createSite.mutate({ data: values }, options)
    }
  }

  const confirmActivationChange = () => {
    if (!pendingActivationSite) return
    const site = pendingActivationSite
    const nextStatus = site.activationStatus === "active" ? "inactive" : "active"
    updateActivation.mutate(
      { data: { siteName: site.siteName, activationStatus: nextStatus } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: getListPlatformSitesQueryKey() })
          toast({
            title: nextStatus === "active" ? "Site resumed" : "Site paused",
            description: nextStatus === "active" ? "Authorized SCADA operators can access this site again." : "The site is no longer available as an active SCADA site.",
          })
          setPendingActivationSite(null)
        },
        onError: (error) => {
          toast({
            title: "Site status update failed",
            description: error instanceof Error ? error.message : "The site could not be updated.",
            variant: "destructive",
          })
        },
      },
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Sites</h1>
          <p className="text-muted-foreground mt-1">
            Manage SCADA sites and their locations.
          </p>
        </div>
        <Dialog open={isCreateOpen || Boolean(editingSite)} onOpenChange={(open) => !open && closeSiteDialog()}>
          <DialogTrigger asChild>
            <Button onClick={openCreateDialog}>
              <Plus className="mr-2 h-4 w-4" />
              New Site
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingSite ? "Edit Site" : "Create Site"}</DialogTitle>
              <DialogDescription>
                {editingSite ? "Update the managed site and its central SCADA location record. The site key cannot be changed after creation." : "Provision a new physical site under an organization."}
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="organizationId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Organization</FormLabel>
                       <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select organization" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {orgs?.map((org) => (
                            <SelectItem key={org.id} value={org.id}>
                              {org.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="siteName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Site Name</FormLabel>
                       <FormControl>
                         <Input placeholder="Desert Solar Array 1" disabled={Boolean(editingSite)} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="timezone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Timezone</FormLabel>
                      <FormControl>
                        <Input placeholder="America/Los_Angeles" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="latitude"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Latitude</FormLabel>
                       <FormControl>
                         <Input type="number" step="any" value={field.value ?? ""} onChange={field.onChange} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="longitude"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Longitude</FormLabel>
                       <FormControl>
                         <Input type="number" step="any" value={field.value ?? ""} onChange={field.onChange} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={closeSiteDialog}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createSite.isPending || updateSite.isPending}>
                    {createSite.isPending || updateSite.isPending ? "Saving..." : editingSite ? "Save Changes" : "Create Site"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Site Name</TableHead>
                <TableHead>Organization</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Timezone</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoadingSites ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center">
                    Loading sites...
                  </TableCell>
                </TableRow>
              ) : !sites?.length ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground flex flex-col items-center justify-center">
                    <MapPin className="h-8 w-8 mb-2 opacity-20" />
                    No sites found
                  </TableCell>
                </TableRow>
              ) : (
                sites.map((site) => (
                  <TableRow key={site.siteName}>
                    <TableCell className="font-medium">{site.siteName}</TableCell>
                    <TableCell>{site.organizationName}</TableCell>
                    <TableCell className="text-muted-foreground text-xs font-mono">
                       {site.latitude !== null && site.longitude !== null
                         ? `${site.latitude.toFixed(4)}, ${site.longitude.toFixed(4)}`
                         : <span className="inline-flex items-center gap-1 font-sans"><MapPinOff className="h-3.5 w-3.5" /> Not set</span>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{site.timezone}</TableCell>
                    <TableCell>
                       <Badge variant={site.activationStatus === 'active' ? 'success' : 'secondary'}>
                         {site.activationStatus === 'active' ? 'SCADA active' : site.lastTelemetryTestResult ? 'Paused' : 'Awaiting verification'}
                      </Badge>
                    </TableCell>
                     <TableCell className="text-right">
                       <div className="flex justify-end gap-2">
                         <Button variant="outline" size="sm" onClick={() => openEditDialog(site)}>
                           <Pencil className="mr-1.5 h-3.5 w-3.5" />
                           Edit
                         </Button>
                         <Button variant="outline" size="sm" onClick={() => setPendingActivationSite(site)}>
                           {site.activationStatus === "active" ? <Pause className="mr-1.5 h-3.5 w-3.5" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
                           {site.activationStatus === "active" ? "Pause" : site.lastTelemetryTestResult ? "Resume" : "Activate"}
                         </Button>
                       </div>
                     </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <AlertDialog open={Boolean(pendingActivationSite)} onOpenChange={(open) => !open && setPendingActivationSite(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingActivationSite?.activationStatus === "active" ? "Pause this SCADA site?" : pendingActivationSite?.lastTelemetryTestResult ? "Resume this SCADA site?" : "Activate this SCADA site?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingActivationSite?.activationStatus === "active"
                ? `${pendingActivationSite.siteName} will stop being available as an active site to authorized SCADA operators.`
                : `${pendingActivationSite?.siteName} will become available again only if it has a successful live telemetry verification.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={updateActivation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(event) => { event.preventDefault(); confirmActivationChange() }} disabled={updateActivation.isPending}>
              {updateActivation.isPending ? "Saving..." : pendingActivationSite?.activationStatus === "active" ? "Pause site" : pendingActivationSite?.lastTelemetryTestResult ? "Resume site" : "Activate site"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
