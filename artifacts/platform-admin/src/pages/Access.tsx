import { useState } from "react"
import { 
  useListPlatformUsers, 
  useGrantPlatformSiteAccess,
  useListPlatformSites,
  getListPlatformUsersQueryKey
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import * as z from "zod"

import { Button } from "@/components/ui/button"
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
import { Key, ShieldPlus } from "lucide-react"

const accessSchema = z.object({
  siteName: z.string().min(1, "Site is required"),
  role: z.enum(["viewer", "operator", "site-admin"]),
})

export default function Access() {
  const [selectedUser, setSelectedUser] = useState<{id: string, email: string} | null>(null)
  const { data: users, isLoading: isLoadingUsers } = useListPlatformUsers()
  const { data: sites } = useListPlatformSites()
  const grantAccess = useGrantPlatformSiteAccess()
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const form = useForm<z.infer<typeof accessSchema>>({
    resolver: zodResolver(accessSchema),
    defaultValues: {
      siteName: "",
      role: "viewer",
    },
  })

  const onSubmit = (values: z.infer<typeof accessSchema>) => {
    if (!selectedUser) return

    grantAccess.mutate(
      { 
        data: {
          userId: selectedUser.id,
          siteName: values.siteName,
          role: values.role
        } 
      },
      {
        onSuccess: () => {
          toast({ title: "Access granted successfully" })
          queryClient.invalidateQueries({ queryKey: getListPlatformUsersQueryKey() })
          setSelectedUser(null)
          form.reset()
        },
        onError: () => {
          toast({ title: "Failed to grant access", variant: "destructive" })
        },
      }
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Access Grants</h1>
        <p className="text-muted-foreground mt-1">
          Review users and manage their site-level permissions.
        </p>
      </div>

      <Dialog open={!!selectedUser} onOpenChange={(open) => !open && setSelectedUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Grant Site Access</DialogTitle>
            <DialogDescription>
              Grant {selectedUser?.email} access to a specific site.
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="siteName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Site</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select site" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {sites?.map((site) => (
                          <SelectItem key={site.siteName} value={site.siteName}>
                            {site.siteName} ({site.organizationName})
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
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Role</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select role" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="viewer">Viewer (Read-only)</SelectItem>
                        <SelectItem value="operator">Operator (Read & Write)</SelectItem>
                        <SelectItem value="site-admin">Site Admin</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setSelectedUser(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={grantAccess.isPending}>
                  {grantAccess.isPending ? "Granting..." : "Grant Access"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Site Access</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoadingUsers ? (
                <TableRow>
                  <TableCell colSpan={3} className="h-24 text-center">
                    Loading users...
                  </TableCell>
                </TableRow>
              ) : !users?.length ? (
                <TableRow>
                  <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                    <Key className="h-8 w-8 mb-2 opacity-20 mx-auto" />
                    No users found
                  </TableCell>
                </TableRow>
              ) : (
                users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <div className="font-medium">{user.name}</div>
                      <div className="text-sm text-muted-foreground">{user.email}</div>
                    </TableCell>
                    <TableCell>
                      {user.access.length > 0 ? (
                        <div className="flex gap-2 flex-wrap max-w-md">
                          {user.access.map(acc => (
                            <Badge key={`${acc.siteName}-${acc.role}`} variant="secondary" className="text-xs">
                              {acc.siteName} <span className="opacity-50 ml-1">({acc.role})</span>
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground italic">No access</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" onClick={() => setSelectedUser({id: user.id, email: user.email || user.name})}>
                        <ShieldPlus className="h-4 w-4 mr-2" />
                        Grant
                      </Button>
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
