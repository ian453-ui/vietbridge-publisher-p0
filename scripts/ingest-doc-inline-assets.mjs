import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const sourceRoot = resolve(process.argv[2] ?? "/tmp/vb-inline-assets-20260921");
const targetRoot = resolve(process.argv[3] ?? "../Content-Library/VBE-20260915-READY");
const rows = [
  ["VBE-20260915-001","越南进口增速35.3%：采购增长前先做“进口依赖暴露图”","1Npao6PLviE5VdEXk4HVas_eed9y7ZZIO0zW4dhBygfs","kix.qggl2qy2fytr","1EIiW9NOm4YkvrJfPuNipwKKKCjF3IopX"],
  ["VBE-20260915-002","越南经营决策：先看事实，再做判断","1fzEYLDVXPZhgu-xHtwEMo45ydnPZDs86xjYxpf59FIQ","kix.zbyw0raoboqe","1PYjCUnIKGp_xVLVCMsRHTv0Sq4nQs9OL"],
  ["VBE-20260915-003","越南经营决策：先看事实，再做判断","1pvbhRHeFGSvhGIVLiox9RvgrpZt-NciSP1VecA2YI-A","kix.e8syg8zcw5oc","19Eyeh-H4YVJW1qmhEXWn0aBydBzmt_vG"],
  ["VBE-20260915-004","越南经营决策：先看事实，再做判断","1GVbuPSiRaKqEcybvOV7AuG4PSVAtorxmNBNIcl87_mA","kix.cmfc96jye9g5","1b5GFDsttoDH20wdPaUPEL_s5fC5k9ThR"],
  ["VBE-20260915-005","越南经营决策：先看事实，再做判断","1xfm-i0NiNOPUC6Srkpuz1oEVacs00wCWMfpE7ovFc_M","kix.2y4z2wfj5b7z","1LGgiJHRrcmSjxCNY1SXM7mysnGVQGBAw"],
  ["VBE-20260915-006","越南经营决策：先看事实，再做判断","1WPLnRfrI9icq_jqCWlmr-6lebISA3RC2owD8PRARpeU","kix.pjk7qor4i2d","1H2OoGVgDTZjYOg5XhE9k7DMm_fN3gYS4"],
  ["VBE-20260915-007","越南经营决策：先看事实，再做判断","17ZDQ5WMDrG_Be-RPBfa9hzGyJYU6SlgNaNDPnAlrAmA","kix.d5bk6thdk9ce","1AGEQo8ZO2xG3peMftVjhfdebjdz0rQsi"],
  ["VBE-20260915-008","越南经营决策：先看事实，再做判断","1-oUQHWKWky2lpwKk2MOX3FhVMb6r5y9rNPUhClVixY0","kix.bjw8vg8tfnf3","18UPCJoASO6rq2AJ9W46i5zSXhjU4Y5jH"],
  ["VBE-20260915-009","越南经营决策：先看事实，再做判断","17v0ECuJoYsEWN2kP7r--4Qk5eu_EPbq06S1GCJaJ6LM","kix.bfxpaopg50na","12DqIRCoaB6xp9LvJQMog4GsOCTTGNXAo"],
  ["VBE-20260915-010","越南经营决策：先看事实，再做判断","1LtC3Fjj9RTvRabg6k6iMp0UbU9_0NvANlE-tpCpbWjA","kix.flqx722id7bm","1ATvM0Njj9WnGI5O6L0OFxglce52hFiDG"],
  ["VBE-20260915-011","进口很多、出口也很多：真正该问的是进口创造了什么价值？","1qYESPAN-pYhfxE1cOjhceHbwS2GT3vGElDkCh-4pJS4","kix.wrq2byr2f4q3","1TSCbcSOeSYlDRPOfry8KwrF1vG5qRwNf"],
  ["VBE-20260915-012","物流报价涨了，别只砍价：先把一票运费拆开","1eNoVXVFU6V31rYoSx-GSJe0wv7ZKh43Bl_hqj5wSIF0","kix.4qcgpnq31s6l","1BVMP2HZ2oPpjvFOhPOlY6q5xIyyTbbyx"],
  ["VBE-20260915-013","工业集群新规生效：选址最怕的不是租贵，而是未来扩不动","1ESwNiAxtkI0gQ3n3c-zHWufRLBsh4TtrH_a6Bbjv9J4","kix.jnw6ggnlqmcx","1MZE84fa54XSudeyl0bgmivnjtxxCWOdh"],
  ["VBE-20260915-014","跨境电商别只看GMV：先把订单级利润算清楚","1wkYLhdWwMoJQmwbJ4u8bRKDZC3wnjga3Z9NuPZJYGTY","kix.dme0k2m3k71u","1zpHbjgEPfDHCiFqkaCJJDoSS96IhjZtA"],
  ["VBE-20260915-015","企业培训最浪费的钱：上完课，经营行为没有发生变化","1gYlNsX-f_e17M30VVkuxKWW0sldlVe64iIbwHf9HAsQ","kix.8pq134ufwgq4","1BEbJvsD8a1LLhFDPXnLf7g9essDL3Xs4"],
  ["VBE-20260915-016","“本地采购率”很高，也可能没有真正本地化","1F6_WhhJpkZCO3gUagPynL143LXTTRRLw0RcyH79-Eys","kix.bql8bgrfmmqh","1wQvSzX3HMyfHUAGG6ZX1dsehsDbhSj8q"],
  ["VBE-20260915-017","大客户越大越安全吗？制造企业该同时管理“价值”和“依赖”","1f_X8l9weetynDugE93PoYfL3iKmoo3tb_KNdLQgf9Pg","kix.kx2jsdty5ioq","1YUvN11omcUBLlFkUmJgOIw0eEFNT5I3l"],
  ["VBE-20260915-018","工资不是全部人工成本：工厂真正要看“有效工时创造了什么”","1Owz0Ch-owzz9tpWWSWTJ-PQ3HzWRAKpTfbf_sOyan4I","kix.dzpxj5nsupt5","1eGW5z0dFOKj3iOnUz6UiswU3YJkXJyuN"],
  ["VBE-20260915-019","供应商说“能交货”还不够：真正要管的是承诺可靠性","1d5UF-ij-J3fv5U3KobA7ZMjIpIv2CdE7yaXvdyUkKlw","kix.dikurxab5r8t","1D8indSxONf5w-o9fVkjKhCX20-mhIRnM"],
  ["VBE-20260915-020","客户问题最怕“所有人都在处理”：跨部门协作需要唯一Owner","1mNxMYKxJgifa-1gkTQrtZ18irD8CmPsvMjsPN-oXc30","kix.amyzynukr703","1YZageh0--5UBx24-UisOS-PYQz97hMrs"],
  ["VBE-20260916-041","老板最该看的不是20张报表，而是一张“异常清单”","10E676AYi8Ed9CQExeQ8zSxezZl5b64IcMjSHBW2pXIs","kix.ma3d5bkmkp5k","1pqqsBJx5BZdxKtQppfP9zbznbNR9Ukiz"]
];

