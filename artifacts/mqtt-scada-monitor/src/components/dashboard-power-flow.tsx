import type { CSSProperties } from 'react';
import { inverterFlowState, type InverterFlowProvenance, type InverterFlowQuality, type InverterFlowStatus } from '../inverter-flow-state';

type DashboardPowerFlowProps = {
  mode: 'demo' | 'live';
  value: number | null;
  unit: string;
  quality: InverterFlowQuality;
  provenance?: InverterFlowProvenance;
  status: InverterFlowStatus;
  sourceLabel: string;
  observedAt?: string;
  observationLabel?: string;
  inverterCount?: number;
};

function formatFlowReading(value: number | null, unit: string) {
  if (value === null) return 'Awaiting data';
  const number = value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return unit ? `${number} ${unit}` : number;
}

export function DashboardPowerFlow({
  mode,
  value,
  unit,
  quality,
  provenance,
  status,
  sourceLabel,
  observedAt,
  observationLabel = 'Observed',
  inverterCount,
}: DashboardPowerFlowProps) {
  const flow = inverterFlowState({ value, quality, status, mode, provenance });
  const statusTone = provenance === 'snapshot' ? 'saved' : flow.rawLiveTelemetry ? 'raw' : flow.streaming ? 'active' : 'paused';
  const reading = formatFlowReading(value, unit);
  const timestampLabel = observedAt
    ? (() => {
      const parsed = new Date(observedAt);
      return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : observedAt;
    })()
    : 'Timestamp unavailable';
  const normalizedUnit = unit.trim().toLowerCase();
  const powerInKw = value === null || value <= 0 || quality === 'raw'
    ? 0
    : normalizedUnit === 'w'
      ? value / 1000
      : normalizedUnit === 'kw'
        ? value
        : normalizedUnit === 'mw'
        ? value * 1000
        : 0;
  const flowIntensity = flow.streaming ? Math.min(1, Math.max(0.16, Math.log10(1 + powerInKw) / 4)) : 0;
  const flowStyle = {
    '--dashboard-flow-speed': `${Math.max(0.48, 1.65 - flowIntensity * 1.1)}s`,
    '--dashboard-flow-opacity': `${0.48 + flowIntensity * 0.52}`,
    '--dashboard-flow-glow-opacity': `${flowIntensity * 0.28}`,
  } as CSSProperties;
  const inverterLabel = inverterCount
    ? `${inverterCount} inverter${inverterCount === 1 ? '' : 's'}`
    : 'Inverter';

  return (
    <section
      aria-label="Plant power-flow visualization"
      className="scada-dashboard-flow relative isolate overflow-hidden rounded-2xl border px-3 py-4 sm:px-5 sm:py-5"
      data-testid="dashboard-power-flow"
      data-flow-state={flow.streaming ? 'streaming' : value === 0 ? 'zero' : provenance === 'snapshot' ? 'saved' : 'paused'}
      data-stream-mode={mode}
      data-quality={quality}
      data-flow-provenance={provenance ?? 'unavailable'}
      style={flowStyle}
    >
      <div className="scada-dashboard-flow-grid pointer-events-none absolute inset-0" />
      <div className="scada-dashboard-flow-glow pointer-events-none absolute inset-0" />
      <div className="relative z-10 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">Plant energy lane</p>
          <p className="mt-1 text-sm font-bold text-slate-100">
            {mode === 'demo'
              ? 'Demo power flow'
              : provenance === 'snapshot'
                ? 'Last saved power record'
              : flow.rawLiveTelemetry
                ? 'Live raw telemetry stream'
                : quality === 'raw'
                  ? 'Raw source-tag evidence'
                  : flow.streaming
                    ? 'Live broker power flow'
                    : 'Power flow awaiting fresh telemetry'}
          </p>
        </div>
        <span className={`scada-dashboard-flow-state scada-dashboard-flow-state--${statusTone}`}>
          <span className="scada-dashboard-flow-state-dot" />
          {flow.statusLabel}
        </span>
      </div>

      <div className="relative z-10 mt-3 h-[180px] sm:h-[225px] lg:h-[255px]">
        <svg viewBox="0 0 1000 280" role="img" aria-label={`Power movement from solar array through inverter to grid: ${reading}`} className="h-full w-full">
          <path d="M300 120 H425 Q450 120 450 147 V158" fill="none" className={flow.streaming ? 'dashboard-flow-path' : ''} stroke={flow.streaming ? '#00E5FF' : 'var(--dashboard-flow-idle)'} strokeDasharray={flow.streaming ? '14 9' : undefined} strokeWidth="5" strokeLinecap="round" />
          <path d="M550 158 V147 Q550 120 575 120 H782" fill="none" className={flow.streaming ? 'dashboard-flow-path dashboard-flow-path-delayed' : ''} stroke={flow.streaming ? '#00E5FF' : 'var(--dashboard-flow-idle)'} strokeDasharray={flow.streaming ? '14 9' : undefined} strokeWidth="5" strokeLinecap="round" />
          <path d="M500 212 V244 H340" fill="none" stroke="var(--dashboard-flow-idle)" strokeWidth="3.5" strokeLinecap="round" />

          <g transform="translate(66 34)">
            <polygon points="0,59 143,0 238,47 96,109" fill="var(--dashboard-flow-node)" stroke="var(--dashboard-flow-stroke)" strokeWidth="2.5" />
            <image href="/assets/solar-array-accent.webp" x="10" y="6" width="218" height="91" preserveAspectRatio="xMidYMid slice" opacity=".7" style={{ clipPath: 'polygon(0 58%, 61% 0, 100% 45%, 40% 100%)' }} />
            <path d="M24 59 166 5M48 73 190 20M72 88 214 34M42 37 83 88M83 20 125 72M124 4 166 56M165 -12 207 40" stroke="var(--dashboard-flow-grid-stroke)" strokeWidth="1.7" opacity=".8" />
            <path d="M96 109 v43 M166 81 v52 M84 152 h95" stroke="var(--dashboard-flow-stroke)" strokeWidth="3.5" strokeLinecap="round" />
            <rect x="128" y="78" width="17" height="10" rx="2" fill="var(--dashboard-flow-grid-stroke)" opacity=".8" />
          </g>

          <g transform="translate(457 138)">
            <rect width="86" height="86" rx="13" fill="var(--dashboard-flow-inverter)" stroke="#00E5FF" strokeWidth="3" filter="drop-shadow(0 0 9px rgba(0,229,255,0.32))" />
            <rect x="15" y="15" width="56" height="28" rx="5" fill="var(--dashboard-flow-node)" stroke="var(--dashboard-flow-idle)" />
            <path d="M23 28h40" stroke="var(--dashboard-flow-grid-stroke)" strokeWidth="1.5" opacity=".7" />
            <circle cx="43" cy="63" r="8" className={flow.streaming ? 'scada-flow-live-beacon' : undefined} fill={flow.rawLiveTelemetry ? '#F59E0B' : flow.streaming ? '#00F2A6' : 'var(--dashboard-flow-stroke)'} />
            <path d="M37 76 h12" stroke="var(--dashboard-flow-stroke)" strokeWidth="2.5" strokeLinecap="round" />
          </g>

          <g transform="translate(790 12)">
            <path d="M52 0 0 207h104L52 0Zm0 29 28 157H24L52 29Z" fill="var(--dashboard-flow-node)" stroke="var(--dashboard-flow-stroke)" strokeWidth="2.5" />
            <path d="M15 143h74M24 105h56M34 70h36M52 29v157M24 186l56-81M80 186 24 105" stroke="var(--dashboard-flow-grid-stroke)" strokeWidth="2" />
            <path d="M-18 54h140M-5 54l-21 29M109 54l21 29" stroke="var(--dashboard-flow-stroke)" strokeWidth="3.5" strokeLinecap="round" />
            <path d="M10 207h84" stroke="var(--dashboard-flow-stroke)" strokeWidth="4" strokeLinecap="round" />
            <circle cx="-22" cy="83" r="4" fill="#FF5C00" opacity=".7" />
            <circle cx="126" cy="83" r="4" fill="#00E5FF" opacity=".7" />
          </g>

          <g transform="translate(205 150)">
            <path d="M0 44 70 0l70 44v76H0V44Z" fill="var(--dashboard-flow-inverter)" stroke="var(--dashboard-flow-stroke)" strokeWidth="2.5" />
            <path d="M-10 44 70 -9l80 53" fill="none" stroke="var(--dashboard-flow-grid-stroke)" strokeWidth="4" strokeLinecap="round" />
            <path d="M108 16V-6h18v34" fill="var(--dashboard-flow-node)" stroke="var(--dashboard-flow-stroke)" strokeWidth="2" />
            <rect x="22" y="67" width="27" height="53" rx="2" fill="var(--dashboard-flow-node)" stroke="var(--dashboard-flow-idle)" />
            <path d="M45 94h4" stroke="var(--dashboard-flow-stroke)" strokeWidth="2" />
            <rect x="83" y="68" width="29" height="25" rx="2" fill="var(--dashboard-flow-node)" stroke="var(--dashboard-flow-idle)" />
            <path d="M97 68v25M83 80h29" stroke="var(--dashboard-flow-idle)" strokeWidth="1.5" />
            <rect x="82" y="96" width="31" height="24" rx="2" fill="#FF5C00" opacity=".4" />
          </g>

        </svg>
      </div>

      <div className="scada-dashboard-flow-label-grid relative z-10 grid grid-cols-2 gap-2 min-[640px]:grid-cols-4" aria-label="Plant energy lane equipment">
        <div className="scada-dashboard-flow-label scada-dashboard-flow-label--solar"><span className="scada-dashboard-flow-label-mark scada-dashboard-flow-label-mark--solar" />Solar array</div>
        <div className="scada-dashboard-flow-label scada-dashboard-flow-label--load"><span className="scada-dashboard-flow-label-mark scada-dashboard-flow-label-mark--load" />Plant load</div>
        <div className="scada-dashboard-flow-label scada-dashboard-flow-label--inverter"><span className="scada-dashboard-flow-label-mark scada-dashboard-flow-label-mark--inverter" />{inverterLabel}</div>
        <div className="scada-dashboard-flow-label scada-dashboard-flow-label--grid"><span className="scada-dashboard-flow-label-mark scada-dashboard-flow-label-mark--grid" />Plant output / grid</div>
      </div>

      <div className="relative z-10 mt-2 grid grid-cols-1 gap-2 min-[480px]:grid-cols-2">
        <div className="scada-dashboard-flow-reading">
          <span>Actual AC power</span>
          <strong className={quality === 'raw' ? 'text-amber-300' : 'text-slate-100'}>{reading}</strong>
          <small>{observationLabel} {timestampLabel}</small>
        </div>
        <div className="scada-dashboard-flow-reading min-[480px]:text-right">
          <span>Telemetry source</span>
          <strong className={`block truncate ${quality === 'raw' ? 'text-amber-300' : 'text-slate-100'}`} title={sourceLabel}>{sourceLabel}</strong>
          <small>{inverterCount ? `${inverterLabel} contributing` : provenance === 'snapshot' ? 'Saved evidence — animation paused' : flow.streaming ? 'Fresh telemetry — animation active' : 'No fresh power flow'}</small>
        </div>
      </div>
    </section>
  );
}