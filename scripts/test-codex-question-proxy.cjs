const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createTranslator } = require("../src-tauri/driver/codex-question-proxy.cjs");
const raw = (questions) => ({ method: "rawResponseItem/completed", params: { threadId: "owner", turnId: "turn", item: { type: "function_call", name: "request_user_input_async", call_id: "call-1", arguments: JSON.stringify({ questions }) } } });
test("actual async arguments become native questions with their owning IDs and zero deadline", () => {
  const translator = createTranslator();
  const result = translator.outgoing(raw([{ title: "Keep search?", options: ["Clear (Recommended)", "Keep"] }, { title: "Scroll to Discover?" }]));
  assert.equal(result.method, "item/tool/requestUserInput");
  assert.equal(result.params.threadId, "owner");
  assert.equal(result.params.turnId, "turn");
  assert.equal(result.params.itemId, "call-1");
  assert.equal(result.params.autoResolutionMs, 0);
  assert.equal(result.params.isBlocking, false);
  assert.deepEqual(result.params.questions[0].options, [{label:"Clear (Recommended)",description:""},{label:"Keep",description:""}]);
  assert.equal(result.params.questions[1].options, null);
  assert.equal(translator.consumeResponse({ id: result.id, result: { answers: {} } }), true);
  assert.equal(translator.consumeResponse({ id: "native", result: {} }), false);
});
test("agent message metadata is a fallback and does not duplicate a raw async question", () => {
  const translator = createTranslator();
  const questions = [{ title: "Keep search?", options: ["Clear", "Keep"] }];
  assert.ok(translator.outgoing(raw(questions)));
  assert.equal(translator.outgoing({method:"item/completed",params:{threadId:"owner",turnId:"turn",item:{type:"agentMessage",id:"message",questions}}}), null);
  translator.outgoing({method:"turn/completed",params:{threadId:"owner",turn:{id:"turn"}}});
  assert.ok(translator.outgoing(raw(questions)));
});
test("raw async metadata followed by the same native request produces one clarification", () => {
  const translator = createTranslator();
  assert.ok(translator.outgoing(raw([{title:"Existing",options:null}])));
  const duplicate = {method:"item/tool/requestUserInput",id:12,params:{threadId:"owner",turnId:"turn",itemId:"call-1",questions:[{question:"Existing",options:null}]}};
  assert.deepEqual(translator.outgoing(duplicate),{jsonrpc:"2.0",id:12,result:{answers:{}}});
});
test("distinct native requests with identical question text are never cancelled", () => {
  const translator = createTranslator();
  const native = (id) => ({method:"item/tool/requestUserInput",id,params:{threadId:"owner",turnId:"turn",itemId:`distinct-${id}`,questions:[{question:"Choose",options:[{label:"Yes"},{label:"No"}]}]}});
  assert.equal(translator.outgoing(native(1)),null);
  assert.equal(translator.outgoing(native(2)),null);
});
test("unrelated messages and existing native questions pass through untouched", () => {
  const translator = createTranslator();
  const message = {method:"item/tool/requestUserInput",id:5,params:{threadId:"owner",turnId:"turn",itemId:"call-1",questions:[{question:"Existing",options:null}]}};
  const before = JSON.stringify(message);
  assert.equal(translator.outgoing(message), null);
  assert.equal(JSON.stringify(message), before);
  assert.equal(translator.consumeResponse({id:5,result:{answers:{}}}),false);
  assert.equal(translator.outgoing(raw([{title:"Existing",options:null}])),null);
  assert.equal(translator.outgoing({method:"item/completed",params:{threadId:"owner",turnId:"turn",item:{type:"commandExecution",id:"cmd"}}}),null);
});
test("invalid async metadata fails explicitly without creating a request", () => {
  for (const questions of [[],[{title:""}],[{title:"Choose",options:[]}],[{title:"Choose",options:[5]}]]) {
    assert.throws(() => createTranslator().outgoing(raw(questions)), /Invalid Codex async question/);
  }
});
test("proxy preserves the configured child executable, arguments, environment and protocol payloads", () => {
  const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const { spawnSync } = require("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "palisade-proxy-test-"));
  try {
    const fixture = join(root, "child.cjs");
    writeFileSync(fixture, `const {createInterface}=require('node:readline');
      console.log(JSON.stringify({method:'child-info',params:{args:process.argv.slice(2),target:process.env.CODEX_PATH,proxyTarget:process.env.PALISADE_CODEX_TARGET??null}}));
      createInterface({input:process.stdin}).on('line',line=>console.log(line));`);
    const payload = JSON.stringify(raw([{ title: "Clear search?", options: ["Yes", "No"] }]));
    const reply = '{"jsonrpc":"2.0","id":5,"result":{"answers":{"native":"Yes"}}}';
    const run = spawnSync(process.execPath, [require.resolve("../src-tauri/driver/codex-question-proxy.cjs"), fixture, "value with spaces"], {
      input: `${payload}\n${reply}\n`, encoding: "utf8", timeout: 5000,
      env: { ...process.env, PALISADE_CODEX_TARGET: process.execPath },
    });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split("\n");
    const info = JSON.parse(lines[0]);
    assert.deepEqual(info.params.args, ["value with spaces"]);
    assert.equal(info.params.target, process.execPath);
    assert.equal(info.params.proxyTarget, null);
    assert.ok(lines.includes(payload));
    assert.ok(lines.includes(reply));
    assert.equal(lines.map(JSON.parse).filter((message) => message.method === "item/tool/requestUserInput").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("proxy preserves the complete final frame before exiting", () => {
  const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const { spawnSync } = require("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "palisade-proxy-drain-"));
  try {
    const fixture = join(root, "child.cjs");
    writeFileSync(fixture, `process.stdout.write(JSON.stringify({method:'final',params:{text:'x'.repeat(2000000)}})+'\\n',()=>process.exit(0));`);
    const run = spawnSync(process.execPath, [require.resolve("../src-tauri/driver/codex-question-proxy.cjs"), fixture], {
      encoding: "utf8", timeout: 5000, maxBuffer: 3000000,
      env: { ...process.env, PALISADE_CODEX_TARGET: process.execPath },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).params.text.length, 2000000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("malformed async metadata visibly fails the connection without printing its private payload", () => {
  const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const { spawnSync } = require("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "palisade-proxy-error-"));
  try {
    const fixture = join(root, "child.cjs");
    const message = raw([{title:"sensitive-title", options:[5]}]);
    writeFileSync(fixture, `console.log(${JSON.stringify(JSON.stringify(message))});setInterval(()=>{},1000);`);
    const run = spawnSync(process.execPath, [require.resolve("../src-tauri/driver/codex-question-proxy.cjs"), fixture], {
      encoding: "utf8", timeout: 5000,
      env: { ...process.env, PALISADE_CODEX_TARGET: process.execPath },
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /agent connection was stopped/);
    assert.equal(run.stderr.includes("sensitive-title"), false);
    assert.equal(run.stdout.includes("sensitive-title"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
