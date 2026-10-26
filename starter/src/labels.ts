export const normalizeLabels = (xs: string[]) => [
  ...new Set(xs.map((x) => x.trim()).filter(Boolean)),
];
