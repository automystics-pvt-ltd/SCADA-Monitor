import { Link, useLocation } from "wouter"
import { useTheme } from "@/components/theme-provider"
import { cn } from "@/lib/utils"
import {
  Activity,
  Building2,
  Database,
  Key,
  LayoutDashboard,
  LogOut,
  MapPin,
  Moon,
  Server,
  Sun,
  ShieldAlert,
  User,
} from "lucide-react"
import {
  getHealthCheckQueryKey,
  useGetPlatformAdminAuthUser,
  useHealthCheck,
} from "@workspace/api-client-react"

const navigation = [
  { name: "Overview", href: "/", icon: LayoutDashboard },
  { name: "Organizations", href: "/organizations", icon: Building2 },
  { name: "Sites", href: "/sites", icon: MapPin },
  { name: "Access Grants", href: "/access", icon: Key },
  { name: "Platform Health", href: "/platform", icon: Server },
  { name: "Database", href: "/database", icon: Database },
  { name: "Audit Log", href: "/audit", icon: ShieldAlert },
]

export function Shell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation()
  const { theme, setTheme } = useTheme()
  const { data: authUser, isLoading: isAuthLoading } = useGetPlatformAdminAuthUser()
  const { data: health } = useHealthCheck(
    { query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 30000 } }
  )

  if (isAuthLoading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background">
        <Activity className="h-8 w-8 text-primary animate-pulse" />
      </div>
    )
  }

  // If not admin, you could redirect or show access denied, 
  // assuming API gate handles it but we can show a nice state.
  if (authUser && !authUser.admin) {
    return (
      <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-background text-center p-4">
        <ShieldAlert className="h-12 w-12 text-destructive mb-4" />
        <h1 className="text-2xl font-bold tracking-tight mb-2">Access Denied</h1>
        <p className="text-muted-foreground max-w-md">
          {authUser.user
            ? `Your account (${authUser.user.email}) does not have platform administrator privileges.`
            : "Sign in with an email that is included in the server-managed platform administrator allowlist."}
        </p>
        <a
          href="/api/platform-admin/login?returnTo=/platform-admin/"
          className="mt-6 inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          Sign in as platform admin
        </a>
        <button
          type="button"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="mt-3 inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium text-foreground hover:bg-muted"
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          {theme === "dark" ? "Use light mode" : "Use dark mode"}
        </button>
      </div>
    )
  }

  return (
    <div className="min-h-[100dvh] flex flex-col md:flex-row bg-background">
      {/* Sidebar */}
      <aside className="w-full md:w-64 flex-shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground flex flex-col">
        <div className="h-16 flex items-center px-6 border-b border-sidebar-border">
          <Activity className="h-6 w-6 text-sidebar-primary mr-3" />
          <span className="font-semibold tracking-tight text-lg">SCADA Admin</span>
        </div>
        
        <div className="p-4 flex-1 flex flex-col gap-1 overflow-y-auto">
          <div className="flex-1 space-y-1">
            {navigation.map((item) => {
              const isActive = location === item.href
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  {item.name}
                </Link>
              )
            })}
          </div>
        </div>

        <div className="p-4 border-t border-sidebar-border space-y-4">
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="bg-sidebar-accent rounded-full p-1.5 flex-shrink-0">
              <User className="h-4 w-4 text-sidebar-accent-foreground" />
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-medium truncate">
                {authUser?.user?.name || 'Administrator'}
              </span>
              <span className="text-xs text-sidebar-foreground/60 truncate">
                {authUser?.user?.email || 'admin@platform'}
              </span>
            </div>
          </div>
          
          <div className="space-y-1">
            <button
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              {theme === "dark" ? "Light Mode" : "Dark Mode"}
            </button>
            <a
              href="/api/platform-admin/logout?returnTo=/platform-admin/"
              className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
            >
              <LogOut className="h-4 w-4" />
              Sign Out
            </a>
          </div>

          <div className="px-3 pt-2 flex items-center justify-between text-xs text-sidebar-foreground/50">
            <span>API Status</span>
            <div className="flex items-center gap-1.5">
              <div className={cn(
                "w-2 h-2 rounded-full",
                health?.status === 'ok' ? "bg-emerald-500" : "bg-destructive animate-pulse"
              )} />
              <span className="uppercase">{health?.status || 'check'}</span>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="flex-1 overflow-y-auto p-6 md:p-8">
          <div className="mx-auto max-w-6xl">
            {children}
          </div>
        </div>
      </main>
    </div>
  )
}
