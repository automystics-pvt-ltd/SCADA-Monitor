import { useState, useEffect, useMemo, useId } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { 
  useListPlatformSites, 
  useListPlatformTelemetryDevices, 
  useCreatePlatformTelemetryTest, 
  useUpdatePlatformSiteActivation,
  getListPlatformSitesQueryKey,
  getListPlatformTelemetryDevicesQueryKey,
  useListPlatformTelemetryParameters,
  getListPlatformTelemetryParametersQueryKey,
  useUpsertPlatformTelemetryMapping,
  useClearPlatformTelemetryMapping,
  PlatformTelemetryDestination,
  type PlatformTelemetryTest,
  type PlatformTelemetryParameter,
  type PlatformTelemetryMappingInput,
  type PlatformTelemetryMappingIdentity
} from "@workspace/api-client-react"
import { format } from "date-fns"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog"
import { useToast } from "@/hooks/use-toast"
import { Activity, Radio, ShieldCheck, ShieldAlert, AlertTriangle, TerminalSquare, Search, RefreshCw, CheckCircle2, ChevronRight, Play, GitMerge, Save, Trash2 } from "lucide-react"
import { inverterIdentityForMapping, requiresInverterIdentity } from "@/telemetry-mapping-form"
import { telemetryMappingGuidance } from "@/telemetry-mapping-guidance"

