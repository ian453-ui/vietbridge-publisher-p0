import { ingestDocxContentBundle } from "./docx-content-ingestor.ts";

const [source, target, driveFileId, driveFolderId] = process.argv.slice(2);
if (!source || !target) throw new Error("用法: node src/ingest-docx-cli.ts <bundle.docx> <content-root> [drive-file-id] [drive-folder-id]");
console.log(JSON.stringify(ingestDocxContentBundle(source, target, { driveFileId, driveFolderId }), null, 2));
