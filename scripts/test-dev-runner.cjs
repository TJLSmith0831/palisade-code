const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const runner = resolve(__dirname, 'dev-runner.sh');
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'palisade-dev-runner-'));
  const log = join(directory, 'calls.jsonl');
  const program = (name, body) => {
    const file = join(directory, name);
    writeFileSync(file, '#!' + process.execPath + '\n' + body, { mode: 0o755 });
    return file;
  };
  program('cargo', 'console.log(JSON.stringify({args:process.argv.slice(2),arm:process.env.CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER,intel:process.env.CARGO_TARGET_X86_64_APPLE_DARWIN_RUNNER}));');
  program('security', `if(process.argv[2]==="find-identity"){if(!process.env.TEST_NO_APPLE&&!process.env.TEST_CERT_MISSING)console.log('  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Developer ID Application: Test (3DWSA8QSH5)"');}else process.exit(process.env.TEST_CERT_MISSING?1:0);`);
  program('codesign', 'require("node:fs").appendFileSync(process.env.TEST_LOG,JSON.stringify({kind:"sign",args:process.argv.slice(2)})+"\\n");process.exit(Number(process.env.TEST_SIGN_FAILURE||0));');
  program('pnpm', 'const fs=require("node:fs");fs.mkdirSync("src-tauri/target/release/bundle/macos/Palisade.app",{recursive:true});fs.mkdirSync("src-tauri/target/release/bundle/dmg",{recursive:true});fs.writeFileSync("src-tauri/target/release/bundle/dmg/Palisade.dmg","");');
  program('xattr', 'process.exit(0);');
  const app = program('app with spaces', 'require("node:fs").appendFileSync(process.env.TEST_LOG,JSON.stringify({kind:"app",args:process.argv.slice(2)})+"\\n");');
  const run = (args, extra = {}) => spawnSync('bash', [runner, ...args], {
    encoding: 'utf8', env: { ...process.env, CODESIGN_ID: '', PATH: directory + ':' + process.env.PATH, TEST_LOG: log, ...extra },
  });
  const runPackage = (extra = {}) => {
    const script = join(directory, 'package.sh');
    writeFileSync(script, readFileSync(resolve(__dirname, '../package.sh')));
    mkdirSync(join(directory, 'scripts'), { recursive: true });
    const helper = resolve(__dirname, 'codesign-identity.sh');
    if (existsSync(helper)) writeFileSync(join(directory, 'scripts/codesign-identity.sh'), readFileSync(helper));
    return spawnSync('bash', [script, '--no-install'], { encoding: 'utf8', env: { ...process.env, CODESIGN_ID: '', APPLE_SIGNING_IDENTITY: '', PATH: directory + ':' + process.env.PATH, TEST_LOG: log, ...extra } });
  };
  return { directory, app, run, runPackage, calls: () => readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('Cargo run preserves every flag and installs the signing runner for both Mac targets', () => {
  const f = fixture();
  try {
    const result = f.run(['run', '--features', 'readiness-test', '--target', 'x86_64-apple-darwin', '--', 'two words']);
    assert.equal(result.status, 0, result.stderr);
    const received = JSON.parse(result.stdout);
    assert.deepEqual(received.args, ['run', '--features', 'readiness-test', '--target', 'x86_64-apple-darwin', '--', 'two words']);
    assert.equal(received.arm, runner);
    assert.equal(received.intel, runner);
  } finally { f.cleanup(); }
});
test('release build delegates without installing a runtime signer', () => {
  const f = fixture();
  try {
    const result = f.run(['build', '--release']);
    assert.equal(result.status, 0, result.stderr);
    const received = JSON.parse(result.stdout);
    assert.deepEqual(received.args, ['build', '--release']);
    assert.equal(received.arm, undefined);
    assert.equal(received.intel, undefined);
  } finally { f.cleanup(); }
});
test('the executable is signed with a stable identity before launch and receives unchanged arguments', () => {
  const f = fixture();
  try {
    const result = f.run([f.app, 'two words', '--flag']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.calls(), [
      { kind: 'sign', args: ['--force', '--identifier', 'com.tjlsmith0831.palisade-code', '--sign', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', f.app] },
      { kind: 'app', args: ['two words', '--flag'] },
    ]);
  } finally { f.cleanup(); }
});
test('a fresh machine without the default certificate warns and keeps the dev workflow available', () => {
  const f = fixture();
  try {
    const result = f.run([f.app], { TEST_CERT_MISSING: '1' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /ad-hoc.*permission/i);
    assert.ok(f.calls()[0].args.includes('-'));
    assert.deepEqual(f.calls()[1], { kind: 'app', args: [] });
  } finally { f.cleanup(); }
});
test('explicit signing failure stops launch instead of silently changing identity', () => {
  const f = fixture();
  try {
    const result = f.run([f.app], { CODESIGN_ID: 'Custom Dev', TEST_SIGN_FAILURE: '1' });
    assert.equal(result.status, 1);
    assert.equal(f.calls().length, 1);
    assert.ok(f.calls()[0].args.includes('Custom Dev'));
  } finally { f.cleanup(); }
});

test('real Cargo builds then invokes the signer with the artifact and app arguments', { skip: process.platform !== 'darwin' }, () => {
  const f = fixture();
  try {
    rmSync(join(f.directory, 'cargo'));
    mkdirSync(join(f.directory, 'src'));
    writeFileSync(join(f.directory, 'Cargo.toml'), '[package]\nname="dev-runner-check"\nversion="0.1.0"\nedition="2021"\n');
    writeFileSync(join(f.directory, 'src/main.rs'), 'fn main() { println!("{:?}", std::env::args().skip(1).collect::<Vec<_>>()); }');
    const result = f.run(['run', '--offline', '--manifest-path', join(f.directory, 'Cargo.toml'), '--', 'two words', '--flag']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['two words', '--flag']);
    const calls = f.calls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'sign');
    assert.match(calls[0].args.at(-1), /dev-runner-check$/);
  } finally { f.cleanup(); }
});

test('the self-signed fallback explicitly warns that recurring Keychain prompts remain', () => {
  const f = fixture();
  try {
    const result = f.run([f.app], { TEST_NO_APPLE: '1' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /self-signed.*Keychain.*each rebuild/);
    assert.ok(f.calls()[0].args.includes('Palisade Code Dev'));
  } finally { f.cleanup(); }
});

test('local packaging uses the same Apple identity default without touching release distribution signing', () => {
  const f = fixture();
  try {
    const result = f.runPackage();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(f.calls()[0].args.includes('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
    assert.ok(f.calls()[0].args.includes('--deep'));
  } finally { f.cleanup(); }
});
test('explicit local packaging certificate is honored', () => {
  const f = fixture();
  try {
    const result = f.runPackage({ CODESIGN_ID: 'Custom Dev' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(f.calls()[0].args.includes('Custom Dev'));
  } finally { f.cleanup(); }
});

test('distribution signing never manually re-signs Tauri output', () => {
  const f = fixture();
  try {
    const result = f.runPackage({ APPLE_SIGNING_IDENTITY: 'Developer ID Application: Test' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(f.calls().every((call) => !call.args.includes('--force')));
  } finally { f.cleanup(); }
});
