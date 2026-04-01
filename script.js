const TOTAL_BLOCKS = 256;
const BLOCK_SIZE_KB = 4;
const TOTAL_SIZE_KB = TOTAL_BLOCKS * BLOCK_SIZE_KB;
const SUPERBLOCK_COUNT = 2;
const STEP_DELAY = 80;

let diskBlocks, files, nextFileId, openFileId, ioStats, totalRecovered, zoomLevel, isBusy;

const $ = id => document.getElementById(id);
const fileListEl = $('file-list');
const diskEl = $('disk-container');
const journalEl = $('journal-list');
const tooltipEl = $('block-tooltip');
const rwPanel = $('rw-panel');
const recoveryPanel = $('recovery-panel');
const pieCanvas = $('pie-chart');
const modalEl = $('modal-new-file');

function initState() {
    diskBlocks = new Array(TOTAL_BLOCKS).fill('free');
    diskBlocks[0] = 'superblock';
    diskBlocks[1] = 'superblock';
    files = [];
    nextFileId = 1;
    openFileId = null;
    ioStats = { reads: 0, writes: 0, bytesRead: 0, bytesWritten: 0, syscalls: 0, recoveries: 0 };
    totalRecovered = 0;
    zoomLevel = 1;
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
    const t = new Date();
    const ts = t.toTimeString().slice(0, 8) + '.' + String(t.getMilliseconds()).padStart(3, '0');
    const e = document.createElement('div');
    e.className = 'journal-entry ' + type;
    e.innerHTML = '<span class="log-time">' + ts + '</span><span class="log-syscall">' + syscall + '</span><span class="log-detail">' + detail + '</span>';
    journalEl.appendChild(e);
    journalEl.scrollTop = journalEl.scrollHeight;
    ioStats.syscalls++;
    updateIO();
}

function getFreeBlocks() {
    const r = [];
    for (let i = 0; i < TOTAL_BLOCKS; i++) if (diskBlocks[i] === 'free') r.push(i);
    return r;
}

function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function allocBlocksRandom(n) {
    const free = shuffleArray(getFreeBlocks());
    return free.length >= n ? free.slice(0, n) : null;
}

function findOwner(idx) {
    return files.find(f => f.blocks.includes(idx)) || null;
}

function hlBlock(idx, dur) {
    dur = dur || 500;
    const el = diskEl.children[idx];
    if (el) { el.classList.add('highlight'); setTimeout(() => el.classList.remove('highlight'), dur); }
}

function setBlockCls(idx, cls) {
    const el = diskEl.children[idx];
    if (!el) return;
    el.className = 'disk-block ' + cls;
    el.style.fontSize = Math.max(6, Math.round(9 * zoomLevel)) + 'px';
}

