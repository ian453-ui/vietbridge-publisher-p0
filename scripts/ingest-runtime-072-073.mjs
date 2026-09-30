import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestDocxContentBundle } from '../src/docx-content-ingestor.ts';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..');
const sourceDocx = join(project, 'input/20260923-072-073/canonical.docx');
const targetRoot = resolve(project, '../Content-Library/Drive-Batches/VBE-20260923-072-073');
const assets = {
  'VBE-20260923-072': [
    { filename: 'VBE-20260923-072_COVER_V01.png', role: 'cover', driveFileId: '1hq5foHB1oWUIfpO7grSsv9Fvs7QHFwn-', inlineObjectId: 'kix.91mz8rohzoda', semanticLabel: '封面' },
    { filename: 'VBE-20260923-072_BODY_FACT_V01.png', role: 'body', driveFileId: '1Yi0MNkAl_P0GFHmciDeuXWiRbmim3dCR', inlineObjectId: 'kix.segqon8s4n6u', semanticLabel: '投资法换版事实图' },
    { filename: 'VBE-20260923-072_BODY_FRAMEWORK_V01.png', role: 'body', driveFileId: '1cE9BsBUYGPC__5r0m_NR-nczWED6vbgH', inlineObjectId: 'kix.wr0i82990u4h', semanticLabel: 'Business Boundary Map框架图' },
    { filename: 'VBE-20260923-072_BODY_ACTION_V01.png', role: 'body', driveFileId: '13LJ1HYpjWTRfa745HujeHTW5waFeQB7D', inlineObjectId: 'kix.5ca1cg3uq9v5', semanticLabel: '老板季度五问行动图' },
  ],
  'VBE-20260923-073': [
    { filename: 'VBE-20260923-073_COVER_V01.png', role: 'cover', driveFileId: '128LWx0hdMrgsOl9QqRNXRNlcxwt-RiLz', inlineObjectId: 'kix.ahsy0llr1lox', semanticLabel: '封面' },
    { filename: 'VBE-20260923-073_BODY_FACT_V01.png', role: 'body', driveFileId: '1VdAZbutVaZjw9PzLYqx5tjsAUnLmxUaT', inlineObjectId: 'kix.rv5mzgbwqi8x', semanticLabel: '税款延期事实图' },
    { filename: 'VBE-20260923-073_BODY_FRAMEWORK_V01.png', role: 'body', driveFileId: '18A_Ha9CeCmEmbEoXfNx7ut5YblyU8E9-', inlineObjectId: 'kix.jr47ytvb2x90', semanticLabel: '税务现金流判断框架图' },
    { filename: 'VBE-20260923-073_BODY_ACTION_V01.png', role: 'body', driveFileId: '1MGtBVKJwgfZh-SzRQ1hcwtOSlq1KlBSO', inlineObjectId: 'kix.k0u6mkorstaq', semanticLabel: '财务行动图' },
  ],
};

const result = ingestDocxContentBundle(sourceDocx, targetRoot, {
  driveFileId: '1YG1dhjmB5GNrJnQEdMJ24yNZdsp5I-vsYzPlwzQm9H4',
  driveFolderId: '1tbgSZlOFEG1c86J_GilfG_f13hik9OAd',
  sourceUrl: 'https://docs.google.com/document/d/1YG1dhjmB5GNrJnQEdMJ24yNZdsp5I-vsYzPlwzQm9H4/edit',
  activeAssetOverrides: assets,
});
console.log(JSON.stringify({ ...result, targetRoot }, null, 2));
