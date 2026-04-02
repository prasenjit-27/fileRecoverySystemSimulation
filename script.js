var TOTAL_BLOCKS = 256;
var BLOCK_SIZE_KB = 4;
var CHARS_PER_BLOCK = BLOCK_SIZE_KB * 256;
var TOTAL_SIZE_KB = TOTAL_BLOCKS * BLOCK_SIZE_KB;
var SUPERBLOCK_COUNT = 2;
var STEP_DELAY = 80;

var diskBlocks, files, nextFileId, openFileId, ioStats, totalRecovered, zoomLevel, isBusy;

var $ = function(id) { return document.getElementById(id); };
var fileListEl = $('file-list');
var diskEl = $('disk-container');
var journalEl = $('journal-list');
var tooltipEl = $('block-tooltip');
var rwPanel = $('rw-panel');
var recoveryPanel = $('recovery-panel');
var pieCanvas = $('pie-chart');
var modalEl = $('modal-new-file');

function initState() {
    diskBlocks = new Array(TOTAL_BLOCKS).fill('free');
    diskBlocks[0] = 'superblock';
    diskBlocks[1] = 'superblock';
    files = [];
    nextFileId = 1;
    openFileId = null;
    ioStats = { reads: 0, writes: 0, bytesRead: 0, bytesWritten: 0, syscalls: 0, recoveries: 0 };
    totalRecovered = 0;
    zoomLevel = 1.25;
    isBusy = false;
    rwPanel.style.display = 'none';
    recoveryPanel.style.display = 'none';
}

function init() {
    initState();
    journalEl.innerHTML = '';
    addLog('system', 'SYSTEM RESET', 'SIMFS v3.0 journaling filesystem initialized');
    addLog('system', 'mount()', '/dev/sda1 mounted, journal replay: clean');
    renderAll();
}

function addLog(type, syscall, detail) {
    var t = new Date();
    var ts = t.toTimeString().slice(0, 8) + '.' + String(t.getMilliseconds()).padStart(3, '0');
    var e = document.createElement('div');
    e.className = 'journal-entry ' + type;
    e.innerHTML = '<span class="log-time">' + ts + '</span><span class="log-syscall">' + syscall + '</span><span class="log-detail">' + detail + '</span>';
    journalEl.appendChild(e);
    journalEl.scrollTop = journalEl.scrollHeight;
    ioStats.syscalls++;
    updateIO();
}

function getFreeBlocks() {
    var r = [];
    for (var i = 0; i < TOTAL_BLOCKS; i++) { if (diskBlocks[i] === 'free') r.push(i); }
    return r;
}

function shuffleArray(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
}

function allocBlocksRandom(n) {
    var free = shuffleArray(getFreeBlocks());
    return free.length >= n ? free.slice(0, n) : null;
}

function findOwner(idx) {
    for (var i = 0; i < files.length; i++) {
        if (files[i].blocks.indexOf(idx) !== -1) return files[i];
    }
    return null;
}

function hlBlock(idx, dur) {
    dur = dur || 500;
    var el = diskEl.children[idx];
    if (el) { el.classList.add('highlight'); setTimeout(function() { el.classList.remove('highlight'); }, dur); }
}

function setBlockCls(idx, cls) {
    var el = diskEl.children[idx];
    if (!el) return;
    el.className = 'disk-block ' + cls;
}

