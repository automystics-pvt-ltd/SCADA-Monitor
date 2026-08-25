export type ScadaAccessState = {
  sites: string[];
  roles: Record<string, string>;
  global: boolean;
  loading: boolean;
  error: string;
};

export function dashboardAccessState(
  state: ScadaAccessState,
  selectedSite: string,
): "loading" | "ready" | "denied" | "unavailable" {
  if (state.loading) return "loading";
  if (state.error) return "unavailable";
  if (state.global || state.sites.includes(selectedSite)) return "ready";
  return "denied";
}