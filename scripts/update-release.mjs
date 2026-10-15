// Signed, version-bound update manifest. The key is independent of OS code signing.
import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const publicFile = join(root, 'src-tauri/update-public-key.txt');
export function artifactKind(name, version) {
  const names = new Map([
    [`vterm_${version}_universal_update.zip`, ['mac', 'universal']],
    [`vterm-portable-${version}-x86_64.exe`, ['portable', 'x86_64']],
    [`vterm-portable-${version}-x86_64-webview2.exe`, ['portable-webview2', 'x86_64']],
    [`vterm_${version}_x64-setup.exe`, ['nsis', 'x86_64']],
    [`vterm_${version}_x64_en-US.msi`, ['msi', 'x86_64']],
    [`vterm_${version}_amd64.deb`, ['deb', 'x86_64']],
    [`vterm-${version}-1.x86_64.rpm`, ['rpm', 'x86_64']],
    [`vterm_${version}_amd64.AppImage`, ['appimage', 'x86_64']],
  ]);
  return names.get(name) ?? null;
}
function digestFile(path) {
  const hash = createHash('sha256'), fd = openSync(path, 'r'), buffer = Buffer.alloc(65536);
  try { let n; while ((n = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n)); }
  finally { closeSync(fd); }
  return hash.digest('hex');
}
export function buildManifest(directory, version, privatePem, publicBase64) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a release version');
  const key = createPrivateKey(privatePem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected an Ed25519 key');
  const publicRaw = createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  if (publicRaw !== publicBase64.trim()) throw new Error('Signing key does not match the key embedded in vterm');
  const assets = readdirSync(directory).sort().flatMap(name => {
    const kind = artifactKind(name, version);
    if (!kind) return [];
    const path = join(directory, name), size = statSync(path).size;
    if (!size || size > 2 * 1024 ** 3) throw new Error(`Invalid asset size: ${name}`);
    return [{ kind: kind[0], arch: kind[1], name, size, sha256: digestFile(path) }];
  });
  if (assets.length !== 8 || new Set(assets.map(a => a.kind)).size !== 8) throw new Error('All eight update formats must be present before publication');
  const payload = Buffer.from(JSON.stringify({ schema: 1, version, assets }));
  return { payload: payload.toString('base64'), signature: sign(null, payload, key).toString('base64') };
}
function main([command, path, extra]) {
  if (command === 'keygen') {
    if (!path) throw new Error('Usage: keygen <private-directory>');
    mkdirSync(path, { mode: 0o700 }); // refuses an existing directory/key
    const key = generateKeyPairSync('ed25519');
    writeFileSync(join(path, 'update-private.pem'), key.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
    writeFileSync(publicFile, key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') + '\n');
    process.stdout.write('Update key created. Keep the private directory outside version control.\n');
  } else if (command === 'manifest') {
    const privatePem = process.env.VTERM_UPDATE_PRIVATE_KEY;
    if (!privatePem) throw new Error('VTERM_UPDATE_PRIVATE_KEY is required');
    writeFileSync(join(path, 'vterm-update.json'), JSON.stringify(buildManifest(path, extra, privatePem, readFileSync(publicFile, 'utf8'))) + '\n');
  } else if (command === 'maczip') {
    if (basename(path) !== 'vterm.app') throw new Error('Expected vterm.app');
    // Zip only regular files/directories: extraction does not need to trust symlinks.
    execFileSync('python3', ['-c', `import os,sys,zipfile
source,out=sys.argv[1:]
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
 for root,dirs,files in os.walk(source):
  for name in dirs+files:
   p=os.path.join(root,name)
   if os.path.islink(p): raise ValueError('Symlink in application bundle: '+p)
   z.write(p,os.path.relpath(p,os.path.dirname(source)))
`, resolve(path), resolve(extra)], { stdio: 'inherit' });
  } else throw new Error('Expected keygen, manifest or maczip');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 1; }
}