function ParameterMappingRow({ 
  parameter, 
  onSave,
  onClear
}: { 
  parameter: PlatformTelemetryParameter,
  onSave: (input: PlatformTelemetryMappingInput) => Promise<void>,
  onClear: (identity: PlatformTelemetryMappingIdentity) => Promise<void>
}) {
  const m = parameter.mapping;
  const unitSuggestionId = `telemetry-unit-${useId().replace(/:/g, "")}`;
  
  const [destination, setDestination] = useState<PlatformTelemetryDestination>(
    m?.destination || PlatformTelemetryDestination['discovered-other']
  );
  const [displayLabel, setDisplayLabel] = useState(m?.displayLabel || parameter.displayLabel || '');
  const [category, setCategory] = useState(m?.category || parameter.category || '');
  const [inverterIdentity, setInverterIdentity] = useState(m?.inverterIdentity || 'inv1');
  const [displayUnit, setDisplayUnit] = useState(m?.displayUnit || parameter.displayUnit || parameter.sourceUnit || '');
  const [scalingMultiplier, setScalingMultiplier] = useState(m?.scalingMultiplier ?? 1);
  const [scalingOffset, setScalingOffset] = useState(m?.scalingOffset ?? 0);
  
  const [lastSyncedUpdatedAt, setLastSyncedUpdatedAt] = useState(m?.updatedAt);
  const [isSaving, setIsSaving] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  
  useEffect(() => {
    if (parameter.mapping?.updatedAt !== lastSyncedUpdatedAt) {
      const nm = parameter.mapping;
      setDestination(nm?.destination || PlatformTelemetryDestination['discovered-other']);
      setDisplayLabel(nm?.displayLabel || parameter.displayLabel || '');
      setCategory(nm?.category || parameter.category || '');
      setInverterIdentity(nm?.inverterIdentity || 'inv1');
      setDisplayUnit(nm?.displayUnit || parameter.displayUnit || parameter.sourceUnit || '');
      setScalingMultiplier(nm?.scalingMultiplier ?? 1);
      setScalingOffset(nm?.scalingOffset ?? 0);
      setLastSyncedUpdatedAt(nm?.updatedAt);
    }
  }, [parameter.mapping, parameter.displayLabel, parameter.category, parameter.displayUnit, parameter.sourceUnit, lastSyncedUpdatedAt]);

  const needsInverterIdentity = requiresInverterIdentity(destination);
  const guidance = telemetryMappingGuidance(destination, parameter.normalizedName || parameter.displayLabel, parameter.sourceUnit);
  const needsConfirmedUnit = !guidance.unitless && !displayUnit.trim() && !parameter.sourceUnit;
  const applyGuidance = () => {
    setDisplayLabel(guidance.recommendedLabel);
    setCategory(guidance.recommendedCategory);
    if (parameter.sourceUnit) setDisplayUnit(parameter.sourceUnit);
  };
  const isDirty = 
    destination !== (m?.destination || PlatformTelemetryDestination['discovered-other']) ||
    displayLabel !== (m?.displayLabel || parameter.displayLabel || '') ||
    category !== (m?.category || parameter.category || '') ||
    displayUnit !== (m?.displayUnit || parameter.displayUnit || parameter.sourceUnit || '') ||
    scalingMultiplier !== (m?.scalingMultiplier ?? 1) ||
    scalingOffset !== (m?.scalingOffset ?? 0) ||
    (needsInverterIdentity && inverterIdentity !== (m?.inverterIdentity || 'inv1'));
    
  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave({
        siteName: parameter.siteName,
        deviceId: parameter.deviceId,
        sourceIdentity: parameter.sourceIdentity,
        normalizedName: parameter.normalizedName,
        address: parameter.address || "—",
        destination,
        displayLabel,
        category,
        inverterIdentity: inverterIdentityForMapping(destination, inverterIdentity),
        sourceUnit: parameter.sourceUnit || null,
        displayUnit: displayUnit.trim() || null,
        scalingMultiplier,
        scalingOffset,
      });
    } catch (e) {
      // Ignored, handled by parent
    } finally {
      setIsSaving(false);
    }
  }

  const handleClear = async () => {
    setIsClearing(true);
    try {
      await onClear({
        siteName: parameter.siteName,
        deviceId: parameter.deviceId,
        sourceIdentity: parameter.sourceIdentity,
        normalizedName: parameter.normalizedName,
        address: parameter.address || "—",
      });
    } finally {
      setIsClearing(false);
    }
  }

  const isMapped = !!m && m.status === 'active';
  const canSave = !isMapped || isDirty;

  return (
    <TableRow className={`group transition-colors ${isDirty ? "bg-primary/5 hover:bg-primary/10" : "hover:bg-muted/30"}`}>
      {/* Source Parameter */}
      <TableCell className="align-top py-3">
          <div className="flex items-center gap-2 mb-1">
          <div className={`w-1.5 h-1.5 rounded-full flex-none ${isMapped ? 'bg-emerald-500 shadow-[0_0_5px_rgba(16,185,129,0.5)]' : 'bg-muted-foreground/30'}`} />
            <div className="font-semibold text-foreground text-sm truncate max-w-[240px]" title={parameter.displayLabel}>
              {parameter.displayLabel}
            </div>
        </div>
          <div className="text-[10px] text-muted-foreground pl-3.5">Source: {parameter.sourceName}</div>
        <div className="font-mono text-[10px] text-muted-foreground truncate max-w-[250px] pl-3.5" title={parameter.sourceIdentity}>
          {parameter.sourceIdentity}
        </div>
        <div className="flex items-center gap-1.5 pl-3.5 mt-1">
          <Badge variant="outline" className="text-[9px] h-4 px-1 rounded bg-background/50 border-border/50 text-muted-foreground font-mono font-normal">
            {parameter.sourceUnit ? `Reported unit: ${parameter.sourceUnit}` : "No source unit reported"}
          </Badge>
        </div>
        <div className="text-[10px] text-muted-foreground/80 pl-3.5 mt-1">
          <span className="font-mono">{parameter.observationCount} observation{parameter.observationCount === 1 ? '' : 's'}</span>
          {parameter.lastSeenAt && <span> · Last seen {format(new Date(parameter.lastSeenAt), 'MMM d, HH:mm:ss')}</span>}
        </div>
        {parameter.address && (
          <div className="font-mono text-[10px] text-muted-foreground/70 truncate max-w-[250px] pl-3.5 mt-0.5" title={parameter.address}>
            ADDR: {parameter.address}
          </div>
        )}
      </TableCell>

      {/* Latest Evidence */}
      <TableCell className="align-top py-3">
        {parameter.evidenceAvailable ? (
          <>
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-sm font-medium text-emerald-600 dark:text-emerald-400">
                {parameter.reportedValue}
              </span>
              {parameter.sourceUnit && (
                <Badge variant="outline" className="text-[9px] uppercase h-4 px-1 rounded bg-background/50 border-border/50 text-muted-foreground font-mono font-normal flex-none">
                  {parameter.sourceUnit}
                </Badge>
              )}
            </div>
            <div className="text-[10px] text-muted-foreground mt-1 font-mono truncate max-w-[180px] opacity-70" title={`RAW: ${parameter.rawValue}`}>
              RAW: {parameter.rawValue}
            </div>
          </>
        ) : (
          <div className="rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-[10px] text-amber-700 dark:text-amber-300">
            Evidence unavailable. Saved configuration remains editable.
          </div>
        )}
        {parameter.displayValue !== null && parameter.displayValue !== undefined && (
          <div className="mt-1 text-[10px] font-medium text-primary">
            Actual: <span className="font-mono">{parameter.displayValue}</span>{parameter.displayUnit ? ` ${parameter.displayUnit}` : ''}
            {parameter.mappingValidationStatus === 'valid' ? ' · approved map' : ''}
          </div>
        )}
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          <Badge variant="secondary" className={isMapped ? "text-[8px] h-3.5 px-1 rounded-sm leading-none font-medium uppercase tracking-wider bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "text-[8px] h-3.5 px-1 rounded-sm leading-none font-medium uppercase tracking-wider"}>
            {isMapped ? `Saved · v${m.version}` : "Unmapped"}
          </Badge>
          {isDirty && <Badge variant="secondary" className="text-[8px] h-3.5 px-1 rounded-sm leading-none font-medium uppercase tracking-wider bg-primary/10 text-primary">Unsaved edit</Badge>}
          <Badge variant="secondary" className={`text-[8px] h-3.5 px-1 rounded-sm leading-none font-medium uppercase tracking-wider ${parameter.dataQuality === 'validated' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'}`}>
            {parameter.dataQuality}
          </Badge>
          <Badge variant="secondary" className="text-[8px] h-3.5 px-1 rounded-sm leading-none font-medium uppercase tracking-wider bg-primary/5 text-primary/80">
            {parameter.provenance}
          </Badge>
        </div>
      </TableCell>

      {/* Destination */}
      <TableCell className="align-top py-3">
        <div className="space-y-2">
          <Select value={destination} onValueChange={(v: PlatformTelemetryDestination) => setDestination(v)}>
            <SelectTrigger className={`h-8 text-xs ${isDirty && destination !== m?.destination ? 'border-primary/50 bg-primary/5 ring-1 ring-primary/20' : 'bg-background'}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.values(PlatformTelemetryDestination).map(dest => (
                <SelectItem key={dest} value={dest} className="text-xs font-medium">
                  {dest}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {needsInverterIdentity && (
            <div className="space-y-1">
              <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Physical inverter</p>
              <Select value={inverterIdentity} onValueChange={setInverterIdentity}>
                <SelectTrigger className={`h-8 text-xs ${isDirty && inverterIdentity !== m?.inverterIdentity ? 'border-primary/50 bg-primary/5 ring-1 ring-primary/20' : 'bg-background border-amber-500/30'}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['inv1', 'inv2', 'inv3', 'inv4', 'inv5'].map(inv => (
                    <SelectItem key={inv} value={inv} className="text-xs font-mono">
                      {inv.toUpperCase()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="rounded-md border border-primary/15 bg-primary/[0.035] p-2 text-[10px] leading-4">
            <p className="font-semibold text-primary">Suggested mapping: {guidance.recommendedLabel}</p>
            <p className="mt-0.5 text-muted-foreground">{guidance.explanation}</p>
            <p className="mt-1 text-muted-foreground"><span className="font-medium text-foreground">SCADA display:</span> {guidance.frontEndDisplay}</p>
            <button type="button" onClick={applyGuidance} className="mt-1.5 text-[9px] font-semibold text-primary hover:underline">
              Use suggested label &amp; category
            </button>
          </div>
        </div>
      </TableCell>

      {/* Display Config */}
      <TableCell className="align-top py-3">
        <div className="space-y-2">
          <Input 
            className={`h-8 text-xs ${isDirty && displayLabel !== (m?.displayLabel || parameter.displayLabel || '') ? 'border-primary/50 bg-primary/5 ring-1 ring-primary/20' : 'bg-background'}`} 
            placeholder="Display Label"
            value={displayLabel}
            onChange={e => setDisplayLabel(e.target.value)}
          />
          <Input 
            className={`h-8 text-xs ${isDirty && category !== (m?.category || parameter.category || '') ? 'border-primary/50 bg-primary/5 ring-1 ring-primary/20' : 'bg-background'}`} 
            placeholder="Category"
            value={category}
            onChange={e => setCategory(e.target.value)}
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Display unit</p>
            {parameter.sourceUnit ? (
              <button
                type="button"
                className="text-[9px] font-medium text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
                onClick={() => setDisplayUnit(parameter.sourceUnit || "")}
                disabled={displayUnit === parameter.sourceUnit}
                title="Use the unit reported by this source"
              >
                Use reported unit: {parameter.sourceUnit}
              </button>
            ) : (
              <span className="text-[9px] text-muted-foreground">{guidance.unitless ? "Unitless event/state" : "Source unit unavailable"}</span>
            )}
          </div>
          {!guidance.unitless && guidance.unitSuggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[9px] text-muted-foreground">Confirmed-unit choices:</span>
              {guidance.unitSuggestions.map((unit) => (
                <button
                  type="button"
                  key={unit}
                  onClick={() => setDisplayUnit(unit)}
                  className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${displayUnit === unit ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground"}`}
                  title={parameter.sourceUnit === unit ? "Unit reported by the device" : "Select only after confirming this unit against the source"}
                >
                  {unit}{parameter.sourceUnit === unit ? " · reported" : ""}
                </button>
              ))}
            </div>
          )}
          <div className="grid grid-cols-3 gap-1.5">
            <Input
              className={`h-8 text-xs bg-background ${needsConfirmedUnit ? "border-amber-500/50 bg-amber-500/5" : ""}`}
              placeholder={guidance.unitless ? "Unitless" : parameter.sourceUnit ? `Suggested: ${parameter.sourceUnit}` : "Choose confirmed unit"}
              value={displayUnit}
              onChange={e => setDisplayUnit(e.target.value)}
              list={unitSuggestionId}
              aria-label={`Display unit for ${parameter.displayLabel}`}
              title={parameter.sourceUnit ? `Suggested source unit: ${parameter.sourceUnit}` : "Customer-facing display unit; do not infer a unit"}
            />
            <datalist id={unitSuggestionId}>
              {parameter.sourceUnit && <option value={parameter.sourceUnit} />}
            </datalist>
            <Input
              className="h-8 text-xs bg-background"
              type="number"
              step="any"
              value={scalingMultiplier}
              onChange={e => setScalingMultiplier(Number(e.target.value))}
              title="Multiplier in Actual = reported × multiplier + offset"
            />
            <Input
              className="h-8 text-xs bg-background"
              type="number"
              step="any"
              value={scalingOffset}
              onChange={e => setScalingOffset(Number(e.target.value))}
              title="Offset in Actual = reported × multiplier + offset"
            />
          </div>
          {guidance.unitless ? (
            <p className="text-[9px] text-muted-foreground">This mapping saves as a unitless event/state. Its source value remains visible as evidence.</p>
          ) : needsConfirmedUnit ? (
            <p className="text-[9px] text-amber-700 dark:text-amber-300">Choose a confirmed unit before saving. Suggestions are not applied automatically when the source did not report one.</p>
          ) : null}
          {isMapped ? (
            <p className="text-[9px] text-muted-foreground font-mono">
              Actual = reported × {scalingMultiplier} + {scalingOffset}
            </p>
          ) : isDirty ? (
            <p className="text-[9px] text-muted-foreground font-mono">
              Draft = reported × {scalingMultiplier} + {scalingOffset} · not saved
            </p>
          ) : (
            <p className="text-[9px] text-muted-foreground/70 font-mono">
              No approved transform saved
            </p>
          )}
        </div>
      </TableCell>

      {/* Actions */}
      <TableCell className="align-top py-3 text-right pr-6">
        <div className="flex flex-col items-end gap-2">
          <Button 
            size="sm" 
            className={`h-8 w-28 text-xs font-semibold shadow-sm transition-all duration-300 ${canSave ? 'opacity-100 translate-x-0' : 'opacity-50 grayscale'}`}
            variant={canSave ? "default" : "secondary"}
            disabled={!canSave || isSaving || needsConfirmedUnit}
            onClick={handleSave}
          >
            {isSaving ? <RefreshCw className="w-3 h-3 animate-spin mr-1.5" /> : <Save className="w-3 h-3 mr-1.5" />}
            {isSaving ? "Saving" : needsConfirmedUnit ? "Choose unit" : isDirty ? "Save edit" : isMapped ? "Saved" : "Save mapping"}
          </Button>

          {isMapped && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button 
                  size="sm" 
                  variant="outline" 
                  className="h-8 w-20 text-xs text-destructive hover:text-destructive border-destructive/20 hover:bg-destructive/10" 
                  disabled={isClearing || isSaving}
                >
                  {isClearing ? <RefreshCw className="w-3 h-3 animate-spin mr-1.5" /> : <Trash2 className="w-3 h-3 mr-1.5" />}
                  Clear
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="border-destructive/20">
                <AlertDialogHeader>
                  <AlertDialogTitle className="text-destructive flex items-center gap-2">
                    <Trash2 className="w-5 h-5" />
                    Clear Parameter Mapping
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to clear the mapping for <strong className="text-foreground">{parameter.sourceName}</strong>?
                    <br/><br/>
                    This will stop routing this telemetry stream to <strong className="text-foreground">{m?.destination}</strong> and revert it to raw/unmapped status in the platform.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction 
                    onClick={handleClear} 
                    className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
                  >
                    Yes, clear mapping
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

function MappingWorkspace({ siteName, deviceId }: { siteName: string, deviceId: string }) {
  const queryClient = useQueryClient()
  const { toast } = useToast()
  
  const { data, isLoading } = useListPlatformTelemetryParameters(
    { siteName, deviceId: deviceId || undefined },
    { query: { enabled: !!siteName, refetchInterval: 15_000, queryKey: getListPlatformTelemetryParametersQueryKey({ siteName, deviceId: deviceId || undefined }) } }
  )
  
  const [searchTerm, setSearchTerm] = useState("")
  const [workspaceView, setWorkspaceView] = useState<'queue' | 'all'>('queue')
  
  const upsertMapping = useUpsertPlatformTelemetryMapping()
  const clearMapping = useClearPlatformTelemetryMapping()

  const handleSave = async (input: PlatformTelemetryMappingInput) => {
    try {
      await upsertMapping.mutateAsync({ data: input })
      await queryClient.invalidateQueries({ queryKey: getListPlatformTelemetryParametersQueryKey({ siteName, deviceId: deviceId || undefined }) })
      toast({ title: "Mapping saved", description: `Updated destination to ${input.destination}` })
    } catch (err) {
      toast({ 
        title: "Failed to save mapping", 
        description: err instanceof Error ? err.message : "An error occurred",
        variant: "destructive" 
      })
      throw err;
    }
  }

  const handleClear = async (identity: PlatformTelemetryMappingIdentity) => {
    try {
      await clearMapping.mutateAsync({ data: identity })
      await queryClient.invalidateQueries({ queryKey: getListPlatformTelemetryParametersQueryKey({ siteName, deviceId: deviceId || undefined }) })
      toast({ title: "Mapping cleared", description: `Removed mapping for ${identity.sourceIdentity}` })
    } catch (err) {
      toast({ 
        title: "Failed to clear mapping", 
        description: err instanceof Error ? err.message : "An error occurred",
        variant: "destructive" 
      })
      throw err;
    }
  }

  const parameters = data?.parameters || []
  const unmappedParameters = parameters.filter((parameter) =>
    parameter.mappingLifecycleStatus === 'unmapped' && parameter.mapping === null
  )
  const workspaceParameters = workspaceView === 'queue' ? unmappedParameters : parameters
  const filtered = workspaceParameters.filter(p =>
    !searchTerm || 
    p.sourceName.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.sourceIdentity.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.normalizedName.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.displayLabel.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.category.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.mapping?.destination.toLowerCase().includes(searchTerm.toLowerCase())
  )

  if (!siteName) {
    return (
      <Card className="border-dashed bg-muted/10 border-primary/20">
        <CardContent className="h-48 flex flex-col items-center justify-center text-muted-foreground">
          <GitMerge className="w-10 h-10 mb-4 opacity-20" />
          <p>Select a managed site to view and map telemetry parameters.</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-primary/20 bg-card/50 backdrop-blur-sm shadow-lg overflow-hidden flex flex-col">
      <CardHeader className="border-b bg-muted/30 pb-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <GitMerge className="w-5 h-5 text-primary" />
              Parameter Mapping Workspace
            </CardTitle>
            <CardDescription className="mt-1.5">
              Map inbound telemetry variables to standardized platform destinations. 
                <span className="inline-block font-medium text-emerald-600 dark:text-emerald-500 md:ml-1 mt-1 md:mt-0 bg-emerald-500/10 px-1.5 py-0.5 rounded-sm">
                  Approved mapping transforms produce the labeled Actual value; raw evidence and KPI calibration remain separate.
              </span>
            </CardDescription>
          </div>
          <div className="flex-none">
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="flex rounded-md border bg-background p-0.5">
                <Button
                  type="button"
                  size="sm"
                  variant={workspaceView === 'queue' ? 'secondary' : 'ghost'}
                  onClick={() => setWorkspaceView('queue')}
                  className="h-8 gap-1.5 text-xs"
                >
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                  Unmapped queue
                  <Badge variant="outline" className="h-4 min-w-4 px-1 text-[9px] tabular-nums">
                    {unmappedParameters.length}
                  </Badge>
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={workspaceView === 'all' ? 'secondary' : 'ghost'}
                  onClick={() => setWorkspaceView('all')}
                  className="h-8 text-xs"
                >
                  All parameters
                </Button>
              </div>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Filter parameters..."
                  className="pl-9 w-full md:w-[250px] bg-background border-primary/20 focus-visible:ring-primary/30"
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                />
              </div>
            </div>
          </div>
        </div>
        <div className={`mt-3 rounded-md border px-3 py-2 text-xs ${
          unmappedParameters.length
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200'
            : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200'
        }`}>
          {unmappedParameters.length
            ? <span className="flex items-center gap-2"><AlertTriangle className="h-3.5 w-3.5 flex-none" />{unmappedParameters.length} exact source identit{unmappedParameters.length === 1 ? 'y needs' : 'ies need'} mapping. Rows stay raw until an administrator saves an approved destination.</span>
            : <span className="flex items-center gap-2"><CheckCircle2 className="h-3.5 w-3.5 flex-none" />No unmapped source identities are waiting for review.</span>}
        </div>
      </CardHeader>
      <div className="max-h-[600px] overflow-auto">
        <Table>
          <TableHeader className="bg-muted/50 sticky top-0 z-10 backdrop-blur-md shadow-sm">
            <TableRow>
              <TableHead className="w-[280px]">Source Parameter</TableHead>
              <TableHead className="w-[200px]">Latest Evidence</TableHead>
              <TableHead className="w-[220px]">Destination</TableHead>
              <TableHead className="w-[220px]">Display Config</TableHead>
              <TableHead className="text-right w-[100px] pr-6">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                  <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2 opacity-50" />
                  Loading parameters...
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                  {parameters.length === 0
                    ? "No source parameters have been received for this managed site yet. Confirm the broker is connected and the site is active, then refresh."
                    : workspaceView === 'queue' && unmappedParameters.length === 0
                      ? "Every discovered source identity is mapped. Switch to All parameters to review saved configuration."
                      : "No parameters found matching your criteria."}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map(param => (
                <ParameterMappingRow 
                  key={[param.siteName, param.deviceId, param.sourceIdentity, param.normalizedName, param.address ?? "—"].join("\u001f")}
                  parameter={param} 
                  onSave={handleSave} 
                  onClear={handleClear} 
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {filtered.length > 0 && (
        <div className="bg-muted/30 border-t px-6 py-2 text-[10px] text-muted-foreground font-mono uppercase tracking-wider flex justify-between">
          <span>{filtered.length} {workspaceView === 'queue' ? 'unmapped queue item' : 'parameter'}{filtered.length === 1 ? '' : 's'}</span>
          <span>{filtered.filter(p => p.mapping?.status === 'active').length} mapped</span>
        </div>
      )}
    </Card>
  )
}

export default function Telemetry() {
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const [selectedSiteName, setSelectedSiteName] = useState<string>("")
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("")
  const [timeoutSeconds, setTimeoutSeconds] = useState<number>(5)
  const [testResult, setTestResult] = useState<PlatformTelemetryTest | null>(null)
  
  const [isActivationDialogOpen, setIsActivationDialogOpen] = useState(false)

  const { data: sites, isLoading: isLoadingSites } = useListPlatformSites()
  const { data: devices, isLoading: isLoadingDevices } = useListPlatformTelemetryDevices({
    query: { queryKey: getListPlatformTelemetryDevicesQueryKey(), refetchInterval: 10_000 }
  })

  const createTest = useCreatePlatformTelemetryTest()
  const updateActivation = useUpdatePlatformSiteActivation()

  const selectedSite = useMemo(() => sites?.find(s => s.siteName === selectedSiteName), [sites, selectedSiteName])
  const filteredDevices = useMemo(() => devices?.filter(d => d.siteName === selectedSiteName) || [], [devices, selectedSiteName])

  useEffect(() => {
    if (selectedSiteName) return
    const activeSites = sites?.filter((site) => site.activationStatus === "active") ?? []
    if (activeSites.length === 1) setSelectedSiteName(activeSites[0].siteName)
  }, [sites, selectedSiteName])

  const handleSiteChange = (val: string) => {
    setSelectedSiteName(val)
    setSelectedDeviceId("")
    setTestResult(null)
  }

  const handleRunTest = () => {
    if (!selectedSiteName || !selectedDeviceId) return;

    createTest.mutate(
      {
        data: {
          siteName: selectedSiteName,
          deviceId: selectedDeviceId,
          timeoutSeconds
        }
      },
      {
        onSuccess: (data) => {
          setTestResult(data)
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: getListPlatformSitesQueryKey() }),
            queryClient.invalidateQueries({ queryKey: getListPlatformTelemetryDevicesQueryKey() }),
          ])
          toast({ 
            title: "Test completed", 
            description: `Telemetry test returned: ${data.result}` 
          })
        },
        onError: (err) => {
          toast({ 
            title: "Test execution failed", 
            description: err instanceof Error ? err.message : "An error occurred",
            variant: "destructive" 
          })
        }
      }
    )
  }

  const handleToggleActivation = () => {
    if (!selectedSite) return

    const isCurrentlyActive = selectedSite.activationStatus === 'active'
    const nextStatus = isCurrentlyActive ? 'inactive' : 'active'

    updateActivation.mutate(
      {
        data: {
          siteName: selectedSite.siteName,
          activationStatus: nextStatus
        }
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListPlatformSitesQueryKey() })
          toast({ title: `Site ${nextStatus === 'active' ? 'activated' : 'deactivated'} successfully` })
          setIsActivationDialogOpen(false)
        },
        onError: (err) => {
          toast({ 
            title: "Activation update failed", 
            description: err instanceof Error ? err.message : "An error occurred",
            variant: "destructive" 
          })
        }
      }
    )
  }

  const renderPayload = (val: string | null) => {
    if (!val) return <span className="text-slate-500">No payload received during observation window.</span>
    try {
      const obj = JSON.parse(val)
      return <pre>{JSON.stringify(obj, null, 2)}</pre>
    } catch {
      return <pre>{val}</pre>
    }
  }

  const isTestSuccess = selectedSite?.lastTelemetryTestResult === 'success'
  const isSiteActive = selectedSite?.activationStatus === 'active'
  const canActivate = isTestSuccess || testResult?.result === 'success'

  return (
    <div className="space-y-6 animate-in fade-in duration-500 pb-12">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-primary flex items-center gap-3">
          <Activity className="h-8 w-8" />
          Telemetry Administration
        </h1>
        <p className="text-muted-foreground mt-2">
          Verify live device communication and map inbound parameters to SCADA destinations.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Control Panel */}
        <div className="lg:col-span-4 space-y-6 flex flex-col">
          <Card className="flex-none border-primary/20 bg-card/50 backdrop-blur-sm shadow-sm">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg flex items-center gap-2">
                <Search className="w-5 h-5 text-primary" /> 
                Target Selection
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <label className="text-sm font-medium">Managed Site</label>
                <Select value={selectedSiteName} onValueChange={handleSiteChange} disabled={isLoadingSites}>
                  <SelectTrigger className="bg-background">
                    <SelectValue placeholder="Select a site..." />
                  </SelectTrigger>
                  <SelectContent>
                    {sites?.map((site) => (
                      <SelectItem key={site.siteName} value={site.siteName}>
                        {site.siteName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Device Source</label>
                <Select value={selectedDeviceId} onValueChange={setSelectedDeviceId} disabled={!selectedSiteName || isLoadingDevices || filteredDevices.length === 0}>
                  <SelectTrigger className="bg-background">
                    <SelectValue placeholder={!selectedSiteName ? "Select site first" : filteredDevices.length === 0 ? "No devices found" : "Select a device..."} />
                  </SelectTrigger>
                  <SelectContent>
                    {filteredDevices.map((dev) => (
                      <SelectItem key={dev.deviceId} value={dev.deviceId}>
                        {dev.deviceName} <span className="text-muted-foreground text-xs ml-1 font-mono">({dev.deviceId})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Observation Timeout</label>
                <Select value={timeoutSeconds.toString()} onValueChange={(val) => setTimeoutSeconds(Number(val))}>
                  <SelectTrigger className="bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="3">3 seconds</SelectItem>
                    <SelectItem value="5">5 seconds</SelectItem>
                    <SelectItem value="10">10 seconds</SelectItem>
                    <SelectItem value="15">15 seconds</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
            <div className="p-6 pt-0">
              <Button 
                className="w-full font-semibold transition-all shadow-sm" 
                onClick={handleRunTest} 
                disabled={!selectedSiteName || !selectedDeviceId || createTest.isPending}
                size="lg"
              >
                {createTest.isPending ? (
                  <RefreshCw className="w-5 h-5 mr-2 animate-spin" />
                ) : (
                  <Play className="w-5 h-5 mr-2" />
                )}
                {createTest.isPending ? "Observing Telemetry..." : "Run Telemetry Test"}
              </Button>
            </div>
          </Card>

          {selectedSite && (
            <Card className={`flex-none transition-colors duration-300 ${isSiteActive ? "border-emerald-500/50 shadow-[0_0_15px_rgba(16,185,129,0.1)]" : "border-border shadow-sm"}`}>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {isSiteActive ? <ShieldCheck className="w-5 h-5 text-emerald-500" /> : <ShieldAlert className="w-5 h-5 text-muted-foreground" />}
                    Site Activation
                  </div>
                  <Badge variant={isSiteActive ? "default" : "secondary"} className={isSiteActive ? "bg-emerald-500 hover:bg-emerald-600 text-white" : ""}>
                    {isSiteActive ? "ACTIVE" : "INACTIVE"}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  {isSiteActive 
                    ? "Site is available to authorized SCADA operators. Device health remains separate." 
                    : "Activate only after a successful live telemetry verification."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md bg-card border p-3 mb-4 space-y-2 text-sm shadow-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Last Test</span>
                    <span className="font-mono text-foreground text-xs pt-0.5">
                      {selectedSite.lastTelemetryTestedAt 
                        ? format(new Date(selectedSite.lastTelemetryTestedAt), "HH:mm:ss yyyy-MM-dd")
                        : "Never"}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Status</span>
                    {selectedSite.lastTelemetryTestResult === 'success' ? (
                      <span className="text-emerald-500 font-semibold flex items-center gap-1 text-xs">
                        <CheckCircle2 className="w-3.5 h-3.5" /> PASS
                      </span>
                    ) : selectedSite.lastTelemetryTestResult === 'error' ? (
                      <span className="text-destructive font-semibold flex items-center gap-1 text-xs">
                        <AlertTriangle className="w-3.5 h-3.5" /> FAIL
                      </span>
                    ) : selectedSite.lastTelemetryTestResult === 'no-telemetry' ? (
                      <span className="text-amber-500 font-semibold flex items-center gap-1 text-xs">
                        <Radio className="w-3.5 h-3.5" /> NO DATA
                      </span>
                    ) : (
                      <span className="text-muted-foreground font-mono text-xs">UNKNOWN</span>
                    )}
                  </div>
                </div>

                <Dialog open={isActivationDialogOpen} onOpenChange={setIsActivationDialogOpen}>
                  <DialogTrigger asChild>
                    <Button 
                      variant={isSiteActive ? "destructive" : "default"} 
                      className={`w-full font-medium ${!isSiteActive && canActivate ? "bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm" : ""}`}
                      disabled={!isSiteActive && !canActivate}
                    >
                      {isSiteActive ? "Deactivate Site" : "Activate Site"}
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>
                        Confirm {isSiteActive ? "Deactivation" : "Activation"}
                      </DialogTitle>
                      <DialogDescription>
                        {isSiteActive 
                          ? `Are you sure you want to deactivate ${selectedSite.siteName}? Authorized SCADA users will lose access to this managed site until it is explicitly activated again.` 
                          : `Are you sure you want to activate ${selectedSite.siteName}? Its successful live test will be recorded and the updated site state will reach connected SCADA clients immediately.`}
                      </DialogDescription>
                    </DialogHeader>
                    
                    {!isSiteActive && testResult?.result !== 'success' && selectedSite.lastTelemetryTestResult === 'success' && (
                      <div className="bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 rounded-lg p-4 flex gap-3 text-sm mt-2">
                        <AlertTriangle className="h-5 w-5 shrink-0" />
                        <div>
                          <h4 className="font-semibold mb-1">Notice</h4>
                          <p>A previous test passed, but you haven't run a successful test in this session. Proceed with caution.</p>
                        </div>
                      </div>
                    )}

                    <DialogFooter className="mt-4">
                      <Button variant="outline" onClick={() => setIsActivationDialogOpen(false)}>Cancel</Button>
                      <Button 
                        variant={isSiteActive ? "destructive" : "default"}
                        onClick={handleToggleActivation}
                        disabled={updateActivation.isPending}
                      >
                        {updateActivation.isPending && <RefreshCw className="w-4 h-4 mr-2 animate-spin" />}
                        Confirm {isSiteActive ? "Deactivate" : "Activate"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
                
                {!isSiteActive && !canActivate && (
                  <p className="text-[11px] text-center text-muted-foreground mt-3 bg-muted/50 p-2 rounded">
                    A successful telemetry test is required before activation.
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right Diagnostics Panel */}
        <div className="lg:col-span-8 space-y-6 flex flex-col">
          <Card className="flex-1 flex flex-col border-primary/10 shadow-sm overflow-hidden bg-card/50 backdrop-blur-sm">
            <CardHeader className="border-b bg-muted/30 pb-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg flex items-center gap-2">
                  <TerminalSquare className="w-5 h-5 text-primary" />
                  Diagnostic Output
                </CardTitle>
                {testResult && (
                  <Badge variant="outline" className={
                    testResult.result === 'success' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30' :
                    testResult.result === 'error' ? 'bg-destructive/15 text-destructive border-destructive/30' : 
                    'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
                  }>
                    {testResult.result.toUpperCase()}
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="flex-1 p-0">
              {testResult ? (
                <div className="p-6 space-y-8 animate-in slide-in-from-bottom-2 duration-300">
                  {/* Status Grid */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="space-y-1.5 p-3 rounded-lg bg-card border shadow-sm">
                      <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Broker Status</div>
                      <div className="font-mono text-sm font-semibold flex items-center gap-2 truncate">
                        <div className={`w-2 h-2 rounded-full flex-none ${testResult.brokerStatus === 'connected' ? 'bg-emerald-500 shadow-[0_0_5px_rgba(16,185,129,0.5)]' : 'bg-destructive shadow-[0_0_5px_rgba(239,68,68,0.5)]'}`} />
                        {testResult.brokerStatus}
                      </div>
                    </div>
                    <div className="space-y-1.5 p-3 rounded-lg bg-card border shadow-sm">
                      <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Subscription</div>
                      <div className="font-mono text-sm font-semibold flex items-center gap-2 truncate">
                        <div className={`w-2 h-2 rounded-full flex-none ${testResult.subscriptionStatus === 'active' ? 'bg-emerald-500 shadow-[0_0_5px_rgba(16,185,129,0.5)]' : 'bg-amber-500 shadow-[0_0_5px_rgba(245,158,11,0.5)]'}`} />
                        {testResult.subscriptionStatus}
                      </div>
                    </div>
                    <div className="space-y-1.5 p-3 rounded-lg bg-card border shadow-sm">
                      <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Device Health</div>
                      <div className="font-mono text-sm font-semibold flex items-center gap-2 truncate">
                        {testResult.deviceStatus === 'live' ? (
                          <><div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_5px_rgba(16,185,129,0.5)] flex-none" /> LIVE</>
                        ) : (
                          <><div className="w-2 h-2 rounded-full bg-muted-foreground flex-none" /> {testResult.deviceStatus.toUpperCase()}</>
                        )}
                      </div>
                    </div>
                    <div className="space-y-1.5 p-3 rounded-lg bg-card border shadow-sm">
                      <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Data Quality</div>
                      <div className="font-mono text-[11px] font-semibold flex items-center gap-1.5 truncate">
                         {testResult.dataQuality === 'source-backed' ? (
                          <span className="text-emerald-500 flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5 flex-none" /> SOURCE-BACKED</span>
                        ) : testResult.dataQuality === 'received-unprocessed' ? (
                          <span className="text-amber-500 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5 flex-none" /> UNPROCESSED</span>
                        ) : (
                          <span className="text-muted-foreground flex items-center gap-1"><Radio className="w-3.5 h-3.5 flex-none" /> {testResult.dataQuality.toUpperCase()}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Metrics */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-6 pt-4 border-t border-border/50">
                    <div className="space-y-1">
                      <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Messages Rx</div>
                      <div className="font-mono text-3xl tracking-tighter text-foreground">{testResult.messageCount}</div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Frequency</div>
                      <div className="font-mono text-3xl tracking-tighter text-foreground">
                        {testResult.dataFrequencySeconds ? `${testResult.dataFrequencySeconds}s` : '--'}
                      </div>
                    </div>
                    <div className="space-y-1 md:col-span-2">
                      <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Topic Path</div>
                      <div className="font-mono text-xs bg-muted/50 border px-3 py-2 rounded-md inline-block text-foreground truncate max-w-full shadow-inner mt-1 w-full" title={testResult.topic}>
                        {testResult.topic}
                      </div>
                    </div>
                  </div>

                  {/* Payload */}
                  <div className="space-y-2.5 pt-4 border-t border-border/50">
                    <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest flex items-center justify-between">
                      Actual Value Received
                      {testResult.lastReceivedAt && (
                        <span className="normal-case font-mono font-normal tracking-normal text-xs text-muted-foreground">
                          {format(new Date(testResult.lastReceivedAt), "HH:mm:ss.SSS")}
                        </span>
                      )}
                    </div>
                    <div className="bg-[#0f172a] dark:bg-black rounded-lg p-4 font-mono text-xs text-emerald-400 overflow-x-auto shadow-inner border border-slate-800 max-h-[180px] custom-scrollbar">
                      {renderPayload(testResult.actualValue)}
                    </div>
                  </div>

                  {/* Errors */}
                  {testResult.communicationErrors.length > 0 && (
                    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 mt-6 shadow-sm">
                      <div className="flex items-center gap-2 text-destructive font-semibold mb-3 text-sm">
                        <AlertTriangle className="w-4 h-4" />
                        Communication Errors ({testResult.communicationErrors.length})
                      </div>
                      <ul className="space-y-2">
                        {testResult.communicationErrors.map((err, i) => (
                          <li key={i} className="text-[11px] font-mono text-destructive/90 flex items-start gap-2 bg-destructive/10 p-2 rounded">
                            <ChevronRight className="w-3.5 h-3.5 shrink-0 mt-0 opacity-60" />
                            <span className="leading-relaxed">{err}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <div className="h-full min-h-[420px] flex flex-col items-center justify-center text-center p-8 text-muted-foreground">
                  <div className="w-20 h-20 rounded-full bg-muted/50 border flex items-center justify-center mb-6 shadow-inner relative">
                    <div className="absolute inset-0 rounded-full border-2 border-primary/20 animate-ping opacity-20" style={{ animationDuration: '3s' }}></div>
                    <Radio className="w-10 h-10 text-primary/40" />
                  </div>
                  <h3 className="text-xl font-medium text-foreground mb-2">Awaiting Telemetry</h3>
                  <p className="max-w-md text-sm text-muted-foreground leading-relaxed">
                    Select a managed site and device, then run a test to observe live MQTT ingress data and confirm connectivity before mapping parameters.
                  </p>
                </div>
              )}
            </CardContent>
            
            {testResult && (
              <div className="bg-muted/30 border-t px-6 py-2.5 text-[10px] text-muted-foreground font-mono flex justify-between uppercase tracking-wider">
                <span>TEST_ID: {testResult.id.substring(0, 8)}...</span>
                <span>
                  WINDOW: {format(new Date(testResult.startedAt), "HH:mm:ss")} - {format(new Date(testResult.finishedAt), "HH:mm:ss")}
                </span>
              </div>
            )}
          </Card>
        </div>
      </div>

      <MappingWorkspace siteName={selectedSiteName} deviceId={selectedDeviceId} />
    </div>
  )
}
