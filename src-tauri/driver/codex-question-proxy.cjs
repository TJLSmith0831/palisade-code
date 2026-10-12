#!/usr/bin/env node
// codex-acp drops native async question metadata; translate only that metadata to its supported input request.
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { realpathSync } = require("node:fs");

function createTranslator() {
  const seen = new Map();
  const synthetic = new Set();
  let sequence = 0;
  const signature = (questions) => JSON.stringify(questions.map((question) => [question.question ?? question.title, question.options?.map((option) => typeof option === "string" ? option : option.label) ?? null]));
  function outgoing(message) {
    const params = message.params;
    const turnId = params?.turnId ?? params?.turn?.id;
    if (!params?.threadId || !turnId) return null;
    const key = `${params.threadId}:${turnId}`;
    if (message.method === "turn/completed") { seen.delete(key); return null; }
    if (message.method === "item/tool/requestUserInput") {
      const records = seen.get(key) ?? new Map();
      if (params.itemId && records.get(params.itemId)?.source === "async") return { jsonrpc: "2.0", id: message.id, result: { answers: {} } };
      if (params.itemId) records.set(params.itemId, { source: "native", signature: signature(params.questions) });
      seen.set(key, records);
      return null;
    }
    let questions;
    let itemId;
    if (message.method === "rawResponseItem/completed" && params.item?.type === "function_call" && params.item.name === "request_user_input_async") {
      questions = JSON.parse(params.item.arguments).questions;
      itemId = params.item.call_id;
    } else if (message.method === "item/completed" && params.item?.type === "agentMessage" && params.item.questions?.length) {
      questions = params.item.questions;
      itemId = params.item.id;
    } else return null;
    if (!Array.isArray(questions) || !questions.length || !itemId) throw new Error("Invalid Codex async question metadata");
    const converted = questions.map((question, index) => {
      if (typeof question.title !== "string" || !question.title.trim()) throw new Error("Invalid Codex async question title");
      if (question.options != null && (!Array.isArray(question.options) || !question.options.length || question.options.some((option) => typeof option !== "string"))) throw new Error("Invalid Codex async question options");
      return { id: `${itemId}-${index}`, header: "Clarification", question: question.title, isOther: false, isSecret: false,
        options: question.options?.map((label) => ({ label, description: "" })) ?? null };
    });
    const records = seen.get(key) ?? new Map();
    const questionSignature = signature(questions);
    if (records.has(itemId)) return null;
    // Completed message metadata has a different ID from its original async call.
    if (message.method === "item/completed" && [...records.values()].some((record) => record.signature === questionSignature)) return null;
    records.set(itemId, { source: "async", signature: questionSignature });
    seen.set(key, records);
    const id = `palisade-question-${process.pid}-${sequence++}`;
    synthetic.add(id);
    return { jsonrpc: "2.0", id, method: "item/tool/requestUserInput", params: {
      threadId: params.threadId, turnId, itemId, questions: converted, isBlocking: false, autoResolutionMs: 0,
    } };
  }
  return { outgoing, consumeResponse(message) {
    if (!synthetic.has(message.id) || message.method) return false;
    synthetic.delete(message.id);
    return true;
  } };
}

function run() {
  const target = process.env.PALISADE_CODEX_TARGET || "codex";
  if (target.includes("/") || target.includes("\\")) {
    if (realpathSync(target) === realpathSync(__filename)) throw new Error("Codex question proxy cannot launch itself");
  }
  const env = { ...process.env, CODEX_PATH: target };
  delete env.PALISADE_CODEX_TARGET;
  const child = spawn(target, process.argv.slice(2), { env, stdio: ["pipe", "pipe", "inherit"], shell: false });
  const translator = createTranslator();
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { child.stdin.write(`${line}\n`); return; }
    if (!translator.consumeResponse(message)) child.stdin.write(`${line}\n`);
  });
  input.on("close", () => child.stdin.end());
  let failed = false;
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const translated = translator.outgoing(JSON.parse(line));
      if (translated && !translated.method) {
        child.stdin.write(`${JSON.stringify(translated)}\n`);
      } else {
        process.stdout.write(`${line}\n`);
        if (translated) process.stdout.write(`${JSON.stringify(translated)}\n`);
      }
    } catch {
      failed = true;
      process.stderr.write("Palisade could not translate Codex async question metadata; the agent connection was stopped.\n");
      child.kill("SIGTERM");
    }
  });
  child.on("error", () => {
    failed = true;
    process.stderr.write("Palisade could not start the Codex question bridge.\n");
    input.close();
    process.exitCode = 1;
  });
  child.stdin.on("error", () => {});
  child.on("close", (code, signal) => { input.close(); process.exitCode = failed ? 1 : code ?? (signal ? 1 : 0); });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
}
if (require.main === module) run();
module.exports = { createTranslator };