function fmtBytes(b) {
    if (b === 0) return '0 B';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(2) + ' MB';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function createFile(name, sizeKB) {
    const needed = Math.ceil(sizeKB / BLOCK_SIZE_KB);
    const blks = allocBlocksRandom(needed);
    if (!blks) { addLog('error', 'create()', 'ENOSPC: need ' + needed + ' blocks for "' + name + '"'); return false; }
    blks.forEach(b => diskBlocks[b] = 'allocated');
    const file = { id: nextFileId++, name, sizeKB, blocks: blks, content: '', crashed: false, damagedBlocks: [], intactBlocks: [], everRecovered: false };
    files.push(file);
    blks.forEach(b => hlBlock(b));
    addLog('create', 'create()', '"' + name + '" \u2192 ' + needed + ' blocks [' + blks.join(',') + '] (' + sizeKB + ' KB)');
    addLog('system', 'journal_write()', 'journal: CREATE "' + name + '" committed');
    renderAll();
    return true;
}

function deleteFile(id) {
    const f = files.find(x => x.id === id);
    if (!f) return;
    f.blocks.forEach(b => { diskBlocks[b] = 'free'; hlBlock(b); });
    files = files.filter(x => x.id !== id);
    if (openFileId === id) { openFileId = null; rwPanel.style.display = 'none'; }
    addLog('delete', 'unlink()', '"' + f.name + '" freed ' + f.blocks.length + ' blocks');
    renderAll();
}

function openFile(id) {
    const f = files.find(x => x.id === id);
    if (!f) return;
    openFileId = id;
    rwPanel.style.display = 'block';
    $('rw-panel-title').textContent = f.name;
    $('rw-filename').textContent = f.name;
    $('rw-size').textContent = f.sizeKB + ' KB \u00b7 ' + f.blocks.length + ' blk';
    if (f.crashed) {
        const ratio = f.damagedBlocks.length + '/' + f.blocks.length;
        $('rw-status').textContent = 'DAMAGED ' + ratio;
        $('rw-status').className = 'rw-status status-partial';
        $('file-content').value = '';
        $('file-content').disabled = true;
    } else {
        $('rw-status').textContent = 'OK';
        $('rw-status').className = 'rw-status status-ok';
        $('file-content').value = f.content || '(empty)';
        $('file-content').disabled = false;
    }
    addLog('open', 'open()', '"' + f.name + '" fd=' + f.id + ' O_RDWR');
    f.blocks.forEach(b => hlBlock(b));
    renderFileList();
}

function closeFile() {
    if (openFileId === null) return;
    const f = files.find(x => x.id === openFileId);
    addLog('close', 'close()', 'fd=' + openFileId + ' "' + (f ? f.name : '?') + '"');
    openFileId = null;
    rwPanel.style.display = 'none';
    $('file-content').disabled = false;
    renderFileList();
}

function readFile() {
    if (openFileId === null) return;
    const f = files.find(x => x.id === openFileId);
    if (!f) return;
    if (f.crashed) { addLog('error', 'read()', 'EIO: "' + f.name + '" has damaged blocks \u2014 cannot read'); return; }
    addLog('read', 'read()', 'fd=' + f.id + ' count=' + (f.sizeKB * 1024) + ' offset=0');
    $('file-content').value = f.content || '(empty)';
    ioStats.reads++;
    ioStats.bytesRead += f.sizeKB * 1024;
    f.blocks.forEach((b, i) => setTimeout(() => hlBlock(b, 400), i * 30));
    addLog('read', 'read() \u2192', f.content.length + ' bytes from "' + f.name + '"');
    updateIO();
}

function writeFile() {
    if (openFileId === null) return;
    const f = files.find(x => x.id === openFileId);
    if (!f) return;
    if (f.crashed) { addLog('error', 'write()', 'EIO: "' + f.name + '" damaged \u2014 recover first'); return; }
    const txt = $('file-content').value;
    const needed = Math.max(1, Math.ceil(txt.length / (BLOCK_SIZE_KB * 1024)));
    const cur = f.blocks.length;
    addLog('write', 'write()', 'fd=' + f.id + ' count=' + txt.length + ' offset=0');
    if (needed > cur) {
        const extra = allocBlocksRandom(needed - cur);
        if (!extra) { addLog('error', 'write()', 'ENOSPC: need ' + (needed - cur) + ' more blocks'); return; }
        extra.forEach(b => diskBlocks[b] = 'allocated');
        f.blocks.push(...extra);
        f.sizeKB = needed * BLOCK_SIZE_KB;
        addLog('write', 'fallocate()', '+' + extra.length + ' blocks [' + extra.join(',') + ']');
    } else if (needed < cur) {
        const freed = f.blocks.splice(needed);
        freed.forEach(b => diskBlocks[b] = 'free');
        f.sizeKB = needed * BLOCK_SIZE_KB;
        addLog('write', 'fallocate()', '-' + freed.length + ' blocks freed');
    }
    f.content = txt;
    ioStats.writes++;
    ioStats.bytesWritten += txt.length;
    f.blocks.forEach((b, i) => setTimeout(() => hlBlock(b, 400), i * 30));
    addLog('system', 'journal_write()', 'journal: WRITE "' + f.name + '" ' + txt.length + ' bytes');
    $('rw-size').textContent = f.sizeKB + ' KB \u00b7 ' + f.blocks.length + ' blk';
    renderAll();
}

function allocateRandom() {
    if (isBusy) return;
    const names = ['data.bin', 'log.txt', 'cfg.ini', 'img.dat', 'tmp.cache', 'idx.map', 'bak.tar', 'raw.dump', 'pkg.gz', 'db.sql'];
    const free = getFreeBlocks().length;
    if (free < 1) { addLog('error', 'create()', 'ENOSPC: no free blocks'); return; }
    const n = Math.min(free, 20);
    const cnt = Math.floor(Math.random() * n) + 1;
    const name = names[Math.floor(Math.random() * names.length)] + '_' + Date.now().toString(36).slice(-4);
    const ok = createFile(name, cnt * BLOCK_SIZE_KB);
    if (ok) {
        const f = files[files.length - 1];
        if (f) {
            f.content = '[' + f.name + '] created ' + new Date().toISOString() + '\nJournal-protected content block.\n'.repeat(Math.max(1, cnt));
        }
    }
}

async function optimizeSystem() {
    if (isBusy) return;
    const crashedFiles = files.filter(f => f.crashed);
    const damagedOrphan = [];
    for (let i = 0; i < TOTAL_BLOCKS; i++) {
        if (diskBlocks[i] === 'damaged') {
            const owner = findOwner(i);
            if (!owner || !owner.crashed) damagedOrphan.push(i);
        }
    }
    if (crashedFiles.length === 0 && damagedOrphan.length === 0) {
        addLog('optimize', 'ioctl(DEFRAG)', 'Starting defragmentation...');
        await defragment();
        return;
    }
    isBusy = true;
    addLog('optimize', 'fsck()', 'Found ' + crashedFiles.length + ' crashed file(s), ' + damagedOrphan.length + ' orphan damaged block(s)');
    for (const f of crashedFiles) {
        addLog('optimize', 'unlink()', 'Removing crashed "' + f.name + '" (' + f.blocks.length + ' blocks)');
        f.blocks.forEach(b => { diskBlocks[b] = 'free'; hlBlock(b, 300); });
        await sleep(25);
    }
    files = files.filter(f => !f.crashed);
    if (openFileId && !files.find(f => f.id === openFileId)) { openFileId = null; rwPanel.style.display = 'none'; }
    if (damagedOrphan.length > 0) {
        addLog('optimize', 'ioctl(BLKRRPART)', 'Clearing ' + damagedOrphan.length + ' orphan damaged blocks');
        damagedOrphan.forEach(b => { diskBlocks[b] = 'free'; hlBlock(b, 300); });
        await sleep(25);
    }
    addLog('optimize', 'fsck() \u2192', 'Clean: all damaged resources removed');
    await defragment();
    isBusy = false;
    renderAll();
}

async function defragment() {
    const healthy = files.filter(f => !f.crashed);
    if (healthy.length === 0) { addLog('optimize', 'ioctl(DEFRAG) \u2192', 'Nothing to defragment'); renderAll(); return; }
    addLog('optimize', 'ioctl(DEFRAG)', 'Defragmenting ' + healthy.length + ' file(s)...');
    let ptr = SUPERBLOCK_COUNT;
    for (const f of healthy) {
        const newBlks = [];
        for (let i = 0; i < f.blocks.length; i++) newBlks.push(ptr + i);
        f.blocks.forEach(b => { if (diskBlocks[b] === 'allocated') diskBlocks[b] = 'free'; });
        newBlks.forEach(b => { diskBlocks[b] = 'allocated'; hlBlock(b, 350); });
        addLog('optimize', 'block_move()', '"' + f.name + '": [' + f.blocks.join(',') + '] \u2192 [' + newBlks.join(',') + ']');
        f.blocks = newBlks;
        ptr += f.blocks.length;
        await sleep(20);
    }
    addLog('optimize', 'ioctl(DEFRAG) \u2192', 'Defragmentation complete \u2014 ' + healthy.length + ' file(s) compacted');
    addLog('system', 'sync()', 'Disk sync after defragmentation');
    renderAll();
}

async function crashSystem() {
    if (isBusy) return;
    const healthy = files.filter(f => !f.crashed);
    if (healthy.length === 0) { addLog('error', 'crash()', 'No healthy files to crash'); return; }
    isBusy = true;
    addLog('crash', 'PANIC', 'Kernel panic \u2014 I/O error on /dev/sda1');
    let totalHit = 0;
    for (const f of healthy) {
        const blkCount = f.blocks.length;
        const minHit = Math.max(1, Math.ceil(blkCount * 0.3));
        const maxHit = Math.max(minHit, Math.floor(blkCount * 0.6));
        const hitCount = minHit + Math.floor(Math.random() * (maxHit - minHit + 1));
        const shuffled = shuffleArray([...f.blocks]);
        const hit = shuffled.slice(0, hitCount).sort((a, b) => a - b);
        const intact = shuffled.slice(hitCount).sort((a, b) => a - b);
        hit.forEach(b => diskBlocks[b] = 'damaged');
        f.crashed = true;
        f.damagedBlocks = hit;
        f.intactBlocks = intact;
        totalHit += hitCount;
        hit.forEach((b, i) => setTimeout(() => hlBlock(b, 700), i * 20));
        await sleep(15);
        addLog('crash', 'ioctl(BLKDISCARD)', '"' + f.name + '": ' + hitCount + '/' + blkCount + ' blocks damaged [' + hit.join(',') + ']');
        addLog('crash', 'ioctl(BLKDISCARD)', '"' + f.name + '": ' + intact.length + ' blocks still intact [' + intact.join(',') + ']');
    }
    addLog('crash', 'PANIC', 'System crashed: ' + healthy.length + ' file(s), ' + totalHit + ' blocks damaged');
    addLog('system', 'journal_check()', 'Journal intact: ' + healthy.length + ' file(s) recoverable');
    if (openFileId && files.find(f => f.id === openFileId && f.crashed)) {
        const of = files.find(f => f.id === openFileId);
        $('rw-status').textContent = 'DAMAGED ' + of.damagedBlocks.length + '/' + of.blocks.length;
        $('rw-status').className = 'rw-status status-partial';
        $('file-content').value = '';
        $('file-content').disabled = true;
    }
    isBusy = false;
    renderAll();
}

async function recoverSystem() {
    if (isBusy) return;
    const crashed = files.filter(f => f.crashed);
    if (crashed.length === 0) { addLog('recover', 'fsck()', 'No crashed files \u2014 system healthy'); return; }
    isBusy = true;
    recoveryPanel.style.display = 'block';
    let fileIdx = 0;
    for (const f of crashed) {
        fileIdx++;
        const damaged = [...f.damagedBlocks];
        const intact = [...f.intactBlocks];
        $('recovery-file-name').textContent = '[' + fileIdx + '/' + crashed.length + '] ' + f.name;
        $('recovery-bar-fill').style.width = '0%';
        $('recovery-pct').textContent = '0%';
        $('recovery-steps').innerHTML = '';
        addLog('recover', 'fsck()', 'Recovering "' + f.name + '" \u2014 ' + damaged.length + ' damaged, ' + intact.length + ' intact');
        await sleep(STEP_DELAY);
        addStep('[1/6] Scanning damaged blocks...');
        addLog('recover', 'blkid()', 'Scanning [' + damaged.join(',') + ']');
        damaged.forEach(b => setBlockCls(b, 'damaged'));
        setProgress(10);
        await sleep(STEP_DELAY * 2);
        addStep('[2/6] Verifying journal integrity...');
        addLog('recover', 'journal_verify()', 'Checking journal for inode ' + f.id);
        setProgress(20);
        await sleep(STEP_DELAY * 2);
        addLog('recover', 'journal_verify() \u2192', 'OK: ' + f.content.length + ' bytes recoverable for "' + f.name + '"');
        markDone();
        addStep('[2/6] Journal verified \u2014 data intact');
        setProgress(30);
        await sleep(STEP_DELAY);
        addStep('[3/6] Allocating ' + damaged.length + ' replacement blocks...');
        addLog('recover', 'alloc_blocks()', 'Requesting ' + damaged.length + ' free blocks for remap');
        const repl = allocBlocksRandom(damaged.length);
        if (!repl) {
            addLog('error', 'alloc_blocks()', 'ENOSPC: Cannot recover \u2014 no free blocks');
            addStep('[3/6] FAILED: ENOSPC');
            break;
        }
        repl.forEach(b => diskBlocks[b] = 'allocated');
        addLog('recover', 'alloc_blocks() \u2192', 'Got [' + repl.join(',') + ']');
        setProgress(40);
        await sleep(STEP_DELAY);
        addStep('[4/6] Remapping ' + damaged.length + ' blocks & copying data...');
        for (let i = 0; i < damaged.length; i++) {
            const old = damaged[i];
            const nw = repl[i];
            setBlockCls(nw, 'recovering');
            addLog('recover', 'block_remap()', '#' + old + ' \u2192 #' + nw + ' (' + BLOCK_SIZE_KB + ' KB)');
            await sleep(STEP_DELAY);
            setBlockCls(nw, 'recovered-flash');
            setTimeout(() => setBlockCls(nw, 'allocated'), 500);
            diskBlocks[old] = 'free';
            setProgress(40 + Math.round(((i + 1) / damaged.length) * 30));
        }
        markDone();
        addStep('[4/6] All ' + damaged.length + ' blocks remapped, ' + intact.length + ' kept');
        setProgress(70);
        await sleep(STEP_DELAY);
        addStep('[5/6] Repairing inode pointers...');
        addLog('recover', 'inode_repair()', 'inode ' + f.id + ': replace [' + damaged.join(',') + '] \u2192 [' + repl.join(',') + ']');
        const newBlks = [];
        let ri = 0;
        for (const b of f.blocks) {
            if (damaged.includes(b)) newBlks.push(repl[ri++]);
            else newBlks.push(b);
        }
        f.blocks = newBlks;
        setProgress(88);
        await sleep(STEP_DELAY);
        markDone();
        addStep('[5/6] Inode repaired');
        await sleep(STEP_DELAY);
        addStep('[6/6] Syncing to disk...');
        addLog('recover', 'sync()', 'Flushing "' + f.name + '" recovered data');
        setProgress(95);
        await sleep(STEP_DELAY * 2);
        const ok = f.blocks.every(b => diskBlocks[b] === 'allocated');
        f.crashed = false;
        f.damagedBlocks = [];
        f.intactBlocks = [];
        f.everRecovered = true;
        totalRecovered++;
        ioStats.recoveries++;
        setProgress(100);
        $('recovery-pct').textContent = '100%';
        markDone();
        addStep('[6/6] Verified \u2014 100% recovered');
        addLog('recover-done', 'fsck() \u2192', '"' + f.name + '" RECOVERED 100% \u2014 ' + damaged.length + ' remapped, ' + intact.length + ' kept, ' + f.content.length + ' bytes intact');
        f.blocks.forEach((b, i) => {
            setTimeout(() => {
                const el = diskEl.children[b];
                if (el) { el.classList.add('recovered-flash'); setTimeout(() => el.classList.remove('recovered-flash'), 600); }
            }, i * 25);
        });
        if (openFileId === f.id) {
            $('rw-status').textContent = 'OK';
            $('rw-status').className = 'rw-status status-ok';
            $('file-content').value = f.content || '(empty)';
            $('file-content').disabled = false;
            $('rw-size').textContent = f.sizeKB + ' KB \u00b7 ' + f.blocks.length + ' blk';
        }
        renderAll();
        await sleep(STEP_DELAY * 3);
    }
    addLog('recover-done', 'fsck()', 'Full recovery complete: ' + crashed.length + ' file(s) restored 100%');
    setTimeout(() => recoveryPanel.style.display = 'none', 2500);
    isBusy = false;
    renderAll();
}

function addStep(text) {
    const el = document.createElement('div');
    el.className = 'recovery-step active';
    el.textContent = text;
    $('recovery-steps').appendChild(el);
    $('recovery-steps').scrollTop = $('recovery-steps').scrollHeight;
}

function markDone() {
    $('recovery-steps').querySelectorAll('.recovery-step.active').forEach(s => s.className = 'recovery-step done');
}

function setProgress(pct) {
    $('recovery-bar-fill').style.width = pct + '%';
    $('recovery-pct').textContent = pct + '%';
}

function formatDisk() {
    if (isBusy) return;
    addLog('format', 'umount()', 'Unmounting /dev/sda1...');
    setTimeout(() => {
        addLog('format', 'mkfs.simfs()', 'Formatting ' + TOTAL_SIZE_KB + ' KB...');
        setTimeout(() => {
            initState();
            journalEl.innerHTML = '';
            addLog('format', 'mkfs.simfs() \u2192', 'Format complete, journal initialized');
            addLog('system', 'mount()', '/dev/sda1 mounted at /');
            renderAll();
        }, 350);
    }, 250);
}

function renderAll() {
    renderDisk();
    renderFileList();
    renderAnalytics();
    renderMetadata();
    updateIO();
    updateZoom();
}

function renderDisk() {
    diskEl.innerHTML = '';
    const fs = Math.max(6, Math.round(9 * zoomLevel));
    for (let i = 0; i < TOTAL_BLOCKS; i++) {
        const d = document.createElement('div');
        d.className = 'disk-block ' + diskBlocks[i];
        d.textContent = i;
        d.dataset.index = i;
        d.style.fontSize = fs + 'px';
        d.addEventListener('mouseenter', showTip);
        d.addEventListener('mousemove', moveTip);
        d.addEventListener('mouseleave', hideTip);
        diskEl.appendChild(d);
    }
}

function renderFileList() {
    $('file-count').textContent = files.length;
    if (files.length === 0) { fileListEl.innerHTML = '<div class="empty-files">No files yet</div>'; return; }
    fileListEl.innerHTML = files.map(f => {
        let badge = '';
        if (f.crashed) {
            badge = '<span class="file-badge crashed-badge">CRASHED ' + f.damagedBlocks.length + '/' + f.blocks.length + '</span>';
        } else if (f.everRecovered) {
            badge = '<span class="file-badge recovered-badge">RECOVERED</span>';
        } else {
            badge = '<span class="file-badge ok-badge">OK</span>';
        }
        return '<div class="file-item ' + (openFileId === f.id ? 'active ' : '') + (f.crashed ? 'crashed' : '') + '" data-id="' + f.id + '">' +
            '<span class="file-icon"><i class="fa-solid ' + (f.crashed ? 'fa-triangle-exclamation' : 'fa-file-lines') + '"></i></span>' +
            '<span class="file-name">' + f.name + '</span>' +
            badge +
            '<span class="file-size">' + f.sizeKB + ' KB</span>' +
            '<button class="file-del" data-del="' + f.id + '" title="Delete"><i class="fa-solid fa-trash"></i></button>' +
            '</div>';
    }).join('');
    fileListEl.querySelectorAll('.file-item').forEach(el => {
        el.addEventListener('click', e => { if (!e.target.closest('.file-del')) openFile(+el.dataset.id); });
    });
    fileListEl.querySelectorAll('[data-del]').forEach(el => {
        el.addEventListener('click', e => { e.stopPropagation(); deleteFile(+el.dataset.del); });
    });
}

function renderAnalytics() {
    const c = { free: 0, superblock: 0, allocated: 0, damaged: 0 };
    diskBlocks.forEach(s => c[s]++);
    const usedKB = (c.allocated + c.superblock) * BLOCK_SIZE_KB;
    const freeKB = c.free * BLOCK_SIZE_KB;
    const hp = ((TOTAL_BLOCKS - c.damaged) / TOTAL_BLOCKS * 100).toFixed(1);
    const hcls = hp >= 95 ? 'green' : hp >= 80 ? 'orange' : 'red';
    $('stat-used').textContent = usedKB + ' KB';
    $('stat-free').textContent = freeKB + ' KB';
    $('stat-health').textContent = hp + '%';
    $('stat-health').className = 'stat-value ' + hcls;
    $('stat-files').textContent = files.length;
    drawPie(c);
}

function drawPie(c) {
    const ctx = pieCanvas.getContext('2d');
    const w = pieCanvas.width, h = pieCanvas.height;
    const cx = w / 2, cy = h / 2, r = Math.min(cx, cy) - 8, inner = r * 0.58;
    ctx.clearRect(0, 0, w, h);
    const cs = getComputedStyle(document.documentElement);
    const data = [
        { v: c.free, col: cs.getPropertyValue('--block-free-bg').trim() || '#111b27' },
        { v: c.superblock, col: cs.getPropertyValue('--blue').trim() },
        { v: c.allocated, col: cs.getPropertyValue('--accent').trim() },
        { v: c.damaged, col: cs.getPropertyValue('--red').trim() },
    ];
    const total = data.reduce((s, d) => s + d.v, 0);
    if (!total) return;
    let start = -Math.PI / 2;
    data.forEach(d => {
        if (!d.v) return;
        const sweep = (d.v / total) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, start, start + sweep);
        ctx.arc(cx, cy, inner, start + sweep, start, true);
        ctx.closePath();
        ctx.fillStyle = d.col;
        ctx.fill();
        ctx.strokeStyle = cs.getPropertyValue('--bg-panel').trim();
        ctx.lineWidth = 2;
        ctx.stroke();
        start += sweep;
    });
    const usedPct = ((c.allocated + c.superblock) / total * 100).toFixed(0);
    ctx.fillStyle = cs.getPropertyValue('--fg').trim();
    ctx.font = '700 16px "Space Grotesk"';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(usedPct + '%', cx, cy - 5);
    ctx.fillStyle = cs.getPropertyValue('--fg-dim').trim();
    ctx.font = '600 9px "Space Grotesk"';
    ctx.fillText('USED', cx, cy + 10);
}

