import { 
  useGetPlatformMqttConfig, 
  useUpdatePlatformMqttConfig,
  useApplyPlatformMqttConfig,
  getGetPlatformMqttConfigQueryKey
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import * as z from "zod"
import { useEffect, useRef } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { useToast } from "@/hooks/use-toast"
import { Server, Save, RefreshCw } from "lucide-react"

const configSchema = z.object({
  brokerUrl: z.string().min(8, "URL is too short").max(300),
  topic: z.string().min(1, "Topic is required").max(300),
  plantSite: z.string().min(1, "Plant site is required").max(160),
  timezone: z.string().min(1, "Timezone is required").max(80),
})

export default function Platform() {
  const { data: config, isLoading } = useGetPlatformMqttConfig({ query: { queryKey: getGetPlatformMqttConfigQueryKey(), refetchInterval: 3000 } })
  const updateConfig = useUpdatePlatformMqttConfig()
  const applyConfig = useApplyPlatformMqttConfig()
  const queryClient = useQueryClient()
  const { toast } = useToast()
  
  const initialized = useRef(false)

  const form = useForm<z.infer<typeof configSchema>>({
    resolver: zodResolver(configSchema),
    defaultValues: {
      brokerUrl: "",
      topic: "",
      plantSite: "",
      timezone: "UTC",
    },
  })

  // Synchronize form when data loads, only once per fresh load
  useEffect(() => {
    if (config && !initialized.current) {
      form.reset({
        brokerUrl: config.brokerUrl,
        topic: config.topic,
        plantSite: config.plantSite,
        timezone: config.timezone,
      })
      initialized.current = true
    }
  }, [config, form])

  const onSubmit = (values: z.infer<typeof configSchema>) => {
    updateConfig.mutate(
      { data: values },
      {
        onSuccess: (data) => {
          toast({ title: "Configuration staged", description: "Apply it below when you are ready to reconnect the consumer." })
          queryClient.setQueryData(getGetPlatformMqttConfigQueryKey(), data)
          form.reset(values) // Reset form to clear isDirty state
        },
        onError: () => {
          toast({ title: "Failed to update configuration", variant: "destructive" })
        },
      }
    )
  }

  const apply = () => {
    applyConfig.mutate(undefined, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetPlatformMqttConfigQueryKey(), data)
        toast({ title: "MQTT configuration applied", description: "The broker connection and topic subscription were confirmed." })
      },
      onError: (error) => {
        queryClient.invalidateQueries({ queryKey: getGetPlatformMqttConfigQueryKey() })
        toast({ title: "Apply rolled back", description: error instanceof Error ? error.message : "The previous working connection was restored.", variant: "destructive" })
      },
    })
  }

  const applying = applyConfig.isPending || config?.applyState === "connecting" || config?.applyState === "rolling-back"
  const applyLabel = config?.applyState === "rolling-back" ? "Restoring working connection..." : applying ? "Connecting and confirming..." : "Apply staged configuration"

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Platform Configuration</h1>
        <p className="text-muted-foreground mt-1">
          Stage broker settings for a controlled telemetry-consumer restart.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5" /> MQTT Broker Settings
            </CardTitle>
            <CardDescription>
              Stage safe endpoint, topic, site, and timezone settings, then apply them to the live consumer. Broker credentials remain in workspace secrets and are never stored or displayed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-4 animate-pulse">
                <div className="h-10 bg-muted rounded w-full"></div>
                <div className="h-10 bg-muted rounded w-full"></div>
              </div>
            ) : (
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <FormField
                      control={form.control}
                      name="brokerUrl"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Broker URL</FormLabel>
                          <FormControl>
                            <Input placeholder="tls://broker.emqx.io:8883" {...field} />
                          </FormControl>
                          <FormDescription>
                            Secure TLS endpoints recommended for production.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="topic"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Root Topic</FormLabel>
                          <FormControl>
                            <Input placeholder="scada/telemetry/#" {...field} />
                          </FormControl>
                          <FormDescription>
                            The wildcard topic path for device ingestion.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="plantSite"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Default Plant Site</FormLabel>
                          <FormControl>
                            <Input placeholder="plant-01" {...field} />
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
                            <Input placeholder="UTC" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                  
                  <div className="flex items-center justify-between border-t pt-4">
                    <div className="text-sm text-muted-foreground flex items-center gap-2">
                      <div className={`h-2 w-2 rounded-full ${config?.credentialsConfigured ? 'bg-emerald-500' : 'bg-destructive'}`} />
                      {config?.credentialsConfigured ? "Credentials securely configured" : "Warning: No credentials configured"}
                    </div>
                    <div className="flex items-center gap-3">
                    <Button type="button" variant="outline" onClick={apply} disabled={applying || !config?.pendingApply}>
                      <RefreshCw className={`h-4 w-4 mr-2 ${applying ? "animate-spin" : ""}`} />
                      {applyLabel}
                    </Button>
                    <Button type="submit" disabled={updateConfig.isPending || !form.formState.isDirty || applying}>
                      {updateConfig.isPending ? (
                        "Saving..."
                      ) : (
                        <>
                          <Save className="h-4 w-4 mr-2" />
                          Stage Configuration
                        </>
                      )}
                    </Button>
                    </div>
                  </div>
                  <div className="rounded-md border bg-muted/30 px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">Live consumer</span>
                      <span className={config?.connected ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}>
                        {config?.connected ? "Connected and subscribed" : config?.applyState === "failed" ? "Apply failed; previous settings restored" : "Disconnected"}
                      </span>
                    </div>
                    {config?.pendingApply && !applying && (
                      <p className="mt-1 text-muted-foreground">A staged configuration differs from the active consumer.</p>
                    )}
                    {config?.lastApplyError && (
                      <p className="mt-1 text-destructive">{config.lastApplyError}</p>
                    )}
                  </div>
                </form>
              </Form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
