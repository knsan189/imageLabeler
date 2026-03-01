export function parsePositivePrompt(prompt: string): string {
  const temp = prompt.split(/Negative prompt:/i)[0];
  const positive = temp
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return positive.join(",");
}

export function parsePositivePromptLabels(positivePrompt: string): string[] {
  return positivePrompt
    .split(",")
    .map(cleanToken)
    .flatMap((label) => label.split("|"))
    .filter(Boolean);
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
    .replace(/:\d+(\.\d+)?/g, "")
    .replaceAll(".", "")
    .replace(/\(.*?:.*?\)/g, "")
    .replace(/[()[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}
