var CONFIG = {
  TOTAL_BLOCKS: 48,
  GRID_COLS: 8,
  BLOCK_SIZE: 8,
  SUPERBLOCK: 0,
  FILETABLE_START: 1,
  FILETABLE_END: 3,
  JOURNAL_START: 4,
  JOURNAL_END: 5,
  BITMAP_START: 6,
  BITMAP_END: 7,
  DATA_START: 8,
  DATA_END: 47,
  DATA_COUNT: 40,
  PLAY_INTERVAL: 1200,
  CACHE_SIZE: 8
};

var state = {
  disk: [],
  files: {},
  directories: { '/': [] },
  journal: [],
  syscalls: [],
  allocationStrategy: 'contiguous',
  explainMode: true,
  isCrashed: false,
  cache: [],
  writeBuffer: [],
  optimizations: { cache: false, readahead: false, writeBuffer: false },
  selectedFile: null,
  nextFd: 3
};

function initDisk() {
  state.disk = [];
  for (var i = 0; i < CONFIG.TOTAL_BLOCKS; i++) {
    var type = 'data', status = 'free';
    if (i === CONFIG.SUPERBLOCK) { type = 'superblock'; status = 'allocated'; }
    else if (i >= CONFIG.FILETABLE_START && i <= CONFIG.FILETABLE_END) { type = 'filetable'; status = 'allocated'; }
    else if (i >= CONFIG.JOURNAL_START && i <= CONFIG.JOURNAL_END) { type = 'journal'; status = 'allocated'; }
    else if (i >= CONFIG.BITMAP_START && i <= CONFIG.BITMAP_END) { type = 'bitmap'; status = 'allocated'; }
    state.disk.push({ id: i, type: type, status: status, data: '', fileRef: null, nextBlock: null, isIndexBlock: false, pointedBlocks: [] });
  }
}

var executor = {
  steps: [],
  current: -1,
  playing: false,
  timer: null,
  snapshot: null,

  load: function(steps) {
    this.stop();
    this.steps = steps;
    this.current = -1;
    this.snapshot = JSON.parse(JSON.stringify({
      disk: state.disk, files: state.files,
      directories: state.directories, journal: state.journal,
      syscalls: state.syscalls, cache: state.cache,
      writeBuffer: state.writeBuffer, isCrashed: state.isCrashed,
      nextFd: state.nextFd
    }));
    updateProgress();
    updateStepDisplay(null);
  },

  next: function() {
    if (this.current >= this.steps.length - 1) { this.stop(); return false; }
    this.current++;
    var step = this.steps[this.current];
    clearHighlight();
    if (step.highlightBlock !== undefined) highlightBlock(step.highlightBlock);
    step.action();
    updateStepDisplay(step);
    updateProgress();
    renderDisk();
    renderFileTree();
    renderCache();
    renderWriteBuffer();
    drawConnections();
    renderJournalLog();
    if (this.current >= this.steps.length - 1) this.stop();
    return true;
  },

  prev: function() {
    if (this.current <= 0) return;
    var snap = this.snapshot;
    state.disk = JSON.parse(JSON.stringify(snap.disk));
    state.files = JSON.parse(JSON.stringify(snap.files));
    state.directories = JSON.parse(JSON.stringify(snap.directories));
    state.journal = JSON.parse(JSON.stringify(snap.journal));
    state.syscalls = JSON.parse(JSON.stringify(snap.syscalls));
    state.cache = JSON.parse(JSON.stringify(snap.cache));
    state.writeBuffer = JSON.parse(JSON.stringify(snap.writeBuffer));
    state.isCrashed = snap.isCrashed;
    state.nextFd = snap.nextFd;
    this.current--;
    for (var i = 0; i <= this.current; i++) { this.steps[i].action(); }
    var step = this.steps[this.current];
    updateStepDisplay(step);
    updateProgress();
    renderAll();
  },

  play: function() {
    if (this.playing) return;
    if (this.current >= this.steps.length - 1) return;
    this.playing = true;
    document.getElementById('btnPlay').innerHTML = '<i class="fas fa-pause"></i> Pause';
    setActionButtons(false);
    var self = this;
    this.timer = setInterval(function() { if (!self.next()) self.stop(); }, CONFIG.PLAY_INTERVAL);
    this.next();
  },

  stop: function() {
    this.playing = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    document.getElementById('btnPlay').innerHTML = '<i class="fas fa-play"></i> Play';
    setActionButtons(true);
  },

  reset: function() {
    this.stop();
    if (this.snapshot) {
      var snap = this.snapshot;
      state.disk = JSON.parse(JSON.stringify(snap.disk));
      state.files = JSON.parse(JSON.stringify(snap.files));
      state.directories = JSON.parse(JSON.stringify(snap.directories));
      state.journal = JSON.parse(JSON.stringify(snap.journal));
      state.syscalls = JSON.parse(JSON.stringify(snap.syscalls));
      state.cache = JSON.parse(JSON.stringify(snap.cache));
      state.writeBuffer = JSON.parse(JSON.stringify(snap.writeBuffer));
      state.isCrashed = snap.isCrashed;
      state.nextFd = snap.nextFd;
    }
    this.steps = [];
    this.current = -1;
    this.snapshot = null;
    clearHighlight();
    updateProgress();
    updateStepDisplay(null);
    renderAll();
  },

  isBusy: function() { return this.steps.length > 0 && this.current < this.steps.length - 1; }
};

function getNextFd() { return state.nextFd++; }

function addSyscall(text, retVal, error) {
  state.syscalls.push({ text: text, retVal: retVal, error: !!error, internal: text.startsWith('(') });
  renderSyscallLog();
}

function chunkData(data, size) {
  var chunks = [];
  for (var i = 0; i < data.length; i += size) chunks.push(data.slice(i, i + size));
  return chunks.length ? chunks : [''];
}

function findContiguousBlocks(startFrom, count) {
  var consecutive = 0, start = -1;
  for (var i = startFrom; i <= CONFIG.DATA_END; i++) {
    if (state.disk[i].status === 'free') {
      if (consecutive === 0) start = i;
      consecutive++;
      if (consecutive === count) {
        var blocks = [];
        for (var j = start; j < start + count; j++) blocks.push(j);
        return blocks;
      }
    } else { consecutive = 0; start = -1; }
  }
  return null;
}

function findAnyFreeBlocks(count) {
  var blocks = [];
  for (var i = CONFIG.DATA_START; i <= CONFIG.DATA_END && blocks.length < count; i++) {
    if (state.disk[i].status === 'free') blocks.push(i);
  }
  return blocks.length === count ? blocks : null;
}

function findSingleFreeBlock() {
  for (var i = CONFIG.DATA_START; i <= CONFIG.DATA_END; i++) {
    if (state.disk[i].status === 'free') return i;
  }
  return -1;
}

function countFreeBlocks() {
  var c = 0;
  for (var i = CONFIG.DATA_START; i <= CONFIG.DATA_END; i++) { if (state.disk[i].status === 'free') c++; }
  return c;
}

function addToCache(blockId) {
  state.cache = state.cache.filter(function(id) { return id !== blockId; });
  state.cache.push(blockId);
  if (state.cache.length > CONFIG.CACHE_SIZE) state.cache.shift();
}

function isInCache(blockId) { return state.cache.indexOf(blockId) !== -1; }

function getBlockCenter(blockId) {
  var el = document.querySelector('[data-block="' + blockId + '"]');
  var wrapper = document.getElementById('diskGridWrapper');
  if (!el || !wrapper) return null;
  var wr = wrapper.getBoundingClientRect();
  var er = el.getBoundingClientRect();
  return { x: er.left - wr.left + er.width / 2, y: er.top - wr.top + er.height / 2 };
}

function showToast(msg, type) {
  var t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  document.getElementById('toastContainer').appendChild(t);
  setTimeout(function() { t.remove(); }, 3000);
}

