import { useState } from "react"
import {
  useListPlatformTelemetrySnapshotGapSummaries,
  useGetPlatformTelemetrySnapshotGapDetail,
  getGetPlatformTelemetrySnapshotGapDetailQueryKey,
  type PlatformTelemetrySnapshotGapSummary,
} from "@workspace/api-client-react"
import { format } from "date-fns"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { AlertTriangle, CheckCircle2, ChevronRight, Radio, ShieldAlert } from "lucide-react"
import { cn } from "@/lib/utils"

// Above this many reconnect+resubscribe cycles in the window, the broker
// connection itself is flagged as the likely root cause of any gaps, not
// just an incidental detail buried in individual gap reasons.
const RECONNECT_HEALTH_WARNING_THRESHOLD = 5

function saveStatusBadge(status: string) {
  if (status === "absent") return <Badge variant="destructive">Absent</Badge>
  if (status === "missing") return <Badge variant="destructive">Missing</Badge>
  if (status === "incomplete") return <Badge variant="secondary">Incomplete</Badge>
  return <Badge variant="secondary">{status}</Badge>
}

function reconnectBadge(reconnectCount: number) {
  const flagged = reconnectCount >= RECONNECT_HEALTH_WARNING_THRESHOLD
  return (
    <Badge variant={flagged ? "destructive" : "secondary"} className={cn("gap-1", !flagged && "opacity-60")}>
      <Radio className="h-3 w-3" />
      {reconnectCount} reconnect{reconnectCount === 1 ? "" : "s"}
    </Badge>
  )
}

function GapDetailDialog({ site, onClose }: { site: PlatformTelemetrySnapshotGapSummary | null; onClose: () => void }) {
  const { data: detail, isLoading, error } = useGetPlatformTelemetrySnapshotGapDetail(
    { siteName: site?.siteName ?? "" },
    {
      query: {
        enabled: Boolean(site),
        queryKey: getGetPlatformTelemetrySnapshotGapDetailQueryKey({ siteName: site?.siteName ?? "" }),
      },
    },
  )

  return (
    <Dialog open={Boolean(site)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{site?.siteName} — scheduled save gaps</DialogTitle>
          <DialogDescription>
            {detail
              ? `${detail.gapCount} of ${detail.expectedWindows} scheduled windows missing or incomplete between ${format(new Date(detail.range.from), "MMM d, HH:mm")} and ${format(new Date(detail.range.to), "MMM d, HH:mm")}.`
              : "Scheduled 15-minute save windows that were not recorded as a complete save."}
          </DialogDescription>
        </DialogHeader>
        {detail && detail.reconnectCount >= RECONNECT_HEALTH_WARNING_THRESHOLD ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              The MQTT broker reconnected {detail.reconnectCount} times in this range. An unstable broker connection
              is the likely root cause of the gaps below, not an unexplained outage.
            </span>
          </div>
        ) : null}
        {isLoading ? (
          <p className="text-sm text-muted-foreground py-6 text-center">Loading gap detail...</p>
        ) : error ? (
          <p className="text-sm text-destructive py-6 text-center">Unable to load gap detail for this site.</p>
        ) : !detail?.gaps.length ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-emerald-500" />
            <p className="text-sm">No scheduled save gaps in this range.</p>
          </div>
        ) : (
          <div className="max-h-[50vh] overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Scheduled For</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.gaps.map((gap) => (
                  <TableRow key={gap.scheduledFor}>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {format(new Date(gap.scheduledFor), "MMM d, yyyy HH:mm")}
                    </TableCell>
                    <TableCell>{saveStatusBadge(gap.saveStatus)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{gap.missingReason ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export default function SaveGaps() {
  const [selectedSite, setSelectedSite] = useState<PlatformTelemetrySnapshotGapSummary | null>(null)
  const { data, isLoading, error } = useListPlatformTelemetrySnapshotGapSummaries()

  const sitesWithGaps = data?.sites.filter((site) => site.gapCount > 0).length ?? 0
  const maxReconnectCount = data?.sites.reduce((max, site) => Math.max(max, site.reconnectCount), 0) ?? 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Save Gaps</h1>
        <p className="text-muted-foreground mt-1">
          Scheduled telemetry save windows that were not recorded, across every active managed site.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <ShieldAlert className="h-5 w-5" /> Last {data?.windowHours ?? 24}h
          </CardTitle>
          <CardDescription>
            {isLoading
              ? "Checking scheduled saves across active sites..."
              : sitesWithGaps > 0
                ? `${sitesWithGaps} of ${data?.sites.length ?? 0} active site${data?.sites.length === 1 ? "" : "s"} missed a scheduled save.`
                : `All ${data?.sites.length ?? 0} active site${data?.sites.length === 1 ? "" : "s"} saved every scheduled window.`}
          </CardDescription>
        </CardHeader>
        {maxReconnectCount >= RECONNECT_HEALTH_WARNING_THRESHOLD ? (
          <div className="mx-6 mb-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <Radio className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              The MQTT broker reconnected {maxReconnectCount} times in the last {data?.windowHours ?? 24}h. Frequent
              reconnects are a broker connection health problem and the likely root cause of scheduled-save gaps below.
            </span>
          </div>
        ) : null}
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Site</TableHead>
                <TableHead>Organization</TableHead>
                <TableHead>Expected Windows</TableHead>
                <TableHead>Gaps</TableHead>
                <TableHead>Broker Health</TableHead>
                <TableHead className="text-right">Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center">
                    Loading save-gap summary...
                  </TableCell>
                </TableRow>
              ) : error ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-destructive">
                    Unable to load save-gap summary.
                  </TableCell>
                </TableRow>
              ) : !data?.sites.length ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground flex flex-col items-center justify-center">
                    <CheckCircle2 className="h-8 w-8 mb-2 opacity-20" />
                    No active managed sites yet
                  </TableCell>
                </TableRow>
              ) : (
                data.sites.map((site) => (
                  <TableRow
                    key={site.siteName}
                    className={cn(
                      "cursor-pointer hover:bg-muted/50",
                      site.gapCount === 0 && "text-muted-foreground",
                    )}
                    onClick={() => setSelectedSite(site)}
                  >
                    <TableCell className={cn("font-medium", site.gapCount === 0 && "font-normal")}>
                      {site.siteName}
                    </TableCell>
                    <TableCell>{site.organizationName}</TableCell>
                    <TableCell>{site.expectedWindows}</TableCell>
                    <TableCell>
                      {site.gapCount > 0 ? (
                        <Badge variant="destructive" className="gap-1">
                          <AlertTriangle className="h-3 w-3" />
                          {site.gapCount} gap{site.gapCount === 1 ? "" : "s"}
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="gap-1 opacity-60">
                          <CheckCircle2 className="h-3 w-3" />
                          No gaps
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{reconnectBadge(site.reconnectCount)}</TableCell>
                    <TableCell className="text-right">
                      <ChevronRight className="h-4 w-4 inline-block text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <GapDetailDialog site={selectedSite} onClose={() => setSelectedSite(null)} />
    </div>
  )
}
