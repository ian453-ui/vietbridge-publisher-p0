import test from "node:test";import assert from "node:assert/strict";import {QA_CASES} from "../src/qa-cases.js";
test("UC-001 through UC-056 have traceable coverage",()=>{assert.equal(QA_CASES.length,56);assert.deepEqual(QA_CASES.map(x=>x.id),Array.from({length:56},(_,i)=>`UC-${String(i+1).padStart(3,"0")}`));assert.ok(QA_CASES.every(x=>["AUTOMATED","CLICKABLE_MOCK"].includes(x.coverage)))});
