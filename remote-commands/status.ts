import type {SSHConnectionStatus} from '@anikitenko/fdo-sdk';
export type MonitorSnapshot = {active: boolean; observation: SSHConnectionStatus | null; error: string};

/** Freshness is recomputed in the view even if polling or the host feed stalls. */
export function describeStatus(snapshot: MonitorSnapshot | null, now = Date.now()) {
  const observation = snapshot?.observation;
  const checked = observation?.checkedAt ? Date.parse(observation.checkedAt) : NaN;
  const stamp = Number.isFinite(checked) ? `Observed ${new Date(checked).toLocaleTimeString()}` : 'No authenticated observation yet';
  if (!snapshot?.active) return {label: 'SSH status unknown', detail: snapshot?.error || `${stamp} · monitoring inactive`, tone: ''};
  if (!observation || !Number.isFinite(checked)) return {label: 'SSH status unknown', detail: stamp, tone: ''};
  if (checked > now + 1000) return {label: 'SSH status unknown', detail: 'Host observation is in the future; check clock synchronization.', tone: ''};
  if (now - checked >= observation.staleAfterMs) return {label: 'SSH status stale', detail: `${stamp} · waiting for a fresh observation`, tone: ''};
  const names = {unknown: 'SSH status unknown', connecting: 'SSH connecting', connected: 'SSH connected', disconnected: 'SSH disconnected'};
  return {label: names[observation.state], detail: `${stamp} · fresh`, tone: observation.state === 'connected' ? 'rc-ok' : observation.state === 'disconnected' ? 'rc-error' : ''};
}
