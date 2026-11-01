// Shared readers for the simulator records (`d` = /status, /telemetry, /log ...). One definition each; the simulation pages import them from here.
export const lastOf = (log, kind) => [...(log || [])].reverse().find((l) => l.kind === kind);
export const isPhysOf = (d) => !!(
  d?.status?.mode === 'PHYSICAL' ||
  d?.status?.provenance === 'MEASURED' ||
  d?.telemetry?.provenance === 'MEASURED' ||
  d?.status?.origin === 'physical_device' ||
  (Array.isArray(d?.telemetry) && d?.telemetry[0]?.provenance === 'MEASURED')
);
export const samplesOf = (d) => d.telemetry?.samples || [];
