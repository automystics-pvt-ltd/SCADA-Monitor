import { useState } from "react"
import { Link, useLocation } from "wouter"
import { useTheme } from "@/components/theme-provider"
import { cn } from "@/lib/utils"
import {
  Activity,
  Building2,
  Database,
  KeyRound,
  Key,
  LayoutDashboard,
  LogOut,
  Mail,
  MapPin,
  Moon,
  Radio,
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
  { name: "User Access", href: "/access", icon: Key },
  { name: "Platform Health", href: "/platform", icon: Server },
  { name: "Telemetry", href: "/telemetry", icon: Radio },
  { name: "Database", href: "/database", icon: Database },
  { name: "Audit Log", href: "/audit", icon: ShieldAlert },
]

type OtpResponse = {
  challengeId?: string
  message?: string
  ok?: boolean
}

function PlatformAdminSignIn({ theme, setTheme }: { theme: string; setTheme: (theme: "light" | "dark") => void }) {
  const [email, setEmail] = useState("")
  const [code, setCode] = useState("")
  const [challengeId, setChallengeId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const access = new URLSearchParams(window.location.search).get("access")

  const requestCode = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch("/api/platform-admin/otp/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      })
      const data = await response.json().catch(() => ({})) as OtpResponse
      if (!response.ok || !data.challengeId) {
        throw new Error(data.message || "We could not send a sign-in code. Please try again.")
      }
      setChallengeId(data.challengeId)
      setNotice(data.message || "A one-time code was sent to your administrator email.")
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "We could not send a sign-in code. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  const verifyCode = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!challengeId) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch("/api/platform-admin/otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, challengeId, code }),
      })
      const data = await response.json().catch(() => ({})) as OtpResponse
      if (!response.ok || !data.ok) {
        throw new Error(data.message || "That sign-in code could not be verified.")
      }
      window.location.assign("/platform-admin/")
    } catch (verificationError) {
      setError(verificationError instanceof Error ? verificationError.message : "That sign-in code could not be verified.")
    } finally {
      setBusy(false)
    }
  }

  const resetOtp = () => {
    setChallengeId(null)
    setCode("")
    setError(null)
    setNotice(null)
  }

  return (
    <div className="min-h-[100dvh] overflow-y-auto bg-gradient-to-br from-background via-background to-muted/40 px-4 py-6 sm:px-6 sm:py-8">
      <div className="mx-auto flex min-h-[calc(100dvh-3rem)] max-w-md items-center py-2 sm:min-h-[calc(100dvh-4rem)]">
        <section className="w-full rounded-2xl border border-border bg-card p-6 shadow-xl shadow-black/10 sm:p-8">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-primary/10 p-2.5 text-primary">
                <KeyRound className="h-6 w-6" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">SCADA Platform</p>
                <h1 className="mt-0.5 text-xl font-bold tracking-tight text-foreground">Administrator sign in</h1>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              className="rounded-md border border-border p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label={theme === "dark" ? "Use light mode" : "Use dark mode"}
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>

          <p className="mt-5 text-sm leading-6 text-muted-foreground">
            Use your approved Google account or receive a one-time code at your provisioned administrator email.
          </p>

          {access === "denied" && <p role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">This Google account is not approved for Platform Admin access.</p>}
          {access === "retry" && <p role="alert" className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">Google sign-in could not be completed. Please try again.</p>}

          <a
            href="/api/platform-admin/google/login?returnTo=/platform-admin/"
            className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 fill-current"><path d="M21.35 12.28c0-.78-.07-1.53-.2-2.25H12v4.26h5.23a4.47 4.47 0 0 1-1.94 2.93v2.77h3.15c1.84-1.7 2.91-4.2 2.91-7.71Z" /><path d="M12 21.75c2.62 0 4.82-.87 6.43-2.36l-3.15-2.77c-.87.58-1.99.92-3.28.92-2.52 0-4.66-1.7-5.42-3.99H3.32v2.86A9.72 9.72 0 0 0 12 21.75Z" /><path d="M6.58 13.55A5.85 5.85 0 0 1 6.28 12c0-.54.09-1.07.3-1.55V7.59H3.32A9.74 9.74 0 0 0 2.25 12c0 1.57.38 3.06 1.07 4.41l3.26-2.86Z" /><path d="M12 6.46c1.43 0 2.71.49 3.72 1.45l2.79-2.79C16.81 3.53 14.62 2.25 12 2.25a9.72 9.72 0 0 0-8.68 5.34l3.26 2.86c.76-2.29 2.9-3.99 5.42-3.99Z" /></svg>
            Continue with Google
          </a>

          <div className="my-6 flex items-center gap-3 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground"><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div>

          {!challengeId ? (
            <form onSubmit={requestCode} className="space-y-3">
              <label className="block text-sm font-medium text-foreground">Administrator email
                <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required placeholder="admin@company.com" aria-label="Administrator email" className="mt-1.5 h-12 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20" />
              </label>
              <button type="submit" disabled={busy} aria-busy={busy} className="flex h-12 w-full items-center justify-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-4 text-sm font-semibold text-primary transition hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-60">
                <Mail className="h-4 w-4" />{busy ? "Sending code…" : "Email me a sign-in code"}
              </button>
            </form>
          ) : (
            <form onSubmit={verifyCode} className="space-y-3">
              <label className="block text-sm font-medium text-foreground">Six-digit code
                <input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" required placeholder="000000" aria-label="Six-digit verification code" className="mt-1.5 h-12 w-full rounded-lg border border-input bg-background px-3 text-center font-mono text-lg tracking-[0.4em] outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20" />
              </label>
              <button type="submit" disabled={busy || code.length !== 6} aria-busy={busy} className="flex h-12 w-full items-center justify-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60">
                {busy ? "Verifying…" : "Verify and sign in"}
              </button>
              <button type="button" onClick={resetOtp} className="w-full text-sm font-medium text-muted-foreground hover:text-foreground">Use a different email</button>
            </form>
          )}

          {notice && <p role="status" className="mt-4 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">{notice}</p>}
          {error && <p role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <p className="mt-5 text-center text-xs leading-5 text-muted-foreground">Only active, pre-provisioned Platform Admin accounts can complete either sign-in method.</p>
        </section>
      </div>
    </div>
  )
}

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

  if (!authUser?.admin) return <PlatformAdminSignIn theme={theme} setTheme={setTheme} />

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
