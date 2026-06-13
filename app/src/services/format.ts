export function diamondCost(value: number, perUse = false): string {
  return `💎x${value}${perUse ? '/次' : ''}`;
}
