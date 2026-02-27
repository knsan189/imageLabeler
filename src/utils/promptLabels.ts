export function parsePositivePromptLabels(prompt: string): string[] {
  const positive = prompt.split(/Negative prompt:/i)[0];
  return positive.split(",").map(cleanToken).filter(Boolean);
}

export function parseModelPromptLabel(prompt: string): string | null {
  const modelMatch = prompt.match(/(?:^|,\s*)Model:\s*([^,\n\r]+)/i);
  if (!modelMatch?.[1]) return null;

  const normalized = cleanToken(modelMatch[1]);
  if (!normalized) return null;

  return `${normalized}`;
}

export function cleanToken(token: string): string {
  return token
    .trim()
    .replaceAll(".", "")
    .replace(/\(.*?:.*?\)/g, "")
    .replace(/[()[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}
