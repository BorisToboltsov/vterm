import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { createHash, sign } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const repo = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'darwin') throw new Error('This smoke exercise requires macOS');
if (!process.argv[2]) throw new Error('Usage: node scripts/test-updater-helper.mjs <private-key-file> [helper-binary]');
const binary = resolve(process.argv[3] ?? join(repo, 'src-tauri/target/debug/vterm'));
const current = JSON.parse(readFileSync(join(repo, 'package.json'))).version.split('.').map(Number);
const version = `${current[0]}.${current[1] + 1}.0`;
const base = mkdtempSync(join(tmpdir(), 'vterm-helper-smoke-'));
const rustc = join(homedir(), '.cargo/bin/rustc');
const key = readFileSync(process.argv[2]);
const src = join(base,'fixture.rs');
writeFileSync(src, `fn main() { if std::env::var("VTERM_FIXTURE_FAIL").is_ok() { std::process::exit(9); } if let Ok(p) = std::env::var("VTERM_UPDATE_ACK") { std::fs::write(p, "${version}").unwrap(); } std::thread::sleep(std::time::Duration::from_secs(1)); }`);
execFileSync(rustc,[src,'-o',join(base,'new-binary')]);
writeFileSync(src, `fn main() { if let Ok(p) = std::env::var("VTERM_FIXTURE_OLD") { std::fs::write(p, "old").unwrap(); } }`);
execFileSync(rustc,[src,'-o',join(base,'old-binary')]);
for (const fail of [false,true]) {
 const work=join(base,fail?'rollback':'success'); mkdirSync(work);
 const home=join(work,'home'); mkdirSync(home);
 const target=join(work,'installed','vterm.app'), source=join(work,'source','vterm.app');
 for (const app of [target,source]) {
  mkdirSync(join(app,'Contents/MacOS'),{recursive:true});
  writeFileSync(join(app,'Contents/Info.plist'),`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>vterm</string><key>CFBundleIdentifier</key><string>su.vcore.vterm.fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
 }
 const executable=join(target,'Contents/MacOS/vterm');
 cpSync(join(base,'old-binary'),executable);
 cpSync(join(base,'new-binary'),join(source,'Contents/MacOS/vterm'));
 const payload=join(work,'update.zip');
 execFileSync(process.execPath,[join(repo,'scripts/update-release.mjs'),'maczip',source,payload]);
 const bytes=readFileSync(payload);
 const manifestPayload=Buffer.from(JSON.stringify({schema:1,version,assets:[{kind:'mac',arch:'universal',name:'update.zip',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]}));
 const manifest=join(work,'vterm-update.json');
 writeFileSync(manifest,JSON.stringify({payload:manifestPayload.toString('base64'),signature:sign(null,manifestPayload,key).toString('base64')}));
 const plan={version,kind:'mac',arch:'universal',target,executable,payload,manifest,parentPid:2147483647,parentStart:0,result:join(work,'result.json')};
 const planPath=join(work,'plan.json'); writeFileSync(planPath,JSON.stringify(plan));
 const helper=join(work,'vterm-update-helper'); cpSync(binary,helper);
 const child=spawn(helper,['--vterm-update-helper',planPath],{env:{...process.env,HOME:home,VTERM_FIXTURE_OLD:join(work,'old-started'),...(fail?{VTERM_FIXTURE_FAIL:'1'}:{})},stdio:['ignore','ignore','pipe']});
 let errors='';child.stderr.on('data',b=>errors+=b);
 const ended=new Promise((r,reject)=>{ child.on('exit',r); child.on('error',reject); });
 for (let n=0;n<300 && !existsSync(join(work,'helper-ready'));n++) {if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,100));}
 assert(existsSync(join(work,'helper-ready')),errors || 'helper did not become ready');
 assert.deepEqual(readFileSync(executable),readFileSync(join(base,'old-binary')),'preparation must preserve installed app');
 writeFileSync(join(work,'commit'),'install');
 await ended;
 const result=JSON.parse(readFileSync(plan.result));
 assert.equal(result,fail?'update-rolled-back':'updated',errors);
 assert(!existsSync(join(work,'installed','.vterm-previous')));
 if(fail)assert.deepEqual(readFileSync(executable),readFileSync(join(base,'old-binary')));
 console.log(fail?'PASS: failed startup restores previous bundle':'PASS: signed update prepares, swaps, acknowledges version and removes backup');
}
console.log('Fixtures: '+base);
