import { useGetPlatformAdminOverview } from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Activity, Building2, Key, MapPin, Users } from "lucide-react"

export default function Overview() {
  const { data: overview, isLoading, error } = useGetPlatformAdminOverview()

  if (isLoading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 bg-muted rounded"></div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map(i => (
            <Card key={i}>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <div className="h-4 w-24 bg-muted rounded"></div>
                <div className="h-4 w-4 bg-muted rounded"></div>
              </CardHeader>
              <CardContent>
                <div className="h-8 w-16 bg-muted rounded mb-1"></div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    )
  }

  if (error || !overview) {
    return (
      <div className="rounded-lg border border-destructive bg-destructive/10 p-6 text-destructive">
        Failed to load platform overview.
      </div>
    )
  }

  const metrics = [
    {
      title: "Organizations",
      value: overview.organizationCount,
      icon: Building2,
    },
    {
      title: "Active Sites",
      value: overview.siteCount,
      icon: MapPin,
    },
    {
      title: "Platform Users",
      value: overview.userCount,
      icon: Users,
    },
    {
      title: "Access Grants",
      value: overview.activeAccessGrantCount,
      icon: Key,
    },
  ]

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Platform Overview</h1>
        <p className="text-muted-foreground mt-2">
          Control center for SCADA platform operators.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        {metrics.map((metric) => (
          <Card key={metric.title}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {metric.title}
              </CardTitle>
              <metric.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{metric.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Activity className="h-5 w-5" /> Broker Health
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex justify-between items-center border-b pb-2">
                <span className="text-sm text-muted-foreground">Broker URL</span>
                <span className="text-sm font-medium font-mono">{overview.broker.brokerUrl}</span>
              </div>
              <div className="flex justify-between items-center border-b pb-2">
                <span className="text-sm text-muted-foreground">Topic Base</span>
                <span className="text-sm font-medium font-mono">{overview.broker.topic}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground">Credentials</span>
                <span className="text-sm font-medium">
                  {overview.broker.credentialsConfigured ? (
                    <span className="text-emerald-600 dark:text-emerald-400">Configured</span>
                  ) : (
                    <span className="text-destructive">Missing</span>
                  )}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Recent Audit Events</CardTitle>
          </CardHeader>
          <CardContent>
            {overview.recentAudit.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recent events.</p>
            ) : (
              <div className="space-y-4">
                {overview.recentAudit.map((event) => (
                  <div key={event.id} className="flex flex-col gap-1 border-b last:border-0 pb-3 last:pb-0">
                    <div className="flex justify-between items-start">
                      <span className="text-sm font-medium">{event.action}</span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(event.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      by {event.actorEmail} on {event.targetType} ({event.targetId})
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
