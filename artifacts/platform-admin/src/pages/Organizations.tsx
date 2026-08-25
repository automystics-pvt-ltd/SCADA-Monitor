import { useState } from "react"
import { 
  useListPlatformOrganizations, 
  useCreatePlatformOrganization,
  getListPlatformOrganizationsQueryKey
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import * as z from "zod"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
import { useToast } from "@/hooks/use-toast"
import { Building2, Plus } from "lucide-react"

const orgSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(160),
  slug: z.string().min(2, "Slug must be at least 2 characters").max(80).regex(/^[a-z0-9-]+$/, "Lowercase letters, numbers, and hyphens only"),
})

export default function Organizations() {
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const { data: orgs, isLoading } = useListPlatformOrganizations()
  const createOrg = useCreatePlatformOrganization()
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const form = useForm<z.infer<typeof orgSchema>>({
    resolver: zodResolver(orgSchema),
    defaultValues: {
      name: "",
      slug: "",
    },
  })

  const onSubmit = (values: z.infer<typeof orgSchema>) => {
    createOrg.mutate(
      { data: values },
      {
        onSuccess: () => {
          toast({ title: "Organization created" })
          queryClient.invalidateQueries({ queryKey: getListPlatformOrganizationsQueryKey() })
          setIsCreateOpen(false)
          form.reset()
        },
        onError: (error) => {
          toast({
            title: "Failed to create organization",
            description: error instanceof Error ? error.message : "Check the organization details and try again.",
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
          <h1 className="text-3xl font-bold tracking-tight">Organizations</h1>
          <p className="text-muted-foreground mt-1">
            Manage tenant organizations and their limits.
          </p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              New Organization
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Organization</DialogTitle>
              <DialogDescription>
                Add a new tenant organization to the platform.
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Organization Name</FormLabel>
                      <FormControl>
                        <Input placeholder="Acme Energy Corp" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="slug"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Slug</FormLabel>
                      <FormControl>
                        <Input placeholder="acme-energy" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => setIsCreateOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createOrg.isPending}>
                    {createOrg.isPending ? "Creating..." : "Create Organization"}
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
                <TableHead>Organization</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Sites</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center">
                    Loading organizations...
                  </TableCell>
                </TableRow>
              ) : !orgs?.length ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center text-muted-foreground flex flex-col items-center justify-center">
                    <Building2 className="h-8 w-8 mb-2 opacity-20" />
                    No organizations found
                  </TableCell>
                </TableRow>
              ) : (
                orgs.map((org) => (
                  <TableRow key={org.id}>
                    <TableCell className="font-medium">{org.name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{org.slug}</TableCell>
                    <TableCell>{org.siteCount}</TableCell>
                    <TableCell>
                      <Badge variant={org.status === 'active' ? 'success' : 'secondary'}>
                        {org.status}
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
