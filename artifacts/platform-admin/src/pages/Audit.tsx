import { useListPlatformAuditEvents } from "@workspace/api-client-react"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ShieldAlert } from "lucide-react"

export default function Audit() {
  const { data: events, isLoading } = useListPlatformAuditEvents()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Audit Log</h1>
        <p className="text-muted-foreground mt-1">
          Review historical actions performed by administrators and operators.
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Timestamp</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center">
                    Loading audit events...
                  </TableCell>
                </TableRow>
              ) : !events?.length ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                    <ShieldAlert className="h-8 w-8 mb-2 opacity-20 mx-auto" />
                    No audit events found
                  </TableCell>
                </TableRow>
              ) : (
                events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {new Date(event.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="font-medium">{event.actorEmail}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center rounded-md bg-secondary px-2 py-1 text-xs font-medium text-secondary-foreground">
                        {event.action}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">
                      <span className="text-muted-foreground">{event.targetType}</span>
                      <span className="mx-1 opacity-50">/</span>
                      <span className="font-mono text-xs">{event.targetId}</span>
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
