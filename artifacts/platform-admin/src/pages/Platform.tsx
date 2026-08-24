import { 
  useGetPlatformMqttConfig, 
  useUpdatePlatformMqttConfig,
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
import { Server, Save } from "lucide-react"

const configSchema = z.object({
  brokerUrl: z.string().min(8, "URL is too short").max(300),
  topic: z.string().min(1, "Topic is required").max(300),
  plantSite: z.string().min(1, "Plant site is required").max(160),
  timezone: z.string().min(1, "Timezone is required").max(80),
})

export default function Platform() {
  const { data: config, isLoading } = useGetPlatformMqttConfig()
  const updateConfig = useUpdatePlatformMqttConfig()
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
          toast({ title: "Configuration staged", description: "Restart the API Server workflow to apply it to the MQTT consumer." })
          queryClient.setQueryData(getGetPlatformMqttConfigQueryKey(), data)
          form.reset(values) // Reset form to clear isDirty state
        },
        onError: () => {
          toast({ title: "Failed to update configuration", variant: "destructive" })
        },
      }
    )
  }

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
              Changes are saved server-side but are not applied to the running MQTT consumer until the API Server workflow is restarted. Broker credentials remain in workspace secrets.
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
                    <Button type="submit" disabled={updateConfig.isPending || !form.formState.isDirty}>
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
                </form>
              </Form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