function renderMetadata() {
    const c = { free: 0, superblock: 0, allocated: 0, damaged: 0 };
    diskBlocks.forEach(s => c[s]++);
    const crashed = files.filter(f => f.crashed).length;
    $('meta-grid').innerHTML = [
        ['Filesystem', 'SIMFS v3.0'],
        ['Journaling', 'Enabled'],
        ['Block Size', '4 KB'],
        ['Total Blocks', '256'],
        ['Free Blocks', c.free],
        ['Used Blocks', c.allocated + c.superblock],
        ['Damaged Blocks', c.damaged],
        ['Crashed Files', crashed],
        ['Total Recovered', totalRecovered],
        ['Inodes', files.length],
    ].map(([k, v]) => '<div class="meta-row"><span class="meta-key">' + k + '</span><span class="meta-val">' + v + '</span></div>').join('');
}

function updateIO() {
    $('io-grid').innerHTML = [
        ['Reads', ioStats.reads, ''],
        ['Writes', ioStats.writes, ''],
        ['Bytes Read', fmtBytes(ioStats.bytesRead), ''],
        ['Bytes Written', fmtBytes(ioStats.bytesWritten), ''],
        ['Syscalls', ioStats.syscalls, ''],
        ['Recoveries', ioStats.recoveries, 'cyan-val'],
    ].map(([k, v, cls]) => '<div class="io-row"><span class="io-label">' + k + '</span><span class="io-value ' + cls + '">' + v + '</span></div>').join('');
}

