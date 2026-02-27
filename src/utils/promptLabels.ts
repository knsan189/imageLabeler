export function parsePositivePromptLabels(prompt: string): string[] {
  const positive = prompt.split(/Negative prompt:/i)[0];

  return positive.split(",").map(cleanToken).filter(Boolean);
}

export function cleanToken(token: string): string {
  return token
    .trim()
    .replace(/\(.*?:.*?\)/g, "")
    .replace(/[()[\]{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
