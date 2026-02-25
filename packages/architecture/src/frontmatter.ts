export function parseFrontmatter(content: string): Record<string, any> {
  if (!content.startsWith("---")) return {};
  const closingIdx = content.indexOf("---", 3);
  if (closingIdx === -1) return {};

  const yaml = content.slice(3, closingIdx).trim();
  const result: Record<string, any> = {};

  for (const line of yaml.split("\n")) {
    const match = line.match(/^(\w[\w-]*):\s*(.+)$/);
    if (!match) continue;

    const key = match[1];
    let value: any = match[2].trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1);
      value = inner
        .split(",")
        .map((s: string) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }

    result[key] = value;
  }

  return result;
}

export function extractFrontmatterBody(content: string): string {
  if (!content.startsWith("---")) return content;
  const closingIdx = content.indexOf("---", 3);
  if (closingIdx === -1) return content;
  return content.slice(closingIdx + 3).trim();
}

export function parseTopicsFromFrontmatter(content: string): string[] {
  if (!content.startsWith("---")) return [];
  const closingIdx = content.indexOf("---", 3);
  if (closingIdx === -1) return [];

  const fromFlatParser = parseFrontmatter(content).topics;
  if (Array.isArray(fromFlatParser)) {
    return fromFlatParser
      .map((topic) => String(topic).trim())
      .filter(Boolean);
  }
  if (typeof fromFlatParser === "string" && fromFlatParser.trim()) {
    return [fromFlatParser.trim().replace(/^["']|["']$/g, "")];
  }

  const yaml = content.slice(3, closingIdx).trim();
  const lines = yaml.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const topicsMatch = lines[i].match(/^\s*topics:\s*(.*)$/);
    if (!topicsMatch) continue;

    const inline = topicsMatch[1].trim();
    if (inline.length > 0) {
      if (inline.startsWith("[") && inline.endsWith("]")) {
        return inline
          .slice(1, -1)
          .split(",")
          .map((part) => part.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      }
      return [inline.replace(/^["']|["']$/g, "")].filter(Boolean);
    }

    const items: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const itemMatch = lines[j].match(/^\s*-\s*(.+)$/);
      if (itemMatch) {
        items.push(itemMatch[1].trim().replace(/^["']|["']$/g, ""));
        continue;
      }

      if (items.length === 0 && lines[j].trim() === "") continue;
      break;
    }

    return items;
  }

  return [];
}

export function loadVocabulary(content: string): Record<string, string> {
  const frontmatterMatch = content.match(/^---\n([\s\S]+?)\n---/);
  if (!frontmatterMatch) return {};

  const yaml = frontmatterMatch[1];
  const vocab: Record<string, string> = {};

  const vocabParts = yaml.split(/^vocabulary:\n/m);
  if (vocabParts.length > 1) {
    for (const line of vocabParts[1].split("\n")) {
      if (line.length > 0 && !/^[ \t]/.test(line)) break;
      const m = line.match(/^[ \t]+(\w+):\s*(.+)$/);
      if (!m) continue;
      let value = m[2].trim().replace(/^["']|["']$/g, "");

      // Strip leading slash if present (e.g. "/surface" -> "surface")
      if (value.startsWith("/")) {
        value = value.substring(1);
      }

      if (
        value.startsWith("-") ||
        value.startsWith("[") ||
        value.startsWith("{")
      ) {
        continue;
      }
      vocab[m[1]] = value;
    }
  }

  return vocab;
}