function showTip(e) {
    const i = +e.target.dataset.index;
    const s = diskBlocks[i];
    let owner = '\u2014';
    if (s === 'allocated' || s === 'damaged') {
        const f = findOwner(i);
        owner = f ? f.name + (f.crashed ? ' [DAMAGED]' : '') : '?';
    }
    if (s === 'superblock') owner = 'FS Metadata';
    const cols = { free: 'var(--fg-dim)', superblock: 'var(--blue)', allocated: 'var(--accent)', damaged: 'var(--red)' };
    tooltipEl.innerHTML =
        '<div class="tooltip-row"><span class="tooltip-key">Block</span><span class="tooltip-val">#' + i + '</span></div>' +
        '<div class="tooltip-row"><span class="tooltip-key">Offset</span><span class="tooltip-val">' + (i * 4) + ' KB</span></div>' +
        '<div class="tooltip-row"><span class="tooltip-key">State</span><span class="tooltip-val" style="color:' + (cols[s] || 'var(--fg)') + '">' + s.toUpperCase() + '</span></div>' +
        '<div class="tooltip-row"><span class="tooltip-key">Owner</span><span class="tooltip-val">' + owner + '</span></div>';
    tooltipEl.style.display = 'block';
    moveTip(e);
}

function moveTip(e) {
    let x = e.clientX + 12, y = e.clientY + 12;
    const r = tooltipEl.getBoundingClientRect();
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 8;
    if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 8;
    tooltipEl.style.left = x + 'px';
    tooltipEl.style.top = y + 'px';
}

