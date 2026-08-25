import { useState } from "react"
import { 
  useListPlatformSites, 
  useCreatePlatformSite,
  useListPlatformOrganizations,
  getListPlatformSitesQueryKey,
  getListPlatformOrganizationsQueryKey,
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
import { MapPin, Plus } from "lucide-react"

const siteSchema = z.object({
  siteName: z.string().min(2, "Name must be at least 2 characters").max(160),
  organizationId: z.string().min(1, "Organization is required"),
  timezone: z.string().min(1, "Timezone is required").max(80),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
})

export default function Sites() {
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const { data: sites, isLoading: isLoadingSites } = useListPlatformSites()
  const { data: orgs } = useListPlatformOrganizations()
  const createSite = useCreatePlatformSite()
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const form = useForm<z.infer<typeof siteSchema>>({
    resolver: zodResolver(siteSchema),
    defaultValues: {
      siteName: "",
      organizationId: "",
      timezone: "UTC",
      latitude: 0,
      longitude: 0,
    },
  })

  const onSubmit = (values: z.infer<typeof siteSchema>) => {
    createSite.mutate(
      { data: values },
      {
        onSuccess: () => {
          toast({ title: "Site created" })
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: getListPlatformSitesQueryKey() }),
            queryClient.invalidateQueries({ queryKey: getListPlatformOrganizationsQueryKey() }),
          ])
          setIsCreateOpen(false)
          form.reset()
        },
        onError: (error) => {
          toast({
            title: "Failed to create site",
            description: error instanceof Error ? error.message : "Check the site details and try again.",
            variant: "destructive",
          })
        },
      }
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
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              New Site
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Site</DialogTitle>
              <DialogDescription>
                Provision a new physical site under an organization.
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
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
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
                        <Input placeholder="Desert Solar Array 1" {...field} />
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
                          <Input type="number" step="any" {...field} />
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
                          <Input type="number" step="any" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setIsCreateOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createSite.isPending}>
                    {createSite.isPending ? "Creating..." : "Create Site"}
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
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoadingSites ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center">
                    Loading sites...
                  </TableCell>
                </TableRow>
              ) : !sites?.length ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground flex flex-col items-center justify-center">
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
                      {site.latitude?.toFixed(4)}, {site.longitude?.toFixed(4)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{site.timezone}</TableCell>
                    <TableCell>
                      <Badge variant={site.status === 'active' ? 'success' : 'secondary'}>
                        {site.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
