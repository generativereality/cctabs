# Testing cctabs on the Windows 11 ARM64 guest

The scripts that ran `restart-tabby` and the startup-dialog fixes end to end on Windows
(2026-10-15, Tabby 1.0.238, plugin 0.1.6). The guest itself is the qemu VM in `~/VMs/win11` on
mbp21; how to boot and drive it is the `windows-dev` skill. All scripts are ASCII on purpose: a
non-ASCII character breaks the PowerShell parser through the console code page.

## ⛔ The guest is shared — snapshot before, revert after

Other tabs use it (`clerk-windows` keeps clean states in it; `codex-support` was running it the
same evening). Before booting, check nobody is: `pgrep -fl qemu-system-aarch64`, and look at the
newest `~/VMs/win11/run-*.log`. Then, with the VM **off**:

```sh
cd ~/VMs/win11 && T=pre-cctabs-<what>-$(date +%F)
qemu-img snapshot -c $T disk.qcow2 && cp -p efi-vars.fd efi-vars.fd.$T
# ... test ...  then shut the guest down (ssh winarm 'shutdown /s /t 0'), wait for qemu to exit:
qemu-img snapshot -a $T disk.qcow2 && cp -p efi-vars.fd.$T efi-vars.fd
```

Leave it off if you found it off.

## Stage on the Mac (the guest's DNS is lossy — copy everything in)

```sh
W=<scratch dir>
# Tabby arm64 installer + Node win-arm64 zip (zip only: there is no arm64 MSI)
curl -sSLo $W/tabby-setup-arm64.exe https://github.com/Eugeny/tabby/releases/download/v1.0.238/tabby-1.0.238-setup-arm64.exe
curl -sSLo $W/node-win-arm64.zip    https://nodejs.org/dist/v24.22.0/node-v24.22.0-win-arm64.zip
# cctabs from this checkout, with its runtime deps (--ignore-scripts: see CLAUDE.md, release flow)
npm run build && npm pack --ignore-scripts --pack-destination $W/stage-cctabs
(cd $W/stage-cctabs && echo '{"private":true}' > package.json && npm i --omit=dev --ignore-scripts ./generativereality-cctabs-*.tgz)
tar czf $W/cctabs-stage.tgz -C $W/stage-cctabs node_modules package.json
# the Tabby plugin at the pinned version
(mkdir -p $W/stage-plugin && cd $W/stage-plugin && echo '{"private":true}' > package.json && npm i --legacy-peer-deps --ignore-scripts tabby-cctabs@0.1.6)
tar czf $W/plugin-stage.tgz -C $W/stage-plugin node_modules package.json
```

`setup.ps1` hard-codes the Node folder name (`node-v24.22.0-win-arm64`); change it with the zip.

## Run

1. Boot (`windows-dev` §1) and **log in at the console**: the unattend's autologon is a 3-boot
   countdown and has long run out, so the guest sits at the lock screen with no session — and
   Tabby needs one. Read the password from the unattend ISO into a variable without printing it,
   stop `uefi-autoboot.py`, then `python3 mon.py "sendkey spc"` and `python3 type.py "$PW"`.
   `ssh winarm 'query user'` shows `dev … console … Active` when it took.
2. `scp` the staged files and these scripts to `C:\Users\dev\cctabs-in\`, then run, in order,
   with `powershell -NoProfile -ExecutionPolicy Bypass -File <script>`:
   - `setup.ps1` — Node to `C:\tools\node`, cctabs to `C:\tools\cctabs` with a
     `C:\tools\bin\cctabs.cmd` shim, both on the user PATH; plugin into
     `%APPDATA%\tabby\plugins`; Tabby per-user (`/S`).
   - `path.ps1` — puts `~\.local\bin` on the user PATH. The Claude installer does not, and a
     tab then gets the prompt typed into Git Bash (`reply: command not found`).
   - `start-tabby.ps1` — starts Tabby **in session 1** through a scheduled task (a GUI started
     over SSH is invisible), deleting the task in the same script, and waits for the plugin.
3. A fresh guest has never accepted Claude's folder trust or its one-time **Bypass Permissions**
   question. cctabs answers trust for a named folder and, by design, never answers the bypass
   one — accept it once by hand (Down, Enter) before testing anything that needs a running Claude.
4. `rt-run.ps1` opens a driver tab that runs `cctabs restart-tabby --yes` from inside Tabby (it
   has to be inside Tabby: that is how it finds its own tab). `rt-check.ps1` prints its output,
   the worker log, the tabs and whether the pending restore cleared.
5. Revert (above).