function fmtBytes(b) {
    if (b === 0) return '0 B';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(2) + ' MB';
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function getBlockData(file, blockIdx) {
    if (!file.content || file.content.length === 0) return null;
    var numBlocks = file.blocks.length;
    if (numBlocks <= 0) return null;
    var charsPerBlock = Math.max(1, Math.ceil(file.content.length / numBlocks));
    var start = blockIdx * charsPerBlock;
    if (start >= file.content.length) return null;
    var end = Math.min(start + charsPerBlock, file.content.length);
    var data = file.content.substring(start, end);
    var clean = data.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (clean.length === 0) return null;
    return clean;
}

function getBlockDisplayText(file, blockIdx) {
    var data = getBlockData(file, blockIdx);
    if (!data) return null;
    return data.substring(0, 50);
}

function calcBlockFontSize(zoom, textLen) {
    var base = Math.round(9 * zoom);
    if (textLen <= 6) return Math.max(7, base);
    if (textLen <= 12) return Math.max(6, Math.round(base * 0.9));
    if (textLen <= 20) return Math.max(5, Math.round(base * 0.8));
    return Math.max(5, Math.round(base * 0.7));
}

function createFile(name, sizeKB) {
    var needed = Math.ceil(sizeKB / BLOCK_SIZE_KB);
    var blks = allocBlocksRandom(needed);
    if (!blks) { addLog('error', 'create()', 'ENOSPC: need ' + needed + ' blocks for "' + name + '"'); return false; }
    blks.forEach(function(b) { diskBlocks[b] = 'allocated'; });
    var file = { id: nextFileId++, name: name, sizeKB: sizeKB, reservedKB: sizeKB, blocks: blks, content: '', crashed: false, damagedBlocks: [], intactBlocks: [], everRecovered: false };
    files.push(file);
    blks.forEach(function(b) { hlBlock(b); });
    addLog('create', 'open()', 'open("' + name + '", O_CREAT | O_RDWR, 0644)');
    addLog('system', 'journal_write()', 'journal: CREATE "' + name + '" committed');
    renderAll();
    return true;
}

function deleteFile(id) {
    var f = null;
    for (var i = 0; i < files.length; i++) { if (files[i].id === id) { f = files[i]; break; } }
    if (!f) return;
    f.blocks.forEach(function(b) { diskBlocks[b] = 'free'; hlBlock(b); });
    files = files.filter(function(x) { return x.id !== id; });
    if (openFileId === id) { openFileId = null; rwPanel.style.display = 'none'; }
    addLog('delete', 'unlink()', '"' + f.name + '" freed...' + f.blocks.length + ' blocks');
    renderAll();
}

function openFile(id) {
    var f = null;
    for (var i = 0; i < files.length; i++) { if (files[i].id === id) { f = files[i]; break; } }
    if (!f) return;
    openFileId = id;
    rwPanel.style.display = 'block';
    $('rw-panel-title').textContent = f.name;
    $('rw-filename').textContent = f.name;
    $('rw-size').textContent = f.blocks.length + ' blk \u00b7 ' + (f.blocks.length * BLOCK_SIZE_KB) + ' KB';
    if (f.crashed) {
        $('rw-status').textContent = 'DAMAGED ' + f.damagedBlocks.length + '/' + f.blocks.length;
        $('rw-status').className = 'rw-status status-partial';
        $('file-content').value = '';
        $('file-content').disabled = true;
    } else {
        $('rw-status').textContent = 'OK';
        $('rw-status').className = 'rw-status status-ok';
        $('file-content').value = f.content || '(empty)';
        $('file-content').disabled = false;
    }
    addLog('open', 'open()', 'open("' + f.name + '", O_RDWR) = ' + f.id);
    f.blocks.forEach(function(b) { hlBlock(b); });
    renderFileList();
}

function closeFile() {
    if (openFileId === null) return;
    var f = null;
    for (var i = 0; i < files.length; i++) { if (files[i].id === openFileId) { f = files[i]; break; } }
    addLog('close', 'close()', 'fd=' + openFileId + ' "' + (f ? f.name : '?') + '"');
    openFileId = null;
    rwPanel.style.display = 'none';
    $('file-content').disabled = false;
    renderFileList();
}

function readFile() {
    if (openFileId === null) return;
    var f = null;
    for (var i = 0; i < files.length; i++) { if (files[i].id === openFileId) { f = files[i]; break; } }
    if (!f) return;
    if (f.crashed) { addLog('error', 'read()', 'EIO: "' + f.name + '" has damaged blocks -- cannot read'); return; }
    addLog('read', 'read()', 'read(' + f.id + ', buffer, ' + f.content.length + ')');
    $('file-content').value = f.content || '(empty)';
    ioStats.reads++;
    ioStats.bytesRead += f.content.length;
    f.blocks.forEach(function(b, i) { setTimeout(function() { hlBlock(b, 400); }, i * 30); });
    addLog('read', 'read() ->', f.content.length + ' bytes from "' + f.name + '"');
    updateIO();
}

function writeFile() {
    if (openFileId === null) return;
    var f = null;
    for (var i = 0; i < files.length; i++) { if (files[i].id === openFileId) { f = files[i]; break; } }
    if (!f) return;
    if (f.crashed) { addLog('error', 'write()', 'EIO: "' + f.name + '" damaged -- recover first'); return; }

    var txt = $('file-content').value;
    var needed = Math.max(1, Math.ceil(txt.length / CHARS_PER_BLOCK));
    var current = f.blocks.length;

    addLog('write', 'write()', 'write(' + f.id + ', buffer, ' + txt.length + ')');

    if (needed > current) {
        var extra = allocBlocksRandom(needed - current);
        if (!extra) { addLog('error', 'write()', 'ENOSPC: need ' + (needed - current) + ' more blocks'); return; }
        extra.forEach(function(b) { diskBlocks[b] = 'allocated'; });
        f.blocks = f.blocks.concat(extra);
        addLog('write', 'fallocate()', '+' + extra.length + ' blocks [' + extra.join(',') + '] for "' + f.name + '"');
    }

    f.content = txt;
    f.sizeKB = f.blocks.length * BLOCK_SIZE_KB;
    ioStats.writes++;
    ioStats.bytesWritten += txt.length;

    f.blocks.forEach(function(b, i) { setTimeout(function() { hlBlock(b, 400); }, i * 30); });

    var perBlock = f.blocks.length > 0 ? Math.ceil(txt.length / f.blocks.length) : 0;
    addLog('system', 'journal_write()', 'journal: WRITE "' + f.name + '" ' + txt.length + ' bytes across ' + f.blocks.length + ' blocks (~' + perBlock + ' bytes/block)');
    addLog('write', 'write() ->', 'wrote ' + txt.length + ' bytes to "' + f.name + '" (' + f.blocks.length + ' blocks, no merge)');
    $('rw-size').textContent = f.blocks.length + ' blk \u00b7 ' + f.sizeKB + ' KB';
    renderAll();
}

function allocateRandom() {
    if (isBusy) return;
    var names = ['data.bin', 'log.txt', 'cfg.ini', 'img.dat', 'tmp.cache', 'idx.map', 'bak.tar', 'raw.dump', 'pkg.gz', 'db.sql'];
    var free = getFreeBlocks().length;
    if (free < 1) { addLog('error', 'create()', 'ENOSPC: no free blocks'); return; }
    var cnt = Math.floor(Math.random() * Math.min(free, 16)) + 1;
    var sizeKB = cnt * BLOCK_SIZE_KB;
    var name = names[Math.floor(Math.random() * names.length)] + '_' + Date.now().toString(36).slice(-4);
    var ok = createFile(name, sizeKB);
    if (ok) {
        var f = files[files.length - 1];
        if (f) {
            var content = '';
            for (var bi = 0; bi < cnt; bi++) {
                content += '[Blk' + bi + '] ' + f.name + ' data chunk\nCreated: ' + new Date().toISOString() + '\n';
            }
            f.content = content;
        }
        renderAll();
    }
}

async function optimizeSystem() {
    if (isBusy) return;
    var crashedFiles = files.filter(function(f) { return f.crashed; });
    var damagedOrphan = [];
    for (var i = 0; i < TOTAL_BLOCKS; i++) {
        if (diskBlocks[i] === 'damaged') {
            var owner = findOwner(i);
            if (!owner || !owner.crashed) damagedOrphan.push(i);
        }
    }
    if (crashedFiles.length === 0 && damagedOrphan.length === 0) {
        addLog('optimize', 'ioctl()', 'ioctl(fd, FS_IOC_DEFRAG)');
        await defragment();
        return;
    }
    isBusy = true;
    addLog('optimize', 'fsck()', 'Found ' + crashedFiles.length + ' crashed, ' + damagedOrphan.length + ' orphan damaged');
    for (var ci = 0; ci < crashedFiles.length; ci++) {
        var cf = crashedFiles[ci];
        addLog('optimize', 'unlink()', 'Removing crashed "' + cf.name + '" (' + cf.blocks.length + ' blocks)');
        cf.blocks.forEach(function(b) { diskBlocks[b] = 'free'; hlBlock(b, 300); });
        await sleep(25);
    }
    files = files.filter(function(x) { return !x.crashed; });
    if (openFileId) { var still = false; for (var xi = 0; xi < files.length; xi++) { if (files[xi].id === openFileId) { still = true; break; } } if (!still) { openFileId = null; rwPanel.style.display = 'none'; } }
    if (damagedOrphan.length > 0) {
        addLog('optimize', 'ioctl(BLKRRPART)', 'Clearing ' + damagedOrphan.length + ' orphan damaged blocks');
        damagedOrphan.forEach(function(b) { diskBlocks[b] = 'free'; hlBlock(b, 300); });
        await sleep(25);
    }
    addLog('optimize', 'fsck() ->', 'Clean');
    await defragment();
    isBusy = false;
    renderAll();
}

async function defragment() {
    var healthy = files.filter(function(f) { return !f.crashed; });
    if (healthy.length === 0) { addLog('optimize', 'ioctl(DEFRAG) ->', 'Nothing to defragment'); renderAll(); return; }
    addLog('optimize', 'ioctl(DEFRAG)', 'Defragmenting ' + healthy.length + ' file(s)...');
    var ptr = SUPERBLOCK_COUNT;
    for (var fi = 0; fi < healthy.length; fi++) {
        var f = healthy[fi];
        var newBlks = [];
        for (var bi = 0; bi < f.blocks.length; bi++) newBlks.push(ptr + bi);
        f.blocks.forEach(function(b) { if (diskBlocks[b] === 'allocated') diskBlocks[b] = 'free'; });
        newBlks.forEach(function(b) { diskBlocks[b] = 'allocated'; hlBlock(b, 350); });
        addLog('optimize', 'block_move()', '"' + f.name + '": [' + f.blocks.join(',') + '] -> [' + newBlks.join(',') + ']');
        f.blocks = newBlks;
        ptr += f.blocks.length;
        await sleep(20);
    }
    addLog('optimize', 'ioctl(DEFRAG) ->', healthy.length + ' file(s) compacted');
    addLog('system', 'sync()', 'Disk sync');
    renderAll();
}

async function crashSystem() {
    if (isBusy) return;
    var healthy = files.filter(function(f) { return !f.crashed; });
    if (healthy.length === 0) { addLog('error', 'crash()', 'No healthy files to crash'); return; }
    isBusy = true;
    addLog('crash', 'PANIC', 'Kernel panic -- I/O error on /dev/sda1');
    var totalHit = 0;
    for (var fi = 0; fi < healthy.length; fi++) {
        var f = healthy[fi];
        var blkCount = f.blocks.length;
        var minHit = Math.max(1, Math.ceil(blkCount * 0.3));
        var maxHit = Math.max(minHit, Math.floor(blkCount * 0.6));
        var hitCount = minHit + Math.floor(Math.random() * (maxHit - minHit + 1));
        var shuffled = shuffleArray(f.blocks.slice());
        var hit = shuffled.slice(0, hitCount).sort(function(a, b) { return a - b; });
        var intact = shuffled.slice(hitCount).sort(function(a, b) { return a - b; });
        hit.forEach(function(b) { diskBlocks[b] = 'damaged'; });
        f.crashed = true;
        f.damagedBlocks = hit;
        f.intactBlocks = intact;
        totalHit += hitCount;
        hit.forEach(function(b, i) { setTimeout(function() { hlBlock(b, 700); }, i * 20); });
        await sleep(15);
        addLog('crash', 'ioctl(BLKDISCARD)', '"' + f.name + '": ' + hitCount + '/' + blkCount + ' damaged [' + hit.join(',') + ']');
        addLog('crash', 'ioctl(BLKDISCARD)', '"' + f.name + '": ' + intact.length + ' intact [' + intact.join(',') + ']');
    }
    addLog('crash', 'PANIC', healthy.length + ' file(s), ' + totalHit + ' blocks damaged');
    addLog('system', 'journal_check()', 'Journal intact: ' + healthy.length + ' file(s) recoverable');
    if (openFileId) {
        var of = null;
        for (var oi = 0; oi < files.length; oi++) { if (files[oi].id === openFileId && files[oi].crashed) { of = files[oi]; break; } }
        if (of) { $('rw-status').textContent = 'DAMAGED ' + of.damagedBlocks.length + '/' + of.blocks.length; $('rw-status').className = 'rw-status status-partial'; $('file-content').value = ''; $('file-content').disabled = true; }
    }
    isBusy = false;
    renderAll();
}

async function recoverSystem() {
    if (isBusy) return;

    var crashed = files.filter(function(f) { return f.crashed; });
    if (crashed.length === 0) {
        addLog('recover', 'fsck()', 'No crashed files -- system healthy');
        return;
    }

    isBusy = true;
    recoveryPanel.style.display = 'block';

    var fileIdx = 0;

    for (var fi = 0; fi < crashed.length; fi++) {
        var f = crashed[fi];
        fileIdx++;

        var damaged = f.damagedBlocks.slice();
        var intact = f.intactBlocks.slice();

        $('recovery-file-name').textContent =
            '[' + fileIdx + '/' + crashed.length + '] ' + f.name;

        $('recovery-bar-fill').style.width = '0%';
        $('recovery-pct').textContent = '0%';
        $('recovery-steps').innerHTML = '';

        addLog('recover', 'fsck()', '"' + f.name + '" -- ' + damaged.length + ' damaged, ' + intact.length + ' intact');

        await sleep(STEP_DELAY);

        /* ================= STEP 1 ================= */
        addStep('[1/6] Scanning damaged blocks...');
        addLog('recover', 'blkid()', 'Scanning [' + damaged.join(',') + ']');

        damaged.forEach(function(b) {
            setBlockCls(b, 'damaged');
        });

        setProgress(10);
        await sleep(STEP_DELAY * 2);

        /* ================= STEP 2 ================= */
        addStep('[2/6] Verifying journal...');
        addLog('recover', 'journal_verify()', 'Checking journal for inode ' + f.id);

        setProgress(20);
        await sleep(STEP_DELAY * 2);

        addLog('recover', 'journal_verify() ->', f.content.length + ' bytes recoverable');
        markDone();

        addStep('[2/6] Journal OK');
        setProgress(30);
        await sleep(STEP_DELAY);

        /* ================= STEP 3 ================= */
        addStep('[3/6] Preparing in-place recovery...');
        addLog('recover', 'alloc_blocks()', 'In-place recovery (no reallocation)');

        setProgress(40);
        await sleep(STEP_DELAY);

        /* ================= STEP 4 ================= */
        addStep('[4/6] Repairing damaged blocks in-place...');

        for (var ri = 0; ri < damaged.length; ri++) {
    var blk = damaged[ri];

    setBlockCls(blk, 'recovering');

    addLog(
        'recover',
        'block_repair()',
        '#' + blk + ' repaired in-place (' + BLOCK_SIZE_KB + ' KB)'
    );

    await sleep(STEP_DELAY);

    // ✅ UPDATE STATE HERE
    diskBlocks[blk] = 'allocated';

    setBlockCls(blk, 'recovered-flash');

    setTimeout((function(b) {
        return function() {
            var el = diskEl.children[b];
            if (!el) return;

            el.classList.remove('damaged', 'recovering', 'recovered-flash');
            el.className = 'disk-block allocated';
        };
    })(blk), 500);

    setProgress(40 + Math.round(((ri + 1) / damaged.length) * 30));
}

        markDone();
        addStep('[4/6] ' + damaged.length + ' blocks repaired in-place');

        setProgress(70);
        await sleep(STEP_DELAY);

        /* ================= STEP 5 ================= */
        addStep('[5/6] Repairing inode...');
        addLog(
            'recover',
            'inode_repair()',
            'inode ' + f.id + ': in-place recovery, no remap'
        );

        setProgress(88);
        await sleep(STEP_DELAY);

        markDone();
        addStep('[5/6] Inode repaired');

        await sleep(STEP_DELAY);

        /* ================= STEP 6 ================= */
        addStep('[6/6] Syncing...');
        addLog('recover', 'sync()', 'Flushing "' + f.name + '"');

        setProgress(95);
        await sleep(STEP_DELAY * 2);

        /* FINALIZE */
        f.crashed = false;
        f.damagedBlocks = [];
        f.intactBlocks = [];
        f.everRecovered = true;

        totalRecovered++;
        ioStats.recoveries++;

        setProgress(100);
        $('recovery-pct').textContent = '100%';

        markDone();
        addStep('[6/6] 100% recovered');

        addLog(
            'recover-done',
            'fsck() ->',
            '"' + f.name + '" RECOVERED 100% -- ' +
            f.content.length + ' bytes across ' +
            f.blocks.length + ' blocks (in-place)'
        );

        /* Visual flash */
        f.blocks.forEach(function(b, i) {
            setTimeout(function() {
                var el = diskEl.children[b];
                if (el) {
                    el.classList.add('recovered-flash');
                    setTimeout(function() {
                        el.classList.remove('recovered-flash');
                    }, 600);
                }
            }, i * 25);
        });

        /* Restore editor if open */
        if (openFileId === f.id) {
            $('rw-status').textContent = 'OK';
            $('rw-status').className = 'rw-status status-ok';
            $('file-content').value = f.content || '(empty)';
            $('file-content').disabled = false;
            $('rw-size').textContent =
                f.blocks.length + ' blk · ' + f.sizeKB + ' KB';
        }

        renderAll();
        await sleep(STEP_DELAY * 3);
    }

    addLog('recover-done', 'fsck()', crashed.length + ' file(s) restored 100%');

    setTimeout(function() {
        recoveryPanel.style.display = 'none';
    }, 2500);

    isBusy = false;
    renderAll();
}

function addStep(text) { var el = document.createElement('div'); el.className = 'recovery-step active'; el.textContent = text; $('recovery-steps').appendChild(el); $('recovery-steps').scrollTop = $('recovery-steps').scrollHeight; }
function markDone() { var steps = $('recovery-steps').querySelectorAll('.recovery-step.active'); for (var i = 0; i < steps.length; i++) { steps[i].className = 'recovery-step done'; } }
function setProgress(pct) { $('recovery-bar-fill').style.width = pct + '%'; $('recovery-pct').textContent = pct + '%'; }

function formatDisk() {
    if (isBusy) return;
    addLog('format', 'umount()', 'Unmounting /dev/sda1...');
    setTimeout(function() {
        addLog('format', 'mkfs.simfs()', 'Formatting ' + TOTAL_SIZE_KB + ' KB...');
        setTimeout(function() { initState(); journalEl.innerHTML = ''; addLog('format', 'mkfs.simfs() ->', 'Format complete'); addLog('system', 'mount()', '/dev/sda1 mounted'); renderAll(); }, 350);
    }, 250);
}

function renderAll() { renderDisk(); renderFileList(); renderAnalytics(); renderMetadata(); updateIO(); updateZoom(); }

function renderDisk() {
    diskEl.innerHTML = '';
    for (var i = 0; i < TOTAL_BLOCKS; i++) {
        var d = document.createElement('div');
        d.dataset.index = i;

        if (diskBlocks[i] === 'allocated') {
            var owner = findOwner(i);
            if (owner) {
                var blockIdx = owner.blocks.indexOf(i);
                var displayText = getBlockDisplayText(owner, blockIdx);
                if (displayText !== null) {
                    d.className = 'disk-block allocated has-data';
                    d.textContent = displayText;
                    d.style.fontSize = calcBlockFontSize(zoomLevel, displayText.length) + 'px';
                } else {
                    d.className = 'disk-block allocated';
                    d.textContent = i;
                    d.style.fontSize = Math.max(7, Math.round(10 * zoomLevel)) + 'px';
                }
            } else {
                d.className = 'disk-block allocated';
                d.textContent = i;
                d.style.fontSize = Math.max(7, Math.round(10 * zoomLevel)) + 'px';
            }
        } else {
            d.className = 'disk-block ' + diskBlocks[i];
            d.textContent = i;
            d.style.fontSize = Math.max(7, Math.round(10 * zoomLevel)) + 'px';
        }

        d.addEventListener('mouseenter', showTip);
        d.addEventListener('mousemove', moveTip);
        d.addEventListener('mouseleave', hideTip);
        diskEl.appendChild(d);
    }
}

function renderFileList() {
    $('file-count').textContent = files.length;
    if (files.length === 0) { fileListEl.innerHTML = '<div class="empty-files">No files yet</div>'; return; }
    var html = '';
    for (var i = 0; i < files.length; i++) {
        var f = files[i];
        var badge = '';
        if (f.crashed) badge = '<span class="file-badge crashed-badge">CRASHED ' + f.damagedBlocks.length + '/' + f.blocks.length + '</span>';
        else if (f.everRecovered) badge = '<span class="file-badge recovered-badge">RECOVERED</span>';
        else badge = '<span class="file-badge ok-badge">OK</span>';
        html += '<div class="file-item ' + (openFileId === f.id ? 'active ' : '') + (f.crashed ? 'crashed' : '') + '" data-id="' + f.id + '"><span class="file-icon"><i class="fa-solid ' + (f.crashed ? 'fa-triangle-exclamation' : 'fa-file-lines') + '"></i></span><span class="file-name">' + f.name + '</span>' + badge + '<span class="file-size">' + f.blocks.length + ' blk</span><button class="file-del" data-del="' + f.id + '" title="Delete"><i class="fa-solid fa-trash"></i></button></div>';
    }
    fileListEl.innerHTML = html;
    var items = fileListEl.querySelectorAll('.file-item');
    for (var j = 0; j < items.length; j++) { (function(el) { el.addEventListener('click', function(e) { if (!e.target.closest('.file-del')) openFile(+el.dataset.id); }); })(items[j]); }
    var dels = fileListEl.querySelectorAll('[data-del]');
    for (var k = 0; k < dels.length; k++) { (function(el) { el.addEventListener('click', function(e) { e.stopPropagation(); deleteFile(+el.dataset.del); }); })(dels[k]); }
}

function renderAnalytics() {
    var c = { free: 0, superblock: 0, allocated: 0, damaged: 0 };
    for (var i = 0; i < TOTAL_BLOCKS; i++) c[diskBlocks[i]]++;
    $('stat-used').textContent = ((c.allocated + c.superblock) * BLOCK_SIZE_KB) + ' KB';
    $('stat-free').textContent = (c.free * BLOCK_SIZE_KB) + ' KB';
    var hp = ((TOTAL_BLOCKS - c.damaged) / TOTAL_BLOCKS * 100).toFixed(1);
    $('stat-health').textContent = hp + '%';
    $('stat-health').className = 'stat-value ' + (hp >= 95 ? 'green' : hp >= 80 ? 'orange' : 'red');
    $('stat-files').textContent = files.length;
    drawPie(c);
}

function drawPie(c) {
    var ctx = pieCanvas.getContext('2d');
    var w = pieCanvas.width, h = pieCanvas.height;
    var cx = w / 2, cy = h / 2, r = Math.min(cx, cy) - 8, inner = r * 0.58;
    ctx.clearRect(0, 0, w, h);
    var cs = getComputedStyle(document.documentElement);
    var data = [
        { v: c.free, col: cs.getPropertyValue('--block-free-bg').trim() || '#111b27' },
        { v: c.superblock, col: cs.getPropertyValue('--blue').trim() },
        { v: c.allocated, col: cs.getPropertyValue('--accent').trim() },
        { v: c.damaged, col: cs.getPropertyValue('--red').trim() }
    ];
    var total = 0; for (var i = 0; i < data.length; i++) total += data[i].v;
    if (!total) return;
    var start = -Math.PI / 2;
    for (var di = 0; di < data.length; di++) {
        if (!data[di].v) continue;
        var sweep = (data[di].v / total) * Math.PI * 2;
        ctx.beginPath(); ctx.arc(cx, cy, r, start, start + sweep); ctx.arc(cx, cy, inner, start + sweep, start, true); ctx.closePath();
        ctx.fillStyle = data[di].col; ctx.fill();
        ctx.strokeStyle = cs.getPropertyValue('--bg-panel').trim(); ctx.lineWidth = 2; ctx.stroke();
        start += sweep;
    }
    ctx.fillStyle = cs.getPropertyValue('--fg').trim();
    ctx.font = '700 16px "Space Grotesk"'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(((c.allocated + c.superblock) / total * 100).toFixed(0) + '%', cx, cy - 5);
    ctx.fillStyle = cs.getPropertyValue('--fg-dim').trim();
    ctx.font = '600 9px "Space Grotesk"'; ctx.fillText('USED', cx, cy + 10);
}

function renderMetadata() {
    var c = { free: 0, superblock: 0, allocated: 0, damaged: 0 };
    for (var i = 0; i < TOTAL_BLOCKS; i++) c[diskBlocks[i]]++;
    var crashed = 0; for (var j = 0; j < files.length; j++) { if (files[j].crashed) crashed++; }
    var rows = [['Filesystem', 'SIMFS v3.0'], ['Journaling', 'Enabled'], ['Block Size', '4 KB'], ['Total Blocks', '256'], ['Free Blocks', c.free], ['Used Blocks', c.allocated + c.superblock], ['Damaged', c.damaged], ['Crashed Files', crashed], ['Recovered', totalRecovered], ['Inodes', files.length]];
    var html = ''; for (var r = 0; r < rows.length; r++) html += '<div class="meta-row"><span class="meta-key">' + rows[r][0] + '</span><span class="meta-val">' + rows[r][1] + '</span></div>';
    $('meta-grid').innerHTML = html;
}

function updateIO() {
    var rows = [['Reads', ioStats.reads, ''], ['Writes', ioStats.writes, ''], ['Bytes Read', fmtBytes(ioStats.bytesRead), ''], ['Bytes Written', fmtBytes(ioStats.bytesWritten), ''], ['Syscalls', ioStats.syscalls, ''], ['Recoveries', ioStats.recoveries, 'cyan-val']];
    var html = ''; for (var i = 0; i < rows.length; i++) html += '<div class="io-row"><span class="io-label">' + rows[i][0] + '</span><span class="io-value ' + rows[i][2] + '">' + rows[i][1] + '</span></div>';
    $('io-grid').innerHTML = html;
}

function showTip(e) {
    var i = +e.target.dataset.index;
    var s = diskBlocks[i];
    var owner = '\u2014';
    if (s === 'allocated' || s === 'damaged') { var f = findOwner(i); if (f) { owner = f.name + (f.crashed ? ' [DAMAGED]' : ''); } else owner = '?'; }
    if (s === 'superblock') owner = 'FS Metadata';
    var cols = { free: 'var(--fg-dim)', superblock: 'var(--blue)', allocated: 'var(--accent)', damaged: 'var(--red)' };

    var dataBlock = '';
    if (s === 'allocated') {
        var f2 = findOwner(i);
        if (f2) {
            var bIdx = f2.blocks.indexOf(i);
            var blockData = getBlockData(f2, bIdx);
            if (blockData !== null) {
                dataBlock = '<div class="tooltip-data">Block ' + bIdx + ' data:<br>' + blockData.substring(0, 120) + (blockData.length > 120 ? '...' : '') + '</div>';
            } else {
                dataBlock = '<div class="tooltip-data">Block ' + bIdx + ': (empty)</div>';
            }
        }
    }

    tooltipEl.innerHTML = '<div class="tooltip-row"><span class="tooltip-key">Block</span><span class="tooltip-val">#' + i + '</span></div><div class="tooltip-row"><span class="tooltip-key">Offset</span><span class="tooltip-val">' + (i * 4) + ' KB</span></div><div class="tooltip-row"><span class="tooltip-key">State</span><span class="tooltip-val" style="color:' + (cols[s] || 'var(--fg)') + '">' + s.toUpperCase() + '</span></div><div class="tooltip-row"><span class="tooltip-key">Owner</span><span class="tooltip-val">' + owner + '</span></div>' + dataBlock;
    tooltipEl.style.display = 'block';
    moveTip(e);
}

function moveTip(e) { var x = e.clientX + 12, y = e.clientY + 12; var r = tooltipEl.getBoundingClientRect(); if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 8; if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 8; tooltipEl.style.left = x + 'px'; tooltipEl.style.top = y + 'px'; }
function hideTip() { tooltipEl.style.display = 'none'; }

function updateZoom() {
    var s = Math.round(42 * zoomLevel);
    document.documentElement.style.setProperty('--block-size', s + 'px');
    var blocks = diskEl.querySelectorAll('.disk-block');
    for (var i = 0; i < blocks.length; i++) {
        var el = blocks[i];
        if (el.classList.contains('has-data')) {
            el.style.fontSize = calcBlockFontSize(zoomLevel, el.textContent.length) + 'px';
        } else {
            el.style.fontSize = Math.max(7, Math.round(10 * zoomLevel)) + 'px';
        }
    }
    $('zoom-level').textContent = Math.round(zoomLevel * 100) + '%';
}

function toggleTheme() { var html = document.documentElement; var isDark = html.getAttribute('data-theme') === 'dark'; html.setAttribute('data-theme', isDark ? 'light' : 'dark'); $('theme-icon').className = isDark ? 'fa-solid fa-sun' : 'fa-solid fa-moon'; var c = { free: 0, superblock: 0, allocated: 0, damaged: 0 }; for (var i = 0; i < TOTAL_BLOCKS; i++) c[diskBlocks[i]]++; drawPie(c); }

function showModal() { modalEl.style.display = 'flex'; $('input-filename').value = ''; $('input-filesize').value = '8'; setTimeout(function() { $('input-filename').focus(); }, 80); }
function hideModal() { modalEl.style.display = 'none'; }

function confirmCreate() {
    var name = $('input-filename').value.trim();
    var size = parseInt($('input-filesize').value);
    if (!name) { addLog('error', 'create()', 'EINVAL: empty filename'); hideModal(); return; }
    if (!/^[a-zA-Z0-9_.\-]+$/.test(name)) { addLog('error', 'create()', 'EINVAL: bad chars'); hideModal(); return; }
    var exists = false; for (var i = 0; i < files.length; i++) { if (files[i].name === name) { exists = true; break; } }
    if (exists) { addLog('error', 'create()', 'EEXIST: "' + name + '"'); hideModal(); return; }
    if (isNaN(size) || size < 1) { addLog('error', 'create()', 'EINVAL: invalid size'); hideModal(); return; }
    addLog('system', 'stat()', 'Checking "' + name + '" (' + size + ' KB)');
    createFile(name, size);
    hideModal();
}

 $('btn-new-file').addEventListener('click', showModal);
 $('btn-allocate-random').addEventListener('click', allocateRandom);
 $('btn-optimize').addEventListener('click', optimizeSystem);
 $('btn-crash-system').addEventListener('click', crashSystem);
 $('btn-recover-system').addEventListener('click', recoverSystem);
 $('btn-reset').addEventListener('click', init);
 $('btn-format').addEventListener('click', formatDisk);
 $('btn-write').addEventListener('click', writeFile);
 $('btn-read').addEventListener('click', readFile);
 $('btn-close-file').addEventListener('click', closeFile);
 $('btn-theme').addEventListener('click', toggleTheme);
 $('btn-clear-log').addEventListener('click', function() { journalEl.innerHTML = ''; addLog('system', 'clear()', 'Log cleared'); });
 $('modal-close-new').addEventListener('click', hideModal);
 $('modal-cancel-new').addEventListener('click', hideModal);
 $('modal-confirm-new').addEventListener('click', confirmCreate);
 $('input-filename').addEventListener('keydown', function(e) { if (e.key === 'Enter') confirmCreate(); });
 $('input-filesize').addEventListener('keydown', function(e) { if (e.key === 'Enter') confirmCreate(); });
modalEl.addEventListener('click', function(e) { if (e.target === modalEl) hideModal(); });
 $('btn-zoom-in').addEventListener('click', function() { zoomLevel = Math.min(2.5, zoomLevel + 0.25); updateZoom(); });
 $('btn-zoom-out').addEventListener('click', function() { zoomLevel = Math.max(0.4, zoomLevel - 0.25); updateZoom(); });
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') { if (modalEl.style.display === 'flex') hideModal(); else if (openFileId !== null) closeFile(); } });

init();