export function buildRecoveryVerdict(
  tool: string,
  errorType: string,
  attempts: number,
): string {
  return `✓ Recovered from ${attempts} failed \`${tool}:${errorType}\` attempts.`;
}
