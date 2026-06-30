export function buildPromotionFragment(
  tool: string,
  errorType: string,
  failCount: number,
  model: string,
): string {
  const modelPart = model ? ` (model: ${model})` : "";
  return [
    `⚠️ STUCK DETECTED: \`${tool}:${errorType}\` failed ${failCount} consecutive times${modelPart}.`,
    `SWITCH TO DETAILED THINKING:`,
    `- Before running the next tool, verify you have the correct path.`,
    `- Try alternative approach: \`ls\` the directory, then re-read with correct path.`,
    `- If the tool output format has changed, check for updated parameters.`,
    `- Break complex commands into smaller steps.`,
  ].join("\n");
}
