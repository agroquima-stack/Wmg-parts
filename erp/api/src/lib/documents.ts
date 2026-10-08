export const digits = (s: string) => s.replace(/\D/g, '');

export function isValidCPF(raw: string): boolean {
  const c = digits(raw);
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  for (const n of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(c[i]) * (n + 1 - i);
    const d = ((sum * 10) % 11) % 10;
    if (d !== Number(c[n])) return false;
  }
  return true;
}

export function isValidCNPJ(raw: string): boolean {
  const c = digits(raw);
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  for (const n of [12, 13]) {
    const w = n === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
    const sum = w.reduce((a, wi, i) => a + Number(c[i]) * wi, 0);
    const r = sum % 11;
    const d = r < 2 ? 0 : 11 - r;
    if (d !== Number(c[n])) return false;
  }
  return true;
}
