export type DocInlineAsset = {
  inlineObjectId: string;
  startIndex: number;
  contentUri?: string;
};

export function orderedInlineAssets(document: Record<string, any>): DocInlineAsset[] {
  const objects = document.inlineObjects ?? {};
  const found: DocInlineAsset[] = [];
  const visit = (value: any): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!value || typeof value !== "object") return;
    if (typeof value.inlineObjectElement?.inlineObjectId === "string") {
      const id = value.inlineObjectElement.inlineObjectId;
      const embedded = objects[id]?.inlineObjectProperties?.embeddedObject;
      found.push({ inlineObjectId: id, startIndex: Number(value.startIndex ?? Number.MAX_SAFE_INTEGER), contentUri: embedded?.imageProperties?.contentUri });
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(document.body?.content ?? document.tabs ?? []);
  return [...new Map(found.sort((a, b) => a.startIndex - b.startIndex).map(item => [item.inlineObjectId, item])).values()];
}

export function chooseAssetCandidate(options: { inline?: DocInlineAsset; driveFileId?: string; localPath?: string }): { source: "DOC_INLINE" | "DRIVE_MATCH" | "LOCAL_MATCH"; locator: string } | undefined {
  if (options.inline?.contentUri) return { source: "DOC_INLINE", locator: options.inline.contentUri };
  if (options.driveFileId) return { source: "DRIVE_MATCH", locator: options.driveFileId };
  if (options.localPath) return { source: "LOCAL_MATCH", locator: options.localPath };
  return undefined;
}

export function dedupeAssetCandidates<T extends { sha256: string }>(items: T[]): T[] {
  return [...new Map(items.map(item => [item.sha256, item])).values()];
}
