import { useState, useEffect, useRef } from "react";
import { format } from "date-fns";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock,
  Database as DatabaseIcon,
  Download,
  FileText,
  HardDrive,
  History,
  LayoutList,
  Play,
  Search,
  Table2,
  TerminalSquare,
  ChevronLeft,
  ChevronRight,
  DatabaseZap,
  ServerCrash
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import {
  useGetPlatformDatabaseHealth,
  useListPlatformDatabaseTables,
  useBrowsePlatformDatabaseTable,
  useGetPlatformDatabaseMigrations,
  useRunPlatformDatabaseQuery,
  getGetPlatformDatabaseHealthQueryKey,
} from "@workspace/api-client-react";

export default function Database() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground flex items-center gap-2">
          <DatabaseZap className="h-8 w-8 text-primary" />
          Platform Database
        </h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Isolated SCADA database operations. Monitor health, inspect schema migrations,
          browse approved records, and execute read-only exploratory queries safely.
        </p>
      </div>

      <Tabs defaultValue="health" className="w-full">
        <TabsList className="grid w-full grid-cols-3 mb-6 max-w-md">
          <TabsTrigger value="health" className="flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Health & Migrations
          </TabsTrigger>
          <TabsTrigger value="browse" className="flex items-center gap-2">
            <Table2 className="h-4 w-4" />
            Browse Data
          </TabsTrigger>
          <TabsTrigger value="query" className="flex items-center gap-2">
            <TerminalSquare className="h-4 w-4" />
            SQL Query
          </TabsTrigger>
        </TabsList>

        <TabsContent value="health" className="mt-0 outline-none">
          <HealthTab />
        </TabsContent>

        <TabsContent value="browse" className="mt-0 outline-none">
          <BrowseTab />
        </TabsContent>

        <TabsContent value="query" className="mt-0 outline-none">
          <QueryTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function HealthTab() {
  const { data: health, isLoading: healthLoading, error: healthError } = useGetPlatformDatabaseHealth({
    query: { queryKey: getGetPlatformDatabaseHealthQueryKey(), refetchInterval: 30000 }
  });
  const { data: migrations, isLoading: migrationsLoading } = useGetPlatformDatabaseMigrations();

  return (
    <div className="grid gap-6 md:grid-cols-2">
      {/* Health Overview */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            Database Health
          </CardTitle>
          <CardDescription>Real-time application database status and latency</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {healthError ? (
            <Alert variant="destructive">
              <ServerCrash className="h-4 w-4" />
              <AlertTitle>Health Check Failed</AlertTitle>
              <AlertDescription>
                Unable to contact the database health endpoint. The server may be down or unreachable.
              </AlertDescription>
            </Alert>
          ) : healthLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : health ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">Status</p>
                  <div className="flex items-center gap-2">
                    {health.status === 'ok' ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                    ) : (
                      <AlertCircle className="h-5 w-5 text-destructive" />
                    )}
                    <span className="text-lg font-semibold uppercase">{health.status}</span>
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">Latency</p>
                  <div className="flex items-center gap-2">
                    <Clock className="h-5 w-5 text-muted-foreground" />
                    <span className="text-lg font-semibold">{health.latencyMs} ms</span>
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">Database</p>
                  <div className="flex items-center gap-2">
                    <DatabaseIcon className="h-5 w-5 text-muted-foreground" />
                    <span className="text-sm font-medium">{health.database}</span>
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">Schema</p>
                  <div className="flex items-center gap-2">
                    <LayoutList className="h-5 w-5 text-muted-foreground" />
                    <span className="text-sm font-medium">{health.schema}</span>
                  </div>
                </div>
              </div>

              {health.message && (
                <div className="rounded-md bg-muted p-3">
                  <p className="text-sm">{health.message}</p>
                </div>
              )}
              
              <div className="text-xs text-muted-foreground">
                Last checked: {format(new Date(health.checkedAt), 'PPpp')}
              </div>
            </>
          ) : null}
        </CardContent>
        <CardFooter className="bg-muted/50 border-t p-6">
          <Button asChild variant="outline" className="w-full">
            <a href="/api/platform-admin/database/backup" download>
              <Download className="mr-2 h-4 w-4" />
              Download Application Audit Backup (JSON)
            </a>
          </Button>
        </CardFooter>
      </Card>

      {/* Migrations */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="h-5 w-5 text-primary" />
            Schema Readiness
          </CardTitle>
          <CardDescription>Application migrations and table verifications</CardDescription>
        </CardHeader>
        <CardContent>
          {migrationsLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : migrations ? (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">Status</p>
                  <Badge variant={migrations.status === 'ready' ? 'default' : 'destructive'} className="uppercase">
                    {migrations.status}
                  </Badge>
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">Tables Verified</p>
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-semibold">
                      {migrations.presentTables} / {migrations.expectedTables}
                    </span>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">Migration History</p>
                <ScrollArea className="h-[240px] rounded-md border">
                  <Table>
                    <TableHeader className="bg-muted/50 sticky top-0">
                      <TableRow>
                        <TableHead>Migration</TableHead>
                        <TableHead className="text-right">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {migrations.migrations.map((m) => (
                        <TableRow key={m.name}>
                          <TableCell className="font-mono text-xs">{m.name}</TableCell>
                          <TableCell className="text-right">
                            <Badge variant={m.status === 'present' ? 'outline' : m.status === 'missing' ? 'destructive' : 'secondary'} className="text-[10px]">
                              {m.status}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                      {migrations.migrations.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={2} className="text-center text-muted-foreground h-24">
                            No migrations tracked
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No migration data available.</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function BrowseTab() {
  const { data: tables, isLoading: tablesLoading } = useListPlatformDatabaseTables();
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  
  const browseTable = useBrowsePlatformDatabaseTable();
  const mutateRef = useRef(browseTable.mutate);
  mutateRef.current = browseTable.mutate;

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1); // Reset page on new search
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (selectedTable) {
      mutateRef.current({
        data: {
          tableName: selectedTable,
          page,
          pageSize,
          search: debouncedSearch || undefined,
        }
      });
    }
  }, [selectedTable, page, pageSize, debouncedSearch]);

  const rowsData = browseTable.data;
  const isFetchingRows = browseTable.isPending;

  return (
    <Card className="h-[700px] flex flex-col overflow-hidden">
      <div className="flex h-full">
        {/* Left sidebar - Tables List */}
        <div className="w-64 border-r flex flex-col bg-muted/20">
          <div className="p-4 border-b">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <DatabaseIcon className="h-4 w-4" />
              Tables
            </h3>
          </div>
          <ScrollArea className="flex-1">
            {tablesLoading ? (
              <div className="p-4 space-y-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : tables ? (
              <div className="p-2 space-y-1">
                {tables.map(t => (
                  <button
                    key={t.name}
                    onClick={() => {
                      setSelectedTable(t.name);
                      setPage(1);
                      setSearch("");
                    }}
                    className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                      selectedTable === t.name 
                        ? "bg-primary text-primary-foreground font-medium" 
                        : "hover:bg-muted text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <div className="flex justify-between items-center">
                      <span className="truncate">{t.label || t.name}</span>
                      <span className="text-xs opacity-70">{t.recordCount}</span>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="p-4 text-xs text-muted-foreground text-center">Failed to load tables</div>
            )}
          </ScrollArea>
        </div>

        {/* Right pane - Table Data */}
        <div className="flex-1 flex flex-col min-w-0 bg-background">
          {!selectedTable ? (
            <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
              <Table2 className="h-12 w-12 mb-4 opacity-20" />
              <p>Select a table to browse records</p>
            </div>
          ) : (
            <>
              {/* Header */}
              <div className="p-4 border-b flex items-center justify-between gap-4 bg-background z-10">
                <div>
                  <h3 className="font-semibold text-lg flex items-center gap-2">
                    {rowsData?.table?.label || selectedTable}
                  </h3>
                  {rowsData?.table?.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">{rowsData.table.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 max-w-sm w-full">
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input 
                      placeholder="Search records..." 
                      className="pl-9"
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              {/* Data Table */}
              <div className="flex-1 overflow-auto relative">
                {isFetchingRows && (
                  <div className="absolute inset-0 bg-background/50 backdrop-blur-sm z-20 flex items-center justify-center">
                    <div className="flex items-center gap-2 bg-card border rounded-md px-4 py-2 shadow-sm text-sm font-medium">
                      <Activity className="h-4 w-4 animate-spin text-primary" />
                      Loading records...
                    </div>
                  </div>
                )}
                
                <Table>
                  <TableHeader className="sticky top-0 bg-muted/90 backdrop-blur-sm z-10">
                    <TableRow>
                      {rowsData?.table?.columns?.map(c => (
                        <TableHead key={c.name} className="whitespace-nowrap font-semibold">
                          {c.name}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rowsData?.rows?.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={rowsData?.table?.columns?.length || 1} className="text-center h-32 text-muted-foreground">
                          No records found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      rowsData?.rows?.map((row, i) => (
                        <TableRow key={i} className="hover:bg-muted/30 transition-colors">
                          {rowsData.table.columns.map(c => (
                            <TableCell key={c.name} className="whitespace-nowrap max-w-[300px] truncate text-sm">
                              {row[c.name] === null ? (
                                <span className="text-muted-foreground/50 italic">null</span>
                              ) : typeof row[c.name] === 'object' ? (
                                <span className="font-mono text-xs">{JSON.stringify(row[c.name])}</span>
                              ) : (
                                String(row[c.name])
                              )}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              {rowsData && (
                <div className="p-3 border-t bg-muted/20 flex items-center justify-between text-sm">
                  <div className="text-muted-foreground">
                    Showing <span className="font-medium text-foreground">{(rowsData.page - 1) * rowsData.pageSize + (rowsData.rows.length > 0 ? 1 : 0)}</span> to <span className="font-medium text-foreground">{(rowsData.page - 1) * rowsData.pageSize + rowsData.rows.length}</span> of <span className="font-medium text-foreground">{rowsData.totalRecords}</span> records
                  </div>
                  <div className="flex items-center gap-2">
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                      disabled={page === 1 || isFetchingRows}
                    >
                      <ChevronLeft className="h-4 w-4 mr-1" />
                      Prev
                    </Button>
                    <div className="text-muted-foreground w-16 text-center text-xs">
                      Page {page}
                    </div>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => setPage(p => p + 1)}
                      disabled={page * pageSize >= rowsData.totalRecords || isFetchingRows}
                    >
                      Next
                      <ChevronRight className="h-4 w-4 ml-1" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

function QueryTab() {
  const [query, setQuery] = useState("");
  const runQuery = useRunPlatformDatabaseQuery();
  const { toast } = useToast();

  const handleRunQuery = () => {
    if (!query.trim()) return;
    runQuery.mutate({ data: { query } }, {
      onError: (err: any) => {
        toast({
          title: "Query Error",
          description: err?.message || "Failed to execute query.",
          variant: "destructive"
        });
      }
    });
  };

  const result = runQuery.data;
  const isRunning = runQuery.isPending;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {/* Editor */}
      <Card className="lg:col-span-1 flex flex-col">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TerminalSquare className="h-5 w-5 text-primary" />
            Query Editor
          </CardTitle>
          <CardDescription>One approved table, selected columns, optional LIMIT</CardDescription>
        </CardHeader>
        <CardContent className="flex-1 flex flex-col">
          <textarea
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="SELECT * FROM users LIMIT 10"
            className="flex-1 min-h-[300px] w-full rounded-md border bg-muted/30 p-4 font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary"
            spellCheck={false}
          />
        </CardContent>
        <CardFooter className="border-t bg-muted/20 p-4">
          <Button 
            className="w-full" 
            onClick={handleRunQuery}
            disabled={!query.trim() || isRunning}
          >
            {isRunning ? (
              <Activity className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            Execute Query
          </Button>
        </CardFooter>
      </Card>

      {/* Results */}
      <Card className="lg:col-span-2 flex flex-col min-h-[500px]">
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center justify-between">
            <span>Results</span>
            {result && (
              <Badge variant="secondary" className="font-mono text-xs">
                {result.durationMs}ms
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <div className="flex-1 overflow-auto border-t bg-background relative">
          {!result && !isRunning && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground opacity-50 p-6 text-center">
              <TerminalSquare className="h-12 w-12 mb-4" />
              <p>Write a query and hit Execute to view results.</p>
              <p className="text-xs mt-2">Only SELECT statements are permitted.</p>
            </div>
          )}
          
          {isRunning && (
            <div className="absolute inset-0 bg-background/50 backdrop-blur-sm z-20 flex items-center justify-center">
              <div className="flex flex-col items-center gap-3">
                <Activity className="h-8 w-8 animate-spin text-primary" />
                <span className="text-sm font-medium">Executing...</span>
              </div>
            </div>
          )}

          {result && (
            <>
              {result.truncated && (
                <div className="bg-accent text-accent-foreground px-4 py-2 text-xs flex items-center gap-2 border-b">
                  <AlertCircle className="h-3 w-3" />
                  Results truncated to maximum allowed row count.
                </div>
              )}
              <Table>
                <TableHeader className="sticky top-0 bg-muted/90 backdrop-blur-sm z-10 shadow-sm">
                  <TableRow>
                    {result.columns.map(c => (
                      <TableHead key={c} className="whitespace-nowrap font-mono text-xs">
                        {c}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={result.columns.length} className="text-center h-24 text-muted-foreground">
                        No rows returned
                      </TableCell>
                    </TableRow>
                  ) : (
                    result.rows.map((row, i) => (
                      <TableRow key={i} className="hover:bg-muted/30">
                        {result.columns.map(c => (
                          <TableCell key={c} className="whitespace-nowrap max-w-[400px] truncate text-sm font-mono">
                            {row[c] === null ? (
                              <span className="text-muted-foreground/50 italic">null</span>
                            ) : typeof row[c] === 'object' ? (
                              JSON.stringify(row[c])
                            ) : (
                              String(row[c])
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </>
          )}
        </div>
        {result && (
          <div className="p-3 border-t bg-muted/20 text-xs text-muted-foreground flex justify-between">
            <span>Returned {result.rowCount} rows</span>
            <span>Columns: {result.columns.length}</span>
          </div>
        )}
      </Card>
    </div>
  );
}
