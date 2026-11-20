# MTP-1F

A file transfer page for the OP-1 Field. It runs in Chrome and talks to the unit over USB. Nothing is installed.

**Unofficial.** MTP-1F is not made, endorsed, or supported by Teenage Engineering, and it is not affiliated with them or with [open-field](https://github.com/LaP0573/open-field). "OP-1 Field" and "Teenage Engineering" are named only to say which device this talks to.

**Independently developed.** It was written on its own. It does know the open-field layout: a `.pack` is a feature file, and the page can copy those. open-field itself is a separate project.

**At your own risk.** The page copies, replaces, and deletes files on the unit when you ask it to. Putting a firmware file on the unit does not install it. Installing firmware is a separate step on the unit, and a bad firmware file can leave a unit unable to start. Read [NOTICE.md](NOTICE.md).

## Use it

You need Chrome on a computer, a USB cable, and the files you want to copy.

Run it on your own computer. From this folder:

```
python3 -m http.server 8755 --bind 127.0.0.1
```

Open [http://127.0.0.1:8755](http://127.0.0.1:8755) in Chrome. Chrome will not offer a USB device from a page opened as a file.

A hosted copy is at [seajaysec.github.io/mtp1f-web](https://seajaysec.github.io/mtp1f-web/). Google Safe Browsing may flag it as a dangerous site: the page asks for a USB device and for a folder on your computer, and that alone can be enough for Google's automated checks. Nothing in it phishes or uploads anything. If Chrome warns, run the page locally as above.

1. Press **Choose folder** and pick the folder on this computer. **Connect** appears once a folder is chosen.
2. Connect the unit and press **Connect**. A unit that is running is asked to share its drive.
3. Press **Stage** on each pack you want copied, or **Stage all** for everything that is new or newer here. New logs on the unit are staged for you; nothing else is. **Staged** means it is waiting. Press it again to take it back.
4. Press **Send**. That is the copy.

## Packs

`.pack` files are feature files. A row shows a pack's name and version. When the folder holds several builds of one pack, the row shows the one that fits the unit's OS and, among those, the newest. Newest means the newest date (created, modified or added, with the unit's own clock taken into account), not the highest version number, since a republished pack can start again at version 1. Every pack is compared byte for byte, so a copy on the unit counts as the file it was copied from: its date on the unit is only when it was sent. The other builds are behind the copies button on the row, where you can pick one by hand.

A pack that needs another pack cannot be staged alone. The page offers to stage both, or says that the pack it needs is not in the folder. A pack built for another OS than 1.7.3 is marked **Wrong OS**: the loader leaves it out, so it cannot be staged, and a 1.7.3 build of the same pack in the folder is used instead. Packs already on the unit that were built for another OS are listed, with one button to remove them.

## Slots

The loader looks at 32 pack files. The page shows 32 slots: blue for packs already on the unit, green for packs this copy adds, red for any over the limit. Staging stops at the limit and says why. If the unit's loader log reports a different limit, the page follows it.

## Removing

A pack on the unit can be removed from the unit from the copies button on its row. Staging a pack that the unit already holds under another file name also stages that file's removal, since the new file replaces it; unstaging puts it back. Before any file on the unit is removed or replaced, the page copies it here unless the folder already holds those exact bytes, so nothing that only the unit has is lost. With no folder chosen, it stays on the unit. A different file of the same name is left where it is, and the unit's copy is written beside it.

## Firmware and logs

`.ldr` is a firmware file. The page can put it on the unit's drive; it is not installed by the page. Firmware and packs can go in the same copy: `os.ldr`, the spacer the installer needs, and the packs. A pack on its own does not send firmware. Sending a firmware file can put `mtp-1f-pad.bin` on the drive, and a few tiny `park` files. The size is what matters. The file itself is an ordinary pattern, and a copy that does not include a firmware file does not add one. If that name is already there, the next free name is used. An older `padd.ing` in the folder on this computer is removed once. A pad file already on the unit under a different name is left where it is.

A log is a `log_*.txt`, or a `.txt` directly inside a folder named `logs`. New logs on the unit are staged to be copied to this computer. Turn any off, or all of them, with the logs list's own toggle.

A copy names the file that is moving and how far through that file it is. After the copy the disk is read again.

## What is in this repository

The page is `index.html`, `style.css`, `app.js`, `mtp.js`, and `volume.js`. There is no firmware here, original or otherwise, and no copy of a unit's files. What the page can and cannot reach is in [SECURITY.md](SECURITY.md).

## Scope

Developed and tested on macOS using Chrome.

PRs and Forks welcome. This project does not support file patching.

## Licence

MIT: [LICENSE](LICENSE).