function hideTip() { tooltipEl.style.display = 'none'; }

function updateZoom() {
    const s = Math.round(42 * zoomLevel);
    const fs = Math.max(6, Math.round(9 * zoomLevel));
    document.documentElement.style.setProperty('--block-size', s + 'px');
    document.querySelectorAll('.disk-block').forEach(el => el.style.fontSize = fs + 'px');
    $('zoom-level').textContent = Math.round(zoomLevel * 100) + '%';
}

function toggleTheme() {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    $('theme-icon').className = isDark ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    const c = { free: 0, superblock: 0, allocated: 0, damaged: 0 };
    diskBlocks.forEach(s => c[s]++);
    drawPie(c);
}

function showModal() { modalEl.style.display = 'flex'; $('input-filename').value = ''; $('input-filesize').value = '8'; setTimeout(() => $('input-filename').focus(), 80); }
function hideModal() { modalEl.style.display = 'none'; }

function confirmCreate() {
    const name = $('input-filename').value.trim();
    const size = parseInt($('input-filesize').value);
    if (!name) { addLog('error', 'create()', 'EINVAL: empty filename'); hideModal(); return; }
    if (!/^[a-zA-Z0-9_.\-]+$/.test(name)) { addLog('error', 'create()', 'EINVAL: bad chars in filename'); hideModal(); return; }
    if (files.some(f => f.name === name)) { addLog('error', 'create()', 'EEXIST: "' + name + '" exists'); hideModal(); return; }
    if (isNaN(size) || size < 1) { addLog('error', 'create()', 'EINVAL: invalid size'); hideModal(); return; }
    if (size > TOTAL_SIZE_KB - SUPERBLOCK_COUNT * BLOCK_SIZE_KB) { addLog('error', 'create()', 'ENOSPC: too large'); hideModal(); return; }
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
 $('btn-clear-log').addEventListener('click', () => { journalEl.innerHTML = ''; addLog('system', 'clear()', 'Log cleared'); });
 $('modal-close-new').addEventListener('click', hideModal);
 $('modal-cancel-new').addEventListener('click', hideModal);
 $('modal-confirm-new').addEventListener('click', confirmCreate);
 $('input-filename').addEventListener('keydown', e => { if (e.key === 'Enter') confirmCreate(); });
 $('input-filesize').addEventListener('keydown', e => { if (e.key === 'Enter') confirmCreate(); });
modalEl.addEventListener('click', e => { if (e.target === modalEl) hideModal(); });
 $('btn-zoom-in').addEventListener('click', () => { zoomLevel = Math.min(2.5, zoomLevel + 0.25); updateZoom(); });
 $('btn-zoom-out').addEventListener('click', () => { zoomLevel = Math.max(0.4, zoomLevel - 0.25); updateZoom(); });
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        if (modalEl.style.display === 'flex') hideModal();
        else if (openFileId !== null) closeFile();
    }
});

init();