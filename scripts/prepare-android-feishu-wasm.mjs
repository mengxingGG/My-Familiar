import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
// 使用独立依赖副本和 Go 编译覆盖层，保留上游校验包及原生执行器源码。
const root=resolve('.artifacts/android-feishu-wasm/overlay');await mkdir(root,{recursive:true});const Replace={};
async function add(original,name,source){const target=resolve(root,name);await writeFile(target,source);Replace[resolve(original)]=target;}
const originalMods='.artifacts/android-toolchain/go-work/pkg/mod/github.com',mods='.artifacts/android-feishu-wasm/modules',cli='.artifacts/android-toolchain/cli-cb5a3d704379552dc61e37898e5f74798783190d';
const work='.artifacts/android-feishu-wasm/cli-work';
if(!existsSync(work))await cp('.artifacts/android-feishu/managed-cli',work,{recursive:true,errorOnExist:true,force:false});
for(const name of ['main.go','workspace.go','content.go','policy.go','main_test.go','policy_test.go','policy_cases_test.json','go.sum'])await cp('.artifacts/android-feishu/managed-cli/'+name,work+'/'+name);
let mod=await readFile('.artifacts/android-feishu/managed-cli/go.mod','utf8');
for(const [name,version] of [['atotto/clipboard','v0.1.4'],['gofrs/flock','v0.8.1'],['charmbracelet/bubbletea','v1.3.6']]){
 const target=mods+'/'+name+'@'+version;if(!existsSync(target))await cp(originalMods+'/'+name+'@'+version,target,{recursive:true,errorOnExist:true,force:false});
 if(!existsSync(target+'/go.mod'))await cp('.artifacts/android-toolchain/go-work/pkg/mod/cache/download/github.com/'+name+'/@v/'+version+'.mod',target+'/go.mod');
 mod+='\nreplace github.com/'+name+' => '+JSON.stringify(resolve(target).replaceAll('\\','/'))+'\n';
}
await writeFile(work+'/go.mod',mod);
await add(mods+'/atotto/clipboard@v0.1.4/clipboard_js.go','clipboard_js.go',`//go:build js && wasm
package clipboard
import "errors"
func readAll()(string,error){return "",errors.New("FAMILIAR_CLIPBOARD_REQUIRES_ANDROID_UI")}
func writeAll(string)error{return errors.New("FAMILIAR_CLIPBOARD_REQUIRES_ANDROID_UI")}
`);
const flock=mods+'/gofrs/flock@v0.8.1';
await add(flock+'/flock_unix.go','flock_unix.go',(await readFile(flock+'/flock_unix.go','utf8')).replace('// +build !aix,!windows','//go:build !aix && !windows && !js\n// +build !aix,!windows,!js'));
await add(flock+'/flock_js.go','flock_js.go',`//go:build js && wasm
package flock
import "errors"
func(f *Flock)Lock()error{return errors.New("FAMILIAR_KEYCHAIN_ONLY")}
func(f *Flock)RLock()error{return errors.New("FAMILIAR_KEYCHAIN_ONLY")}
func(f *Flock)Unlock()error{return errors.New("FAMILIAR_KEYCHAIN_ONLY")}
func(f *Flock)TryLock()(bool,error){return false,errors.New("FAMILIAR_KEYCHAIN_ONLY")}
func(f *Flock)TryRLock()(bool,error){return false,errors.New("FAMILIAR_KEYCHAIN_ONLY")}
`);
const vfs=cli+'/internal/vfs/localfileio';
await add(vfs+'/openvalidated_unix.go','openvalidated_unix.go',(await readFile(vfs+'/openvalidated_unix.go','utf8')).replace('//go:build !windows','//go:build !windows && !js'));
await add(vfs+'/openvalidated_js.go','openvalidated_js.go',`//go:build js && wasm
package localfileio
import("errors";"os")
func openValidated(string)(*os.File,error){return nil,errors.New("FAMILIAR_WORKSPACE_PROVIDER_REQUIRED")}
func inspectOpenedFile(*os.File,os.FileInfo,bool)error{return errors.New("FAMILIAR_WORKSPACE_PROVIDER_REQUIRED")}
`);
await add(cli+'/internal/keychain/keychain_js.go','keychain_js.go',`//go:build js && wasm
package keychain
import "errors"
func platformGet(string,string)(string,error){return "",errors.New("FAMILIAR_KEYCHAIN_ONLY")}
func platformSet(string,string,string)error{return errors.New("FAMILIAR_KEYCHAIN_ONLY")}
func platformRemove(string,string)error{return errors.New("FAMILIAR_KEYCHAIN_ONLY")}
`);
const locks=cli+'/internal/lockfile';
await add(locks+'/lock_unix.go','lock_unix.go',(await readFile(locks+'/lock_unix.go','utf8')).replace('//go:build !windows','//go:build !windows && !js'));
await add(locks+'/lock_js.go','lock_js.go',`//go:build js && wasm
package lockfile
import("errors";"os")
func tryLockFile(*os.File)error{return errors.New("FAMILIAR_NO_NATIVE_FILE_LOCK")}
func unlockFile(*os.File)error{return errors.New("FAMILIAR_NO_NATIVE_FILE_LOCK")}
`);
const consume=cli+'/internal/event/consume';
await add(consume+'/startup_unix.go','startup_unix.go',(await readFile(consume+'/startup_unix.go','utf8')).replace('//go:build !windows','//go:build !windows && !js'));
await add(consume+'/startup_js.go','startup_js.go',`//go:build js && wasm
package consume
import("errors";"os/exec")
func applyDetachAttrs(cmd *exec.Cmd){cmd.Err=errors.New("FAMILIAR_EVENT_OWNER_REQUIRED")}
`);
await add(cli+'/cmd/event/sigpipe_js.go','sigpipe_js.go',`//go:build js && wasm
package event
func ignoreBrokenPipe(){panic("FAMILIAR_EVENT_OWNER_REQUIRED")}
`);
await add(mods+'/charmbracelet/bubbletea@v1.3.6/tty_js.go','tty_js.go',`//go:build js && wasm
package tea
import("errors";"os")
const suspendSupported=false
func suspendProcess(){panic("FAMILIAR_NO_TERMINAL")}
func(p *Program)initInput()error{return errors.New("FAMILIAR_NO_TERMINAL")}
func openInputTTY()(*os.File,error){return nil,errors.New("FAMILIAR_NO_TERMINAL")}
func(p *Program)listenForResize(done chan struct{}){close(done)}
`);
await writeFile(resolve('.artifacts/android-feishu-wasm/overlay.json'),JSON.stringify({Replace},null,2));
