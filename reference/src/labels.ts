export const normalizeLabels = (xs: string[]) => [
  ...new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean)),
];
