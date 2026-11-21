import { readFileSync } from "node:fs";
import { summarizeEvaluation, validateEvaluation } from "@je2be/converter";

const file = process.argv[2];
if (!file) throw new Error("usage: npm run evaluate:gimmicks -- <evaluation.json>");
const record: unknown = JSON.parse(readFileSync(file, "utf8"));
validateEvaluation(record);
console.log(JSON.stringify(summarizeEvaluation(record), null, 2));