function openModal(html) {
  document.getElementById('modalContent').innerHTML = html;
  document.getElementById('modalOverlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
}

function setActionButtons(enabled) {
  var ids = ['btnCreate','btnWrite','btnRead','btnDelete','btnCrash','btnRecover'];
  for (var i = 0; i < ids.length; i++) {
    document.getElementById(ids[i]).disabled = !enabled;
  }
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('fs-sim-theme', theme);
}

function getStoredTheme() {
  var stored = localStorage.getItem('fs-sim-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}

function toggleTheme() {
  var current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
}

function generateCreateSteps(filename) {
  var steps = [];
  var fd = getNextFd();
  steps.push({
    title: 'Checking if "' + filename + '" exists',
    syscall: 'open("' + filename + '", O_RDONLY)',
    explain: 'The file system first checks if a file with this name already exists by searching directory entries in the file table.',
    action: function() { addSyscall('open("' + filename + '", O_RDONLY)', -1, true); }
  });
  if (state.files[filename]) {
    steps.push({ title: 'File Already Exists', syscall: '→ errno = EEXIST', explain: 'A file with this name already exists. The operation is aborted with EEXIST (File exists).', action: function() {} });
    return steps;
  }
  steps.push({
    title: 'Creating file "' + filename + '"', syscall: 'fd = creat("' + filename + '", 0644) → ' + fd,
    explain: 'creat() creates a new file entry in the file table. Mode 0644 means owner can read/write, others can read. File descriptor ' + fd + ' is returned.',
    action: function() {
      addSyscall('fd = creat("' + filename + '", 0644)', fd);
      state.files[filename] = { name: filename, directory: '/', size: 0, data: '', blocks: [], indexBlock: null, strategy: state.allocationStrategy, fd: fd };
      state.directories['/'].push(filename);
    }
  });
  var txnId = state.journal.length + 1;
  steps.push({ title: 'Writing to Journal', syscall: '(journal) txn_create(' + txnId + ', "CREATE ' + filename + '")', explain: 'Before finalizing, the operation is recorded in the journal. This ensures that if a crash occurs during creation, the recovery process knows what was happening.', action: function() { state.journal.push({ txnId: txnId, operation: 'create', file: filename, blockId: null, data: null, status: 'writing', completed: false }); } });
  steps.push({ title: 'Committing Journal Entry', syscall: '(journal) txn_commit(' + txnId + ')', explain: 'The journal entry is marked as committed, meaning the intention to create this file is now permanently recorded on disk.', action: function() { state.journal[state.journal.length - 1].status = 'committed'; } });
  steps.push({ title: 'Completing Journal Entry', syscall: '(journal) txn_complete(' + txnId + ')', explain: 'The file creation is fully complete. The journal entry is marked as completed and can be checkpointed later.', action: function() { state.journal[state.journal.length - 1].status = 'completed'; } });
  steps.push({ title: 'Updating File Table', syscall: '(internal) update_filetable()', explain: 'The file table (inode area) on disk is updated to include the new file entry with name, size, and block pointers.', action: function() {} });
  steps.push({ title: 'File Created Successfully', syscall: 'close(' + fd + ') → 0', explain: 'File descriptor released. "' + filename + '" now exists with 0 bytes and no data blocks allocated. Use "Write Data" to add content.', action: function() { addSyscall('close(' + fd + ')', 0); state.files[filename].fd = null; } });
  return steps;
}

function generateWriteSteps(filename, data) {
  var steps = [];
  var file = state.files[filename];
  if (!file) { steps.push({ title: 'File Not Found', syscall: 'open("' + filename + '", O_WRONLY) → -1', explain: 'The specified file does not exist. Create it first.', action: function() { addSyscall('open("' + filename + '", O_WRONLY)', -1, true); } }); return steps; }
  if (state.isCrashed) { steps.push({ title: 'File System Inconsistent', syscall: 'open("' + filename + '", O_WRONLY) → -1', explain: 'The file system has detected an inconsistent state after a crash. Run recovery first.', action: function() { addSyscall('open("' + filename + '", O_WRONLY)', -1, true); } }); return steps; }
  var fd = getNextFd();
  var chunks = chunkData(data, CONFIG.BLOCK_SIZE);
  var blocksNeeded = chunks.length;
  var strategy = state.allocationStrategy;
  var useWriteBuf = state.optimizations.writeBuffer;
  steps.push({ title: 'Opening "' + filename + '"', syscall: 'fd = open("' + filename + '", O_WRONLY) → ' + fd, explain: 'open() looks up the file in the file table and returns file descriptor ' + fd + '.', action: function() { addSyscall('open("' + filename + '", O_WRONLY)', fd); state.files[filename].fd = fd; } });
  steps.push({ title: 'Seeking to End of File', syscall: 'lseek(' + fd + ', 0, SEEK_END) → ' + file.size, explain: 'lseek() moves the file cursor to the end of the file (offset ' + file.size + ') for appending.', action: function() { addSyscall('lseek(' + fd + ', 0, SEEK_END)', file.size); } });
  steps.push({ title: 'Checking Available Space', syscall: '(internal) check_space(' + blocksNeeded + ')', explain: 'The file system checks if ' + blocksNeeded + ' free block(s) are available. Currently ' + countFreeBlocks() + ' blocks are free' + (strategy === 'indexed' && file.blocks.length === 0 ? ' (plus 1 for index block)' : '') + '.', action: function() {} });
  var totalNeeded = (strategy === 'indexed' && file.indexBlock === null) ? blocksNeeded + 1 : blocksNeeded;
  if (countFreeBlocks() < totalNeeded) {
    steps.push({ title: 'Disk Full', syscall: 'write(' + fd + ', ...) → -1', explain: 'Not enough free blocks. Need ' + totalNeeded + ' but only ' + countFreeBlocks() + ' available.', action: function() { addSyscall('write(' + fd + ', data, ' + data.length + ')', -1, true); } });
    steps.push({ title: 'Closing File', syscall: 'close(' + fd + ') → 0', explain: 'File descriptor released.', action: function() { addSyscall('close(' + fd + ')', 0); } });
    return steps;
  }
  var allocatedBlocks = [];
  var indexBlockId = null;
  if (strategy === 'contiguous') {
    var startFrom = file.blocks.length > 0 ? file.blocks[file.blocks.length - 1] + 1 : CONFIG.DATA_START;
    allocatedBlocks = findContiguousBlocks(startFrom, blocksNeeded);
    if (!allocatedBlocks) allocatedBlocks = findContiguousBlocks(CONFIG.DATA_START, blocksNeeded);
  } else if (strategy === 'linked') {
    allocatedBlocks = findAnyFreeBlocks(blocksNeeded) || [];
  } else if (strategy === 'indexed') {
    if (file.indexBlock === null) {
      indexBlockId = findSingleFreeBlock();
      if (indexBlockId === -1) { steps.push({ title: 'Disk Full (Index Block)', syscall: '(internal) alloc_index() → -1', explain: 'Cannot allocate index block. No space left.', action: function() {} }); steps.push({ title: 'Closing File', syscall: 'close(' + fd + ') → 0', explain: '', action: function() { addSyscall('close(' + fd + ')', 0); } }); return steps; }
    } else { indexBlockId = file.indexBlock; }
    allocatedBlocks = findAnyFreeBlocks(blocksNeeded) || [];
  }
  if (allocatedBlocks.length < blocksNeeded) { steps.push({ title: 'Cannot Allocate Blocks', syscall: 'write(' + fd + ', ...) → -1', explain: 'Not enough free blocks found. Try deleting files or using Linked allocation.', action: function() { addSyscall('write(' + fd + ', data, ' + data.length + ')', -1, true); } }); steps.push({ title: 'Closing File', syscall: 'close(' + fd + ') → 0', explain: '', action: function() { addSyscall('close(' + fd + ')', 0); } }); return steps; }
  if (strategy === 'indexed' && file.indexBlock === null && indexBlockId !== null) {
    steps.push({ title: 'Allocating Index Block #' + indexBlockId, syscall: '(internal) alloc_index(' + indexBlockId + ')', explain: 'In indexed allocation, a special index block stores pointers to all data blocks. It does not store file data itself — only block numbers. This enables direct access to any block without sequential scanning.', highlightBlock: indexBlockId, action: function() { state.disk[indexBlockId].status = 'allocated'; state.disk[indexBlockId].isIndexBlock = true; state.disk[indexBlockId].fileRef = filename; file.indexBlock = indexBlockId; } });
  }
  for (var i = 0; i < chunks.length; i++) {
    (function(i) {
      var chunk = chunks[i];
      var blockId = allocatedBlocks[i];
      if (useWriteBuf) { steps.push({ title: 'Buffering Chunk ' + (i + 1) + ': "' + chunk + '"', syscall: '(buffer) buffer_write("' + chunk + '")', explain: 'With write buffering enabled, data is first placed in a memory buffer rather than being written to disk immediately. This improves performance by batching writes, but risks data loss on crash before flushing.', action: function() { addSyscall('(buffer) buffer_write("' + chunk + '")', 'buffered'); state.writeBuffer.push({ blockId: blockId, data: chunk, file: filename, flushed: false }); } }); }
      var txnId = state.journal.length + 1;
      steps.push({ title: 'Journaling Write to Block #' + blockId, syscall: '(journal) txn_write(' + txnId + ', ' + blockId + ', "' + chunk + '")', explain: 'Before modifying the actual data block, the intended write is recorded in the journal (write-ahead logging). This is the core of journaling: record what you WILL do, then do it.', action: function() { state.journal.push({ txnId: txnId, operation: 'write', file: filename, blockId: blockId, data: chunk, status: 'writing', completed: false }); } });
      steps.push({ title: 'Committing Journal #' + txnId, syscall: '(journal) txn_commit(' + txnId + ')', explain: 'The journal entry is committed to disk. If the system crashes after this step but before the actual write, recovery will redo this operation.', action: function() { state.journal[state.journal.length - 1].status = 'committed'; } });
      steps.push({ title: 'Writing "' + chunk + '" → Block #' + blockId, syscall: 'write(' + fd + ', "' + chunk + '", ' + chunk.length + ') → ' + chunk.length, explain: 'Data "' + chunk + '" (' + chunk.length + ' bytes) is written to disk block #' + blockId + '. The disk controller transfers data from OS buffer to physical storage.', highlightBlock: blockId, action: function() { state.disk[blockId].status = 'allocated'; state.disk[blockId].data = chunk; state.disk[blockId].fileRef = filename; if (strategy === 'linked') { state.disk[blockId].nextBlock = i < chunks.length - 1 ? allocatedBlocks[i + 1] : null; } file.blocks.push(blockId); file.data += chunk; file.size += chunk.length; addSyscall('write(' + fd + ', "' + chunk + '", ' + chunk.length + ')', chunk.length); if (useWriteBuf) { var be = state.writeBuffer.find(function(b) { return b.blockId === blockId && !b.flushed; }); if (be) be.flushed = true; } } });
      if (strategy === 'indexed' && indexBlockId !== null) { steps.push({ title: 'Updating Index Block #' + indexBlockId, syscall: '(internal) index_add(' + indexBlockId + ', ' + blockId + ')', explain: 'Block #' + blockId + ' is registered in the index block #' + indexBlockId + '. To read this data later, the system reads the index block first, then directly accesses block #' + blockId + '.', action: function() { if (state.disk[indexBlockId].pointedBlocks.indexOf(blockId) === -1) state.disk[indexBlockId].pointedBlocks.push(blockId); } }); }
      steps.push({ title: 'Completing Journal #' + txnId, syscall: '(journal) txn_complete(' + txnId + ')', explain: 'The write is confirmed complete. The journal entry is marked as completed. During next checkpoint, this entry will be removed.', action: function() { state.journal[state.journal.length - 1].completed = true; } });
    })(i);
  }
  if (useWriteBuf) { steps.push({ title: 'Flushing Write Buffer', syscall: '(buffer) buffer_flush() → 0', explain: 'All buffered writes are now confirmed flushed to disk. If a crash had occurred before this step, buffered data would have been lost — this is why fsync() is critical.', action: function() { state.writeBuffer = state.writeBuffer.filter(function(b) { return b.flushed; }); } }); }
  steps.push({ title: 'Syncing Metadata to Disk', syscall: 'fsync(' + fd + ') → 0', explain: 'fsync() ensures all data and metadata are physically written to storage, not just in OS memory buffers. This guarantees durability.', action: function() { addSyscall('fsync(' + fd + ')', 0); } });
  steps.push({ title: 'Closing File', syscall: 'close(' + fd + ') → 0', explain: 'File descriptor released. The file table entry is updated.', action: function() { addSyscall('close(' + fd + ')', 0); state.files[filename].fd = null; } });
  steps.push({ title: 'Write Complete — ' + file.blocks.length + ' block(s) used', syscall: '', explain: 'Write operation finished. "' + filename + '" now uses ' + file.blocks.length + ' data block(s)' + (strategy === 'indexed' ? ' plus 1 index block' : '') + ' with total size of ' + file.size + ' bytes.', action: function() {} });
  return steps;
}

function generateReadSteps(filename) {
  var steps = [];
  var file = state.files[filename];
  if (!file) { steps.push({ title: 'File Not Found', syscall: 'open("' + filename + '", O_RDONLY) → -1', explain: 'The file does not exist.', action: function() { addSyscall('open("' + filename + '", O_RDONLY)', -1, true); } }); return steps; }
  if (file.blocks.length === 0) { steps.push({ title: 'File is Empty', syscall: 'read(fd, buf, 0) → 0', explain: 'The file exists but has no data blocks. It was created but never written to. read() returns 0 bytes (EOF).', action: function() { addSyscall('read(fd, buf, 0)', 0); } }); return steps; }
  var fd = getNextFd();
  var useCache = state.optimizations.cache;
  var useRA = state.optimizations.readahead;
  var strategy = file.strategy;
  steps.push({ title: 'Opening "' + filename + '"', syscall: 'fd = open("' + filename + '", O_RDONLY) → ' + fd, explain: 'open() in read-only mode returns file descriptor ' + fd + '. The file system reads the inode from the file table.', action: function() { addSyscall('open("' + filename + '", O_RDONLY)', fd); } });
  if (strategy === 'indexed' && file.indexBlock !== null) { steps.push({ title: 'Reading Index Block #' + file.indexBlock, syscall: 'read(' + fd + ', idx_buf, ' + CONFIG.BLOCK_SIZE + ') → ' + CONFIG.BLOCK_SIZE, explain: 'In indexed allocation, the system first reads the index block to discover where all data blocks are. This adds one extra disk read but enables direct access afterward.', highlightBlock: file.indexBlock, action: function() { addSyscall('read(' + fd + ', idx_buf, ' + CONFIG.BLOCK_SIZE + ')', CONFIG.BLOCK_SIZE); if (useCache) addToCache(file.indexBlock); } }); }
  var blocksToRead = file.blocks.slice();
  for (var i = 0; i < blocksToRead.length; i++) {
    (function(i) {
      var blockId = blocksToRead[i];
      var blockData = state.disk[blockId].data || '';
      if (useCache && isInCache(blockId)) { steps.push({ title: 'Cache Hit: Block #' + blockId, syscall: '(cache) cache_lookup(' + blockId + ') → HIT', explain: 'Block #' + blockId + ' is already in the cache (RAM)! The system reads it directly from memory instead of accessing the slow disk. This is orders of magnitude faster.', action: function() { addSyscall('(cache) cache_lookup(' + blockId + ')', 'HIT'); } }); }
      else {
        if (strategy === 'linked' && i > 0) { steps.push({ title: 'Following Pointer: Block #' + blocksToRead[i - 1] + ' → #' + blockId, syscall: '(internal) follow_link(' + blocksToRead[i - 1] + ') → ' + blockId, explain: 'In linked allocation, each block contains a pointer to the next. The system follows from block #' + blocksToRead[i - 1] + ' to block #' + blockId + '. Blocks can be scattered anywhere on disk.', action: function() { addSyscall('(internal) follow_link(' + blocksToRead[i - 1] + ')', blockId); } }); }
        steps.push({ title: 'Reading Block #' + blockId + ': "' + blockData + '"', syscall: 'read(' + fd + ', buf, ' + CONFIG.BLOCK_SIZE + ') → ' + blockData.length, explain: 'The disk controller reads ' + blockData.length + ' bytes from block #' + blockId + '. Physical disk access is relatively slow (milliseconds vs nanoseconds for RAM).', highlightBlock: blockId, action: function() { addSyscall('read(' + fd + ', buf, ' + CONFIG.BLOCK_SIZE + ')', blockData.length); if (useCache) addToCache(blockId); } });
      }
      if (useRA && i < blocksToRead.length - 1) { var raBlock = blocksToRead[i + 1]; steps.push({ title: 'Read-Ahead: Prefetching Block #' + raBlock, syscall: '(readahead) prefetch(' + raBlock + ')', explain: 'Read-ahead anticipates the next block will be needed and proactively reads it into cache. If the program reads it next, it will be a cache hit — saving a disk access.', highlightBlock: raBlock, action: function() { addSyscall('(readahead) prefetch(' + raBlock + ')', 'prefetched'); if (useCache) addToCache(raBlock); } }); }
    })(i);
  }
  steps.push({ title: 'Assembling File Data', syscall: '(internal) assemble(' + blocksToRead.length + ' blocks) → "' + file.data + '"', explain: 'All ' + blocksToRead.length + ' block(s) have been read. The OS assembles them in order to reconstruct the complete file content: "' + file.data + '"', action: function() { addSyscall('(internal) assemble → "' + file.data + '"', file.data.length); } });
  steps.push({ title: 'Closing File', syscall: 'close(' + fd + ') → 0', explain: 'File descriptor released. The data remains in cache for potential future reads.', action: function() { addSyscall('close(' + fd + ')', 0); } });
  return steps;
}

function generateDeleteSteps(filename) {
  var steps = [];
  var file = state.files[filename];
  if (!file) { steps.push({ title: 'File Not Found', syscall: 'unlink("' + filename + '") → -1', explain: 'The file does not exist.', action: function() { addSyscall('unlink("' + filename + '")', -1, true); } }); return steps; }
  var fd = getNextFd();
  steps.push({ title: 'Opening "' + filename + '"', syscall: 'fd = open("' + filename + '", O_RDWR) → ' + fd, explain: 'The file is opened to verify existence and access metadata.', action: function() { addSyscall('open("' + filename + '", O_RDWR)', fd); } });
  if (file.strategy === 'indexed' && file.indexBlock !== null) { steps.push({ title: 'Freeing Index Block #' + file.indexBlock, syscall: '(internal) free_block(' + file.indexBlock + ')', explain: 'The index block #' + file.indexBlock + ' is freed. Its pointer data is cleared and it becomes available for reuse.', highlightBlock: file.indexBlock, action: function() { state.disk[file.indexBlock].status = 'free'; state.disk[file.indexBlock].data = ''; state.disk[file.indexBlock].fileRef = null; state.disk[file.indexBlock].isIndexBlock = false; state.disk[file.indexBlock].pointedBlocks = []; state.cache = state.cache.filter(function(id) { return id !== file.indexBlock; }); } }); }
  for (var i = 0; i < file.blocks.length; i++) { (function(i) { var blockId = file.blocks[i]; steps.push({ title: 'Freeing Block #' + blockId, syscall: '(internal) free_block(' + blockId + ')', explain: 'Block #' + blockId + ' is marked free in the bitmap. Contents are not immediately erased (data remains until overwritten), but the block is now available for new allocations.', highlightBlock: blockId, action: function() { state.disk[blockId].status = 'free'; state.disk[blockId].data = ''; state.disk[blockId].fileRef = null; state.disk[blockId].nextBlock = null; state.cache = state.cache.filter(function(id) { return id !== blockId; }); } }); })(i); }
  steps.push({ title: 'Removing Directory Entry', syscall: 'unlink("' + filename + '") → 0', explain: 'unlink() removes the file entry from the directory. Note: unlink() works on the directory entry — if another process has the file open, data blocks stay until all references close.', action: function() { addSyscall('unlink("' + filename + '")', 0); state.directories['/'] = state.directories['/'].filter(function(n) { return n !== filename; }); } });
  steps.push({ title: 'Clearing File Table Entry', syscall: '(internal) clear_inode("' + filename + '")', explain: 'The file table (inode) entry is cleared. The inode number can now be reused.', action: function() { delete state.files[filename]; } });
  steps.push({ title: 'Closing File', syscall: 'close(' + fd + ') → 0', explain: 'Operation complete. All blocks are free.', action: function() { addSyscall('close(' + fd + ')', 0); } });
  if (state.selectedFile === filename) state.selectedFile = null;
  return steps;
}

function generateCrashSteps() {
  var steps = [];
  steps.push({ title: 'CRASH DETECTED', syscall: '*** POWER FAILURE ***', explain: 'A sudden power failure has occurred! The system did not complete all pending operations. The file system may be inconsistent — some writes may be incomplete, and some blocks may be corrupted.', action: function() { document.body.classList.add('crash-shake'); var flash = document.createElement('div'); flash.className = 'crash-flash'; document.body.appendChild(flash); setTimeout(function() { document.body.classList.remove('crash-shake'); flash.remove(); }, 700); } });
  steps.push({ title: 'Marking File System as Crashed', syscall: '(internal) set_crash_flag()', explain: 'A crash flag is set in the superblock. On next mount, the OS will detect this and know the file system was not shut down cleanly.', action: function() { state.isCrashed = true; } });
  var allocatedBlocks = [];
  for (var i = CONFIG.DATA_START; i <= CONFIG.DATA_END; i++) { if (state.disk[i].status === 'allocated') allocatedBlocks.push(i); }
  var corruptCount = Math.min(allocatedBlocks.length, 2 + Math.floor(Math.random() * 2));
  var shuffled = allocatedBlocks.slice().sort(function() { return Math.random() - 0.5; });
  var toCorrupt = shuffled.slice(0, corruptCount);
  var committedNotCompleted = state.journal.filter(function(j) { return j.status === 'committed' && !j.completed; });
  var incompleteCount = Math.min(committedNotCompleted.length, Math.floor(Math.random() * 2) + 1);
  var toIncomplete = committedNotCompleted.slice().sort(function() { return Math.random() - 0.5; }).slice(0, incompleteCount);
  for (var c = 0; c < toIncomplete.length; c++) { (function(j) { steps.push({ title: 'Journal Entry #' + j.txnId + ' Incomplete', syscall: '(journal) txn_' + j.txnId + ' → INCOMPLETE', explain: 'Journal entry #' + j.txnId + ' (write to block #' + j.blockId + ') was committed but never completed. The data may or may not have been written. This is exactly what journaling is designed to handle.', action: function() { j.status = 'incomplete'; } }); })(toIncomplete[c]); }
  for (var d = 0; d < toCorrupt.length; d++) { (function(blockId) { var oldData = state.disk[blockId].data; steps.push({ title: 'Block #' + blockId + ' CORRUPTED', syscall: '(crash) corrupt_block(' + blockId + ')', explain: 'Block #' + blockId + ' contained "' + oldData + '" but may now have garbage data due to the interrupted write. It is marked as corrupted and cannot be trusted.', highlightBlock: blockId, action: function() { state.disk[blockId].status = 'corrupted'; state.disk[blockId].data = '????????'.slice(0, Math.max(oldData.length, 8)); } }); })(toCorrupt[d]); }
  if (state.writeBuffer.some(function(b) { return !b.flushed; })) { steps.push({ title: 'Write Buffer Data LOST', syscall: '(crash) buffer_lost()', explain: 'Any data in the write buffer not yet flushed to disk is permanently lost. This demonstrates why fsync() is critical for data durability.', action: function() { state.writeBuffer = []; } }); }
  if (state.cache.length > 0) { steps.push({ title: 'Cache Cleared (Volatile Memory Lost)', syscall: '(crash) cache_clear()', explain: 'The cache exists in RAM (volatile memory). When power is lost, all cached data disappears. This is expected — cache is a performance optimization, not a reliability mechanism.', action: function() { state.cache = []; } }); }
  steps.push({ title: 'Crash Simulation Complete', syscall: '', explain: 'The file system is now inconsistent with ' + toCorrupt.length + ' corrupted block(s) and ' + toIncomplete.length + ' incomplete journal entry/entries. Click "Recover" to initiate journaling-based recovery.', action: function() {} });
  return steps;
}

function generateRecoverSteps() {
  var steps = [];
  if (!state.isCrashed) { steps.push({ title: 'No Recovery Needed', syscall: '(recovery) check() → CLEAN', explain: 'The file system is consistent. No crash has occurred, so recovery is not necessary.', action: function() { addSyscall('(recovery) check()', 'CLEAN'); } }); return steps; }
  steps.push({ title: 'Starting Recovery Process', syscall: '(recovery) mount() → RECOVERY_MODE', explain: 'The file system is mounted in recovery mode. The OS detected the crash flag in the superblock and will scan the journal to fix inconsistencies.', action: function() { addSyscall('(recovery) mount()', 'RECOVERY_MODE'); } });
  steps.push({ title: 'Reading Journal', syscall: '(recovery) journal_scan() → ' + state.journal.length + ' entries', explain: 'The recovery process reads the entire journal from disk. It looks for entries that were committed but not completed — these represent operations interrupted by the crash.', action: function() { addSyscall('(recovery) journal_scan()', state.journal.length + ' entries'); } });
  var incomplete = state.journal.filter(function(j) { return j.status === 'incomplete'; });
  if (incomplete.length === 0) { steps.push({ title: 'No Incomplete Transactions Found', syscall: '(recovery) find_incomplete() → 0', explain: 'No incomplete journal entries were found. All committed transactions completed successfully. The journal is clean.', action: function() { addSyscall('(recovery) find_incomplete()', 0); } }); }
  else {
    steps.push({ title: 'Found ' + incomplete.length + ' Incomplete Transaction(s)', syscall: '(recovery) find_incomplete() → ' + incomplete.length, explain: incomplete.length + ' journal entry/entries were committed but never completed. These need to be replayed (redo) to restore consistency.', action: function() { addSyscall('(recovery) find_incomplete()', incomplete.length); } });
    for (var a = 0; a < incomplete.length; a++) { (function(entry) {
      steps.push({ title: 'Replaying Transaction #' + entry.txnId, syscall: '(recovery) redo(' + entry.txnId + ', block=' + entry.blockId + ', "' + entry.data + '")', explain: 'The recovery process replays (redoes) transaction #' + entry.txnId + ': writing "' + entry.data + '" to block #' + entry.blockId + '. Since the journal recorded the intention, the system knows exactly what data should be in this block.', action: function() { entry.status = 'recovering'; } });
      steps.push({ title: 'Rewriting Block #' + entry.blockId, syscall: '(recovery) write_block(' + entry.blockId + ', "' + entry.data + '")', explain: 'Block #' + entry.blockId + ' is rewritten with the correct data from the journal. If the original write partially completed, this fixes it. If it did not complete at all, this performs it.', highlightBlock: entry.blockId, action: function() { state.disk[entry.blockId].status = 'allocated'; state.disk[entry.blockId].data = entry.data; state.disk[entry.blockId].fileRef = entry.file; addSyscall('(recovery) write_block(' + entry.blockId + ', "' + entry.data + '")', 0); } });
      steps.push({ title: 'Transaction #' + entry.txnId + ' Recovered', syscall: '(recovery) txn_recovered(' + entry.txnId + ')', explain: 'Transaction #' + entry.txnId + ' has been successfully replayed. The block now contains the correct data and the journal entry is marked as completed.', action: function() { entry.status = 'completed'; entry.completed = true; } });
    })(incomplete[a]); }
  }
  var corruptedWithJournal = [];
  for (var b = CONFIG.DATA_START; b <= CONFIG.DATA_END; b++) { if (state.disk[b].status === 'corrupted') { var journalEntry = state.journal.find(function(j) { return j.blockId === b && (j.status === 'completed' || j.status === 'recovering'); }); if (journalEntry) corruptedWithJournal.push({ blockId: b, journalEntry: journalEntry }); } }
  for (var e = 0; e < corruptedWithJournal.length; e++) { (function(item) { steps.push({ title: 'Restoring Corrupted Block #' + item.blockId + ' from Journal', syscall: '(recovery) restore(' + item.blockId + ', "' + item.journalEntry.data + '")', explain: 'Block #' + item.blockId + ' was corrupted, but the journal contains a completed write for this block with data "' + item.journalEntry.data + '". The journal allows the system to restore the correct data, demonstrating its core value.', highlightBlock: item.blockId, action: function() { state.disk[item.blockId].status = 'allocated'; state.disk[item.blockId].data = item.journalEntry.data; addSyscall('(recovery) restore(' + item.blockId + ', "' + item.journalEntry.data + '")', 0); } }); })(corruptedWithJournal[e]); }
  var stillCorrupted = [];
  for (var f = CONFIG.DATA_START; f <= CONFIG.DATA_END; f++) { if (state.disk[f].status === 'corrupted') stillCorrupted.push(f); }
  if (stillCorrupted.length > 0) {
    steps.push({ title: 'Unrecoverable Blocks Detected', syscall: '(recovery) check_unrecoverable() → ' + stillCorrupted.length, explain: stillCorrupted.length + ' corrupted block(s) [' + stillCorrupted.join(', ') + '] have no matching journal entry. These blocks contained data that was never journaled or the journal entry was also lost.', action: function() { addSyscall('(recovery) check_unrecoverable()', stillCorrupted.length + ' blocks'); } });
    for (var g = 0; g < stillCorrupted.length; g++) { (function(blockId) { steps.push({ title: 'Marking Block #' + blockId + ' as Free (Data Lost)', syscall: '(recovery) mark_free(' + blockId + ')', explain: 'Block #' + blockId + ' cannot be recovered from the journal. It is marked as free to prevent it from being used with corrupt data. Any file referencing this block will have data loss.', highlightBlock: blockId, action: function() { state.disk[blockId].status = 'free'; state.disk[blockId].data = ''; state.disk[blockId].fileRef = null; } }); })(stillCorrupted[g]); }
    var affectedFiles = {};
    for (var h = 0; h < stillCorrupted.length; h++) { var bid = stillCorrupted[h]; for (var fn in state.files) { if (state.files[fn].blocks.indexOf(bid) !== -1) affectedFiles[fn] = true; } }
    var affectedKeys = Object.keys(affectedFiles);
    for (var k = 0; k < affectedKeys.length; k++) { (function(fname) { var file = state.files[fname]; var newBlocks = file.blocks.filter(function(b) { return stillCorrupted.indexOf(b) === -1; }); var lostBlocks = file.blocks.filter(function(b) { return stillCorrupted.indexOf(b) !== -1; }); steps.push({ title: 'Updating "' + fname + '" (Lost ' + lostBlocks.length + ' block(s))', syscall: '(recovery) update_file("' + fname + '")', explain: '"' + fname + '" lost ' + lostBlocks.length + ' data block(s). The file entry is updated to reflect the remaining ' + newBlocks.length + ' block(s). Some data is permanently lost.', action: function() { file.blocks = newBlocks; file.data = newBlocks.map(function(b) { return state.disk[b].data; }).join(''); file.size = file.data.length; } }); })(affectedKeys[k]); }
  }
  steps.push({ title: 'Checkpointing Journal', syscall: '(recovery) journal_checkpoint()', explain: 'All completed journal entries are removed (checkpointed). This frees journal space for future operations. The journal is now clean and ready for normal use.', action: function() { state.journal = state.journal.filter(function(j) { return !j.completed; }); } });
  steps.push({ title: 'Clearing Crash Flag', syscall: '(recovery) clear_crash_flag()', explain: 'The crash flag in the superblock is cleared. The file system is now marked as cleanly unmounted. On the next reboot, it will mount in normal mode.', action: function() { state.isCrashed = false; } });
  steps.push({ title: 'Recovery Complete', syscall: '(recovery) done() → SUCCESS', explain: 'Journal-based recovery is complete. The file system is now in a consistent state. This entire process demonstrates why journaling is essential: without it, a crash could silently corrupt data. With it, the system can reliably restore consistency.', action: function() { addSyscall('(recovery) done()', 'SUCCESS'); showToast('File system recovered successfully', 'success'); } });
  return steps;
}

function renderDisk() {
  var grid = document.getElementById('diskGrid');
  grid.innerHTML = '';
  var zones = [
    { label: 'Superblock & File Table', start: 0, end: 3 },
    { label: 'Journal & Bitmap', start: 4, end: 7 },
    { label: 'Data Blocks', start: 8, end: 47 }
  ];
  for (var z = 0; z < zones.length; z++) {
    var zone = zones[z];
    var label = document.createElement('div');
    label.className = 'zone-label';
    label.textContent = zone.label;
    grid.appendChild(label);
    for (var i = zone.start; i <= zone.end; i++) {
      var block = state.disk[i];
      var el = document.createElement('div');
      el.className = 'block';
      el.setAttribute('data-block', i);
      var displayClass = block.status;
      if (block.isIndexBlock) displayClass = 'index-block';
      else if (block.type === 'superblock') displayClass = 'superblock';
      else if (block.type === 'filetable') displayClass = 'filetable';
      else if (block.type === 'journal') displayClass = 'journal-block';
      else if (block.type === 'bitmap') displayClass = 'filetable';
      else if (block.status === 'corrupted') displayClass = 'corrupted';
      if (displayClass === 'allocated' && isInCache(i)) displayClass = 'cached';
      el.classList.add(displayClass);
      var idSpan = document.createElement('span');
      idSpan.className = 'block-id';
      idSpan.textContent = i;
      el.appendChild(idSpan);
      var dataSpan = document.createElement('span');
      dataSpan.className = 'block-data';
      if (block.type === 'superblock') dataSpan.textContent = 'SB';
      else if (block.type === 'filetable') dataSpan.textContent = 'FT';
      else if (block.type === 'journal') dataSpan.textContent = 'JNL';
      else if (block.type === 'bitmap') dataSpan.textContent = 'BMP';
      else if (block.isIndexBlock) dataSpan.textContent = 'IDX';
      else if (block.data) dataSpan.textContent = block.data;
      else dataSpan.textContent = '';
      el.appendChild(dataSpan);
      if (block.status === 'corrupted') { var badge = document.createElement('span'); badge.className = 'block-badge'; badge.style.color = 'var(--danger)'; badge.textContent = 'ERR'; el.appendChild(badge); }
      if (displayClass === 'cached' && block.status === 'allocated') { var badge2 = document.createElement('span'); badge2.className = 'block-badge'; badge2.style.color = 'var(--warning)'; badge2.textContent = 'C'; el.appendChild(badge2); }
      (function(blockId) {
        el.addEventListener('mouseenter', function(e) { showBlockTooltip(e, blockId); });
        el.addEventListener('mousemove', function(e) { moveBlockTooltip(e); });
        el.addEventListener('mouseleave', hideBlockTooltip);
        el.addEventListener('click', function() { if (state.disk[blockId].fileRef && state.files[state.disk[blockId].fileRef]) { state.selectedFile = state.disk[blockId].fileRef; renderFileTree(); } });
      })(i);
      grid.appendChild(el);
    }
  }
}

function showBlockTooltip(e, blockId) {
  var block = state.disk[blockId];
  var tip = document.getElementById('blockTooltip');
  var html = '<div class="tooltip-row"><span class="tooltip-label">Block</span><span class="tooltip-value">#' + blockId + '</span></div>';
  html += '<div class="tooltip-row"><span class="tooltip-label">Type</span><span class="tooltip-value">' + (block.isIndexBlock ? 'Index' : block.type) + '</span></div>';
  html += '<div class="tooltip-row"><span class="tooltip-label">Status</span><span class="tooltip-value" style="color:' + (block.status === 'corrupted' ? 'var(--danger)' : block.status === 'allocated' ? 'var(--accent)' : 'var(--fg-muted)') + '">' + block.status + '</span></div>';
  if (block.fileRef) html += '<div class="tooltip-row"><span class="tooltip-label">File</span><span class="tooltip-value">' + block.fileRef + '</span></div>';
  if (block.data) html += '<div class="tooltip-divider"></div><div class="tooltip-row"><span class="tooltip-label">Data</span><span class="tooltip-value">"' + block.data + '"</span></div>';
  if (block.nextBlock !== null) html += '<div class="tooltip-row"><span class="tooltip-label">Next</span><span class="tooltip-value">#' + block.nextBlock + '</span></div>';
  if (block.pointedBlocks.length > 0) html += '<div class="tooltip-row"><span class="tooltip-label">Points to</span><span class="tooltip-value">[' + block.pointedBlocks.join(', ') + ']</span></div>';
  if (isInCache(blockId)) html += '<div class="tooltip-row"><span class="tooltip-label">Cache</span><span class="tooltip-value" style="color:var(--warning)">YES</span></div>';
  tip.innerHTML = html;
  tip.classList.add('visible');
  moveBlockTooltip(e);
}

function moveBlockTooltip(e) {
  var tip = document.getElementById('blockTooltip');
  var x = e.clientX + 16, y = e.clientY + 16;
  var rect = tip.getBoundingClientRect();
  if (x + rect.width > window.innerWidth - 10) x = e.clientX - rect.width - 10;
  if (y + rect.height > window.innerHeight - 10) y = e.clientY - rect.height - 10;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}

function hideBlockTooltip() { document.getElementById('blockTooltip').classList.remove('visible'); }

function renderFileTree() {
  var container = document.getElementById('fileTree');
  var files = state.directories['/'] || [];
  if (files.length === 0) { container.innerHTML = '<div class="empty-state"><i class="fas fa-folder-open"></i><span>No files yet.<br>Create one to get started.</span></div>'; return; }
  var html = '<div class="dir-label"><i class="fas fa-folder"></i> / (root)</div><div class="file-list">';
  for (var i = 0; i < files.length; i++) {
    var fname = files[i]; var file = state.files[fname]; if (!file) continue;
    var selected = state.selectedFile === fname ? ' selected' : '';
    var stratLabel = file.strategy === 'contiguous' ? 'CONT' : file.strategy === 'linked' ? 'LINK' : 'IDX';
    html += '<div class="file-item' + selected + '" data-file="' + fname + '"><i class="fas fa-file-lines file-icon"></i><span class="file-name">' + fname + '</span><span class="file-meta">' + file.size + 'B ' + file.blocks.length + 'blk</span><span class="file-strategy">' + stratLabel + '</span></div>';
  }
  html += '</div>';
  container.innerHTML = html;
  var items = container.querySelectorAll('.file-item');
  for (var j = 0; j < items.length; j++) { (function(el) { el.addEventListener('click', function() { state.selectedFile = el.getAttribute('data-file'); renderFileTree(); }); })(items[j]); }
}

function renderSyscallLog() {
  var container = document.getElementById('syscallLog');
  if (state.syscalls.length === 0) { container.innerHTML = '<div class="empty-state" style="height:auto;padding:20px 0;"><i class="fas fa-terminal"></i><span>No system calls yet</span></div>'; return; }
  var html = '';
  for (var i = 0; i < state.syscalls.length; i++) {
    var entry = state.syscalls[i];
    var dotClass = 'internal';
    if (entry.error) dotClass = 'error';
    else if (entry.internal) dotClass = 'internal';
    else if (entry.retVal !== undefined && entry.retVal !== -1 && entry.retVal !== 'CLEAN') dotClass = 'success';
    else if (entry.retVal === -1) dotClass = 'error';
    else dotClass = 'info';
    var textContent = entry.text;
    if (entry.error) { textContent += ' → <span class="err-val">-1 (error)</span>'; }
    else if (entry.internal) { textContent = '<span class="internal-val">' + entry.text + '</span>'; if (entry.retVal !== undefined && entry.retVal !== -1 && typeof entry.retVal !== 'string') { textContent += ' → <span class="internal-val">' + entry.retVal + '</span>'; } else if (typeof entry.retVal === 'string' && entry.retVal !== '-1') { textContent += ' → <span class="internal-val">' + entry.retVal + '</span>'; } }
    else { if (entry.retVal !== undefined) { textContent += ' → <span class="ret-val">' + entry.retVal + '</span>'; } }
    html += '<div class="log-entry"><div class="log-dot ' + dotClass + '"></div><div class="log-text">' + textContent + '</div></div>';
  }
  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

function renderJournalLog() {
  var container = document.getElementById('journalLog');
  if (state.journal.length === 0) { container.innerHTML = '<div class="empty-state" style="height:auto;padding:12px 0;"><i class="fas fa-scroll"></i><span>Journal empty</span></div>'; return; }
  var html = '';
  for (var i = 0; i < state.journal.length; i++) {
    var entry = state.journal[i];
    var statusClass = 'status-' + entry.status;
    var entryClass = entry.status;
    var opLabel = entry.operation === 'create' ? 'CREATE' : entry.operation === 'write' ? 'WRITE' : entry.operation;
    html += '<div class="journal-entry ' + entryClass + '"><div style="display:flex;justify-content:space-between;align-items:center;"><span class="journal-txn">TXN #' + entry.txnId + ' — ' + opLabel + '</span><span class="journal-status ' + statusClass + '">' + entry.status + '</span></div>';
    if (entry.file) { html += '<span class="journal-detail">File: ' + entry.file; if (entry.blockId !== null) html += ' | Block: #' + entry.blockId; if (entry.data) html += ' | Data: "' + entry.data + '"'; html += '</span>'; }
    html += '</div>';
  }
  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

function renderCache() {
  var strip = document.getElementById('cacheStrip');
  if (state.cache.length === 0) { strip.innerHTML = '<span style="font-size:10px;color:var(--fg-muted);font-style:italic;">Empty</span>'; return; }
  var html = '';
  for (var i = 0; i < state.cache.length; i++) { var blockId = state.cache[i]; var block = state.disk[blockId]; var lbl = block.fileRef ? block.fileRef + ':' + blockId : '#' + blockId; html += '<span class="opt-chip cache-chip">' + lbl + '</span>'; }
  strip.innerHTML = html;
}

function renderWriteBuffer() {
  var strip = document.getElementById('bufferStrip');
  if (state.writeBuffer.length === 0) { strip.innerHTML = '<span style="font-size:10px;color:var(--fg-muted);font-style:italic;">Empty</span>'; return; }
  var html = '';
  for (var i = 0; i < state.writeBuffer.length; i++) { var entry = state.writeBuffer[i]; var cls = entry.flushed ? 'buffer-chip' : 'buffer-pending'; var lbl = '#' + entry.blockId + ' "' + entry.data + '"' + (entry.flushed ? '' : ' (pending)'); html += '<span class="opt-chip ' + cls + '">' + lbl + '</span>'; }
  strip.innerHTML = html;
}

function drawConnections() {
  var svg = document.getElementById('connectionsSvg');
  svg.innerHTML = '';
  var fnames = Object.keys(state.files);
  for (var f = 0; f < fnames.length; f++) {
    var file = state.files[fnames[f]];
    var strategy = file.strategy;
    if (strategy === 'linked') {
      for (var i = 0; i < file.blocks.length; i++) {
        var fromId = file.blocks[i]; var toId = state.disk[fromId].nextBlock;
        if (toId === null || toId === undefined) continue;
        var from = getBlockCenter(fromId); var to = getBlockCenter(toId);
        if (!from || !to) continue;
        var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', from.x); line.setAttribute('y1', from.y); line.setAttribute('x2', to.x); line.setAttribute('y2', to.y);
        line.classList.add('link-line'); svg.appendChild(line);
        var angle = Math.atan2(to.y - from.y, to.x - from.x); var size = 6;
        var mx = to.x - Math.cos(angle) * 12; var my = to.y - Math.sin(angle) * 12;
        var arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        arrow.setAttribute('points', (mx + Math.cos(angle) * size) + ',' + (my + Math.sin(angle) * size) + ' ' + (mx + Math.cos(angle + 2.5) * size) + ',' + (my + Math.sin(angle + 2.5) * size) + ' ' + (mx + Math.cos(angle - 2.5) * size) + ',' + (my + Math.sin(angle - 2.5) * size));
        arrow.classList.add('arrow-head'); svg.appendChild(arrow);
      }
    }
    if (strategy === 'indexed' && file.indexBlock !== null) {
      var fromCenter = getBlockCenter(file.indexBlock); if (!fromCenter) continue;
      for (var j = 0; j < file.blocks.length; j++) {
        var toCenter = getBlockCenter(file.blocks[j]); if (!toCenter) continue;
        var idxLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        idxLine.setAttribute('x1', fromCenter.x); idxLine.setAttribute('y1', fromCenter.y); idxLine.setAttribute('x2', toCenter.x); idxLine.setAttribute('y2', toCenter.y);
        idxLine.classList.add('index-line'); svg.appendChild(idxLine);
      }
    }
  }
}

function highlightBlock(blockId) {
  clearHighlight();
  var el = document.querySelector('[data-block="' + blockId + '"]');
  if (!el) return;
  var block = state.disk[blockId];
  if (block.status === 'corrupted') el.classList.add('highlight-danger'); else el.classList.add('highlight');
  el.classList.add('pop');
  setTimeout(function() { el.classList.remove('pop'); }, 400);
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearHighlight() {
  var els = document.querySelectorAll('.block.highlight, .block.highlight-danger');
  for (var i = 0; i < els.length; i++) { els[i].classList.remove('highlight', 'highlight-danger'); }
}

function updateProgress() {
  var total = executor.steps.length; var current = executor.current;
  var pct = total > 0 ? ((current + 1) / total) * 100 : 0;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressText').textContent = total > 0 ? (current + 1) + ' / ' + total : 'Idle';
}

function updateStepDisplay(step) {
  var titleEl = document.getElementById('stepTitle');
  var syscallEl = document.getElementById('stepSyscall');
  var explainEl = document.getElementById('stepExplain');
  if (!step) { titleEl.textContent = 'Ready'; syscallEl.textContent = ''; explainEl.textContent = 'Choose an operation below to begin the simulation.'; return; }
  titleEl.textContent = step.title;
  syscallEl.textContent = step.syscall || '';
  syscallEl.style.display = step.syscall ? '' : 'none';
  explainEl.textContent = state.explainMode ? (step.explain || '') : '';
  explainEl.style.display = state.explainMode && step.explain ? '' : 'none';
}

function renderAll() {
  renderDisk(); renderFileTree(); renderSyscallLog(); renderJournalLog(); renderCache(); renderWriteBuffer(); drawConnections();
}

document.getElementById('btnPlay').addEventListener('click', function() { if (executor.playing) executor.stop(); else executor.play(); });
document.getElementById('btnNext').addEventListener('click', function() { if (!executor.isBusy() && executor.steps.length === 0) return; executor.stop(); executor.next(); });
document.getElementById('btnPrev').addEventListener('click', function() { executor.stop(); executor.prev(); });
document.getElementById('btnReset').addEventListener('click', function() { executor.reset(); });
document.getElementById('toggleExplain').addEventListener('click', function() { this.classList.toggle('active'); state.explainMode = this.classList.contains('active'); document.getElementById('stepExplain').style.display = state.explainMode ? '' : 'none'; });
document.getElementById('selStrategy').addEventListener('change', function() { state.allocationStrategy = this.value; });
document.getElementById('toggleCache').addEventListener('click', function() { this.classList.toggle('active'); state.optimizations.cache = this.classList.contains('active'); });
document.getElementById('toggleReadahead').addEventListener('click', function() { this.classList.toggle('active'); state.optimizations.readahead = this.classList.contains('active'); });
document.getElementById('toggleWriteBuf').addEventListener('click', function() { this.classList.toggle('active'); state.optimizations.writeBuffer = this.classList.contains('active'); });
document.getElementById('btnTheme').addEventListener('click', toggleTheme);

document.getElementById('btnCreate').addEventListener('click', function() {
  if (state.isCrashed) { showToast('Run recovery before creating files', 'error'); return; }
  openModal('<div class="modal-title">Create New File</div><div class="modal-field"><label>File Name</label><input type="text" id="inputFilename" placeholder="e.g. document.txt" maxlength="24" autofocus></div><div class="modal-actions"><button class="btn" id="modalCancel">Cancel</button><button class="btn primary" id="modalCreate">Create</button></div>');
  setTimeout(function() { var input = document.getElementById('inputFilename'); input.focus();
    var doCreate = function() { var name = input.value.trim(); if (!name) { showToast('Please enter a file name', 'warn'); return; } if (name.indexOf('/') !== -1 || name.indexOf('\\') !== -1 || name.indexOf('..') !== -1) { showToast('Invalid file name', 'error'); return; } closeModal(); executor.load(generateCreateSteps(name)); executor.play(); };
    document.getElementById('modalCreate').addEventListener('click', doCreate);
    document.getElementById('modalCancel').addEventListener('click', closeModal);
    input.addEventListener('keydown', function(e) { if (e.key === 'Enter') doCreate(); if (e.key === 'Escape') closeModal(); });
  }, 50);
});

document.getElementById('btnWrite').addEventListener('click', function() {
  var fileNames = Object.keys(state.files);
  if (fileNames.length === 0) { showToast('No files to write to. Create a file first.', 'warn'); return; }
  if (state.isCrashed) { showToast('Run recovery before writing files', 'error'); return; }
  var options = fileNames.map(function(n) { return '<option value="' + n + '"' + (state.selectedFile === n ? ' selected' : '') + '>' + n + ' (' + state.files[n].size + 'B)</option>'; }).join('');
  openModal('<div class="modal-title">Write Data to File</div><div class="modal-field"><label>File</label><select id="selectFile">' + options + '</select></div><div class="modal-field"><label>Data to Write</label><input type="text" id="inputData" placeholder="e.g. Hello World!" maxlength="64"></div><div class="modal-actions"><button class="btn" id="modalCancel">Cancel</button><button class="btn primary" id="modalWrite">Write</button></div>');
  setTimeout(function() { var input = document.getElementById('inputData'); input.focus();
    var doWrite = function() { var fname = document.getElementById('selectFile').value; var data = input.value.trim(); if (!data) { showToast('Please enter data to write', 'warn'); return; } closeModal(); executor.load(generateWriteSteps(fname, data)); executor.play(); };
    document.getElementById('modalWrite').addEventListener('click', doWrite);
    document.getElementById('modalCancel').addEventListener('click', closeModal);
    input.addEventListener('keydown', function(e) { if (e.key === 'Enter') doWrite(); if (e.key === 'Escape') closeModal(); });
  }, 50);
});

document.getElementById('btnRead').addEventListener('click', function() {
  var fileNames = Object.keys(state.files);
  if (fileNames.length === 0) { showToast('No files to read. Create a file first.', 'warn'); return; }
  var options = fileNames.map(function(n) { return '<option value="' + n + '"' + (state.selectedFile === n ? ' selected' : '') + '>' + n + ' (' + state.files[n].size + 'B)</option>'; }).join('');
  openModal('<div class="modal-title">Read File</div><div class="modal-field"><label>File</label><select id="selectFile">' + options + '</select></div><div class="modal-actions"><button class="btn" id="modalCancel">Cancel</button><button class="btn primary" id="modalRead">Read</button></div>');
  setTimeout(function() {
    var doRead = function() { var fname = document.getElementById('selectFile').value; closeModal(); executor.load(generateReadSteps(fname)); executor.play(); };
    document.getElementById('modalRead').addEventListener('click', doRead);
    document.getElementById('modalCancel').addEventListener('click', closeModal);
  }, 50);
});

document.getElementById('btnDelete').addEventListener('click', function() {
  var fileNames = Object.keys(state.files);
  if (fileNames.length === 0) { showToast('No files to delete.', 'warn'); return; }
  var options = fileNames.map(function(n) { return '<option value="' + n + '"' + (state.selectedFile === n ? ' selected' : '') + '>' + n + ' (' + state.files[n].size + 'B)</option>'; }).join('');
  openModal('<div class="modal-title">Delete File</div><div class="modal-field"><label>File</label><select id="selectFile">' + options + '</select></div><div class="modal-actions"><button class="btn" id="modalCancel">Cancel</button><button class="btn danger" id="modalDelete">Delete</button></div>');
  setTimeout(function() {
    var doDelete = function() { var fname = document.getElementById('selectFile').value; closeModal(); executor.load(generateDeleteSteps(fname)); executor.play(); };
    document.getElementById('modalDelete').addEventListener('click', doDelete);
    document.getElementById('modalCancel').addEventListener('click', closeModal);
  }, 50);
});

document.getElementById('btnCrash').addEventListener('click', function() {
  var allocatedCount = 0; for (var i = CONFIG.DATA_START; i <= CONFIG.DATA_END; i++) { if (state.disk[i].status === 'allocated') allocatedCount++; }
  if (allocatedCount === 0) { showToast('No data blocks to corrupt. Write some data first.', 'warn'); return; }
  if (state.isCrashed) { showToast('File system is already crashed. Run recovery first.', 'warn'); return; }
  executor.load(generateCrashSteps()); executor.play();
});

document.getElementById('btnRecover').addEventListener('click', function() { executor.load(generateRecoverSteps()); executor.play(); });
document.getElementById('modalOverlay').addEventListener('click', function(e) { if (e.target === e.currentTarget) closeModal(); });
document.addEventListener('keydown', function(e) {
  if (document.querySelector('.modal-overlay.open')) { if (e.key === 'Escape') closeModal(); return; }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === ' ') { e.preventDefault(); if (executor.playing) executor.stop(); else executor.play(); }
  if (e.key === 'ArrowRight') { e.preventDefault(); executor.stop(); executor.next(); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); executor.stop(); executor.prev(); }
  if (e.key === 'r') { e.preventDefault(); executor.reset(); }
});
window.addEventListener('resize', function() { drawConnections(); });

setTheme(getStoredTheme());
initDisk();
renderAll();