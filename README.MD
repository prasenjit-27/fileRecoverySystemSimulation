# 💻 Interactive File System Recovery Simulator

An advanced **Operating System project** that visually demonstrates how file systems work internally — including **file allocation, journaling, caching, crashes, and recovery mechanisms**.

This simulator helps understand complex OS concepts through an **interactive UI and step-by-step execution**.

---

## 📌 Features

✨ **Core File System Operations**

* Create File
* Write Data
* Read File
* Delete File

🧠 **Allocation Strategies**

* Contiguous Allocation
* Linked Allocation
* Indexed Allocation

⚡ **Advanced OS Concepts**

* Journaling (Write-Ahead Logging)
* Crash Simulation
* File System Recovery
* Cache Mechanism
* Read-Ahead Optimization
* Write Buffering

📊 **Visualization**

* Disk Block Map (48 blocks simulation)
* File Explorer
* System Call Logs
* Journal Logs
* Cache & Buffer Visualization

🎮 **Interactive Controls**

* Step-by-step execution
* Play / Pause simulation
* Next / Previous step
* Reset functionality

---

## 🧩 Project Structure

```
📁 File-System-Simulator
│── index.html      # Main UI structure
│── style.css       # Styling and themes
│── script.js       # Core logic & simulation
```

---

## 🖥️ How It Works

### 1. Disk Simulation

* Total Blocks: 48
* Reserved Blocks:

  * Superblock
  * File Table
  * Journal
  * Bitmap
* Remaining blocks used for data storage

📄 Reference: 

---

### 2. File Operations Flow

#### 🔹 Create File

* Check existence
* Add entry in file table
* Log operation in journal
* Commit transaction

#### 🔹 Write Data

* Divide data into chunks
* Allocate blocks (based on strategy)
* Journal each write
* Commit & complete

#### 🔹 Read File

* Access blocks
* Use cache if enabled
* Read-ahead optimization

#### 🔹 Delete File

* Free blocks
* Remove directory entry
* Clear metadata

---

### 3. Crash & Recovery

💥 **Crash Simulation**

* Corrupt random blocks
* Mark incomplete journal entries
* Clear cache & buffer

🛠️ **Recovery Process**

* Scan journal
* Replay incomplete transactions
* Restore corrupted blocks
* Mark unrecoverable blocks

---

## ⚙️ Technologies Used

* HTML5
* CSS3 (Dark/Light Theme + Animations)
* JavaScript (Vanilla JS)
* Font Awesome Icons

📄 UI Reference: 
🎨 Styling: 

---

## 🎯 Learning Outcomes

This project helps in understanding:

* File system architecture
* Disk block allocation techniques
* Journaling and recovery mechanisms
* System calls in OS
* Performance optimizations (cache, buffering)

---

## ▶️ How to Run

1. Download or clone the repository:

   ```
   git clone https://github.com/your-username/file-system-simulator.git
   ```

2. Open `index.html` in your browser

3. Start simulation using buttons:

   * Create File
   * Write Data
   * Read File
   * Simulate Crash
   * Recover

---

## 🎥 Demo Flow (For Viva)

1. Create a file
2. Write data (show allocation strategy)
3. Read file (show cache hits)
4. Simulate crash
5. Recover using journal

---

## 📌 Future Enhancements

* Multi-directory support
* Real-time fragmentation visualization
* File permissions system
* Multi-user simulation

---

## 👨‍💻 Authors

**Mohit Beetan, Prasenjit Majumder, Soumya Prerit**
Lovely Professional University

---

## ⭐ Final Note

This project is designed to make **Operating System concepts visual, interactive, and easy to understand**, bridging the gap between theory and real-world implementation.

---
