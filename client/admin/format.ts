/** Formatting helpers shared by the admin console views. */
export const AMOUNT = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/;
export const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const short = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;
export const time = (ms: number) =>
  new Date(ms).toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
/** Display only: amounts are computed on the server in micro-units. */
export const coins = (micro: bigint) => {
  const s = (Number(micro) / 1e6).toLocaleString("ko-KR", {
    maximumFractionDigits: 6,
  });
  return `${s} CGC`;
};
export const toMicro = (a: string) =>
  AMOUNT.test(a)
    ? BigInt(a.split(".")[0]) * 1_000_000n +
      BigInt((a.split(".")[1] ?? "").padEnd(6, "0"))
    : 0n;
export const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;