for (const [articleId, title, sourceDocId, inlineObjectId, driveFileId] of rows) {
  const number = articleId.endsWith("-041") ? "041" : articleId.slice(-3);
  const source = join(sourceRoot, `VBE-20260915-${number}-legacy-body-main.png`);
  if (!existsSync(source)) throw new Error(`missing downloaded asset: ${source}`);
  const dir = join(targetRoot, articleId); mkdirSync(dir, { recursive: true });
  const filename = "legacy_body_main_QA_PASS.png";
  const destination = join(dir, filename); copyFileSync(source, destination);
  const manifestPath = join(dir, "manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {
    article_id: articleId, title, version: "doc-inline-asset-ingest-2026-09-21", content_type: "image_text",
    source_doc_id: sourceDocId, source_url: `https://docs.google.com/document/d/${sourceDocId}/edit`,
    library_status: "ASSET_INGESTED_PUBLIC_PAYLOAD_PENDING", publication_authorized: false, qa_status: "PASS",
    active_assets: []
  };
  manifest.title = manifest.title || title;
  manifest.source_doc_id = manifest.source_doc_id || sourceDocId;
  manifest.active_assets = [...new Set([...(Array.isArray(manifest.active_assets) ? manifest.active_assets : []), filename])];
  manifest.asset_sources = { ...(manifest.asset_sources || {}), [filename]: {
    role: "BODY_INFOGRAPHIC", sequence: 0, source_kind: "DOC_INLINE_DRIVE_MATCH",
    source_doc_id: sourceDocId, inline_object_id: inlineObjectId, drive_file_id: driveFileId, local_path: destination,
    sha256: createHash("sha256").update(readFileSync(destination)).digest("hex"), semantic_label: title,
    visual_standard_version: "historical-high-density", candidate_only: false
  }};
  if (articleId === "VBE-20260916-041") {
    manifest.qa_status = "FAIL";
    manifest.library_status = "BLOCKED_ASSET_SEMANTIC_MISMATCH";
    manifest.blocking_issue = "historical image depicts logistics KPI, not the exception-list article";
    manifest.active_assets = ["BLOCKED_SEMANTIC_MISMATCH"];
    manifest.asset_sources[filename].candidate_only = true;
    manifest.asset_sources[filename].semantic_label = "物流KPI组合（与异常清单文章不匹配）";
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}
console.log(JSON.stringify({ ingested: rows.length, targetRoot }));
